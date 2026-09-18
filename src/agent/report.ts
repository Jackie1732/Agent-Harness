import type { SessionSnapshot } from '../session/types.js'
import { projectModelSession } from '../model/projection.js'
import { projectAgentSession } from './projection.js'
import { projectCommunicationFacts } from '../communication/projection.js'

/** Bounded public data only; reports neither wake a peer nor execute a model. */
export function projectAgentReport(snapshot: SessionSnapshot) {
  const state = projectAgentSession(snapshot)
  const maximum = state.spec?.payload.limits.maxReportEntries ?? 0
  const pendingWaits = state.waits.filter(wait => wait.settled === null)
  const communication = projectCommunicationFacts(snapshot)
  const pendingReceipts = state.inputs.filter(input => input.message !== null && ['handled', 'abandoned'].includes(input.status)
    && communication.inbox.some(item => item.messageId === input.message!.messageId && item.status === 'pending'))
  const latest = state.turns.at(-1)
  const step = state.steps.find(step => step.opened.stored.eventId === latest?.settled?.payload.finalStep)
  const invocations = projectModelSession(snapshot).invocations
  const model = invocations.find(item => item.invocationId === step?.decided?.payload.model?.invocationId)
  const usage = state.steps.flatMap(step => {
    const source = step.decided?.payload.model
    if (source === null || source === undefined) return []
    const invocation = invocations.find(item => item.invocationId === source.invocationId)
    return invocation?.state === 'settled' ? [{ step: step.opened.stored.eventId, settled: source.settled,
      external: invocation.settled.payload.external, usage: invocation.settled.payload.result.usage }] : []
  })
  const finalText = model?.state === 'settled' ? model.settled.payload.result.blocks.flatMap(block => block.kind === 'text' && block.complete ? [block.text] : []).join('') : ''
  const textBytes = Buffer.byteLength(finalText)
  return Object.freeze({ run: state.runs.at(-1) ?? null, openRun: state.openRun, openTurn: state.openTurn,
    roots: maximum === 0 ? [] : state.roots.slice(-maximum),
    inputs: maximum === 0 ? [] : state.inputs.slice(-maximum).map(({ reference, lane, status, claimedBy, reservedBy, everMatched, reason }) => ({ reference, lane, status, claimedBy, reservedBy, everMatched, reason })),
    waits: pendingWaits.slice(0, maximum),
    modelUsage: maximum === 0 ? [] : usage.slice(-maximum),
    pendingReceipts: pendingReceipts.slice(0, maximum).map(input => ({ reference: input.reference, disposition: input.status })),
    pendingControls: state.controls.filter(item => item.settled === null && item.supersededBy === null
      && !(item.requested.payload.kind === 'close-session' && snapshot.lifecycle === 'ended')).slice(0, maximum).map(item => ({ eventId: item.requested.stored.eventId, kind: item.requested.payload.kind })),
    counts: { roots: state.roots.length, inputs: state.inputs.length, pendingWaits: pendingWaits.length, modelUsage: usage.length, pendingReceipts: pendingReceipts.length },
    nextWakeAt: [...pendingWaits.flatMap(wait => wait.created.payload.result.kind === 'wait' ? [wait.created.payload.result.descriptor.deadline] : []),
      ...state.roots.filter(root => root.outcome === null).map(root => root.deadline)].sort()[0] ?? null,
    final: latest?.settled?.payload.outcome === 'completed' && model?.state === 'settled'
      ? { turn: latest.started.stored.eventId, settled: model.settled.stored.eventId,
        text: textBytes <= (state.spec?.payload.limits.maxResultBytes ?? 0) ? finalText : null, textBytes,
        textOmitted: textBytes > (state.spec?.payload.limits.maxResultBytes ?? 0) } : null })
}
export type AgentRunReport = ReturnType<typeof projectAgentReport>
