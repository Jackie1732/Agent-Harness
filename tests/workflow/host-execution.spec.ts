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
