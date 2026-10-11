import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runnableWorkflowHost } from './host-fixture.js'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { assembleHost } from '../../src/host/assembly.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { formatSessionAddress, formatSessionEventId, parseSessionId, sessionSequence } from '../../src/session/ids.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'

const coordinatorId = parseSessionId('87000000-0000-4000-8000-000000000001')

it.each(['pause', 'resume', 'cancel'] as const)('persists the original %s request after its caller reuses the input object', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'work-control-capture-'))
  try {
    const now = Date.now(), clock = { now: () => now }, spec = runnableWorkflowHost(root)
    await initializeHost(spec, { clock })
    const host = await openHost(spec, { clock })
    try {
      const workflow = host.workflow('research')
      const input = { requestKey: 'accepted-key', reason: 'accepted-reason' }
      const pending = workflow[kind](input)
      input.requestKey = 'reused-key'; input.reason = 'reused-reason'
      const receipt = await pending
      expect(await workflow[kind]({ requestKey: 'accepted-key', reason: 'accepted-reason' })).toEqual(receipt)
      const reader = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
      try {
        const state = projectWorkflowSession(await reader.read(coordinatorId))
        expect(state.controls).toHaveLength(1)
        expect(state.controls[0]!.requested.payload).toMatchObject({ kind, requestKey: 'accepted-key', reason: 'accepted-reason' })
        expect(state.assignments).toHaveLength(0)
      } finally { await reader.dispose() }
    } finally { await host.shutdown({ mode: 'drain' }) }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

it('captures independently queued controls before applying their ordered transitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-control-queue-'))
  try {
    const now = Date.now(), clock = { now: () => now }, spec = runnableWorkflowHost(root)
    await initializeHost(spec, { clock })
    const assembly = await assembleHost(spec, clock, {}, {})
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    try {
      const controls = assembly.workflows!.controls
      const preceding = controls.options.gate.run(() => held)
      const kinds = ['resume', 'pause', 'cancel'] as const
      const pending = kinds.map(kind => {
        const input = { requestKey: String(kind), reason: kind + '-reason' }
        const result = controls.request('research', kind, input)
        input.requestKey = 'reused-' + kind; input.reason = 'reused-reason'
        return result
      })
      release(); await preceding; await Promise.all(pending)
      const state = projectWorkflowSession(assembly.protocolSlots[0]!.session.snapshot())
      expect(state.controls.map(item => item.requested.payload)).toEqual(kinds.map(kind => ({
        definition: state.definition!.stored.eventId, kind, requestKey: kind, reason: kind + '-reason',
      })))
      expect(state.controls.every(item => item.settled?.payload.outcome === 'applied')).toBe(true)
      expect(state.assignments).toHaveLength(0)
    } finally { release(); await assembly.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

it('keeps the exact failed assignment and original retry receipt when the caller changes its nested reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-retry-capture-'))
  try {
    const base = runnableWorkflowHost(root)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('Workflow fixture requires v3')
    const entry = base.workflows.definitions[0]!, node = entry.definition.nodes[0]!
    const definition = decodeWorkflowDefinition({ ...entry.definition, requiredOutputs: [node.nodeKey],
      nodes: [{ ...node, attempts: [node.attempts[0], node.attempts[0]] }],
      communication: { ...entry.definition.communication, disclosures: [entry.definition.communication.disclosures[0]] } })
    const spec = { ...base, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    const now = Date.now(), clock = { now: () => now }
    let producerCalls = 0
    await initializeHost(spec, { clock })
    const host = await openHost(spec, { clock, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* () {
        expect(member.agentKey).toBe('writer')
        const text = ++producerCalls === 1 ? 'invalid JSON' : '{"text":"candidate"}'
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'retry-capture' }
        yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      } }) } })
    try {
      const workflow = host.workflow('research')
      await workflow.resume({ requestKey: 'start' }); await host.run()
      expect(workflow.report().state).toBe('retry-awaiting-decision')
      const failed = workflow.report().assignments[0]!.ref
      const original = { nodeKey: 'read', failedAssignment: { ...failed }, requestKey: 'original-retry' }
      const input = { ...original, failedAssignment: { ...failed } }
      const pending = workflow.retry(input)
      input.requestKey = 'reused-retry'; input.nodeKey = 'missing'
      input.failedAssignment.eventId = formatSessionEventId(coordinatorId, sessionSequence(1))
      const receipt = await pending
      expect(await workflow.retry(original)).toEqual(receipt)
      expect(producerCalls).toBe(1)
      await host.run()
      expect(workflow.report()).toMatchObject({ state: 'completed', closed: true, counts: { accepted: 1 } })
      expect(producerCalls).toBe(2)
      expect(await workflow.retry(original)).toEqual(receipt)
    } finally { await host.shutdown({ mode: 'drain' }) }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 45000)

it('rejects invalid controls before committing control facts or enabling work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-invalid-controls-'))
  try {
    const now = Date.now(), clock = { now: () => now }, spec = runnableWorkflowHost(root)
    await initializeHost(spec, { clock })
    const host = await openHost(spec, { clock })
    try {
      const workflow = host.workflow('research')
      const before = host.read().workflow('research')
      await expect(workflow.resume({ requestKey: '' })).rejects.toThrow()
      await expect(workflow.retry({ requestKey: 'invalid-ref', nodeKey: 'read', failedAssignment: {
        address: formatSessionAddress(parseSessionId(spec.members[0]!.sessionId)), eventId: formatSessionEventId(coordinatorId, sessionSequence(1)),
      } })).rejects.toThrow()
      expect(host.read().workflow('research')).toEqual(before)
      await host.run()
      expect(workflow.report()).toMatchObject({ desired: 'paused', counts: { assignments: 0, pendingControls: 0 } })
    } finally { await host.shutdown({ mode: 'drain' }) }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

it('keeps a closed observation distinct from business settlement after its caller reuses the query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-observation-capture-'))
  try {
    const now = Date.now(), clock = { now: () => now }, base = runnableWorkflowHost(root)
    const spec = { ...base, scheduling: { ...base.scheduling, maxBatchesPerRun: 1 } }
    await initializeHost(spec, { clock })
    const host = await openHost(spec, { clock })
    try {
      for (const member of spec.members) host.pause(member.agentKey)
      const workflow = host.workflow('research')
      await workflow.resume({ requestKey: 'start' }); await host.run()
      await workflow.cancel({ requestKey: 'stop' })
      while (!workflow.report().settled) await host.run()
      expect(workflow.report().closed).toBe(false)
      const before = host.read().workflow('research')
      const input = { until: 'closed' as 'closed' | 'settled', timeoutMs: 1 }
      const pending = workflow.wait(input)
      input.until = 'settled'
      expect(await pending).toMatchObject({ status: 'timeout', report: { settled: true, closed: false } })
      expect(host.read().workflow('research')).toEqual(before)
    } finally { await host.shutdown({ mode: 'drain' }) }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
