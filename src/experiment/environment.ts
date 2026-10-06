import type { JsonObject } from '../foundation/json.js'

/** Observe this controller; repository claims supplied by the caller remain separately unverified. */
export function experimentControllerEnvironment(entry: string): JsonObject {
  return Object.freeze({ nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    entry, revision: 'unverified', dirty: 'unverified', lockfileDigest: 'unverified', sourceArtifactRelationship: 'unverified' })
}
