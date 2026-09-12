import { createEventName, createMiddlewareName } from '../../src/index.js'
import type {
  EventName,
  MiddlewareName,
  RegistrationId,
  RootScope,
  Scope,
  ScopeId,
} from '../../src/index.js'

// @ts-expect-error ScopeTree is an internal runtime record owner.
import type { ScopeTree } from '../../src/index.js'
// @ts-expect-error The event phantom symbol is intentionally private.
import type { eventPayload } from '../../src/index.js'
// @ts-expect-error The middleware phantom symbol is intentionally private.
import type { middlewareTypes } from '../../src/index.js'

const numberEvent = createEventName<{ readonly value: number }>('type.event')
const transform = createMiddlewareName<string, number>('type.middleware')
declare const scope: Scope
declare const root: RootScope
declare const scopeId: ScopeId
declare const registrationId: RegistrationId

scope.on(numberEvent, 'listener', payload => {
  const value: number = payload.value
  void value
})
scope.intercept(transform, 'handler', async (request, next) => {
  const input: string = request
  const currentResult: number = await next()
  const replacementResult: number = await next(input)
  // @ts-expect-error The next request is inferred from MiddlewareName.
  void next(42)
  return currentResult + replacementResult
})

void scope.emit(numberEvent, { value: 1 })
void scope.invoke(transform, 'request', request => request.length)

// @ts-expect-error Event payload is inferred from its name token.
void scope.emit(numberEvent, { value: 'wrong' })
// @ts-expect-error Middleware request is inferred from its name token.
void scope.invoke(transform, 42, () => 1)
// @ts-expect-error Middleware terminal result must match its name token.
void scope.invoke(transform, 'request', () => 'wrong')
// @ts-expect-error Middleware handler result must match its name token.
scope.intercept(transform, 'wrong result', () => 'wrong')
// @ts-expect-error A plain object cannot construct an EventName without its private marker.
const forgedEvent: EventName<number> = { name: 'forged' }
// @ts-expect-error A plain object cannot construct a MiddlewareName without its private marker.
const forgedMiddleware: MiddlewareName<string, number> = { name: 'forged' }
// @ts-expect-error Different event payload types are not interchangeable.
const wrongEvent: EventName<string> = numberEvent
// @ts-expect-error Different middleware request and result types are not interchangeable.
const wrongMiddleware: MiddlewareName<number, string> = transform
// @ts-expect-error Scope and registration identities are different brands.
const wrongId: ScopeId = registrationId
// @ts-expect-error A bare string is not a ScopeId.
const rawId: ScopeId = 's1'
// @ts-expect-error Root lifetime is owned by CapabilityRegistry.
void root.dispose()

void scopeId
void forgedEvent
void forgedMiddleware
void wrongEvent
void wrongMiddleware
void wrongId
void rawId
void (undefined as unknown as [ScopeTree, eventPayload, middlewareTypes])
