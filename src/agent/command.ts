import type { MessageSendCommand } from '../communication/send-command.js'
import type { AgentSendCommand, AgentSpec } from './contract.js'
import { AgentError } from './errors.js'
import { agentJson } from './validation.js'
import type { MessageEnvelope } from '../communication/types.js'

/** Deterministic native routing. The full raw command is the idempotency identity. */
export function resolveAgentSend(spec: AgentSpec, command: AgentSendCommand, trigger?: MessageEnvelope): MessageSendCommand {
  if (!spec.messages.some(item => item.type === command.type && item.payloadVersion === command.payloadVersion)) throw new AgentError('AGENT_INPUT_INVALID', 'message-kind-not-allowed')
  const content = { type: command.type, payloadVersion: command.payloadVersion, payload: agentJson(JSON.parse(command.payloadJson)) }
  if (command.kind === 'reply') return { kind: 'reply', inboxMessageId: command.messageId, ...content }
  const peer = spec.peers.find(peer => peer.key === command.peerKey)
  if (peer === undefined) throw new AgentError('AGENT_INPUT_INVALID', 'peer-not-configured')
  return { kind: 'send', request: trigger === undefined ? { kind: 'root', recipient: peer.address, channelId: peer.channelId }
    : { kind: 'derived', recipient: peer.address, channelId: peer.channelId, correlationId: trigger.correlationId, causationId: trigger.messageId }, ...content }
}
