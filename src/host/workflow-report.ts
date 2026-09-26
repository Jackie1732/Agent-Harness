import type { SessionSnapshot } from '../session/types.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { workflowAssignmentClosed } from '../workflow/closure.js'
import { workExecutionReports } from '../workflow/work-report.js'

export type WorkflowReport = ReturnType<typeof workflowReport>
export type WorkflowReportSummary = ReturnType<typeof workflowReportSummary>

/** Count the whole run before truncating the operator's entry vectors. */
export function workflowReport(session: SessionSnapshot, peers: readonly SessionSnapshot[], resumed: boolean) {
  const state = projectWorkflowSession(session)
  const definition = state.definition!.payload
  const maximum = definition.limits.maxReportEntries
  const nodes = definition.nodes.map(node => ({ nodeKey: node.nodeKey,
    status: state.upstream.find(item => item.nodeKey === node.nodeKey)?.state.kind ?? (state.stop !== null ? state.stop.payload.reason === 'cancelled' ? 'cancelled' : 'failed'
      : state.assignments.some(item => item.payload.nodeKey === node.nodeKey) ? 'assigned' : state.ready.includes(node.nodeKey) ? 'ready' : 'blocked') }))
  const closed = state.assignments.every(assignment => {
    const member = peers.find(peer => peer.header.address === assignment.payload.memberAddress)
    return member !== undefined && workflowAssignmentClosed(session, member, assignment.stored.eventId, peers)
  })
  const completed = definition.requiredOutputs.every(key => state.upstream.find(item => item.nodeKey === key)?.state.kind === 'accepted')
    && nodes.every(node => ['accepted', 'skipped'].includes(node.status))
  const failed = state.upstream.some(item => ['failed', 'result-unknown', 'cancelled'].includes(item.state.kind))
    || definition.requiredOutputs.some(key => state.upstream.find(item => item.nodeKey === key)?.state.kind === 'skipped')
  const assignments = new Set(state.assignments.map(item => item.stored.eventId))
  const work = peers.flatMap(peer => workExecutionReports(peer)).filter(item => assignments.has(item.assignment.eventId))
  const inbox = new Set<string>(), outbox = new Set<string>()
  for (const peer of [session, ...peers]) {
    const facts = projectCommunicationFacts(peer)
    const related = (envelope: import('../communication/types.js').MessageEnvelope) => envelope.type.startsWith('workflow/')
      && (envelope.payload as { assignment?: { address?: string } }).assignment?.address === session.header.address
    for (const item of facts.inbox) if (item.status === 'pending' && related(item.envelope)) inbox.add(item.messageId)
    for (const item of facts.outbox) if (item.status === 'pending' && related(item.envelope)) outbox.add(item.messageId)
  }
  const artifacts = state.proposals.flatMap(item => item.payload.message.artifacts).map(item => ({ ref: item.ref, name: item.value.name,
    mediaType: item.value.mediaType, byteLength: item.value.byteLength, sha256: item.value.sha256 }))
  const pendingRecovery = state.recoveries.filter(item => item.settled === null && item.supersededBy === null)
  const pendingResources = work.filter(item => item.execution !== 'released')
  const knownTokens = (key: 'inputTokens' | 'outputTokens') => work.some(item => item.usage[key] === null) ? null : work.reduce((sum, item) => sum + item.usage[key]!, 0)
  const retries = state.retries.filter(item => item.expired === null && item.consumed === null)
  return Object.freeze({ workflowKey: definition.workflowKey, desired: state.desired,
    state: state.terminal?.payload.outcome ?? (state.stop !== null ? state.stop.payload.reason === 'cancelled' ? 'cancelled' as const : 'failed' as const
      : failed ? 'failed' as const : completed ? 'completed' as const : state.desired === 'paused' ? 'paused' as const
        : !resumed ? 'suspended' as const : retries.some(item => item.request === null) ? 'retry-awaiting-decision' as const : 'running' as const),
    settled: state.terminal !== null, closed: state.closed !== null && closed && state.controls.every(item => item.settled !== null),
    terminal: state.terminal === null ? null : { address: session.header.address, eventId: state.terminal.stored.eventId },
    budget: definition.budget, reservedBudget: state.reservedBudget,
    usage: { scope: 'participant-roots' as const, modelCalls: work.reduce((sum, item) => sum + item.usage.modelCalls, 0),
      toolCalls: work.reduce((sum, item) => sum + item.usage.toolCalls, 0), unknownCalls: work.reduce((sum, item) => sum + item.usage.unknownCalls, 0),
      inputTokens: knownTokens('inputTokens'), outputTokens: knownTokens('outputTokens') },
    recovery: pendingRecovery.slice(0, maximum).map(item => ({ domain: 'workflow:' + session.header.address, supersedes: item.requested.stored.eventId })),
    work: work.slice(0, maximum).map(item => ({ ...item, groups: item.groups.slice(0, maximum) })), artifacts: artifacts.slice(0, maximum),
    counts: { workRoots: work.length, artifacts: artifacts.length, unknown: work.filter(item => item.unknown).length,
      exhausted: work.filter(item => item.exhausted).length, pendingResources: pendingResources.length,
      cleanupIncomplete: pendingResources.filter(item => item.execution === 'unknown').length,
      pendingRecoveries: pendingRecovery.length + work.filter(item => item.recovery !== null).length,
      pendingWaits: work.reduce((sum, item) => sum + item.pendingWaits, 0), externalWaits: work.reduce((sum, item) => sum + item.externalWaits, 0),
      runnable: state.stop === null && state.terminal === null && state.desired === 'running' && resumed
        ? state.ready.length + state.assignments.filter(item => !work.some(root => root.assignment.eventId === item.stored.eventId)).length
          + work.filter(item => item.outcome === null && item.pendingWaits === 0).length : 0,
      nodes: nodes.length, assignments: state.assignments.length, proposals: state.proposals.length, reviews: state.reviews.length, progress: state.progress.length,
      accepted: state.decisions.filter(item => item.payload.outcome === 'accepted' && state.assignments.some(work => work.stored.eventId === item.payload.assignment.eventId && work.payload.kind === 'production')).length,
      failed: state.decisions.filter(item => item.payload.outcome === 'rejected' && state.assignments.some(work => work.stored.eventId === item.payload.assignment.eventId && work.payload.kind === 'production')).length,
      pendingInbox: inbox.size,
      questions: state.interactions.filter(item => item.admitted.payload.kind === 'question').length,
      pendingQuestions: state.interactions.filter(item => item.admitted.payload.kind === 'question' && item.settled === null).length,
      groups: state.interactions.filter(item => item.admitted.payload.kind === 'group').length,
      pendingGroups: state.interactions.filter(item => item.admitted.payload.kind === 'group' && item.settled === null).length,
      pendingControls: state.controls.filter(item => item.settled === null).length,
      retries: state.retries.length, pendingRetries: state.stop === null ? retries.filter(item => item.request === null).length : 0,
      pendingStops: state.assignmentStops.filter(item => !state.stopReceipts.some(receipt => receipt.payload.message.stop.eventId === item.stored.eventId)).length,
      pendingOutbox: outbox.size },
    progress: Object.freeze(state.progress.slice(0, maximum)),
    retries: Object.freeze(retries.slice(0, maximum)),
    nodes: Object.freeze(nodes.slice(0, maximum)), assignments: Object.freeze(state.assignments.slice(0, maximum).map(item => ({
      ref: { address: session.header.address, eventId: item.stored.eventId }, nodeKey: item.payload.nodeKey, memberKey: item.payload.memberKey, attempt: item.payload.attempt }))),
    truncated: work.length > maximum || artifacts.length > maximum || pendingRecovery.length > maximum || work.some(item => item.groups.length > maximum) || nodes.length > maximum || state.assignments.length > maximum || state.progress.length > maximum || retries.length > maximum })
}

/** Full-run outcome totals are independent of the displayed Workflow prefix. */
export function workflowReportSummary(reports: readonly ReturnType<typeof workflowReport>[], maximum: number) {
  return Object.freeze({ count: reports.length, failed: reports.filter(item => item.state === 'failed').length,
    unknown: reports.reduce((sum, item) => sum + item.counts.unknown, 0),
    blocked: reports.filter(item => item.counts.cleanupIncomplete > 0 || item.counts.pendingRecoveries > 0).length,
    unclosed: reports.filter(item => !item.closed).length,
    runnable: reports.reduce((sum, item) => sum + item.counts.runnable, 0),
    exhausted: reports.filter(item => !item.settled).reduce((sum, item) => sum + item.counts.exhausted, 0),
    reports: reports.slice(0, maximum), truncated: reports.length > maximum || reports.some(item => item.truncated) })
}
