import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { runnableWorkflowHost } from './host-fixture.js'
import { SessionRepository } from '../../src/session/repository.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { parseSessionId } from '../../src/session/ids.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { recoverWorkPrefix } from './prefix-fixture.js'
import { assembleHost } from '../../src/host/assembly.js'
import { systemClock } from '../../src/foundation/clock.js'
import { resolveDirectoryReceiver } from '../../src/communication/directory.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'

it.each(['before-assignment', 'before-send', 'before-root', 'deadline', 'assignment-deadline'] as const)('closes %s without starting a model or consuming an unrelated user input', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-unexecuted-stop-'))
  try {
    const base = runnableWorkflowHost(root)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
    const spec = { ...base, scheduling: { ...base.scheduling, maxBatchesPerRun: scenario === 'before-send' ? 1 : 200 } }
    let tick = Date.now()
    await initializeHost(spec)
    const host = await openHost(spec, { clock: { now: () => tick } })
    try {
      for (const member of spec.members) host.pause(member.agentKey)
      await host.submitTask('writer', 'Keep my independent task queued.')
      const workflow = host.workflow('research')
      if (scenario !== 'before-assignment') {
        await workflow.resume({ requestKey: 'start' }); await host.run()
        expect(workflow.report().counts.assignments).toBe(1)
      }
      if (scenario === 'deadline' || scenario === 'assignment-deadline') {
        await workflow.pause({ requestKey: 'pause' })
        tick = scenario === 'deadline' ? Date.parse(base.workflows.definitions[0]!.definition.deadline) : tick + base.workflows.definitions[0]!.definition.nodes[0]!.attempts[0]!.durationMs + 1
      }
      else {
        const cancelled = await workflow.cancel({ requestKey: 'cancel' })
        expect(await workflow.cancel({ requestKey: 'cancel' })).toEqual(cancelled)
      }
      let closingObserved = false
      for (let batch = 0; batch < 100 && !workflow.report().closed; batch++) {
        await host.run()
        if (workflow.report().settled && !workflow.report().closed) {
          closingObserved = true
          expect(await workflow.wait({ until: 'settled', timeoutMs: 100 })).toMatchObject({ status: 'condition-met', report: { closed: false } })
        }
      }
      if (scenario === 'before-send') expect(closingObserved).toBe(true)
      expect(workflow.report()).toMatchObject({ state: scenario.includes('deadline') ? 'failed' : 'cancelled', closed: true,
        counts: { pendingInbox: 0, pendingOutbox: 0, pendingStops: 0, pendingControls: 0 } })
      expect(await workflow.resume({ requestKey: 'too-late' })).toMatchObject({ status: 'no-op' })
      const writer = host.report().members.find(member => member.agentKey === 'writer')!
      expect(writer.agent.roots).toHaveLength(0)
      expect(await workflow.wait({ until: 'closed', timeoutMs: 100 })).toMatchObject({ status: 'condition-met', report: { closed: true } })
    } finally { await host.shutdown() }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const writer = await repository.open(parseSessionId(spec.members[0]!.sessionId)), snapshot = writer.snapshot(), state = projectAgentSession(snapshot)
      expect(state.inputs.find(input => input.input?.originLabel === 'host-user')?.status).toBe('queued')
      expect(state.inputs.filter(input => input.work !== undefined).every(input => input.status === 'not-adopted')).toBe(true)
      const stop = snapshot.history.at(-1)!.events.find(item => item.stored.type === 'work/stop-received')
      if (stop !== undefined) {
        const prefix = await recoverWorkPrefix(snapshot, stop.stored.sequence, spec.storage.maxRecordBytes)
        expect(prefix.state.roots).toHaveLength(0)
        expect(prefix.added.some(item => item.stored.type === 'communication/outbox-accepted')).toBe(false)
      }
      const coordinator = await repository.open(parseSessionId(base.workflows.definitions[0]!.sessionId))
      expect(projectWorkflowSession(coordinator.snapshot()).terminal?.payload.outcome).toBe(scenario.includes('deadline') ? 'failed' : 'cancelled')
    } finally { await repository.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

it('notifies an executing model before joining durable cancellation and releases only its assignment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-active-stop-'))
  try {
    const spec = runnableWorkflowHost(root)
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    let stopped = false, released = false
    await initializeHost(spec)
    const host = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (_submission, signal) {
        expect(() => host.workflow('research').wait({ until: 'closed', timeoutMs: 10 })).toThrow('workflow-cannot-wait-on-own-driver')
        started()
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        stopped = true
        yield { kind: 'message-start' as const, responseId: 'cancelled', reportedModel: member.spec.target.model }
      }, onClose: () => { released = true } }) } })
    try {
      await host.workflow('research').resume({ requestKey: 'start' })
      const drive = host.run()
      await running
      await expect(host.workflow('research').cancel({ requestKey: 'start' })).rejects.toThrow('workflow-request-key-conflict')
      expect(stopped).toBe(false)
      await host.workflow('research').cancel({ requestKey: 'stop-active' })
      await drive
      expect(stopped).toBe(true); expect(released).toBe(true)
      expect(host.workflow('research').report()).toMatchObject({ state: 'cancelled', closed: true, counts: { assignments: 1, accepted: 0 } })
      expect(host.report().members.find(member => member.agentKey === 'reviewer')!.agent.roots).toHaveLength(0)
    } finally { await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

it('bounds observers and wakes them on shutdown without advancing or cancelling work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-observers-'))
  try {
    const spec = runnableWorkflowHost(root)
    await initializeHost(spec)
    const host = await openHost(spec)
    const workflow = host.workflow('research')
    try {
      expect(await workflow.wait({ until: 'closed', timeoutMs: 5 })).toMatchObject({ status: 'timeout' })
      const controller = new AbortController()
      const cancelled = workflow.wait({ until: 'settled', timeoutMs: 10000, signal: controller.signal })
      const rejection = expect(cancelled).rejects.toThrow('observer-only')
      controller.abort(new Error('observer-only')); await rejection
      expect(workflow.report()).toMatchObject({ state: 'paused', counts: { assignments: 0 } })
      const pending = workflow.wait({ until: 'closed', timeoutMs: 10000 })
      const shutdown = expect(pending).resolves.toMatchObject({ status: 'host-closed' })
      await host.shutdown(); await shutdown
      expect(host.status).toBe('stopped')
    } finally { await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 15000)

it('classifies an in-flight task arriving after its authorized stop without creating a root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-late-task-'))
  try {
    const spec = runnableWorkflowHost(root)
    await initializeHost(spec)
    const assembly = await assembleHost(spec, systemClock, {}, {})
    try {
      const domain = assembly.workflows!, coordinator = assembly.protocolSlots.find(slot => slot.member.agentKey === 'workflow:research')!
      await domain.controls.request('research', 'resume', { requestKey: 'start' })
      for (let step = 0; step < 10 && !coordinator.mailbox.snapshot().outbox.some(item => item.envelope.type === 'workflow/assignment'); step++) await domain.nextAction()!()
      const task = coordinator.mailbox.snapshot().outbox.find(item => item.envelope.type === 'workflow/assignment')!
      expect(task.status).toBe('pending')
      await domain.controls.request('research', 'cancel', { requestKey: 'stop-before-receipt' })
      for (let step = 0; step < 15 && !coordinator.mailbox.snapshot().outbox.some(item => item.envelope.type === 'workflow/stop'); step++) await domain.nextAction()!()
      const cancel = coordinator.mailbox.snapshot().outbox.find(item => item.envelope.type === 'workflow/stop')!
      await coordinator.dispatcher.dispatch({ onlyMessageIds: new Set([cancel.messageId]) })
      const member = assembly.slots.find(slot => slot.session.header.address === task.envelope.recipient)!
      for (let step = 0; step < 10 && !member.session.snapshot().history.at(-1)!.events.some(item => item.stored.type === 'work/stop-received'); step++) await domain.nextAction()!()
      const receiver = resolveDirectoryReceiver(assembly.directory, task.envelope.recipient).receiver!
      expect((await receiver.acceptDelivery(task.envelope, task.envelope.sender, new AbortController().signal)).kind).toBe('accepted')
      for (let step = 0; step < 10 && !member.session.snapshot().history.at(-1)!.events.some(item => item.stored.type === 'work/assignment-rejected'); step++) await domain.nextAction()!()
      expect(projectAgentSession(member.session.snapshot()).roots).toHaveLength(0)
      expect(projectAgentSession(member.session.snapshot()).inputs.filter(input => input.work !== undefined)).toHaveLength(0)
      expect(member.session.snapshot().history.at(-1)!.events.some(item => item.stored.type === 'work/assignment-rejected')).toBe(true)
    } finally { await assembly.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 15000)

it.each(['guard-false', 'guard-value'])('fails and closes a required node resolved as %s without dispatching it', async reason => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-required-guard-'))
  try {
    const base = runnableWorkflowHost(root)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
    const entry = base.workflows.definitions[0]!
    const definition = decodeWorkflowDefinition({ ...entry.definition, nodes: entry.definition.nodes.map((node, index) => index === 0 ? node : {
      ...node, guard: { kind: 'equals', nodeKey: 'read', path: [reason === 'guard-false' ? 'text' : 'missing'], value: 'different' },
    }) })
    const spec = { ...base, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    await initializeHost(spec)
    const host = await openHost(spec)
    try {
      await host.workflow('research').resume({ requestKey: 'guard' }); await host.run()
      expect(host.workflow('research').report()).toMatchObject({ state: 'failed', closed: true, counts: { assignments: 1, accepted: 1 } })
    } finally { await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 20000)
