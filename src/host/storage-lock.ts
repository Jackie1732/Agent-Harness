import { randomUUID } from 'node:crypto'
import { mkdir, open, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { HostError } from './errors.js'
import { withHostStorageManagement } from './storage-management.js'

const lockFileName = '.atomic-harness.lock'

export interface HostStorageLockRecord {
  readonly schemaVersion: 1
  readonly hostKey: string
  readonly instanceId: string
  readonly token: string
  readonly processId: number
  readonly acquiredAt: string
}

/** Exclusive ownership of one canonical File Session root. */
export interface HostStorageLock {
  readonly root: string
  readonly record: HostStorageLockRecord
  dispose(): Promise<void>
}

function decodeRecord(value: unknown): HostStorageLockRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HostError('HOST_LOCKED', 'invalid-lock-record')
  const input = value as Record<string, unknown>
  const expected = ['schemaVersion', 'hostKey', 'instanceId', 'token', 'processId', 'acquiredAt']
  if (Object.keys(input).length !== expected.length || expected.some(key => !Object.hasOwn(input, key))
    || input.schemaVersion !== 1 || typeof input.hostKey !== 'string' || typeof input.instanceId !== 'string'
    || typeof input.token !== 'string' || !Number.isSafeInteger(input.processId) || typeof input.acquiredAt !== 'string') {
    throw new HostError('HOST_LOCKED', 'invalid-lock-record')
  }
  return Object.freeze(input) as unknown as HostStorageLockRecord
}

async function existingToken(path: string): Promise<string | null> {
  try {
    return (await readRecord(path)).token
  } catch {
    return null
  }
}

async function readRecord(path: string): Promise<HostStorageLockRecord> {
  const handle = await open(path, 'r')
  try {
    if (!(await handle.stat()).isFile()) throw new HostError('HOST_LOCKED', 'invalid-lock-record')
    const buffer = Buffer.alloc(8193)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size > 8192) throw new HostError('HOST_LOCKED', 'lock-record-too-large')
    return decodeRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))))
  } finally { await handle.close() }
}

/** Acquire the ownership marker before any Repository or Session Writer is opened. */
export async function acquireHostStorageLock(rootInput: string, hostKey: string): Promise<HostStorageLock> {
  await mkdir(rootInput, { recursive: true })
  const root = await realpath(rootInput)
  const path = join(root, lockFileName)
  return await withHostStorageManagement(root, 'acquire', async () => {
    const record: HostStorageLockRecord = Object.freeze({
      schemaVersion: 1,
      hostKey,
      instanceId: randomUUID(),
      token: randomUUID(),
      processId: process.pid,
      acquiredAt: new Date().toISOString(),
    })
    const bytes = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(bytes) > 8192) throw new HostError('HOST_CONFIG_INVALID', 'lock-record-too-large')
    const handle = await open(path, 'wx').catch(async cause => {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      throw new HostError('HOST_LOCKED', 'storage-root-owned', { token: await existingToken(path) })
    })
    try {
      await handle.writeFile(bytes, 'utf8')
      await handle.sync()
    } catch (cause) {
      try { await handle.close(); await unlink(path) }
      catch (cleanup) { throw new HostError('HOST_CLEANUP_FAILED', 'lock-acquisition-cleanup-failed', {}, { cause: new AggregateError([cause, cleanup]) }) }
      throw cause
    }
    await handle.close()
    let task: Promise<void> | undefined
    return Object.freeze({
      root,
      record,
      dispose() {
        task ??= withHostStorageManagement(root, 'release', async () => {
          let observed: HostStorageLockRecord
          try { observed = await readRecord(path) }
          catch (cause) {
            throw new HostError('HOST_CLEANUP_FAILED', 'storage-lock-unreadable', {}, cause instanceof Error ? { cause } : undefined)
          }
          if (observed.token !== record.token) throw new HostError('HOST_CLEANUP_FAILED', 'storage-lock-owner-changed')
          await unlink(path)
        })
        return task
      },
    })
  })
}

/** Remove a residual marker under exclusive management after its predecessor has stopped. */
export async function unlockHostStorage(
  rootInput: string,
  options: { readonly predecessorStopped: true; readonly expectedToken: string },
): Promise<void> {
  if (options.predecessorStopped !== true || options.expectedToken.length === 0) {
    throw new HostError('HOST_CONFIG_INVALID', 'unlock-confirmation-required')
  }
  const root = await realpath(rootInput)
  const path = join(root, lockFileName)
  await withHostStorageManagement(root, 'unlock', async () => {
    const observed = await readRecord(path)
    if (observed.token !== options.expectedToken) throw new HostError('HOST_LOCKED', 'unlock-token-mismatch')
    await unlink(path)
  })
}
