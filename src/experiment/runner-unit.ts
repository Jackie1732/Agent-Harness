import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { EffectOwner } from '../effect/owner.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import { initializeHost, hostRuntimeEventCatalog } from '../host/initialization.js'
import { openHost } from '../host/runtime.js'
import type { AtomicHost } from '../host/runtime.js'
import { decodeHostConfig, resolveHostConfig } from '../host/config.js'
import { acquireHostStorageLock } from '../host/storage-lock.js'
import { FileSessionBackend } from '../session/file-backend.js'
import { SessionRepository } from '../session/repository.js'
import { parseSessionId } from '../session/ids.js'
import { experimentAgentRoot } from './evidence-output.js'
import { collectExperimentEvidence } from './evidence.js'
import type { ExperimentEvidenceTarget } from './evidence-types.js'
import type { ExperimentPlan, ExperimentUnit } from './definition-types.js'
import type { ExperimentStorage } from './storage.js'
import { publishExperimentFile } from './storage.js'
import { experimentJsonDigest } from './parsing.js'
import { renderExperimentTask } from './input.js'
import type { ExperimentOutcome } from './journal-types.js'
import type { ExperimentUnitRunResult, RunExperimentOptions } from './runner-types.js'
import { ExperimentError } from './errors.js'
import { HostError } from '../host/errors.js'
import { experimentControllerEnvironment } from './environment.js'

/** Execute one admitted unit and join its actual Host resources before collecting evidence. */
export async function runExperimentUnit(plan: ExperimentPlan, unit: ExperimentUnit, storage: ExperimentStorage,
  options: RunExperimentOptions): Promise<ExperimentUnitRunResult> {
  const startedAt = performance.now()
  const environment = experimentControllerEnvironment(import.meta.url)
  const variant = plan.variants.find(item => item.variantKey === unit.variantKey)!
  const item = plan.dataset.cases.find(item => item.caseKey === unit.caseKey)!
  const entry = unit.entry
  const config = unit.config.schemaVersion === 3 && unit.config.workflows.kind === 'enabled' && entry.kind === 'workflow'
    ? { ...unit.config, workflows: { ...unit.config.workflows, definitions: unit.config.workflows.definitions.map(record => ({ ...record,
      definition: record.definition.workflowKey !== entry.workflowKey ? record.definition
        : { ...record.definition, deadline: new Date(Date.now() + entry.durationMs).toISOString() } })) } } : unit.config
  const recipe = resolveHostConfig(decodeHostConfig(config, unit.hostRoot))
  const recipeDigest = experimentJsonDigest(recipe as unknown as JsonValue)
  const recipeRef = await publishExperimentFile(storage.location.controlRoot, `runs/${unit.unitKey}/recipe.json`, canonicalJsonBytes(recipe as unknown as JsonValue), plan.evidenceLimits.maxRecipeBytes)
  await storage.journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest, recipe: recipeRef })
  const controller = new AbortController()
  let host: AtomicHost | undefined
  let closing = false
  let stopped: 'cancelled' | 'timed-out' | null = null
  const stop = (reason: 'cancelled' | 'timed-out') => {
    if (stopped === null) stopped = reason
    controller.abort()
    if (closing && host !== undefined) void Promise.resolve().then(() => host!.shutdown({ mode: 'cancel' })).catch(cause => {
      // A Host callback may request cancellation but cannot join its own shutdown; the owner joins it below.
      if (!(cause instanceof HostError && cause.code === 'HOST_REENTRANT_WAIT')) closure = 'failed'
    })
  }
  const abort = () => stop('cancelled')
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted === true) abort()
  const deadline = setTimeout(() => stop('timed-out'), plan.runPolicy.maxWallTimeMs)
  const budgetAt = performance.now()
  const owner = new EffectOwner(`Experiment unit ${unit.unitKey}`)
  let target: ExperimentEvidenceTarget | undefined
  let outcome: ExperimentOutcome = 'failed'
  let reason = 'unit-not-started'
  let closure: ExperimentUnitRunResult['closure'] = 'confirmed'
  let initMs: number | null = null, driveMs: number | null = null, shutdownMs: number | null = null
  let businessMs = 0
  try {
    await prepareUnitWorkspace(plan, unit)
    await mkdir(join(unit.hostRoot, 'sessions'), { recursive: true })
    const initAt = performance.now()
    try {
      if (stopped !== null) { outcome = stopped; reason = 'stopped-before-initialize' }
      else {
        const lease = await owner.run('Host', async effect => {
          await initializeHost(recipe)
          if (stopped !== null) return undefined
          return await effect.apply('Host runtime', () => openHost(recipe, {
            ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
            ...(variant.fixture.kind === 'programmatic' ? { bindings: options.fixtureBindings![variant.fixture.fixtureKey]! } : {}),
          }), async value => {
            const closeAt = performance.now()
            try { await value.shutdown({ mode: stopped === null && (outcome === 'completed' || outcome === 'result-unknown') ? 'drain' : 'cancel' }) }
            finally { shutdownMs = performance.now() - closeAt }
          })
        })
        host = lease.value
      }
    } finally { initMs = performance.now() - initAt }
    if (host !== undefined && stopped === null) {
      const driveAt = performance.now()
      const reader = new SessionRepository({ backend: new FileSessionBackend({ root: unit.hostRoot, maxRecordBytes: recipe.storage.maxRecordBytes }),
        catalog: hostRuntimeEventCatalog, maxLineageDepth: recipe.storage.maxLineageDepth })
      try {
        if (entry.kind === 'agent') {
          const member = recipe.members.find(member => member.kind === 'local' && member.agentKey === entry.agentKey)!
          const receipt = await host.submitTask(entry.agentKey, renderExperimentTask(item, entry), 'experiment-case')
          target = { kind: 'agent', sessionId: parseSessionId(member.sessionId), inputEventId: receipt.eventId, selector: entry.output, mediaType: item.output.mediaType }
        } else {
          if (recipe.schemaVersion !== 3 || recipe.workflows.kind !== 'enabled') throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'workflow-recipe-missing')
          const definition = recipe.workflows.definitions.find(record => record.definition.workflowKey === entry.workflowKey)!
          target = { kind: 'workflow', sessionId: parseSessionId(definition.sessionId), selector: entry.output, mediaType: item.output.mediaType }
          await host.workflow(entry.workflowKey).resume({ requestKey: `experiment-${unit.unitKey}` })
        }
        let observed = false
        for (let call = 0; call < plan.runPolicy.maxDriveCalls && stopped === null; call++) {
          const report = await host.run({ signal: controller.signal })
          if (target.kind === 'agent') {
            const root = experimentAgentRoot(await reader.read(target.sessionId), target.inputEventId)
            if (root?.outcome !== null && root !== undefined) {
              outcome = root.outcome === 'budget-exhausted' ? 'failed' : root.outcome
              if (stopped !== null) outcome = stopped
              reason = root.reason ?? root.outcome; observed = true; break
            }
          } else {
            const workflow = host.workflow(entry.kind === 'workflow' ? entry.workflowKey : '').report()
            if (workflow.settled && workflow.closed) {
              outcome = workflow.state === 'completed' ? 'completed' : workflow.state === 'cancelled' ? 'cancelled' : workflow.counts.unknown > 0 ? 'result-unknown' : 'failed'
              if (stopped !== null) outcome = stopped
              reason = workflow.state; observed = true; break
            }
          }
          if (report.stoppedBy === 'no-progress' || report.stoppedBy === 'quiescent') { reason = report.stoppedBy; break }
          reason = 'drive-limit'
        }
        if (!observed && stopped !== null) { outcome = stopped; reason = 'controller-stop' }
        if (!observed && target.kind === 'agent' && entry.kind === 'agent') {
          const root = experimentAgentRoot(await reader.read(target.sessionId), target.inputEventId)
          if (root?.outcome === null) await host.cancel(entry.agentKey, root.id, `experiment-${reason}`)
        }
      } finally { driveMs = performance.now() - driveAt; await reader.dispose() }
    } else if (stopped !== null) { outcome = stopped; reason = 'controller-stop' }
  } catch (cause) {
    outcome = stopped ?? 'failed'
    reason = cause instanceof ExperimentError ? cause.message : cause instanceof Error && 'code' in cause ? String(cause.code) : 'execution-error'
    if (cause instanceof AggregateError) closure = 'unknown'
  } finally {
    businessMs = performance.now() - budgetAt
    clearTimeout(deadline)
    closing = true
    try { await owner.dispose() } catch { closure = 'failed'; reason = 'host-close-failed' }
    options.signal?.removeEventListener('abort', abort)
  }
  let evidence: ExperimentUnitRunResult['evidence'] = null
  try {
    const lock = closure === 'confirmed' ? await acquireHostStorageLock(unit.hostRoot, 'experiment-evidence') : null
    try {
      const collected = await collectExperimentEvidence({ recipe, limits: plan.evidenceLimits, scope: 'unit-local/v1', mode: plan.runPolicy.mode,
        ...(target === undefined ? {} : { target }) })
      evidence = collected.evidence
    } finally { await lock?.dispose() }
  } catch { reason = 'evidence-unavailable' }
  const totalMs = performance.now() - startedAt
  return { outcome, reason, closure, evidence, measurement: { version: 1, unitKey: unit.unitKey, clock: 'performance.now', environment, initMs, driveMs, shutdownMs,
    totalMs, overdueMs: Math.max(0, businessMs - plan.runPolicy.maxWallTimeMs) } }
}

async function prepareUnitWorkspace(plan: ExperimentPlan, unit: ExperimentUnit): Promise<void> {
  const parent = dirname(unit.workspaceRoot)
  await mkdir(parent, { recursive: true })
  await mkdir(unit.workspaceRoot)
  const resourceRoots = unit.recipe.schemaVersion === 3 ? unit.recipe.workspaceResources
    : unit.recipe.schemaVersion === 2 && unit.recipe.subagents.kind === 'enabled' ? unit.recipe.subagents.workspaceResources : []
  const roots = [...unit.recipe.members.flatMap(member => member.kind === 'local' && member.tools.kind !== 'none' ? [member.tools.rootPath] : []),
    ...resourceRoots.map(resource => resource.rootPath)]
  for (const root of roots) await mkdir(root, { recursive: true })
  const item = plan.dataset.cases.find(item => item.caseKey === unit.caseKey)!
  for (const mapping of unit.entry.materials) {
    const material = item.materials.find(material => material.logicalPath === mapping.logicalPath)!
    const memberKey = unit.entry.kind === 'agent' ? unit.entry.agentKey : null
    const member = unit.recipe.members.find(member => member.kind === 'local' && member.agentKey === memberKey)
    const root = mapping.resourceId !== null ? resourceRoots.find(resource => resource.resourceId === mapping.resourceId)!.rootPath
      : member?.kind === 'local' && member.tools.kind !== 'none' ? member.tools.rootPath : unit.workspaceRoot
    const path = join(root, mapping.relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, material.text, { flag: 'wx', encoding: 'utf8' })
  }
}
