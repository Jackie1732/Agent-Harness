import type { CONTROL_PROTOCOL, CONTROL_VERSION, ControlMethod } from './constants.js'
import type { ApiErrorData } from './errors.js'
import type { Params, Result } from './methods.js'
import type { RequestId } from './references.js'

interface Envelope { readonly protocol: typeof CONTROL_PROTOCOL; readonly version: typeof CONTROL_VERSION }
export type ControlRequest<M extends ControlMethod = ControlMethod> = Envelope & { readonly requestId: RequestId; readonly method: M; readonly params: Params<M> }
export type AnyControlRequest = { [M in ControlMethod]: ControlRequest<M> }[ControlMethod]
export type ControlResult<M extends ControlMethod = ControlMethod> = Envelope & { readonly requestId: RequestId; readonly kind: 'result'; readonly result: Result<M> }
export type ControlError = Envelope & { readonly requestId: RequestId | null; readonly kind: 'error'; readonly error: ApiErrorData }
export type ControlResponse<M extends ControlMethod = ControlMethod> = ControlResult<M> | ControlError
