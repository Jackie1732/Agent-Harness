import type { ModelInvocationId, ModelProvider, ModelRequest, ModelFrame } from '../../src/model/index.js'
import type { SessionId } from '../../src/session/ids.js'
// @ts-expect-error The mutable journal is not part of the public model contract.
import type { ModelJournal } from '../../src/model/index.js'
// @ts-expect-error Provider capacity is an internal lifetime owner.
import type { ExchangeCapacity } from '../../src/model/index.js'

declare const sessionId: SessionId
declare const invocationId: ModelInvocationId
declare const provider: ModelProvider
declare const input: ModelRequest

// @ts-expect-error Session identity is not invocation identity.
const wrongInvocation: ModelInvocationId = sessionId
// @ts-expect-error Raw strings cannot supply a validated invocation identity.
const unvalidatedInvocation: ModelInvocationId = 'unvalidated'
// @ts-expect-error Token controls must be numeric.
const invalidInput: ModelRequest = { ...input, maxOutputTokens: '64' }
// @ts-expect-error A frame cannot name an unimplemented action kind.
const invalidFrame: ModelFrame = { kind: 'execute-tool', name: 'shell' }

const prepared = provider.prepare(input)
const key: string = invocationId
void [prepared, key, wrongInvocation, unvalidatedInvocation, invalidInput, invalidFrame]
// These types remain errors rather than accidentally becoming public exports.
const noInternals: [ModelJournal | undefined, ExchangeCapacity | undefined] = [undefined, undefined]
void noInternals
