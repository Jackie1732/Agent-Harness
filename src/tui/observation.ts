/** React subscriptions acquire observation leases from the terminal's single Effect owner. */
import { useEffect, useRef, useState } from 'react'
import type { EffectOwner } from '../effect/owner.js'
import type { ControlMethod, Params } from '../protocol/index.js'
import type { OperatorResult, OperatorSession } from '../operator/types.js'
import { watchOperatorObservation } from '../operator/observations.js'

export interface DisplayObservation { readonly last: OperatorResult | null; readonly stale: boolean; readonly error: OperatorResult['error'] }

/**
 * Join the old target's observer before subscribing to its replacement.
 * @param session Current operation owner.
 * @param owner Terminal resource owner.
 * @param signal Stops observations during terminal-first closing.
 * @param method Read-only method.
 * @param params Selected exact target; null suspends observation.
 * @param onFailure Lifecycle cleanup failures enter unified closing.
 * @returns Last verified facts and an independent stale marker.
 */
export function useOperatorObservation<M extends ControlMethod>(session: OperatorSession, owner: EffectOwner, signal: AbortSignal,
  method: M, params: Params<M> | null, onFailure: () => void): DisplayObservation {
  const [observation, setObservation] = useState<DisplayObservation>({ last: null, stale: false, error: null })
  const settlement = useRef<Promise<void>>(Promise.resolve())
  const target = JSON.stringify(params)
  useEffect(() => {
    if (params === null) { setObservation({ last: null, stale: false, error: null }); return }
    if (signal.aborted) return
    let listening = true
    setObservation({ last: null, stale: false, error: null })
    const lease = settlement.current.then(() => owner.run(`tui-observe:${method}`, context => context.apply('observer', () => watchOperatorObservation(session, method, params, result => {
      if (!listening) return
      setObservation(current => result.status === 'ok' ? { last: result, stale: false, error: null }
        : { ...current, stale: true, error: result.error })
    }, { signal }), observer => observer.dispose())))
    return () => {
      listening = false
      settlement.current = lease.then(value => value.dispose()).catch(() => { if (!signal.aborted) onFailure() })
    }
  }, [session, owner, signal, method, target, onFailure])
  return observation
}
