import type { SessionEventId } from '../session/ids.js'
import type { DelegationRequest } from '../subagent/contract.js'
import type { HostSubagents } from './subagents.js'
import type { HostSlot } from './runtime-types.js'
import type { HostTimer } from './timer.js'
import { HostError } from './errors.js'
import { decodeDelegationRequest } from '../subagent/request.js'
import { text } from '../agent/validation.js'

export interface ParentSubagentOptions {
  readonly domain: HostSubagents
  readonly parent: HostSlot
  readonly root: SessionEventId
  readonly timer: HostTimer
  readonly scanIntervalMs: number
  assertReady(): void
  assertExternalWait(): void
  track<T>(task: () => Promise<T>): Promise<T>
  wake(): void
}
/** The Host facade itself is the caller's control capability; IDs only select work already owned by this parent. */
export function bindParentSubagents(options: ParentSubagentOptions) {
  const { domain, parent, root } = options
  const inspect = (delegation: SessionEventId) => { options.assertReady(); return domain.inspect(parent.member.agentKey, root, delegation) }
  return Object.freeze({
    spawn(requestKey: string, request: DelegationRequest) {
      options.assertReady()
      text(requestKey, 128)
      const captured = decodeDelegationRequest(request, domain.options.config.limits)
      return options.track(async () => {
        const result = await domain.admission.spawn(parent.member.agentKey, parent.session, root, { kind: 'programmatic', requestKey }, captured)
        options.wake(); return result
      })
    },
    inspect,
    cancel(delegation: SessionEventId, requestKey: string) {
      options.assertReady()
      return options.track(async () => { const result = await domain.cancel(parent.member.agentKey, root, delegation, requestKey); options.wake(); return result })
    },
    async wait(delegation: SessionEventId, query: { readonly until: 'business' | 'closed'; readonly signal?: AbortSignal }) {
      options.assertExternalWait()
      if (query.until !== 'business' && query.until !== 'closed') throw new HostError('HOST_PROTOCOL_INVALID', 'delegation-wait-mode')
      while (true) {
        query.signal?.throwIfAborted()
        const result = inspect(delegation)
        if (query.until === 'closed' ? result.closed : result.inputDisposed || result.adopted || result.resultAvailable) return result
        if (result.recoveryRequired || result.suspended) throw new HostError('HOST_RECOVERY_REQUIRED', 'delegation-wait-blocked')
        await options.timer.wait(options.scanIntervalMs, query.signal ?? new AbortController().signal)
      }
    },
  })
}
export type ParentSubagents = ReturnType<typeof bindParentSubagents>
