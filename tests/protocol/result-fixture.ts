import { createHash } from 'node:crypto'
import type { ControlMethod, Result } from '../../src/protocol/index.js'
import type { AgentRunReport } from '../../src/agent/report-data.js'
import type { AgentReadiness } from '../../src/agent/readiness-data.js'
import type { HostRunReport, HostCurrentReport } from '../../src/host/report-data.js'
import type { WorkflowReport } from '../../src/host/workflow-report-data.js'
import type { DelegationReportEntry } from '../../src/subagent/report-data.js'
import { parseChannelId, channelSequence } from '../../src/communication/ids.js'
import { formatSessionAddress, sessionSequence } from '../../src/session/ids.js'
import { budget, evidence, receiptEvidence, eventId, instanceId, messageId, ref, sessionId } from './fixtures.js'

export const agentReport: AgentRunReport = {
  run: null, openRun: null, openTurn: null, roots: [], inputs: [], waits: [], modelUsage: [],
  pendingReceipts: [], pendingControls: [], pendingOutbox: [], turns: [],
  truncated: { roots: false, inputs: false, waits: false, modelUsage: false, pendingReceipts: false, pendingControls: false, pendingOutbox: false, turns: false },
  counts: { roots: 0, inputs: 0, pendingWaits: 0, modelUsage: 0, pendingReceipts: 0, pendingControls: 0, pendingOutbox: 0,
    turns: 0, pendingInputs: 0, queuedInputs: 0, reservedInputs: 0, reviewRequiredInputs: 0, failedRoots: 0, exhaustedRoots: 0 },
  nextWakeAt: null, final: null,
}
const readiness: AgentReadiness = { sourcePosition: 1, canRun: false, canMaintain: false, nextWakeAt: null, blockedBy: 'idle',
  counts: { runnableInputs: 0, pendingMaintenance: 0, unsupportedInputs: 0, reviewRequiredInputs: 0 } }
const member = { agentKey: 'writer', sessionId, paused: false, faulted: false, mailbox: 'online' as const,
  routingPaused: false, readiness, agent: agentReport }
const hostCounts = { members: 1, pendingInputs: 0, pendingWaits: 0, pendingOutbox: 0, pendingMaintenance: 0,
  runnableInputs: 0, reviewRequiredInputs: 0, unsupportedInputs: 0, blockedMembers: 0, failedRoots: 0, exhaustedRoots: 0 }
export const hostRun: HostRunReport = { batches: 0, businessRuns: 0, maintenanceRuns: 0, deliveryAttempts: 0,
  stoppedBy: 'quiescent', blockedRoutes: [], members: [member], counts: hostCounts, truncated: false }
const hostCurrent: HostCurrentReport = { status: 'ready', shutdownMode: null, hostKey: 'test-host', instanceId,
  configVersion: 1, configFingerprint: '0'.repeat(64), configuredMembers: 1, remoteMembers: 0,
  unfinishedOperations: 0, shutdownOverdue: false, blockedRoutes: [], members: [member], counts: hostCounts,
  truncated: false, cuts: receiptEvidence.cuts }
const input: Result<'input.get'> = { agentKey: 'writer', sessionId, inputEventId: eventId, kind: 'task',
  submission: { namespace: 'api:researcher', key: 'key' }, status: 'queued', claimedBy: null, rootId: null, reason: null, wait: null, ...evidence }
export const root: Result<'root.get'> = { agentKey: 'writer', sessionId, rootId: eventId,
  source: { kind: 'ordinary' }, outcome: 'completed', reason: null, stopControl: null, waits: [],
  final: { turnId: eventId, stepId: eventId, modelSettledId: eventId, text: '', textBytes: 0, textOmitted: false },
  executionPending: false, ...evidence }
const command: Result<'message.send'> = { agentKey: 'writer', sessionId, ...receiptEvidence,
  status: 'outbox-accepted', runId: eventId, commandEventId: eventId, action: { eventId, index: 0 }, outboxAcceptedEventId: eventId, messageId, reason: null }
const envelope = { envelopeVersion: 1 as const, messageId, sender: formatSessionAddress(sessionId), recipient: formatSessionAddress(sessionId),
  channelId: parseChannelId('91000000-0000-4000-8000-000000000004'), channelSequence: channelSequence(1), correlationId: messageId,
  createdAt: '2026-10-07T00:00:00.000Z', type: 'test/note', payloadVersion: 1,
  payload: { cuts: ['user JSON'], address: 'not-an-address', eventId: 'not-an-event' } }
export const message: Result<'message.get'> = { agentKey: 'writer', sessionId, ...evidence, direction: 'outbox', fact: {
  messageId, envelope, acceptedEventId: eventId, acceptedSequence: sessionSequence(1), attemptCount: 0, status: 'pending',
} }
const delegation: DelegationReportEntry = { delegationId: eventId, parentKey: 'writer', parentRoot: eventId, childSessionId: sessionId,
  deadline: '2026-10-07T00:00:00.000Z', grant: budget, localReserved: budget, parentProtocolReserve: budget,
  childModelUsage: null, parentResourceGenerations: 0, businessResolved: false, executionReleased: false, adopted: false,
  inputDisposed: false, closed: false, resultAvailable: false, pendingQuestions: 0, parentResources: [], childResources: [],
  cleanupIncomplete: false, suspended: false, recoveryRequired: false, failed: false }
export const workflowReport: WorkflowReport = { workflowKey: 'research', desired: 'paused', state: 'paused', settled: false,
  closed: false, terminal: null, budget, reservedBudget: budget,
  usage: { scope: 'participant-roots', modelCalls: 0, toolCalls: 0, unknownCalls: 0, inputTokens: null, outputTokens: null },
  recovery: [], work: [], artifacts: [], counts: { workRoots: 0, artifacts: 0, unknown: 0, exhausted: 0,
    pendingResources: 0, cleanupIncomplete: 0, pendingRecoveries: 0, pendingWaits: 0, externalWaits: 0,
    runnable: 0, nodes: 0, assignments: 0, proposals: 0, reviews: 0, progress: 0, accepted: 0, failed: 0,
    pendingInbox: 0, questions: 0, pendingQuestions: 0, groups: 0, pendingGroups: 0, pendingControls: 0,
    retries: 0, pendingRetries: 0, pendingStops: 0, pendingOutbox: 0 }, progress: [], retries: [], nodes: [], assignments: [], truncated: false }
const workflow = { ...workflowReport, ...evidence }
const workflowControl: Result<'workflow.pause'> = { ...receiptEvidence, status: 'applied', ref }
const receipt: Result<'input.submit'> = { agentKey: 'writer', sessionId, inputEventId: eventId, reused: false }
const artifactText = 'accepted text'
export const results = {
  'host.status': { ...receiptEvidence, hostStatus: 'ready', activity: 'idle', report: hostCurrent },
  'host.run': { ...receiptEvidence, report: hostRun },
  'host.shutdown': { instanceId, mode: 'cancel', hostStatus: 'stopped', serviceStatus: 'closing' },
  'agent.get': { agentKey: member.agentKey, sessionId, paused: member.paused, faulted: member.faulted,
    mailbox: member.mailbox, routingPaused: member.routingPaused, readiness, ...evidence, report: agentReport },
  'agent.pause': { agentKey: 'writer', instanceId, paused: true }, 'agent.resume': { agentKey: 'writer', instanceId, paused: false, resumptions: [] },
  'input.submit': receipt, 'input.answer': receipt, 'input.get': input,
  'root.get': root, 'root.wait': { status: 'condition-met', observation: root },
  'root.cancel': { agentKey: 'writer', sessionId, rootId: eventId, stopControl: null, outcome: 'completed', ...evidence },
  'message.send': command, 'message.reply': command, 'message.get': message, 'message.wait': { status: 'timeout', observation: message },
  'session.events': { sessionId, through: 1, parent: null, events: [], nextCursor: null, hasMore: false },
  'delegation.spawn': { ...receiptEvidence, delegationId: eventId, childSessionId: sessionId, childAddress: formatSessionAddress(sessionId) },
  'delegation.get': { ...delegation, ...evidence }, 'delegation.wait': { status: 'timeout', observation: { ...delegation, ...evidence } },
  'delegation.cancel': { ...receiptEvidence, status: 'requested', eventId },
  'workflow.get': workflow, 'workflow.wait': { status: 'timeout', observation: workflow },
  'workflow.pause': workflowControl, 'workflow.resume': { ...workflowControl, status: 'resumed' },
  'workflow.cancel': workflowControl, 'workflow.retry': workflowControl,
  'workflow.output': { ...receiptEvidence, workflowKey: 'research', nodeKey: 'paper', status: 'available', value: null, decisionRef: ref, assignmentRef: ref, proposalRef: ref },
  'workflow.artifact': { ...receiptEvidence, workflowKey: 'research', artifactRef: ref, decisionRef: ref, assignmentRef: ref, proposalRef: ref,
    mediaType: 'text/plain', text: artifactText, byteLength: Buffer.byteLength(artifactText), sha256: createHash('sha256').update(artifactText).digest('hex') },
} as const satisfies { [M in ControlMethod]: Result<M> }
