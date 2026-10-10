import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import { SessionRepository } from '../../src/session/repository.js'
import { childFixture } from '../subagent/child-fixture.js'
import { workFixture } from '../workflow/work-fixture.js'
import { createCommunicationService } from './fixtures.js'

async function retiredDelegationService() {
  const f = await childFixture(false)
  const c = createCommunicationService()
  const lease = await c.service.delegationChannels.restore(f.parent.session, f.cp)
  c.service.delegationChannels.bindChild(lease, f.session)
  const refs = { parent: new WeakRef(f.parent.session), child: new WeakRef(f.session), request: new WeakRef(f.cp) }
  try {
    const cuts = [f.parent.session.snapshot().localPosition, f.session.snapshot().localPosition]
    await c.service.dispose()
    expect([f.parent.session.snapshot().localPosition, f.session.snapshot().localPosition]).toEqual(cuts)
    expect(() => c.service.delegationChannels.revoke(lease)).toThrowError(expect.objectContaining({
      code: 'MESSAGE_SEND_FORBIDDEN', message: 'channel-lease-inactive',
    }))
    expect(() => c.service.protocolCapacity.check(new Map(), new Map())).toThrowError(expect.objectContaining({
      code: 'MESSAGE_SEND_FORBIDDEN', message: 'channel-admission-closed',
    }))
  } finally {
    await c.service.dispose()
    await c.transport.dispose()
    await c.directory.dispose()
    await f.close()
  }
  return { service: c.service, lease, refs }
}

async function retiredWorkflowService() {
  const f = await workFixture()
  try {
    await f.assign()
    const assignment = f.coordinator.snapshot().history.at(-1)!.events.find(item => item.stored.type === 'workflow/assignment-committed')!
    const refs = { coordinator: new WeakRef(f.coordinator), member: new WeakRef(f.session), assignment: new WeakRef(assignment) }
    const cuts = [f.coordinator.snapshot().localPosition, f.session.snapshot().localPosition]
    await f.service.dispose()
    expect([f.coordinator.snapshot().localPosition, f.session.snapshot().localPosition]).toEqual(cuts)
    expect(() => f.service.workflowChannels.bind(f.coordinator, assignment.stored.eventId, f.session)).toThrowError(expect.objectContaining({
      code: 'MESSAGE_SEND_FORBIDDEN', message: 'workflow-channel-retired',
    }))
    return { service: f.service, refs }
  } finally { await f.close() }
}

async function collect(): Promise<void> {
  await setImmediate()
  queryObjects(SessionRepository, { format: 'count' })
}

it('retires closed delegation bindings and quota captures while the Service and old lease remain observable', async () => {
  const { service, lease, refs } = await retiredDelegationService()
  await collect()
  expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined]))).toEqual({ parent: false, child: false, request: false })
  expect(Object.isFrozen(lease)).toBe(true)
  expect(service.dispose()).toBe(service.dispose())
})

it('retires closed Workflow bindings and quota captures without ending durable assignments', async () => {
  const { service, refs } = await retiredWorkflowService()
  await collect()
  expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined]))).toEqual({ coordinator: false, member: false, assignment: false })
  expect(service.dispose()).toBe(service.dispose())
})
