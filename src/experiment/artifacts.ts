import { join } from 'node:path'
import { parseBoundedJson } from '../schema/bounded-json.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import type { ExperimentFileRef } from './definition-types.js'
import { experimentBytesDigest } from './parsing.js'
import { readExperimentFile, publishExperimentFile } from './storage.js'
import { ExperimentError } from './errors.js'

/** Read only bytes authenticated by one committed file reference. */
export async function readExperimentArtifact(root: string, reference: ExperimentFileRef, maximum: number): Promise<unknown> {
  const bytes = await readExperimentFile(join(root, reference.path), maximum)
  if (bytes.byteLength !== reference.byteLength || experimentBytesDigest(bytes) !== reference.sha256) {
    throw new ExperimentError('EXPERIMENT_CONFLICT', 'referenced-artifact-changed')
  }
  return parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { maxBytes: maximum, maxDepth: 64, maxNodes: maximum })
}

/** Publish canonical JSON before the owning Journal operation references it. */
export function publishExperimentArtifact(root: string, path: string, value: JsonValue, maximum: number): Promise<ExperimentFileRef> {
  return publishExperimentFile(root, path, canonicalJsonBytes(value), maximum)
}
