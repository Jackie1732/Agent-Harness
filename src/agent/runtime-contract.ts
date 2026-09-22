import type { SubagentActionExecutor } from '../subagent/action-port.js'
import type { Scope } from '../extension/types.js'
import type { Clock } from '../foundation/clock.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionModelRunner } from '../model/runner.js'
import type { SessionToolRunner } from '../tool/runner.js'
import type { SessionContext } from '../context/session-context.js'
import type { SessionMailbox } from '../communication/mailbox.js'
import type { OutboxDispatcher } from '../communication/dispatcher.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import type { AgentJournal } from './journal.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommunicationService } from '../communication/service.js'
import type { CommunicationPolicy } from '../communication/types.js'
import type { agentExecutionEvents } from './session-events.js'

/** Runners/Context and a lazily attached Mailbox are owned; supplied Mailboxes, Service and Session remain borrowed. */
export interface SessionAgentOptions {
  readonly subagentActions?: SubagentActionExecutor
  readonly session: SessionHandle
  readonly model: SessionModelRunner
  readonly context: SessionContext
  readonly tools?: SessionToolRunner
  readonly mailbox?: SessionMailbox
  readonly dispatcher?: OutboxDispatcher
  /** Attach only after a Run owns the Session. Exclusive with supplied mailbox/dispatcher. */
  readonly communication?: { readonly service: CommunicationService; readonly policy: CommunicationPolicy }
  readonly messageCatalog: MessageCatalog
  readonly clock: Clock
  /** Admission requires the borrowed activation Scope to be published and accepting. */
  readonly scope?: Scope
  readonly signal?: AbortSignal
}
export interface AgentRuntime extends SessionAgentOptions {
  readonly events: ReturnType<typeof agentExecutionEvents>
  readonly journal: AgentJournal
  readonly management?: { remaining: number }
}
export interface AgentTurnControl {
  readonly root: SessionEventId
  readonly controller: AbortController
}
