import type { CommunicationPolicy, IncomingMessagePolicyInput, OutgoingMessagePolicyInput } from '../communication/types.js'
import type { ResolvedHostLocalMember } from './config.js'

function allowed(member: ResolvedHostLocalMember, input: OutgoingMessagePolicyInput): boolean {
  return member.spec.peers.some(peer => peer.address === input.recipient && peer.channelId === input.channelId)
    && member.spec.messages.some(message => message.type === input.type && message.payloadVersion === input.payloadVersion)
}

/** Derive both Mailbox ACL directions from the exact peer and message facts installed in AgentSpec. */
export function createHostCommunicationPolicy(member: ResolvedHostLocalMember): CommunicationPolicy {
  return Object.freeze({
    canSend(input: OutgoingMessagePolicyInput) {
      return allowed(member, input)
        ? Object.freeze({ kind: 'allow' as const })
        : Object.freeze({ kind: 'deny' as const, reasonCode: 'host-spec-send-denied' })
    },
    canReceive(input: IncomingMessagePolicyInput) {
      const authorized = input.sender === input.authenticatedSender
        && member.spec.peers.some(peer => peer.address === input.sender && peer.channelId === input.channelId)
        && member.spec.messages.some(message => message.type === input.type && message.payloadVersion === input.payloadVersion)
      return authorized
        ? Object.freeze({ kind: 'allow' as const })
        : Object.freeze({ kind: 'deny' as const, reasonCode: 'host-spec-receive-denied' })
    },
  })
}
