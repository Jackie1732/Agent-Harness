import { createCapabilityKey } from '../../src/index.js'
import type { CapabilityErrorCode, CapabilityKey, ComponentContext } from '../../src/index.js'

// @ts-expect-error Evaluator classifications are internal to the capability implementation.
import type { ChangeClassification } from '../../src/index.js'
// @ts-expect-error Evaluator changes are internal to the capability implementation.
import type { ComponentChange } from '../../src/index.js'
// @ts-expect-error Evaluator declarations are internal to the capability implementation.
import type { ComponentDeclaration } from '../../src/index.js'
// @ts-expect-error Evaluator cycle records are internal to the capability implementation.
import type { CycleReport } from '../../src/index.js'
// @ts-expect-error Evaluator inputs are internal to the capability implementation.
import type { EvaluationInput } from '../../src/index.js'
// @ts-expect-error Evaluator results are internal to the capability implementation.
import type { EvaluationResult } from '../../src/index.js'
// @ts-expect-error Runtime provider bindings are internal to the capability implementation.
import type { ProviderBinding } from '../../src/index.js'
// @ts-expect-error Runtime provider instances are internal to the capability implementation.
import type { ProviderInstance } from '../../src/index.js'
// @ts-expect-error Runtime provider identities are internal to the capability implementation.
import type { ProviderInstanceId } from '../../src/index.js'
// @ts-expect-error Error construction options are internal to the capability implementation.
import type { CapabilityErrorOptions } from '../../src/index.js'

const textKey = createCapabilityKey<string>('type-test.text')
declare const context: ComponentContext

const text: string = context.require(textKey)
context.provide(textKey, 'value')

// @ts-expect-error A key cannot publish a value of another type.
context.provide(textKey, 42)

// @ts-expect-error Capability keys with different value types are not interchangeable.
const numberKey: CapabilityKey<number> = textKey

// @ts-expect-error Unsatisfied requirements are state, not a public capability error code.
const unsatisfiedCode: CapabilityErrorCode = 'CAPABILITY_UNSATISFIED'

void text
void numberKey
void unsatisfiedCode
void (undefined as unknown as [
  ChangeClassification,
  ComponentChange,
  ComponentDeclaration,
  CycleReport,
  EvaluationInput,
  EvaluationResult,
  ProviderBinding,
  ProviderInstance,
  ProviderInstanceId,
  CapabilityErrorOptions,
])
