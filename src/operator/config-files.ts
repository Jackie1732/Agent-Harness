import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { EffectOwner } from '../effect/owner.js'
import { HostError } from '../host/errors.js'
import { parseBoundedJson } from '../schema/bounded-json.js'
import type { JsonValidationLimits } from '../schema/bounded-json.js'
import type { JsonValue } from '../foundation/json.js'
import type { ConfigWriteOptions } from './config-types.js'

/** Read at most the declared material budget, including files that grow during reading. */
export async function readConfigBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) throw new HostError('HOST_CONFIG_INVALID', 'config-file-size')
    const bytes = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    if (offset > maxBytes) throw new HostError('HOST_CONFIG_INVALID', 'config-file-size')
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}
/** Read finite file bytes before JSON decoding; revisions include the original whitespace. */
export async function readConfigFile(pathInput: string, limits: JsonValidationLimits): Promise<{ readonly path: string; readonly revision: string; readonly value: JsonValue }> {
  const path = resolve(pathInput), input = await readConfigBytes(path, limits.maxBytes)
  const source = new TextDecoder('utf-8', { fatal: true }).decode(input)
  return { path, revision: createHash('sha256').update(input).digest('hex'), value: parseBoundedJson(source, limits) }
}
async function fileRevision(path: string, maxBytes: number): Promise<string | null> {
  try { return createHash('sha256').update(await readConfigBytes(path, maxBytes)).digest('hex') }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause }
}

/** The lease covers cooperating editors; the final revision check also detects prior external edits. */
export async function publishConfigFile(pathInput: string, value: JsonValue, options: ConfigWriteOptions,
  limits: JsonValidationLimits, validate: () => void | Promise<void> = () => {}): Promise<string> {
  const input = resolve(pathInput)
  await mkdir(dirname(input), { recursive: true })
  const directory = await realpath(dirname(input)), path = join(directory, basename(input))
  const marker = join(directory, `.${basename(input)}.operator-lease`), token = randomUUID()
  const owner = new EffectOwner('operator-config-save')
  try {
    const lease = await owner.run('file-publication', async effect => {
      await effect.apply('single-writer', async () => {
        const handle = await open(marker, 'wx').catch(cause => {
          if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new HostError('HOST_LOCKED', 'config-editor-active-or-interrupted')
          throw cause
        })
        try { await handle.writeFile(token); await handle.sync() }
        catch (cause) { await handle.close(); await unlink(marker); throw cause }
        await handle.close()
        return marker
      }, async path => {
        const handle = await open(path, 'r')
        let observed: string
        try {
          const bytes = Buffer.alloc(37), read = await handle.read(bytes, 0, bytes.length, 0)
          observed = bytes.subarray(0, read.bytesRead).toString('utf8')
        } finally { await handle.close() }
        if (observed !== token) throw new HostError('HOST_CLEANUP_FAILED', 'config-lease-owner-changed')
        await unlink(path)
      })
      const current = await fileRevision(path, limits.maxBytes)
      if (current !== null && (!options.replace || options.expectedRevision !== current)
        || current === null && options.expectedRevision !== undefined) {
        throw new HostError('HOST_BINDING_CONFLICT', 'config-revision-conflict', { currentRevision: current })
      }
      await validate()
      const source = `${JSON.stringify(value, null, 2)}\n`
      if (Buffer.byteLength(source) > limits.maxBytes) throw new HostError('HOST_CONFIG_INVALID', 'config-file-size')
      const temporary = join(directory, `.${basename(input)}.${randomUUID()}.tmp`)
      await effect.apply('temporary-file', async () => {
        const handle = await open(temporary, 'wx')
        try { await handle.writeFile(source); await handle.sync() }
        catch (cause) { await handle.close(); await unlink(temporary); throw cause }
        await handle.close()
        return temporary
      }, async path => {
        try { await unlink(path) }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
      })
      const before = await fileRevision(path, limits.maxBytes)
      if (before !== current) throw new HostError('HOST_BINDING_CONFLICT', 'config-revision-conflict', { currentRevision: before })
      await rename(temporary, path)
      return createHash('sha256').update(source).digest('hex')
    })
    return lease.value
  } finally { await owner.dispose() }
}
