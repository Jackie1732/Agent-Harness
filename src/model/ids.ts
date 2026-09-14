import { randomUUID } from 'node:crypto'
import { brand } from '../foundation/brand.js'
import type { Brand } from '../foundation/brand.js'
import { isCanonicalUuid } from '../foundation/protocol-scalars.js'
import { ModelError } from './errors.js'

/** One durable opportunity to issue at most one model request. */
export type ModelInvocationId = Brand<string, 'ModelInvocationId'>

/** Injectable identities; repeated experimental inputs still receive different IDs. */
export interface ModelIdentitySource {
  nextInvocationId(): ModelInvocationId
}

/** Validate without reflecting untrusted identity text into diagnostics. */
export function parseModelInvocationId(value: string): ModelInvocationId {
  if (typeof value !== 'string' || !isCanonicalUuid(value)) {
    throw new ModelError('MODEL_REQUEST_INVALID', 'model invocation identity must be a canonical UUID')
  }
  return brand<string, 'ModelInvocationId'>(value)
}

export const systemModelIdentitySource: ModelIdentitySource = Object.freeze({
  nextInvocationId: () => parseModelInvocationId(randomUUID()),
})
