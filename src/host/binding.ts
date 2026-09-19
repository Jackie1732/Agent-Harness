import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { ContextProfile } from '../context/contract.js'
import { projectContextSession } from '../context/projection.js'
import { assertAgentExecutionQuiescent } from '../agent/execution-health.js'
import { projectAgentSession } from '../agent/projection.js'
import type { AgentSpec } from '../agent/contract.js'
import type { JsonValue } from '../foundation/json.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { ResolvedHostLocalMember } from './config.js'
import { HostError } from './errors.js'
import { projectHostSession } from './session-projection.js'

function same(first: JsonValue, second: JsonValue): boolean {
  return Buffer.from(canonicalJsonBytes(first)).equals(Buffer.from(canonicalJsonBytes(second)))
}

function localEvent<T extends JsonValue>(session: SessionHandle, eventId: SessionEventId): CommittedSessionEvent<T> | undefined {
  const event = session.snapshot().history.at(-1)?.events.find(item => item.kind === 'known' && item.stored.eventId === eventId)
  return event?.kind === 'known' ? event as CommittedSessionEvent<T> : undefined
}

/** Verify saved Host binding facts and every runtime-facing installed source. */
export function validateHostMemberSession(
  session: SessionHandle,
  hostKey: string,
  member: ResolvedHostLocalMember,
  options: { readonly requireQuiescent?: boolean } = {},
): void {
  const snapshot = session.snapshot()
  if (snapshot.header.parent !== undefined) throw new HostError('HOST_BINDING_CONFLICT', 'fork-session-not-supported')
  if (snapshot.lifecycle !== 'active') throw new HostError('HOST_NOT_READY', 'session-ended')
  const binding = projectHostSession(snapshot)
  if (binding.ready === null || binding.ready.payload.hostKey !== hostKey || binding.ready.payload.agentKey !== member.agentKey) {
    throw new HostError('HOST_NOT_READY', 'host-binding-missing')
  }
  const profile = localEvent<ContextProfile>(session, binding.ready.payload.profile)
  const installed = localEvent<AgentSpec>(session, binding.ready.payload.spec)
  if (profile?.stored.type !== 'context/profile-recorded' || profile.stored.payloadVersion !== 2
    || installed?.stored.type !== 'agent/spec-recorded' || installed.stored.payloadVersion !== 1) {
    throw new HostError('HOST_BINDING_CONFLICT', 'host-binding-source-invalid')
  }
  const expected: AgentSpec = Object.freeze({ ...member.spec, profileEventId: profile.stored.eventId })
  const context = projectContextSession(snapshot)
  const agent = projectAgentSession(snapshot)
  if (!same(profile.payload, member.profile) || !same(installed.payload, expected)
    || context.profileHeads.find(item => item.profileKey === member.profile.profileKey)?.eventId !== profile.stored.eventId
    || agent.spec?.stored.eventId !== installed.stored.eventId) {
    throw new HostError('HOST_BINDING_CONFLICT', 'installed-recipe-mismatch')
  }
  if (options.requireQuiescent !== false && (agent.openRun !== null || agent.openRecovery !== null || agent.openTurn !== null || agent.closing !== null)) {
    throw new HostError('HOST_RECOVERY_REQUIRED', 'agent-execution-open')
  }
  if (options.requireQuiescent !== false) {
    try { assertAgentExecutionQuiescent(snapshot) }
    catch (cause) { throw new HostError('HOST_RECOVERY_REQUIRED', 'lower-execution-not-quiescent', {}, { cause }) }
  }
}
