import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { HostError } from './errors.js'

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
    return decodeRecord(JSON.parse(await readFile(path, 'utf8'))).token
  } catch {
    return null
  }
}

/** Acquire the ownership marker before any Repository or Session Writer is opened. */
export async function acquireHostStorageLock(rootInput: string, hostKey: string): Promise<HostStorageLock> {
  await mkdir(rootInput, { recursive: true })
  const root = await realpath(rootInput)
  const path = join(root, lockFileName)
  let handle: FileHandle
  try {
    handle = await open(path, 'wx+')
  } catch (cause) {
    const code = cause !== null && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
    if (code !== 'EEXIST') throw cause
    throw new HostError('HOST_LOCKED', 'storage-root-owned', { token: await existingToken(path) })
  }
  const record: HostStorageLockRecord = Object.freeze({
    schemaVersion: 1,
    hostKey,
    instanceId: randomUUID(),
    token: randomUUID(),
    processId: process.pid,
    acquiredAt: new Date().toISOString(),
  })
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    await handle.sync()
  } catch (cause) {
    await handle.close().catch(() => undefined)
    await unlink(path).catch(() => undefined)
    throw cause
  }
  let task: Promise<void> | undefined
  return Object.freeze({
    root,
    record,
    dispose() {
      task ??= (async () => {
        let observed: HostStorageLockRecord
        try { observed = decodeRecord(JSON.parse(await readFile(path, 'utf8'))) }
        catch (cause) {
          throw new HostError('HOST_CLEANUP_FAILED', 'storage-lock-unreadable', {}, cause instanceof Error ? { cause } : undefined)
        }
        if (observed.token !== record.token) throw new HostError('HOST_CLEANUP_FAILED', 'storage-lock-owner-changed')
        await handle.close()
        await unlink(path)
      })()
      return task
    },
  })
}

/** Remove one residual marker only after an operator confirms its predecessor stopped. */
export async function unlockHostStorage(
  rootInput: string,
  options: { readonly predecessorStopped: true; readonly expectedToken: string },
): Promise<void> {
  if (options.predecessorStopped !== true || options.expectedToken.length === 0) {
    throw new HostError('HOST_CONFIG_INVALID', 'unlock-confirmation-required')
  }
  const root = await realpath(rootInput)
  const path = join(root, lockFileName)
  const observed = decodeRecord(JSON.parse(await readFile(path, 'utf8')))
  if (observed.token !== options.expectedToken) throw new HostError('HOST_LOCKED', 'unlock-token-mismatch')
  await unlink(path)
}
