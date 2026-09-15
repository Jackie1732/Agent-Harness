import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject } from '../foundation/json.js'
import { boundedJson } from '../schema/bounded-json.js'
import { parseSessionId, sessionLogPosition } from '../session/ids.js'
import type { SessionId, SessionLogPosition } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import type { ModelProviderDescriptor } from './contract.js'
import { ModelError } from './errors.js'
import { decodeProviderDescriptor } from './submission.js'
import { keys, object } from './validation.js'

/** Exact local input cut; a durable observation, never a reusable execution permission. */
export interface ModelInputPrecondition extends JsonObject {
  readonly sessionId: SessionId
  readonly expectedLocalPosition: SessionLogPosition
  readonly expectedProviderDescriptor: ModelProviderDescriptor
}

/** Copy before provider code and before the invocation yields to another writer. */
export function snapshotInputPrecondition(value: unknown): ModelInputPrecondition {
  try {
    const input = object(boundedJson(value, { maxBytes: 65536, maxDepth: 32, maxNodes: 8192 }), 'input precondition')
    keys(input, ['sessionId', 'expectedLocalPosition', 'expectedProviderDescriptor'])
    parseSessionId(typeof input.sessionId === 'string' ? input.sessionId : '')
    sessionLogPosition(input.expectedLocalPosition as number)
    decodeProviderDescriptor(object(input.expectedProviderDescriptor, 'expected provider descriptor'))
    return input as ModelInputPrecondition
  } catch {
    throw new ModelError('MODEL_REQUEST_INVALID', 'model input precondition is invalid')
  }
}

/** Preflight and CP0 use full descriptor equality, not a hash or providerId shortcut. */
export function assertInputPrecondition(
  snapshot: SessionSnapshot,
  descriptor: ModelProviderDescriptor,
  precondition: ModelInputPrecondition,
): void {
  if (snapshot.header.sessionId !== precondition.sessionId
    || snapshot.localPosition !== precondition.expectedLocalPosition
    || snapshot.lifecycle !== 'active'
    || !Buffer.from(canonicalJsonBytes(descriptor)).equals(
      Buffer.from(canonicalJsonBytes(precondition.expectedProviderDescriptor)),
    )) {
    throw new ModelError('MODEL_INPUT_STALE', 'model input no longer matches its Session cut or provider binding')
  }
}
