import type { JsonValue } from '../foundation/json.js'

/** Configuration owners supported by the operator. */
export type ConfigKind = 'operator' | 'host' | 'api' | 'ui' | 'automation' | 'experiment'
export type ConfigOperation = { readonly op: 'set' | 'insert'; readonly pointer: string; readonly value: JsonValue }
  | { readonly op: 'remove'; readonly pointer: string }
export interface ConfigCheck {
  readonly kind: ConfigKind
  readonly status: 'valid' | 'needs-plan' | 'dependency-needs-plan'
  readonly protocolVersion: 1 | 2 | 3 | null
  readonly normalized: JsonValue
}
export interface ConfigDocument {
  readonly kind: ConfigKind
  readonly path: string
  readonly revision: string
  readonly value: JsonValue
  readonly check: ConfigCheck
}
/** Original file bytes remain editable when the current static check fails. */
export interface ConfigEditableDocument extends Omit<ConfigDocument, 'check'> {
  readonly check: ConfigCheck | null
  readonly failure: { readonly code: string; readonly message: string } | null
}
/** Creation refuses existing targets unless replacement names their exact revision. */
export interface ConfigWriteOptions { readonly replace?: boolean; readonly expectedRevision?: string }
export interface ConfigWriteStep { readonly kind: ConfigKind; readonly path: string; readonly revision: string }
export interface ConfigDiff {
  readonly revision: string
  readonly changedPointers: readonly string[]
  readonly effect: 'unchanged' | 'reload-display' | 'restart' | 'new-journal' | 'new-experiment-plan' | 'admission-check-required'
  readonly binding: 'not-checked' | 'compatible' | 'incompatible'
  readonly reason: string | null
}
/** A partial result preserves a published file when profile linking failed. */
export interface ConfigMutationResult {
  readonly document: ConfigDocument
  readonly diff: ConfigDiff
  readonly steps: readonly ConfigWriteStep[]
  readonly failure: { readonly code: string; readonly message: string } | null
}
export interface ConfigReadiness {
  readonly kind: ConfigKind
  readonly status: 'ready' | 'not-ready' | 'needs-plan' | 'dependency-needs-plan' | 'admission-check-required'
  readonly evidence: readonly { readonly subject: string; readonly status: 'available' | 'missing' | 'compatible' | 'incompatible'; readonly reason: string | null }[]
}
