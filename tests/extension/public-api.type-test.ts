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

interface Animal { readonly kind: string }
interface Dog extends Animal { bark(): void }
const dogEvent = createEventName<Dog>('type.dog-event')
const animalEvent = createEventName<Animal>('type.animal-event')
scope.on(dogEvent, 'general listener', (payload: Animal) => { void payload.kind })
// @ts-expect-error Widening a token would let emit supply a payload its listeners cannot use.
const widenedEvent: EventName<Animal> = dogEvent
// @ts-expect-error Narrowing a token would let on register a listener that cannot use every payload.
const narrowedEvent: EventName<Dog> = animalEvent
// @ts-expect-error The token's payload cannot widen through the emit argument.
void scope.emit(dogEvent, { kind: 'cat' })
// @ts-expect-error The listener cannot narrow the token's payload.
scope.on(animalEvent, 'dog-only listener', (payload: Dog) => payload.bark())
const dogMiddleware = createMiddlewareName<Dog, Dog>('type.dog-middleware')
const animalMiddleware = createMiddlewareName<Animal, Animal>('type.animal-middleware')
// @ts-expect-error Widening the request would admit values the registered handler cannot use.
const widenedRequest: MiddlewareName<Animal, Dog> = dogMiddleware
// @ts-expect-error Narrowing the request would allow a handler that cannot use every input.
const narrowedRequest: MiddlewareName<Dog, Animal> = animalMiddleware
// @ts-expect-error Widening the result would admit terminal results the registered handlers cannot use.
const widenedResult: MiddlewareName<Dog, Animal> = dogMiddleware
// @ts-expect-error Narrowing the result would misdescribe an existing handler's result.
const narrowedResult: MiddlewareName<Animal, Dog> = animalMiddleware
// @ts-expect-error The request cannot widen through the invoke argument.
void scope.invoke(dogMiddleware, { kind: 'cat' }, request => request)
// @ts-expect-error The result cannot widen through the terminal callback.
void scope.invoke(dogMiddleware, { kind: 'dog', bark() {} }, () => ({ kind: 'cat' }))
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
void widenedEvent
void narrowedEvent
void widenedRequest
void narrowedRequest
void widenedResult
void narrowedResult
void wrongId
void rawId
void (undefined as unknown as [ScopeTree, eventPayload, middlewareTypes])
