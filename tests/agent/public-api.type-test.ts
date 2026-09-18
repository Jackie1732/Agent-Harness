import { SessionAgent, installAgentSpec, recoverAgentSession, SessionAgentKey, createSessionAgentComponent } from '../../src/index.js'
import type { AgentSpec, SessionAgentOptions, SessionHandle, MessageId, SessionEventId, Clock } from '../../src/index.js'

function publicTypes(options: SessionAgentOptions, spec: AgentSpec, session: SessionHandle, clock: Clock, eventId: SessionEventId, messageId: MessageId) {
  const agent = new SessionAgent(options)
  void installAgentSpec(session, spec, clock)
  void agent.submitInput({ kind: 'task', text: 'task', originLabel: 'test' })
  void agent.cancel(eventId)
  void recoverAgentSession(session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 10, maxJournalConflicts: 4, clock })
  void createSessionAgentComponent({ label: 'agent', requires: [], key: SessionAgentKey, create: () => agent })
  // @ts-expect-error Message identities cannot target root control.
  void agent.cancel(messageId)
  // @ts-expect-error Arbitrary text is not a committed Event identity.
  void agent.cancel('made-up-root')
  // @ts-expect-error Runtime journals are not public Agent authority.
  agent.journal.append()
  // @ts-expect-error User inputs cannot choose an instruction role.
  void agent.submitInput({ kind: 'task', text: 'task', originLabel: 'test', role: 'system' })
}
void publicTypes
