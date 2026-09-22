import { AgentJournal } from '../../src/agent/journal.js'
import { installAgentSpec, SessionAgent } from '../../src/agent/session-agent.js'
import { SessionContext } from '../../src/context/session-context.js'
import { createHostModelProvider } from '../../src/host/model-factory.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { createMessageCatalog } from '../../src/communication/message-catalog.js'
import { systemCommunicationIdentitySource, channelSequence } from '../../src/communication/ids.js'
import { messageEnvelopeDigest } from '../../src/communication/canonical-json.js'
import { inboxAcceptedEvent } from '../../src/communication/session-events.js'
import type { MessageEnvelope } from '../../src/communication/types.js'
import { subagentMessageDefinitions } from '../../src/subagent/messages.js'
import * as events from '../../src/subagent/session-events.js'
import { clock, observedAt } from '../agent/fixtures.js'
import { delegationFixture } from './fixtures.js'

export async function childFixture(acceptTask = true) {
  const parent = await delegationFixture()
  const cp = await parent.journal.append(events.delegationRequestedEvent, () => parent.requested)
  const session = await parent.repo.create({ sessionId: parent.requested.childSessionId })
  const journal = new AgentJournal(session, 4, clock)
  const id = { delegation: cp.stored.eventId, parentAddress: parent.session.header.address, childAddress: session.header.address }
  const bound = await journal.append(events.childBoundEvent, () => ({ ...id, requested: parent.requested }))
  const messageCatalog = createMessageCatalog(subagentMessageDefinitions)
  const context = new SessionContext({ session, messageCatalog })
  const profile = await context.recordProfile(parent.template.profile)
  const spec = await installAgentSpec(session, { ...parent.template.spec, profileEventId: profile.stored.eventId,
    budget: parent.requested.grant, subagents: { role: 'child', bound: bound.stored.eventId, deadline: parent.requested.deadline,
      protocolReserve: parent.requested.childProtocolReserve, maxQuestions: 2, maxProgress: 1, maxFileEntries: 8 } }, clock)
  await journal.append(events.childReadyEvent, (_, snapshot) => ({ ...id, bound: bound.stored.eventId,
    profile: profile.stored.eventId, spec: spec.stored.eventId, through: snapshot.localPosition }))
  const opened = await journal.append(events.subagentResourceOpenedEvent, () => ({ ...id, generation: 1, component: 'execution' as const,
    predecessor: null, recovery: null, workspaceGrant: { kind: 'none' as const } }))
  const provider = createHostModelProvider(parent.template.model, {})
  const model = new SessionModelRunner({ session, provider, limits: parent.template.model.runnerLimits })
  const agent = new SessionAgent({ session, context, model, messageCatalog, clock })
  const messageId = systemCommunicationIdentitySource.nextMessageId()
  const envelope: MessageEnvelope = { envelopeVersion: 1, messageId, correlationId: messageId, sender: id.parentAddress,
    recipient: id.childAddress, channelId: parent.requested.channelId, channelSequence: channelSequence(1), createdAt: observedAt,
    type: 'subagent/task', payloadVersion: 1, payload: { delegation: id.delegation, parentRoot: parent.requested.parentRoot,
      childSessionId: parent.requested.childSessionId, task: parent.requested.request.task, materials: [], grant: parent.requested.grant,
      workspace: { kind: 'none' }, deadline: parent.requested.deadline } }
  const inbox = acceptTask ? await session.append(inboxAcceptedEvent, { envelope, digest: messageEnvelopeDigest(envelope) }) : null
  return { parent, cp, session, journal, id, opened, agent, inbox, envelope,
    close: async () => { await agent.dispose(); await provider.dispose(); await parent.close() } }
}
