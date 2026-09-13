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

  let open = true
  let called = false
  const next = ((...args: [] | [TRequest]): Promise<TResult> => {
    if (called) {
      return Promise.reject(new MiddlewareNextRepeatedError(
        name.name,
        String(registration.id),
        String(registration.scope.id),
        registration.label,
      ))
    }
    if (!open) {
      return Promise.reject(new MiddlewareNextInactiveError(
        name.name,
        String(registration.id),
        String(registration.scope.id),
        registration.label,
      ))
    }
    called = true
    return tasks.startContinuation(origin, () => runWaterfall(
      origin,
      originScope,
      name,
      args.length === 0 ? request : args[0],
      terminal,
      registration.ordinal,
      upperBound,
      registrations,
      tasks,
    ))
  }) as MiddlewareNext<TRequest, TResult>

  try {
    return await tasks.runFrame(registration, () =>
      (registration.callback as MiddlewareHandler<TRequest, TResult>)(request, next))
  } finally {
    open = false
  }
}
