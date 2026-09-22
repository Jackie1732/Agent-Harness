import { rootOutcomes } from '../agent/control-codec.js'
import type { AgentBudget, AgentRootOutcome } from '../agent/contract.js'
import { decodeAgentBudget } from '../agent/budget.js'
import { agentJson, array, choice, eventId, exact, flag, integer, record, text, timestamp, unique } from '../agent/validation.js'
import { createMessageDefinition } from '../communication/message-catalog.js'
import { parseMessageId } from '../communication/ids.js'
import type { MessageId } from '../communication/ids.js'
import type { SessionEventId, SessionId } from '../session/ids.js'
import { parseSessionId } from '../session/ids.js'
import { workspaceRelativePath } from '../tool/workspace-path.js'
import type { DelegationWorkspace } from './contract.js'
import { decodeDelegationWorkspace, delegationText } from './request.js'

export const subagentMessageKinds = ['task', 'question', 'answer', 'progress', 'result'] as const
export type SubagentMessageKind = typeof subagentMessageKinds[number]
export type SubagentMessageIdentity = {
  readonly delegation: SessionEventId
  readonly parentRoot: SessionEventId
  readonly childSessionId: SessionId
}
export type SubagentFile = { readonly resourceId: string; readonly path: string; readonly byteLength: number; readonly sha256: string; readonly source: SessionEventId }
export type SubagentUncertainFile = { readonly resourceId: string; readonly path: string; readonly source: SessionEventId; readonly reasonCode: string }
export type SubagentMessagePayloads = {
  readonly task: SubagentMessageIdentity & { readonly task: string; readonly materials: readonly { readonly label: string; readonly text: string }[];
    readonly grant: AgentBudget; readonly workspace: DelegationWorkspace; readonly deadline: string }
  readonly question: SubagentMessageIdentity & { readonly ordinal: number; readonly question: string }
  readonly answer: SubagentMessageIdentity & { readonly questionMessageId: MessageId; readonly text: string }
  readonly progress: SubagentMessageIdentity & { readonly ordinal: number; readonly text: string }
  readonly result: SubagentMessageIdentity & {
    readonly childRoot: SessionEventId
    readonly outcome: AgentRootOutcome
    readonly summary: { readonly text: string; readonly sourceBytes: number; readonly truncated: boolean }
    readonly files: readonly SubagentFile[]
    readonly uncertainFiles: readonly SubagentUncertainFile[]
    readonly executionRelease: { readonly eventId: SessionEventId; readonly outcome: 'released' | 'cleanup-incomplete' }
    readonly source: { readonly turn: SessionEventId; readonly settled: SessionEventId; readonly terminal: SessionEventId }
  }
}
const common = ['delegation', 'parentRoot', 'childSessionId'] as const

/** Wire ceilings are fixed; the effective plan applies smaller task-specific limits at classification. */
export function decodeSubagentMessage<K extends SubagentMessageKind>(kind: K, value: unknown): SubagentMessagePayloads[K] {
  const input = record(agentJson(value))
  eventId(input.delegation); eventId(input.parentRoot); parseSessionId(text(input.childSessionId))
  switch (kind) {
    case 'task':
      exact(input, [...common, 'task', 'materials', 'grant', 'workspace', 'deadline'])
      delegationText(input.task, 1024 * 1024); timestamp(input.deadline); decodeAgentBudget(input.grant)
      decodeDelegationWorkspace(input.workspace, 10000)
      array(input.materials).forEach(value => { const item = record(value); exact(item, ['label', 'text']); delegationText(item.label, 128); delegationText(item.text, 1024 * 1024, true) })
      break
    case 'question':
      exact(input, [...common, 'ordinal', 'question']); integer(input.ordinal, 1); delegationText(input.question, 1024 * 1024); break
    case 'answer':
      exact(input, [...common, 'questionMessageId', 'text']); parseMessageId(text(input.questionMessageId)); delegationText(input.text, 1024 * 1024); break
    case 'progress':
      exact(input, [...common, 'ordinal', 'text']); integer(input.ordinal, 1); delegationText(input.text, 1024 * 1024); break
    case 'result': {
      exact(input, [...common, 'childRoot', 'outcome', 'summary', 'files', 'uncertainFiles', 'executionRelease', 'source'])
      eventId(input.childRoot); choice(input.outcome, rootOutcomes)
      const summary = record(input.summary); exact(summary, ['text', 'sourceBytes', 'truncated'])
      const bytes = Buffer.byteLength(delegationText(summary.text, 1024 * 1024, true))
      if (integer(summary.sourceBytes) < bytes || flag(summary.truncated) !== (summary.sourceBytes !== bytes)) throw new TypeError('summary-byte-accounting')
      const files = array(input.files).map(value => {
        const item = record(value); exact(item, ['resourceId', 'path', 'byteLength', 'sha256', 'source'])
        text(item.resourceId, 128); workspaceRelativePath(item.path, 4096); integer(item.byteLength); eventId(item.source)
        if (!/^[a-f0-9]{64}$/.test(text(item.sha256, 64))) throw new TypeError('file-hash')
        return JSON.stringify([item.resourceId, String(item.path).toLowerCase()])
      }); unique(files)
      const uncertain = array(input.uncertainFiles).map(value => {
        const item = record(value); exact(item, ['resourceId', 'path', 'source', 'reasonCode'])
        text(item.resourceId, 128); workspaceRelativePath(item.path, 4096); eventId(item.source); text(item.reasonCode, 128)
        return JSON.stringify([item.resourceId, String(item.path).toLowerCase()])
      }); unique([...files, ...uncertain])
      const release = record(input.executionRelease); exact(release, ['eventId', 'outcome'])
      eventId(release.eventId); choice(release.outcome, ['released', 'cleanup-incomplete'])
      const source = record(input.source); exact(source, ['turn', 'settled', 'terminal']); eventId(source.turn); eventId(source.settled); eventId(source.terminal)
      break
    }
  }
  return input as SubagentMessagePayloads[K]
}

export const subagentMessageDefinitions = Object.freeze(subagentMessageKinds.map(kind => createMessageDefinition({
  type: `subagent/${kind}`, payloadVersion: 1, decode: value => decodeSubagentMessage(kind, value),
})))

export function subagentMessageKind(type: string): SubagentMessageKind | null {
  return subagentMessageKinds.find(kind => type === `subagent/${kind}`) ?? null
}
