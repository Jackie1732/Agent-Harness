import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HostError } from './errors.js'

/**
 * Serializes marker mutations across cooperating processes on a canonical local root.
 * Contenders fail closed. A crash leaves the management marker in place: recovery
 * requires externally stopping ALL users/administrators of this root before manually
 * removing that marker. Token unlock never removes it or guesses owner liveness.
 */
export async function withHostStorageManagement<T>(root: string, operation: string, action: () => Promise<T>): Promise<T> {
  const path = join(root, '.atomic-harness.lock.management')
  const handle = await open(path, 'wx').catch(cause => {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new HostError('HOST_LOCKED', 'storage-management-active-or-interrupted')
    throw cause
  })
  let failed = false
  let failure: unknown
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, token: randomUUID(), processId: process.pid, operation })}\n`)
    await handle.sync()
    return await action()
  } catch (cause) { failed = true; failure = cause; throw cause }
  finally {
    // Failure to close or remove the guard retains exclusion for explicit offline recovery.
    try { await handle.close(); await unlink(path) }
    catch (cleanup) {
      throw new HostError('HOST_CLEANUP_FAILED', 'storage-management-retained', {},
        { cause: failed ? new AggregateError([failure, cleanup]) : cleanup })
    }
  }
}
