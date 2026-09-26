import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { parseSessionId } from '../../src/session/ids.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { runnableWorkflowHost } from './host-fixture.js'
import { assembleHost } from '../../src/host/assembly.js'
import { systemClock } from '../../src/foundation/clock.js'

it('runs a paused-by-default DAG through independent roots and accepted output copies using the Host scheduler', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-workflow-execution-'))
  try {
    const spec = runnableWorkflowHost(root)
    await initializeHost(spec)
    const host = await openHost(spec)
    try {
      const workflow = host.workflow('research')
      expect(workflow.report()).toMatchObject({ state: 'paused', counts: { assignments: 0 } })
      await host.run()
      expect(workflow.report().counts.assignments).toBe(0)
      const resume = await workflow.resume({ requestKey: 'start' })
      expect(await workflow.resume({ requestKey: 'start' })).toEqual(resume)
      await host.run()
      expect(workflow.report()).toMatchObject({ state: 'completed', closed: true, counts: { assignments: 2, proposals: 2, accepted: 2, pendingInbox: 0, pendingOutbox: 0 } })
      expect(host.report().members.every(member => member.agent.roots.length === 1 && member.agent.roots[0]!.outcome === 'completed')).toBe(true)
      expect(await workflow.cancel({ requestKey: 'after-completion' })).toMatchObject({ status: 'no-op' })
      expect(workflow.report()).toMatchObject({ state: 'completed', closed: true, counts: { accepted: 2 } })
    } finally { await host.shutdown() }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    let artifact
    try {
      const snapshot = await repository.read(parseSessionId('87000000-0000-4000-8000-000000000001'))
      const state = projectWorkflowSession(snapshot)
      expect(state.assignments[1]?.payload.inputs).toEqual({ text: 'accepted upstream' })
      expect(state.assignments[1]?.payload.sourceAccepted).toEqual([{ address: snapshot.header.address, eventId: state.decisions[0]!.stored.eventId }])
      artifact = state.proposals[1]!.payload.message.artifacts[0]!
    } finally { await repository.dispose() }
    const reopened = await openHost(spec)
    try {
      expect(reopened.workflow('research').readArtifact(artifact.ref).value.text).toBe('final report')
      await reopened.run()
      expect(reopened.workflow('research').report().counts.assignments).toBe(2)
    } finally { await reopened.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

it('rechecks pause before executing an already selected admission and does not reactivate an obsolete resume key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-pause-admission-'))
  try {
    const spec = runnableWorkflowHost(root)
    await initializeHost(spec)
    const assembly = await assembleHost(spec, systemClock, {}, {})
    try {
      const domain = assembly.workflows!
      await domain.control('research', 'resume', { requestKey: 'first' })
      const selected = domain.nextAction()!
      expect(selected).toBeTypeOf('function')
      await domain.control('research', 'pause', { requestKey: 'pause' })
      await selected()
      expect(domain.report('research').counts.assignments).toBe(0)
      expect(assembly.slots.every(slot => slot.agent.status === 'accepting')).toBe(true)
      await domain.control('research', 'resume', { requestKey: 'first' })
      expect(domain.nextAction()).toBeUndefined()
      await domain.control('research', 'resume', { requestKey: 'new' })
      await domain.nextAction()!()
      expect(domain.report('research').counts.assignments).toBe(1)
    } finally { await assembly.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('settles invalid output as failed delivery without rewriting the completed model root or starting its dependent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-workflow-invalid-'))
  try {
    const spec = runnableWorkflowHost(root, '```json\n{"text":"fenced"}\n```')
    await initializeHost(spec)
    const host = await openHost(spec)
    try {
      await host.workflow('research').resume({ requestKey: 'invalid-output' })
      await host.run()
      expect(host.workflow('research').report()).toMatchObject({ state: 'failed', closed: true,
        counts: { assignments: 1, proposals: 1, accepted: 0, failed: 1, pendingInbox: 0, pendingOutbox: 0 } })
      expect(host.report().members.find(member => member.agentKey === 'writer')?.agent.roots[0]?.outcome).toBe('completed')
      expect(host.report().members.find(member => member.agentKey === 'reviewer')?.agent.roots).toEqual([])
    } finally { await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
