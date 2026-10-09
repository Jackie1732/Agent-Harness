import { createHash } from 'node:crypto'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import { ExperimentError } from './errors.js'

/** Durable Plan JSON ceilings apply to generated matrices and frozen input alike. */
export const experimentPlanJsonLimits = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxDepth: 64, maxNodes: 1_000_000 })

export function invalidExperiment(reason: string): never { throw new ExperimentError('EXPERIMENT_INPUT_INVALID', reason) }
export function experimentObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidExperiment(`${label}-object`)
  return value as Record<string, unknown>
}
export function experimentKeys(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) invalidExperiment(`${label}-fields`)
}
export function experimentText(value: unknown, label: string, maxBytes = 4096, allowEmpty = false): string {
  if (typeof value !== 'string' || !allowEmpty && value.length === 0 || Buffer.byteLength(value) > maxBytes) invalidExperiment(`${label}-text`)
  return value
}
export function experimentInteger(value: unknown, label: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalidExperiment(`${label}-integer`)
  return value as number
}
export function experimentArray(value: unknown, label: string, maximum = 10000): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalidExperiment(`${label}-array`)
  return value
}
export function experimentKey(value: unknown, label: string): string {
  const result = experimentText(value, label, 128)
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(result)) invalidExperiment(`${label}-key`)
  return result
}
export function experimentChoice<const T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalidExperiment(`${label}-choice`)
  return value as T
}
export function experimentUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalidExperiment(`${label}-duplicate`)
}
/** Require distinct portable files; a file cannot also be another file's parent directory. */
export function experimentFilePaths(values: readonly string[], label: string): void {
  const paths = values.map(value => value.toLowerCase())
  experimentUnique(paths, label)
  const files = new Set(paths)
  for (const path of paths) for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    if (files.has(path.slice(0, slash))) invalidExperiment(`${label}-file-directory-overlap`)
  }
}
export function experimentDigest(value: unknown, label: string): string {
  const result = experimentText(value, label, 64)
  if (!/^[0-9a-f]{64}$/.test(result)) invalidExperiment(`${label}-sha256`)
  return result
}
/** Digest raw file bytes without JSON reserialization. */
export function experimentBytesDigest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
/** Digest metadata under the project's sorted JSON encoding. */
export function experimentJsonDigest(value: JsonValue): string { return experimentBytesDigest(canonicalJsonBytes(value)) }
/** Require a portable relative path whose segments cannot escape the controlled resource. */
export function experimentRelativePath(value: unknown, label: string): string {
  const path = experimentText(value, label)
  if (path.includes('\\') || path.includes(':') || path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..'
    // eslint-disable-next-line no-control-regex -- Portable path segments exclude control characters.
    || /[\u0000-\u001f<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) invalidExperiment(`${label}-relative-path`)
  return path
}
