import { workflowReference } from '../workflow/work-binding.js'
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

function workReference(input: unknown) {
  try { return workflowReference(input) }
  catch (cause) { throw new HostError('HOST_PROTOCOL_INVALID', 'cli-workflow-reference', {}, { cause }) }
}

interface CliCommandEnvelope {
  readonly input: Record<string, JsonValue>
  readonly requestId: string
  readonly kind: string
}

export function commandEnvelope(value: unknown, protocolVersion: 1 | 2 | 3 = 1): CliCommandEnvelope {
  const input = object(value)
  if (input.protocolVersion !== protocolVersion) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-protocol-version')
  return { input, requestId: text(input.requestId, 'cli-request-id', 128), kind: text(input.kind, 'cli-command-kind', 64) }
}

export async function executeCommand(host: AtomicHost, value: unknown, protocolVersion: 1 | 2 | 3 = 1): Promise<unknown> {
  const { input, requestId, kind } = commandEnvelope(value, protocolVersion)
  const response = (value: Record<string, unknown>) => ({ protocolVersion, requestId, ...value })
  switch (kind) {
    case 'workflow-pause':
    case 'workflow-resume':
    case 'workflow-cancel':
    case 'workflow-retry':
    case 'workflow-report':
    case 'workflow-artifact': {
      if (protocolVersion !== 3) throw new HostError('HOST_PROTOCOL_INVALID', 'workflow-command-requires-v3')
      const mutating = !['workflow-report', 'workflow-artifact'].includes(kind)
      exact(input, ['protocolVersion', 'requestId', 'kind', 'workflowKey', ...(mutating ? ['requestKey'] : []),
        ...(kind === 'workflow-retry' ? ['nodeKey', 'failedAssignment'] : kind === 'workflow-artifact' ? ['artifactRef'] : [])],
        ['workflow-pause', 'workflow-resume', 'workflow-cancel'].includes(kind) ? ['reason'] : [])
      const workflowKey = text(input.workflowKey, 'cli-workflow-key', 128), control = host.workflow(workflowKey)
      if (kind === 'workflow-report') return response({ kind: 'workflow-report', report: control.report() })
      if (kind === 'workflow-artifact') return response({ kind: 'workflow-artifact', artifact: control.readArtifact(workReference(input.artifactRef)) })
      const requestKey = text(input.requestKey, 'cli-control-key', 128)
      const result = kind === 'workflow-retry' ? await control.retry({ requestKey, nodeKey: text(input.nodeKey, 'cli-node-key', 128), failedAssignment: workReference(input.failedAssignment) })
        : await control[kind === 'workflow-pause' ? 'pause' : kind === 'workflow-resume' ? 'resume' : 'cancel']({ requestKey,
          ...(input.reason === undefined ? {} : { reason: text(input.reason, 'cli-control-reason', 128) }) })
      return response({ kind: 'control', command: kind, workflowKey, ...result })
    }
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
      const delegations = kind === 'pause' ? (host.pause(agentKey), undefined) : host.resume(agentKey)
      return response({ kind: 'control', command: kind, agentKey, ...(protocolVersion !== 1 && delegations !== undefined ? { delegations } : {}) })
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
      return response({ kind: 'report', report: protocolVersion === 1 ? host.report() : { ...host.report(), subagents: host.delegationReport(), ...(protocolVersion === 3 ? { workflows: host.workflowReport() } : {}) } })
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
