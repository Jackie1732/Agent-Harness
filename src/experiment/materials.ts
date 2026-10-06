import { open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseBoundedJson } from '../schema/bounded-json.js'
import type { ExperimentMaterial, FrozenExperimentMaterial } from './definition-types.js'
import { experimentBytesDigest, invalidExperiment } from './parsing.js'
import { ExperimentError } from './errors.js'

/** Resolve existing ancestors without creating the planned output directory. */
export async function canonicalExperimentPath(input: string): Promise<string> {
  const path = resolve(input)
  try { return await realpath(path) }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    const parent = dirname(path)
    if (parent === path) throw cause
    return resolve(await canonicalExperimentPath(parent), relative(parent, path))
  }
}
/** Test containment in either direction for already canonical absolute directories. */
export function experimentPathsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const part = relative(parent, child)
    return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
  }
  return contains(left, right) || contains(right, left)
}

/** Read a bounded file through its opened handle; a growing file cannot exceed the declared input budget. */
async function readMaterial(path: string, maximum: number): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const information = await handle.stat()
    if (!information.isFile()) invalidExperiment('material-not-file')
    if (information.size > maximum) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'input-bytes-limit')
    const bytes = Buffer.alloc(information.size + 1)
    let size = 0
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size)
      if (read.bytesRead === 0) break
      size += read.bytesRead
    }
    if (size > information.size) throw new ExperimentError('EXPERIMENT_CONFLICT', 'material-changed-during-read')
    return bytes.subarray(0, size)
  } finally { await handle.close() }
}

/** Freeze exact UTF-8 bytes independently of source paths and execution recipes. */
export async function freezeExperimentMaterials(materials: readonly ExperimentMaterial[], maximum: number): Promise<readonly FrozenExperimentMaterial[]> {
  const frozen: FrozenExperimentMaterial[] = []
  let used = 0
  for (const material of materials) {
    const bytes = material.source.kind === 'inline' ? Buffer.from(material.source.text, 'utf8') : await readMaterial(material.source.path, maximum - used)
    used += bytes.byteLength
    if (used > maximum) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'input-bytes-limit')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch (cause) { throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'material-utf8', {}, { cause }) }
    if (material.source.kind === 'inline' && text !== material.source.text) invalidExperiment('material-unicode')
    if (material.mediaType === 'application/json') parseBoundedJson(text, { maxBytes: maximum, maxDepth: 64, maxNodes: 100_000 })
    const sha256 = experimentBytesDigest(bytes)
    if (material.expectedSha256 !== null && material.expectedSha256 !== sha256) throw new ExperimentError('EXPERIMENT_CONFLICT', 'material-digest-mismatch')
    frozen.push(Object.freeze({ logicalPath: material.logicalPath, mediaType: material.mediaType, text, byteLength: bytes.byteLength, sha256 }))
  }
  return Object.freeze(frozen)
}
