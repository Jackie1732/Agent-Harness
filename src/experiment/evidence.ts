import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { FileSessionBackend } from '../session/file-backend.js'
import { loadSessionHistory } from '../session/lineage.js'
import { freezeSessionSnapshot } from '../session/session-handle.js'
import { parseSessionEventId, parseSessionId, sessionLogPosition } from '../session/ids.js'
import type { SessionId, SessionLogPosition } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import { FrameScanner } from '../session/frame.js'
import { hostRuntimeEventCatalog } from '../host/initialization.js'
import { projectAgentSession } from '../agent/projection.js'
import { validateDelegationCausality } from '../subagent/causality.js'
import { collectExperimentMetrics } from './metrics.js'
import { verifyExperimentContexts } from './context-verification.js'
import type { CollectExperimentEvidenceInput, CollectedExperimentEvidence, EvidenceSessionCut } from './evidence-types.js'
import { selectExperimentOutput } from './evidence-output.js'
import { experimentBytesDigest } from './parsing.js'
import { ExperimentError } from './errors.js'
import { readExperimentFile } from './storage.js'

/** Inspect a pre-existing store without a Writer, lock marker, Provider, or directory creation. */
export async function collectExperimentEvidence(input: CollectExperimentEvidenceInput): Promise<CollectedExperimentEvidence> {
  const root = input.recipe.storage.root
  const limits = input.limits
  const reasons: string[] = []
  const snapshots: SessionSnapshot[] = []
  const cuts = new Map<SessionId, EvidenceSessionCut>()
  const selected: { sessionId: SessionId; through?: SessionLogPosition }[] = []
  const includeSession = (sessionId: SessionId): void => {
    if (selected.some(item => item.sessionId === sessionId)) return
    if (selected.length >= limits.maxSessionCount) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'session-count-limit')
    selected.push({ sessionId })
  }
  const fail = (cause: unknown) => reasons.push(cause instanceof ExperimentError ? cause.message
    : cause instanceof Error && 'code' in cause ? String(cause.code) : 'evidence-unreadable')
  let totalBytes = 0
  let totalEvents = 0
  let capturedBytes = 0
  try {
    for (const path of [root, join(root, 'sessions')]) {
      const entry = await lstat(path)
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ExperimentError('EXPERIMENT_EVIDENCE_INCOMPLETE', 'source-directory-invalid')
    }
    if (input.selected !== undefined) selected.push(...input.selected)
    else {
      for (const member of input.recipe.members) if (member.kind === 'local') includeSession(parseSessionId(member.sessionId))
      if (input.recipe.schemaVersion === 3 && input.recipe.workflows.kind === 'enabled') {
        for (const workflow of input.recipe.workflows.definitions) includeSession(parseSessionId(workflow.sessionId))
      }
      const directory = await opendir(join(root, 'sessions'))
      let entries = 0
      for await (const entry of directory) {
        if (++entries > limits.maxSessionCount) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'session-count-limit')
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(entry.name)) continue
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ExperimentError('EXPERIMENT_EVIDENCE_INCOMPLETE', 'session-directory-invalid')
        includeSession(parseSessionId(entry.name))
      }
    }
    if (selected.length > limits.maxSessionCount) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'session-count-limit')
    selected.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    const backend = new FileSessionBackend({ root, maxRecordBytes: input.recipe.storage.maxRecordBytes })
    try {
      // Size checks precede Backend reads; ancestry is checked through bounded Headers first.
      const checked = new Set<SessionId>()
      const checkFailures = new Map<SessionId, unknown>()
      const precheck = async (sessionId: SessionId, depth: number): Promise<void> => {
        if (checkFailures.has(sessionId)) throw checkFailures.get(sessionId)
        if (checked.has(sessionId)) return
        if (checked.size >= limits.maxSessionCount || depth > input.recipe.storage.maxLineageDepth) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'lineage-session-limit')
        checked.add(sessionId)
        try {
          const directory = join(root, 'sessions', sessionId)
          for (const name of ['header.frame', 'events.log']) {
            const entry = await lstat(join(directory, name))
            if (!entry.isFile() || entry.isSymbolicLink()) throw new ExperimentError('EXPERIMENT_EVIDENCE_INCOMPLETE', 'source-file-invalid')
            totalBytes += entry.size
            if (totalBytes > limits.maxEvidenceBytes) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'evidence-byte-limit')
          }
          const header = await backend.readPrefix(sessionId, sessionLogPosition(0))
          if (header.header.parent !== undefined) await precheck(header.header.parent.sessionId, depth + 1)
        } catch (cause) { checkFailures.set(sessionId, cause); throw cause }
      }
      for (const item of selected) {
        try {
          await precheck(item.sessionId, 0)
          const local = await backend.readPrefix(item.sessionId, item.through)
          const history = await loadSessionHistory(backend, hostRuntimeEventCatalog, local, input.recipe.storage.maxLineageDepth)
          const snapshot = freezeSessionSnapshot(history)
          for (const segment of history) {
            const prior = cuts.get(segment.header.sessionId)
            if (prior !== undefined && prior.through >= segment.through) continue
            const cut = await readPhysicalCut(root, segment.header.sessionId, segment.through, input.recipe.storage.maxRecordBytes, limits.maxEvidenceBytes)
            capturedBytes += cut.header.byteLength + cut.log.byteLength - (prior?.header.byteLength ?? 0) - (prior?.log.byteLength ?? 0)
            if (capturedBytes > limits.maxEvidenceBytes) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'evidence-byte-limit')
            totalEvents += segment.through - (prior?.through ?? 0)
            if (totalEvents > limits.maxEvents) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'event-count-limit')
            cuts.set(segment.header.sessionId, { ...cut, role: selected.some(chosen => chosen.sessionId === segment.header.sessionId) ? 'selected' : 'context' })
          }
          snapshots.push(snapshot)
          if (input.selected === undefined && history.at(-1)!.events.some(event => event.stored.type === 'agent/spec-recorded')) {
            for (const provision of projectAgentSession(snapshot).subagents.provisions) {
              if (provision.payload.outcome === 'installed' && provision.payload.child !== null) {
                includeSession(parseSessionEventId(provision.payload.child.ready).sessionId)
              }
            }
          }
        } catch (cause) { fail(cause) }
      }
    } finally { await backend.dispose() }
  } catch (cause) { fail(cause) }
  if (input.selected === undefined) for (const parent of snapshots) {
    if (!parent.history.at(-1)!.events.some(event => event.stored.type === 'agent/spec-recorded')) continue
    try {
      for (const requested of projectAgentSession(parent).subagents.delegations) {
        const child = snapshots.find(snapshot => snapshot.header.sessionId === requested.payload.childSessionId) ?? null
        validateDelegationCausality(parent, child, requested)
      }
    } catch (cause) { fail(cause) }
  }
  reasons.push(...verifyExperimentContexts(snapshots).reasons)
  const selectedIds = [...new Set(selected.map(item => item.sessionId))].sort()
  const coverage = { complete: reasons.length === 0 && snapshots.length === selectedIds.length,
    expectedSessions: input.selected === undefined && reasons.length > 0 ? null : selectedIds.length,
    observedSessions: snapshots.length, reasons: [...new Set(reasons)] }
  const target = input.target ?? null
  const workspace = target?.kind === 'agent' ? input.recipe.members.find(member => member.kind === 'local' && member.sessionId === target.sessionId) : undefined
  const workspaceRoot = workspace?.kind === 'local' && workspace.tools.kind !== 'none' ? workspace.tools.rootPath : null
  const output = target === null ? { status: 'unavailable' as const, reason: 'output-not-selected', sources: [] }
    : coverage.complete ? await selectExperimentOutput(snapshots, target, workspaceRoot, limits.maxEvidenceBytes)
      : { status: 'unavailable' as const, reason: 'evidence-incomplete', sources: [] }
  const metrics = collectExperimentMetrics({ scope: input.scope, mode: input.mode, snapshots,
    selectedSessionIds: selectedIds, coverage, maxMetricSamples: limits.maxMetricSamples })
  return { evidence: { version: 1, digestDomains: { files: 'raw-sha256/v1', logs: 'framed-prefix-sha256/v1', metadata: 'sorted-json-sha256/v1' },
    source: { root, maxRecordBytes: input.recipe.storage.maxRecordBytes, maxLineageDepth: input.recipe.storage.maxLineageDepth },
    scope: input.scope, mode: input.mode, selectedSessionIds: selectedIds,
    selections: selectedIds.map(sessionId => ({ sessionId, through: snapshots.find(snapshot => snapshot.header.sessionId === sessionId)?.localPosition ?? null })),
    sessions: [...cuts.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    coverage, target, output, metrics }, snapshots }
}

async function readPhysicalCut(root: string, sessionId: SessionId, through: SessionLogPosition, maxRecordBytes: number, maxBytes: number): Promise<Omit<EvidenceSessionCut, 'role'>> {
  const prefix = `sessions/${sessionId}`
  const header = await readExperimentFile(join(root, prefix, 'header.frame'), maxBytes)
  const log = await readExperimentFile(join(root, prefix, 'events.log'), maxBytes)
  const scanner = new FrameScanner(maxRecordBytes)
  const frames = scanner.push(log)
  const end = scanner.finish(true)
  const committedBytes = through === 0 ? 0 : frames[through - 1]?.endOffset
  if (committedBytes === undefined) throw new ExperimentError('EXPERIMENT_EVIDENCE_INCOMPLETE', 'cut-exceeds-frames')
  return { sessionId, through, header: { path: `${prefix}/header.frame`, byteLength: header.byteLength, sha256: experimentBytesDigest(header) },
    log: { path: `${prefix}/events.log`, byteLength: log.byteLength, sha256: experimentBytesDigest(log) }, committedBytes,
    committedSha256: experimentBytesDigest(log.subarray(0, committedBytes)), tail: end.incompleteTail === undefined ? null
      : { ...end.incompleteTail, sha256: experimentBytesDigest(log.subarray(end.incompleteTail.byteOffset)) } }
}

/** Verify the original bytes independently of metadata JSON encoding. */
export async function verifyExperimentEvidence(evidence: import('./evidence-types.js').ExperimentEvidence, maxBytes: number): Promise<readonly string[]> {
  const reasons: string[] = []
  let total = 0
  for (const session of evidence.sessions) {
    for (const item of [session.header, session.log]) {
      try {
        const path = join(evidence.source.root, item.path)
        const entry = await lstat(path)
        total += entry.size
        if (!entry.isFile() || entry.isSymbolicLink()) { reasons.push('source-file-invalid'); continue }
        if (total > maxBytes) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'evidence-byte-limit')
        const bytes = await readExperimentFile(path, maxBytes - (total - entry.size))
        if (bytes.byteLength !== item.byteLength || experimentBytesDigest(bytes) !== item.sha256) reasons.push(`file-changed:${item.path}`)
        if (item === session.log && experimentBytesDigest(bytes.subarray(0, session.committedBytes)) !== session.committedSha256) reasons.push(`prefix-changed:${item.path}`)
      } catch (cause) {
        if (cause instanceof ExperimentError && cause.code === 'EXPERIMENT_LIMIT_EXCEEDED') throw cause
        reasons.push(`file-unreadable:${item.path}`)
      }
    }
  }
  return [...new Set(reasons)]
}
