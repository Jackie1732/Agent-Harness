import type { SessionSnapshot } from '../../src/session/types.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { seedWorkPrefix } from './prefix-fixture.js'
import { workGroupRequestedEvent, workGroupResultEvent, workflowGroupMessage } from '../../src/workflow/group-events.js'
import { workflowInteractionAdmittedEvent } from '../../src/workflow/interaction-events.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { projectCommunicationFacts } from '../../src/communication/projection.js'
import { createSessionDirectory } from '../../src/communication/directory.js'
import { createInProcessMessageTransport } from '../../src/communication/transport.js'
import { CommunicationService } from '../../src/communication/service.js'
import { createMessageCatalog } from '../../src/communication/message-catalog.js'
import { workflowMessageDefinitions } from '../../src/workflow/messages.js'
import { nextWorkGroupAction } from '../../src/workflow/group-maintenance.js'
import { WorkflowAdmission } from '../../src/workflow/admission.js'
import { AgentJournal } from '../../src/agent/journal.js'
import { agentControlRequestedEvent } from '../../src/agent/session-events.js'
import { nextWorkInputDisposition } from '../../src/workflow/input-disposition.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { recoverAgentSession } from '../../src/agent/recovery.js'

/** Replay a real cut through actual local mailboxes; only receipt loss replaces a transport outcome. */
export async function groupDeliveryBranch(coordinatorSource: SessionSnapshot, members: readonly SessionSnapshot[], maxRecordBytes: number,
  mode: 'offline' | 'lost-receipt' | 'deadline' | 'pre-send-timeout' | 'cancel-after-result') {
  const backend = new MemorySessionBackend({ maxRecordBytes })
  const coordinatorEvents = coordinatorSource.history.at(-1)!.events
  const admitted = coordinatorEvents.find(event => event.stored.type === workflowInteractionAdmittedEvent.type)!
  await seedWorkPrefix(backend, coordinatorSource, admitted.stored.sequence)
  for (const [index, snapshot] of members.entries()) {
    const events = snapshot.history.at(-1)!.events
    const firstGroup = index === 0 ? projectCommunicationFacts(snapshot).outbox.find(item => item.envelope.type === workflowGroupMessage.type)!.acceptedEventId
      : projectCommunicationFacts(snapshot).inbox.find(item => item.envelope.type === workflowGroupMessage.type)!.acceptedEventId
    await seedWorkPrefix(backend, snapshot, events.find(event => event.stored.eventId === firstGroup)!.stored.sequence - 1)
  }
  const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
  const directory = createSessionDirectory(), direct = createInProcessMessageTransport(directory)
  const requestEvent = members[0]!.history.at(-1)!.events.find(event => event.stored.type === workGroupRequestedEvent.type)!
  const request = workGroupRequestedEvent.decode(requestEvent.stored.payload)
  let tick = Date.parse(request.observedAt)
  const clock = { now: () => tick }
  const limits = { maxMessageBytes: 128 * 1024, maxPendingInbox: 64, maxPendingOutbox: 64,
    maxDeliveryAttempts: mode === 'deadline' ? 3 : 1, maxAttemptsPerRun: 3, maxSendJournalConflicts: 4 }
  const service = new CommunicationService({ directory, clock, limits, transport: { dispose: () => direct.dispose(), deliver: async (envelope, options) => {
    const result = await direct.deliver(envelope, options)
    return mode === 'lost-receipt' && envelope.type === workflowGroupMessage.type && workflowGroupMessage.decode(envelope.payload).index === 2 && result.kind === 'accepted'
      ? { kind: 'retry', code: 'transport-outcome-unknown' } : result
  } } })
  const denied = new CommunicationService({ directory, clock, limits, transport: createInProcessMessageTransport(directory) })
  try {
    const coordinator = await repository.open(coordinatorSource.header.sessionId)
    const handles = await Promise.all(members.map(snapshot => repository.open(snapshot.header.sessionId)))
    const catalog = createMessageCatalog(workflowMessageDefinitions), policy = { canSend: () => ({ kind: 'allow' as const }), canReceive: () => ({ kind: 'allow' as const }) }
    const mailbox = await service.attach(handles[0]!, { catalog, policy })
    await service.attach(handles[1]!, { catalog, policy })
    await denied.attach(handles[2]!, { catalog, policy })
    if (mode !== 'lost-receipt') await directory.declare(handles[3]!.header.address, 'active')
    else await service.attach(handles[3]!, { catalog, policy })
    const admission = new WorkflowAdmission(coordinator, service.protocolCapacity, clock)
    for (const work of projectWorkflowSession(coordinator.snapshot()).assignments) {
      const member = handles.find(handle => handle.header.address === work.payload.memberAddress)!
      await admission.restore({ kind: 'known', ...work, payload: work.payload as typeof work.payload & import('../../src/foundation/json.js').JsonObject }, member)
      service.workflowChannels.bind(coordinator, work.stored.eventId, member)
    }
    if (mode === 'pre-send-timeout') tick += 60001
    else {
      for (let index = 0; index < 3; index++) await nextWorkGroupAction(handles[0]!, mailbox, clock)!()
      const dispatcher = service.createDispatcher(mailbox)
      await dispatcher.dispatch()
      if (mode === 'deadline') { tick += 60001; await nextWorkGroupAction(handles[0]!, mailbox, clock)!() }
      else await dispatcher.dispatch()
    }
    await nextWorkGroupAction(handles[0]!, mailbox, clock)!()
    if (mode === 'cancel-after-result') {
      await new AgentJournal(handles[0]!, 4, clock).append(agentControlRequestedEvent, () => ({ kind: 'cancel-work' as const,
        root: request.root, reason: 'operator-cancel' }))
      await nextWorkInputDisposition(handles[0]!, clock)!()
      await recoverAgentSession(handles[0]!, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 16, maxJournalConflicts: 4, clock })
    }
    const events = handles[0]!.snapshot().history.at(-1)!.events
    const result = workGroupResultEvent.decode(events.find(event => event.stored.type === workGroupResultEvent.type)!.stored.payload)
    return { result, received: handles.slice(1).map(handle => projectCommunicationFacts(handle.snapshot()).inbox.filter(item => item.envelope.type === workflowGroupMessage.type).length),
      outbox: mailbox.snapshot().outbox.filter(item => item.envelope.type === workflowGroupMessage.type),
      sender: handles[0]!.snapshot(), agent: projectAgentSession(handles[0]!.snapshot()) }
  } finally { await denied.dispose(); await service.dispose(); await directory.dispose(); await repository.dispose() }
}
