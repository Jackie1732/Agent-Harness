const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Check the canonical lower-case UUID representation used by durable identities. */
export function isCanonicalUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/** Check the canonical UTC ISO representation used by durable timestamps. */
export function isCanonicalIsoTimestamp(value: string): boolean {
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
}
