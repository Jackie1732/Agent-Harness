import type { Awaitable } from '../effect/index.js'
import {
  EventListenersFailedError,
  MiddlewareNextInactiveError,
  MiddlewareNextRepeatedError,
  MiddlewareUnterminatedError,
} from './errors.js'
import type { OriginTaskRecord, ScopeRecord } from './records.js'
import type { RegistrationStore } from './registration-store.js'
import type { TaskTracker } from './task-tracker.js'
import type {
  EventListener,
  EventListenerFailure,
  EventName,
  MiddlewareHandler,
  MiddlewareName,
  MiddlewareNext,
} from './types.js'

interface NextState<TRequest, TResult> {
  readonly middlewareName: string
  readonly registrationId: string
  readonly scopeId: string
  readonly handlerLabel: string
  called: boolean
  delegate: ((...args: [] | [TRequest]) => Promise<TResult>) | undefined
}

/** Dispatch one event against the eligible registration sequence. */
export function emitEvent<TPayload>(
  scope: ScopeRecord,
  event: EventName<TPayload>,
  payload: TPayload,
  registrations: RegistrationStore,
  tasks: TaskTracker,
): Promise<void> {
  const upperBound = registrations.upperBound
  return tasks.runOrigin(scope, async () => {
    let cursor = 0
    let attempted = 0
    const failures: EventListenerFailure[] = []
    for (;;) {
      const registration = registrations.next('listener', event, cursor, upperBound)
      if (registration === undefined) break
      cursor = registration.ordinal
      attempted += 1
      try {
        await tasks.runFrame(registration, () =>
          (registration.callback as EventListener<TPayload>)(payload))
      } catch (reason) {
        failures.push({
          registrationId: registration.id,
          scopeId: registration.scope.id,
          listenerLabel: registration.label,
          reason,
        })
      }
    }
    if (failures.length > 0) {
      throw new EventListenersFailedError(event.name, attempted, failures)
    }
  })
}

/** Invoke one middleware chain against the eligible registration sequence. */
export function invokeMiddleware<TRequest, TResult>(
  scope: ScopeRecord,
  name: MiddlewareName<TRequest, TResult>,
  request: TRequest,
  terminal: ((request: TRequest) => Awaitable<TResult>) | undefined,
  registrations: RegistrationStore,
  tasks: TaskTracker,
): Promise<TResult> {
  const upperBound = registrations.upperBound
  return tasks.runOrigin(scope, origin => runWaterfall(
    origin,
    scope,
    name,
    request,
    terminal,
    0,
    upperBound,
    registrations,
    tasks,
  ))
}

async function runWaterfall<TRequest, TResult>(
  origin: OriginTaskRecord,
  originScope: ScopeRecord,
  name: MiddlewareName<TRequest, TResult>,
  request: TRequest,
  terminal: ((request: TRequest) => Awaitable<TResult>) | undefined,
  cursor: number,
  upperBound: number,
  registrations: RegistrationStore,
  tasks: TaskTracker,
): Promise<TResult> {
  const registration = registrations.next('middleware', name, cursor, upperBound)
  if (registration === undefined) {
    if (terminal === undefined) {
      throw new MiddlewareUnterminatedError(name.name, String(originScope.id))
    }
    return await terminal(request)
  }

  return await tasks.runFrame(registration, () => {
    const continuation = tasks.createContinuation(origin, (downstreamRequest: TRequest) => runWaterfall(
      origin,
      originScope,
      name,
      downstreamRequest,
      terminal,
      registration.ordinal,
      upperBound,
      registrations,
      tasks,
    ))
    const state: NextState<TRequest, TResult> = {
      middlewareName: name.name,
      registrationId: String(registration.id),
      scopeId: String(registration.scope.id),
      handlerLabel: registration.label,
      called: false,
      delegate: (...args) => continuation(args.length === 0 ? request : args[0]),
    }
    const next = createNext(state)

    try {
      const result = (registration.callback as MiddlewareHandler<TRequest, TResult>)(request, next)
      if (isPromiseLike(result)) {
        return Promise.resolve(result).finally(() => { state.delegate = undefined })
      }
      state.delegate = undefined
      return result
    } catch (reason) {
      state.delegate = undefined
      throw reason
    }
  })
}

/** Keep saved next diagnostics independent of the invocation's retired private references. */
function createNext<TRequest, TResult>(state: NextState<TRequest, TResult>): MiddlewareNext<TRequest, TResult> {
  return (...args: [] | [TRequest]): Promise<TResult> => {
    if (state.called) {
      return Promise.reject(new MiddlewareNextRepeatedError(
        state.middlewareName, state.registrationId, state.scopeId, state.handlerLabel,
      ))
    }
    const delegate = state.delegate
    if (delegate === undefined) {
      return Promise.reject(new MiddlewareNextInactiveError(
        state.middlewareName, state.registrationId, state.scopeId, state.handlerLabel,
      ))
    }
    state.called = true
    state.delegate = undefined
    return delegate(...args)
  }
}

function isPromiseLike<T>(value: Awaitable<T>): value is PromiseLike<T> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as PromiseLike<T>).then === 'function'
}
