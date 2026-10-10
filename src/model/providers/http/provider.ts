import { snapshotJson } from '../../../foundation/json.js'
import type { JsonObject } from '../../../foundation/json.js'
import type { ModelProviderDescriptor, ModelRequest, ModelStreamLimits, ModelSupport, PreparedModelCall, PreparedSubmission } from '../../contract.js'
import { ModelError } from '../../errors.js'
import { assertSameSubmission, createPreparedSubmission, decodeProviderDescriptor } from '../../submission.js'
import { ExchangeCapacity } from '../capacity.js'
import { ManagedModelExchange } from '../exchange.js'
import { ModelHttpClient } from './request.js'
import type { ModelStreamDecoder } from './request.js'

/** Explicit adapter configuration. HTTP is permitted only for literal loopback test hosts. */
export interface HttpModelProviderOptions {
  readonly providerId: string
  /** Complete API endpoint, without userinfo, query parameters, or fragment. */
  readonly endpoint: string
  readonly apiKey: string
  readonly streamLimits: ModelStreamLimits
  readonly maxConcurrentExchanges: number
}

export interface HttpProtocol {
  readonly name: string
  readonly version: string
  readonly support: ModelSupport
  readonly semanticHeaders: JsonObject
  readonly authentication: (apiKey: string) => Readonly<Record<string, string>>
  readonly encode: (request: ModelRequest, descriptor: ModelProviderDescriptor) => JsonObject
  readonly decode: ModelStreamDecoder
}

interface HttpProviderRuntime {
  readonly client: ModelHttpClient
  readonly protocol: HttpProtocol
  readonly authentication: Readonly<Record<string, string>>
}

/** Derive one HTTP Provider descriptor without reading credentials or creating a client. */
export function httpModelDescriptor(
  options: Omit<HttpModelProviderOptions, 'apiKey'>,
  protocol: Pick<HttpProtocol, 'name' | 'version' | 'support' | 'semanticHeaders'>,
): ModelProviderDescriptor {
  let endpoint: URL
  try { endpoint = new URL(options.endpoint) }
  catch { throw new ModelError('MODEL_REQUEST_INVALID', 'model endpoint is not an absolute URL') }
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
    throw new ModelError('MODEL_REQUEST_INVALID', 'model endpoint requires HTTPS except for literal loopback tests')
  }
  return decodeProviderDescriptor(snapshotJson({
    providerId: options.providerId, endpoint: endpoint.href, protocol: protocol.name, adapterVersion: protocol.version,
    support: protocol.support, semanticHeaders: protocol.semanticHeaders, streamLimits: options.streamLimits,
    maxConcurrentExchanges: options.maxConcurrentExchanges,
  }))
}

/** Owns admission and socket-pool lifetime; disposal retains only the safe descriptor and outcome. */
export class HttpModelProvider {
  readonly descriptor: ModelProviderDescriptor
  readonly #capacity: ExchangeCapacity
  #runtime: HttpProviderRuntime | undefined

  constructor(options: HttpModelProviderOptions, protocol: HttpProtocol) {
    if (typeof options.apiKey !== 'string' || options.apiKey.length === 0 || /[^\x21-\x7e]/.test(options.apiKey)) {
      throw new ModelError('MODEL_REQUEST_INVALID', 'model credential must be nonempty printable ASCII without whitespace')
    }
    this.descriptor = httpModelDescriptor(options, protocol)
    this.#capacity = new ExchangeCapacity(options.maxConcurrentExchanges)
    this.#runtime = { client: new ModelHttpClient(), protocol, authentication: Object.freeze(protocol.authentication(options.apiKey)) }
    Object.freeze(this)
  }

  prepare(request: ModelRequest): PreparedModelCall {
    this.#capacity.assertActive()
    const submission = createPreparedSubmission(request, this.descriptor, this.#runtime!.protocol.encode(request, this.descriptor))
    let acquired = false
    return Object.freeze({
      submission,
      acquire: (committed: PreparedSubmission, signal: AbortSignal) => {
        if (acquired) throw new ModelError('MODEL_STATE_INVALID', 'prepared HTTP binding may acquire only once')
        assertSameSubmission(submission, committed)
        const ticket = this.#capacity.reserve()
        const runtime = this.#runtime!
        const capacity = this.#capacity
        acquired = true
        try {
          const request = runtime.client.create(committed, runtime.authentication, runtime.protocol.decode)
          return new ManagedModelExchange({
            assertActive: () => capacity.assertActive(),
            open: currentSignal => request.open(currentSignal), release: () => request.close(),
          }, signal, ticket)
        } catch (reason) { ticket.settle(); throw reason }
      },
    })
  }

  dispose(): Promise<void> {
    return this.#capacity.dispose(() => {
      const runtime = this.#runtime!
      this.#runtime = undefined
      runtime.client.close()
    })
  }
}
