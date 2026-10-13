import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { FileSessionBackend, SessionRepository, hostRuntimeEventCatalog, initializeHost, openHost, parseSessionId } from '../../src/index.js'
import type { JsonObject, SessionSnapshot } from '../../src/index.js'
import { sessionLogPosition } from '../../src/session/ids.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { workflowAssignmentClosed } from '../../src/workflow/closure.js'
import { workflowReport } from '../../src/host/workflow-report.js'
import { workAssignmentSettledEvent } from '../../src/workflow/settlement-events.js'
import { workExecutionReleasedEvent } from '../../src/workflow/result-events.js'
import { modelPreparedEvent } from '../../src/model/session-events.js'
import { runnableWorkflowHost } from './host-fixture.js'

let coordinator: SessionSnapshot
let peers: readonly SessionSnapshot[]

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-closure-observations-'))
  const target = resolve(root)
  if (dirname(target) !== resolve(tmpdir())) throw new Error('fixture directory is outside the temporary root')
  try {
    const spec = runnableWorkflowHost(root)
    await initializeHost(spec)
    const host = await openHost(spec)
    try {
      await host.workflow('research').resume({ requestKey: 'close-observation-fixture' })
      await host.run()
      expect(host.workflow('research').report().closed).toBe(true)
    } finally { await host.shutdown({ mode: 'drain' }) }
    const reader = new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: spec.storage.maxRecordBytes }),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: spec.storage.maxLineageDepth })
    try {
      coordinator = await reader.read(parseSessionId('87000000-0000-4000-8000-000000000001'))
      peers = await Promise.all(spec.members.filter(member => member.kind === 'local').map(member => reader.read(parseSessionId(member.sessionId))))
    } finally { await reader.dispose() }
  } finally {
    await rm(target, { recursive: true, force: true })
  }
}, 15_000)

function prefix(snapshot: SessionSnapshot, through: number): SessionSnapshot {
  const local = snapshot.history.at(-1)!, position = sessionLogPosition(through)
  return { ...snapshot, localPosition: position, history: [...snapshot.history.slice(0, -1),
    { ...local, through: position, events: local.events.slice(0, through) }] }
}

function changePayload(snapshot: SessionSnapshot, type: string, change: (payload: JsonObject) => JsonObject): SessionSnapshot {
  const local = snapshot.history.at(-1)!, chosen = local.events.find(event => event.stored.type === type)!
  const events = local.events.map(event => {
    if (event.stored.eventId !== chosen.stored.eventId || event.kind !== 'known') return event
    const payload = change(event.payload as JsonObject)
    return { ...event, payload, stored: { ...event.stored, payload } }
  })
  return { ...snapshot, history: [...snapshot.history.slice(0, -1), { ...local, events }] }
}

function firstWork() {
  const assignment = projectWorkflowSession(coordinator).assignments[0]!
  const member = peers.find(peer => peer.header.address === assignment.payload.memberAddress)!
  return { assignment, member }
}

it('observes each completed assignment and the complete two-root report', () => {
  const state = projectWorkflowSession(coordinator)
  for (const assignment of state.assignments) {
    const member = peers.find(peer => peer.header.address === assignment.payload.memberAddress)!
    expect(workflowAssignmentClosed(coordinator, member, assignment.stored.eventId, peers)).toBe(true)
  }
  expect(workflowReport(coordinator, peers, false)).toMatchObject({ closed: true, state: 'completed',
    counts: { assignments: 2, accepted: 2, workRoots: 2, pendingInbox: 0, pendingOutbox: 0, pendingResources: 0 } })
})

it('reports incomplete evidence when one assigned member is absent', () => {
  expect(workflowReport(coordinator, peers.slice(1), false)).toMatchObject({ closed: false, counts: { assignments: 2, accepted: 2, workRoots: 1 } })
})

for (const type of [workAssignmentSettledEvent.type, workExecutionReleasedEvent.type]) it(`requires the individual assignment's ${type} fact`, () => {
  const { assignment, member } = firstWork()
  const event = member.history.at(-1)!.events.find(event => event.stored.type === type)!
  const earlier = prefix(member, event.stored.sequence - 1)
  expect(workflowAssignmentClosed(coordinator, earlier, assignment.stored.eventId, peers.map(peer => peer === member ? earlier : peer))).toBe(false)
  expect(workflowReport(coordinator, peers.map(peer => peer === member ? earlier : peer), false).closed).toBe(false)
})

it('rechecks the selected snapshot when the same address has an earlier cut', () => {
  const { member } = firstWork()
  const settled = member.history.at(-1)!.events.find(event => event.stored.type === workAssignmentSettledEvent.type)!
  const earlier = prefix(member, settled.stored.sequence - 1)
  const other = peers.filter(peer => peer !== member)
  expect(workflowReport(coordinator, [member, earlier, ...other], false).closed).toBe(false)
  expect(workflowReport(coordinator, [earlier, member, ...other], false).closed).toBe(false)
  expect(workflowReport(coordinator, peers, false).closed).toBe(true)
})

it('returns early for an absent settlement without validating unconsumed Model facts', () => {
  const { assignment, member } = firstWork()
  const settled = member.history.at(-1)!.events.find(event => event.stored.type === workAssignmentSettledEvent.type)!
  const malformed = changePayload(prefix(member, settled.stored.sequence - 1), modelPreparedEvent.type, payload => ({ ...payload,
    submission: { ...(payload.submission as JsonObject), fingerprint: '0'.repeat(64) } }))
  expect(workflowAssignmentClosed(coordinator, malformed, assignment.stored.eventId, peers)).toBe(false)
  const consumed = changePayload(member, modelPreparedEvent.type, payload => ({ ...payload,
    submission: { ...(payload.submission as JsonObject), fingerprint: '0'.repeat(64) } }))
  expect(() => workflowAssignmentClosed(coordinator, consumed, assignment.stored.eventId, peers)).toThrowError(expect.objectContaining({ code: 'MODEL_STATE_INVALID' }))
})

it('keeps per-peer communication checks behind the first pending obligation', () => {
  const { assignment, member } = firstWork()
  const settled = member.history.at(-1)!.events.find(event => event.stored.type === workAssignmentSettledEvent.type)!
  const pending = prefix(member, settled.stored.sequence)
  const other = peers.find(peer => peer !== member)!
  const malformed = changePayload(other, 'communication/outbox-accepted', payload => ({ ...payload,
    envelope: { ...(payload.envelope as JsonObject), channelSequence: 99 } }))
  expect(workflowAssignmentClosed(coordinator, pending, assignment.stored.eventId, [pending, malformed])).toBe(false)
  expect(() => workflowAssignmentClosed(coordinator, member, assignment.stored.eventId, [member, malformed]))
    .toThrowError(expect.objectContaining({ code: 'MESSAGE_STATE_INVALID' }))
})
