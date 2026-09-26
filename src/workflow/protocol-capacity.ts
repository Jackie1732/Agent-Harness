import type { SessionAddress } from '../session/ids.js'
import type { WorkflowDefinition } from './types.js'

export interface WorkflowMailboxDemand {
  readonly inbox: number
  readonly outbox: number
}

export interface WorkflowProtocolDemand {
  readonly messages: number
  readonly mailboxes: ReadonlyMap<SessionAddress, WorkflowMailboxDemand>
}

/** Upper bound for unique protocol envelopes across all fixed attempt templates. */
export function workflowProtocolDemand(definition: WorkflowDefinition): WorkflowProtocolDemand {
  const mailboxes = new Map<SessionAddress, WorkflowMailboxDemand>()
  const add = (address: SessionAddress, inbox: number, outbox: number): void => {
    const previous = mailboxes.get(address) ?? { inbox: 0, outbox: 0 }
    mailboxes.set(address, { inbox: previous.inbox + inbox, outbox: previous.outbox + outbox })
  }
  const { maxQuestions: questions, maxIncomingQuestions: incomingQuestions, maxGroups: groups,
    maxGroupRecipients: recipients, maxIncomingGroupMessages: incomingGroups, maxProgress: progress } = definition.limits
  const addresses = new Map(definition.roster.map(member => [member.memberKey, member.address]))
  for (const node of definition.nodes) for (const attempt of node.attempts) {
    const assignments = [{ memberKey: node.executor, kind: 'production' as const },
      ...attempt.reviewerGrants.map(grant => ({ memberKey: grant.memberKey, kind: 'review' as const }))]
    for (const assignment of assignments) {
      const production = assignment.kind === 'production'
      const outbound = 3 + (production ? questions + incomingQuestions + groups * recipients + progress : 0)
      const inbound = 3 + (production ? questions + incomingQuestions + incomingGroups : 0)
      add(addresses.get(assignment.memberKey)!, inbound, outbound)
      add(definition.coordinator, 3 + (production ? progress : 0), 3)
    }
  }
  return { messages: [...mailboxes.values()].reduce((sum, item) => sum + item.outbox, 0), mailboxes }
}
