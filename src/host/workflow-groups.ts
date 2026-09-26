import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { formatSessionEventId, sessionSequence } from '../session/ids.js'
import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { HostSlot } from './runtime-types.js'
import { foldAgentSession, projectAgentSession } from '../agent/projection.js'
import { workAcceptanceForRoot } from '../workflow/work-projection.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { selectGroupAdmission } from '../workflow/group-admission.js'
import { groupMessageCommands } from '../workflow/group-action.js'
import type { WorkGroupAuthority } from '../workflow/group-action.js'
import { workGroupRequestedEvent } from '../workflow/group-events.js'
import { workflowInteractionAdmittedEvent } from '../workflow/interaction-events.js'
import { WorkflowJournal } from '../workflow/journal.js'
import { assertWorkflowMessageFits } from '../workflow/message-budget.js'
import { sameWorkflowValue } from '../workflow/work-binding.js'
import { invalidHistory } from '../workflow/errors.js'

/** HostWorkflows serializes this admission with questions and all other group admissions. */
export async function admitWorkGroup(coordinator: SessionHandle, slots: readonly HostSlot[], clock: Clock,
  request: CommittedSessionEvent<ReturnType<typeof workGroupRequestedEvent.decode>>): ReturnType<WorkGroupAuthority['admitGroup']> {
  const state = projectWorkflowSession(coordinator.snapshot()), chosen = selectGroupAdmission(state, request, clockTimestamp(clock))
  if ('outcome' in chosen) return { outcome: 'blocked', reason: chosen.reason }
  const sender = slots.find(slot => slot.session.header.address === chosen.request.address)!
  const source = foldAgentSession(sender.session.snapshot()), saved = source.sources.get(request.stored.eventId)
  if (saved === undefined || !sameWorkflowValue(saved.payload, request.payload)) invalidHistory('group-request-source')
  const root = source.roots.get(request.payload.root)!
  if (root.outcome !== null || root.stopControl !== null) return { outcome: 'blocked', reason: 'work-group-root-stopped' }
  const binding = workAcceptanceForRoot(source, root.id).work!
  const reference = { address: coordinator.header.address, eventId: formatSessionEventId(coordinator.header.sessionId, sessionSequence(Number.MAX_SAFE_INTEGER)) }
  const commands = groupMessageCommands(binding, request, chosen, reference)
  for (const [index, target] of chosen.targets.entries()) {
    const command = commands[index]!, member = slots.find(slot => slot.session.header.address === command.request.recipient)!
    const targetRoot = projectAgentSession(member.session.snapshot()).roots.find(root => root.source.kind === 'workflow' && sameWorkflowValue(root.source.assignment, target.assignment))
    if (targetRoot !== undefined && (targetRoot.outcome !== null || targetRoot.stopControl !== null)) return { outcome: 'blocked', reason: 'work-group-peer-terminal' }
    assertWorkflowMessageFits(sender.session.header.sessionId, command, { ...binding.value.protocolLimits,
      maxRecordBytes: Math.min(sender.session.maxRecordBytes, member.session.maxRecordBytes) })
  }
  const admitted = await new WorkflowJournal(coordinator, clock).append(workflowInteractionAdmittedEvent, () => chosen)
  if (admitted.payload.kind !== 'group') invalidHistory('group-admission-kind')
  return { outcome: 'admitted', admission: { address: coordinator.header.address, eventId: admitted.stored.eventId }, value: admitted.payload }
}
