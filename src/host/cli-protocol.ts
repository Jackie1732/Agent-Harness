import type { JsonValue } from '../foundation/json.js'
import { parseSessionEventId } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import type { AtomicHost } from './runtime.js'
import { HostError } from './errors.js'

function object(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-command-object')
  return value as Record<string, JsonValue>
}

function exact(input: Record<string, JsonValue>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new HostError('HOST_PROTOCOL_INVALID', 'cli-command-fields')
  }
}

function text(input: JsonValue | undefined, label: string, maximum = 65536): string {
  if (typeof input !== 'string' || input.length === 0 || Buffer.byteLength(input) > maximum) throw new HostError('HOST_PROTOCOL_INVALID', label)
  return input
}

function eventId(input: JsonValue | undefined, label: string): SessionEventId {
  const value = text(input, label)
  parseSessionEventId(value)
  return value as SessionEventId
}

interface CliCommandEnvelope {
  readonly input: Record<string, JsonValue>
  readonly requestId: string
  readonly kind: string
}

export function commandEnvelope(value: unknown): CliCommandEnvelope {
  const input = object(value)
  if (input.protocolVersion !== 1) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-protocol-version')
  return { input, requestId: text(input.requestId, 'cli-request-id', 128), kind: text(input.kind, 'cli-command-kind', 64) }
}

export async function executeCommand(host: AtomicHost, value: unknown): Promise<unknown> {
  const { input, requestId, kind } = commandEnvelope(value)
  const response = (value: Record<string, unknown>) => ({ protocolVersion: 1, requestId, ...value })
  switch (kind) {
    case 'task': {
      exact(input, ['protocolVersion', 'requestId', 'kind', 'agentKey', 'text'])
      const receipt = await host.submitTask(text(input.agentKey, 'cli-agent-key', 128), text(input.text, 'cli-task-text'),
        `cli:${requestId}`)
      return response({ kind: 'accepted', command: 'task', ...receipt })
    }
    case 'answer': {
      exact(input, ['protocolVersion', 'requestId', 'kind', 'agentKey', 'wait', 'text'])
      const wait = object(input.wait)
      exact(wait, ['eventId', 'index'])
      const waitEventId = eventId(wait.eventId, 'cli-wait-event')
      if (!Number.isSafeInteger(wait.index) || (wait.index as number) < 0) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-wait-index')
      const receipt = await host.submitAnswer(text(input.agentKey, 'cli-agent-key', 128), { eventId: waitEventId, index: wait.index as number },
        text(input.text, 'cli-answer-text'), `cli:${requestId}`)
      return response({ kind: 'accepted', command: 'answer', ...receipt })
    }
    case 'pause':
    case 'resume': {
      exact(input, ['protocolVersion', 'requestId', 'kind', 'agentKey'])
      const agentKey = text(input.agentKey, 'cli-agent-key', 128)
      if (kind === 'pause') host.pause(agentKey); else host.resume(agentKey)
      return response({ kind: 'control', command: kind, agentKey })
    }
    case 'cancel': {
      exact(input, ['protocolVersion', 'requestId', 'kind', 'agentKey', 'rootTurnId'], ['reason'])
      const agentKey = text(input.agentKey, 'cli-agent-key', 128)
      await host.cancel(agentKey, eventId(input.rootTurnId, 'cli-root-event'),
        input.reason === undefined ? 'cli-cancelled' : text(input.reason, 'cli-cancel-reason', 128))
      return response({ kind: 'control', command: 'cancel', agentKey })
    }
    case 'report':
      exact(input, ['protocolVersion', 'requestId', 'kind'])
      return response({ kind: 'report', report: host.report() })
    case 'shutdown': {
      exact(input, ['protocolVersion', 'requestId', 'kind', 'mode'])
      if (input.mode !== 'drain' && input.mode !== 'cancel') throw new HostError('HOST_PROTOCOL_INVALID', 'cli-shutdown-mode')
      await host.shutdown({ mode: input.mode })
      return response({ kind: 'control', command: 'shutdown', mode: input.mode })
    }
    default:
      throw new HostError('HOST_PROTOCOL_INVALID', 'cli-command-kind')
  }
}
