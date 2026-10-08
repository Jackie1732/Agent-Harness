/** Display projections leave stored data unchanged and admit only component-owned styling. */
import { stripVTControlCharacters } from 'node:util'

/**
 * Remove executable terminal controls and hide known credentials before rendering.
 * @param value Original text or an already JSON-encoded result.
 * @param secrets Credential values held only by this invocation.
 * @returns Plain display text with LF retained and TAB expanded to four spaces.
 */
export function plainText(value: string, secrets: readonly string[] = []): string {
  let result = value
  for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join('[hidden]')
  return stripVTControlCharacters(result).replace(/\t/g, '    ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
}

/**
 * Produce a bounded human-readable result; truncation is a display fact.
 * @param value Original typed result.
 * @param maxBytes Explicit display budget from the profile.
 * @param secrets Credentials excluded from every displayed result.
 * @returns Display JSON with a visible omission marker when its UTF-8 budget is reached.
 */
export function displayValue(value: unknown, maxBytes: number, secrets: readonly string[] = []): string {
  const text = plainText(JSON.stringify(value, null, 2) ?? 'null', secrets.flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)]))
  if (Buffer.byteLength(text) <= maxBytes) return text
  const parts: string[] = []
  let bytes = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maxBytes) break
    parts.push(character); bytes += size
  }
  return parts.join('') + '\n[显示已截断；原记录保持完整]'
}
