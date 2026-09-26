import { beforeAll, afterAll, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordRecoveryScenario, recoveryScenarioSpec, recoveryClock as clock } from './recovery-scenarios.js'
import type { RecoveryScenario } from './recovery-scenarios.js'
import { captureWorkflowTrace, seedWorkflowTrace } from './file-trace.js'
import type { FileTraceEntry } from './file-trace.js'
import { prohibitedRecoveryWrites, recoveryReferences } from './recovery-fixture.js'
import { recoverHost } from '../../src/host/recovery.js'
import { openHost } from '../../src/host/runtime.js'
import { agentControlRequestedEvent } from '../../src/agent/session-events.js'

const traces = new Map<RecoveryScenario, FileTraceEntry[]>()
let base: string
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'workflow-matrix-')) })
afterAll(async () => { await rm(base, { recursive: true, force: true }) })
const options = { predecessorStopped: true as const, maxRecoveryWrites: 128, maxJournalConflicts: 4, clock }
const windows: [RecoveryScenario, string][] = [
  ...['work/interaction-requested', 'workflow/interaction-admitted', 'work/interaction-resolved', 'agent/action-settled', 'agent/turn-settled',
    'communication/outbox-accepted', 'work/protocol-classified', 'work/protocol-recorded', 'agent/wait-settled', 'workflow/interaction-settled'].map(type => ['question', type] as [RecoveryScenario, string]),
  ...['work/group-requested', 'workflow/interaction-admitted', 'work/group-resolved', 'communication/outbox-accepted', 'work/group-result', 'agent/wait-settled'].map(type => ['group', type] as [RecoveryScenario, string]),
  ...['workflow/assignment-committed', 'work/review-recorded', 'workflow/review-received', 'workflow/control-requested', 'workflow/control-settled'].map(type => ['review-retry', type] as [RecoveryScenario, string]),
  ...['subagent/delegation-requested', 'model/invocation-started', 'workflow/control-requested', 'agent/control-requested', 'subagent/release-recorded', 'work/execution-released'].map(type => ['child-cancel', type] as [RecoveryScenario, string]),
  ...['tool/invocation-started', 'tool/invocation-settled', 'artifact/published'].map(type => ['file', type] as [RecoveryScenario, string]),
]

it.each(windows)('recovers %s at %s and each interrupted recovery acknowledgement', async (name, type) => {
  if (!traces.has(name)) traces.set(name, await recordRecoveryScenario(name, join(base, name), join(base, 'workspace')))
  const trace = traces.get(name)!, root = await mkdtemp(join(tmpdir(), 'workflow-matrix-cut-'))
  try {
    // Later occurrences exercise answers, individual group recipients, retries and Child cancellation.
    const positions = trace.flatMap((item, index) => item.kind === 'event' && item.event.type === type ? [index] : [])
    expect(positions.length, name + ':' + type).toBeGreaterThan(0)
    const selected = type === 'communication/outbox-accepted' ? positions.filter(index => {
      const item = trace[index]!
      return item.kind === 'event' && /workflow\/(question|answer|group)/.test(JSON.stringify(item.event.payload))
    }) : [...new Set([positions[0]!, positions.at(-1)!])]
    expect(selected.length).toBeGreaterThan(0)
    for (const position of selected) {
      const cutRoot = join(root, String(position)), prefix = trace.slice(0, position + 1)
      const spec = await recoveryScenarioSpec(name, cutRoot, join(base, 'workspace'))
      await seedWorkflowTrace(cutRoot, prefix)
      const recovered = await captureWorkflowTrace(async () => {
        const result = await recoverHost(spec, options)
        const counts = result.map(item => 'totalWrites' in item.result ? item.result.totalWrites : -1)
        expect(new Set(counts).size).toBe(1); expect(counts[0]).toBeLessThanOrEqual(128)
        for (const item of result) if ('pending' in item.result) expect(item.result.pending.every(key => key.startsWith('resume-installation:'))).toBe(true)
      })
      expect(recovered.every(item => item.kind !== 'event' || !prohibitedRecoveryWrites.has(item.event.type))).toBe(true)
      // A shared Workflow parent must receive one Agent recovery owner, even when it also owns Child relations.
      const owners = recovered.filter(item => item.kind === 'event' && item.event.type === 'agent/control-requested' && agentControlRequestedEvent.decode(item.event.payload).kind === 'recovery')
      expect(new Set(owners.map(item => item.kind === 'event' && item.event.sessionId)).size).toBe(owners.length)
      for (let index = 1; index <= recovered.length; index++) {
        const againRoot = join(root, position + '-' + index)
        await seedWorkflowTrace(againRoot, [...prefix, ...recovered.slice(0, index)])
        const againSpec = await recoveryScenarioSpec(name, againRoot, join(base, 'workspace'))
        const refs = await recoveryReferences(againSpec)
        if (Object.values(refs).some(value => value !== null)) await expect(recoverHost(againSpec, options)).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
        const result = await recoverHost(againSpec, { ...options, domainSupersedes: refs })
        for (const item of result) if ('pending' in item.result) expect(item.result.pending.every(key => key.startsWith('resume-installation:'))).toBe(true)
      }
      const repeated = await captureWorkflowTrace(async () => { await recoverHost(spec, { ...options, domainSupersedes: await recoveryReferences(spec) }) })
      expect(repeated).toEqual([])
      const host = await openHost(spec, { clock })
      try { expect(host.workflow('research').report().state).not.toBe('running') }
      finally { await host.shutdown({ mode: 'drain' }) }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 180000)

it.each(['deadline', 'settlement'] as const)('rejects %s facts inconsistent with the originating question', async field => {
  if (!traces.has('question')) traces.set('question', await recordRecoveryScenario('question', join(base, 'question'), join(base, 'workspace')))
  const trace = traces.get('question')!, root = await mkdtemp(join(tmpdir(), 'workflow-inconsistent-'))
  try {
    const type = field === 'deadline' ? 'workflow/interaction-admitted' : 'workflow/interaction-settled'
    const position = trace.findIndex(item => item.kind === 'event' && item.event.type === type)
    expect(position).toBeGreaterThan(-1)
    const prefix = trace.slice(0, position + 1).map((item, index) => {
      if (index !== position || item.kind !== 'event') return item
      const payload = item.event.payload as import('../../src/foundation/json.js').JsonObject
      return { ...item, event: { ...item.event, payload: { ...payload, ...(field === 'deadline'
        ? { deadline: new Date(Date.parse(payload.deadline as string) - 1).toISOString() }
        : { outcome: payload.outcome === 'interrupted' ? 'answered' : 'interrupted' }) } } }
    })
    await seedWorkflowTrace(root, prefix)
    const spec = await recoveryScenarioSpec('question', root, join(base, 'workspace'))
    await expect(recoverHost(spec, options)).rejects.toMatchObject({ code: 'WORKFLOW_HISTORY_INVALID',
      message: field === 'deadline' ? 'workflow-causal-interaction-source' : 'workflow-causal-interaction-settlement' })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)
