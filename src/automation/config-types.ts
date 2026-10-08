import type { ClientLimits } from '../client/config.js'
import type { SessionId } from '../session/ids.js'

/** Fixed local Job selection; external events supply only their identity and text. */
export interface AutomationJob {
  readonly jobKey: string
  readonly agentKey: string
  readonly trigger: { readonly kind: 'webhook' } | { readonly kind: 'interval'; readonly anchor: string; readonly intervalMs: number; readonly text: string }
}
/** HTTPS and queue resources owned by one automation service. */
export interface AutomationLimits {
  readonly maxRequestBytes: number; readonly maxResponseBytes: number; readonly maxJsonDepth: number; readonly maxJsonNodes: number
  readonly maxHeaderBytes: number; readonly maxConnections: number; readonly maxPendingRequests: number; readonly maxQueued: number
  readonly requestReadTimeoutMs: number; readonly responseWriteTimeoutMs: number; readonly headersTimeoutMs: number
  readonly tlsHandshakeTimeoutMs: number; readonly keepAliveTimeoutMs: number; readonly observeIntervalMs: number
}
/** Closed v1 configuration, containing file and environment references rather than secrets. */
export interface AutomationConfig {
  readonly schemaVersion: 1
  readonly automationKey: string
  readonly hostKey: string
  readonly journal: { readonly root: string; readonly sessionId: SessionId; readonly maxRecordBytes: number; readonly maxTriggers: number; readonly maxEvents: number }
  readonly client: { readonly origin: string; readonly serverName: string | null; readonly tls: { readonly caFile: string; readonly certFile: string; readonly keyFile: string }; readonly limits: ClientLimits }
  readonly webhook: { readonly listenHost: string; readonly listenPort: number; readonly tls: { readonly certFile: string; readonly keyFile: string }; readonly bearerTokenEnv: string }
  readonly limits: AutomationLimits
  readonly jobs: readonly AutomationJob[]
}
