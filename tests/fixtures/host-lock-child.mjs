import filesystem from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const root = process.argv[2]
const unlink = filesystem.unlink
let blocked
let pauseId
filesystem.unlink = async path => {
  if (path === join(root, '.atomic-harness.lock') && pauseId !== undefined) {
    const id = pauseId; pauseId = undefined
    await new Promise(resolve => { blocked = resolve; process.send({ id, barrier: true }) })
  }
  return await unlink(path)
}
syncBuiltinESMExports()
const { acquireHostStorageLock, unlockHostStorage } = await import('../../dist/host/index.js')
let lease
process.on('message', async command => {
  try {
    if (command.kind === 'continue') { blocked(); return }
    if (command.pause) pauseId = command.id
    let value
    if (command.kind === 'acquire') { lease = await acquireHostStorageLock(root, 'child'); value = lease.record.token }
    else if (command.kind === 'unlock') await unlockHostStorage(root, { predecessorStopped: true, expectedToken: command.token })
    else if (command.kind === 'dispose') await lease.dispose()
    else if (command.kind === 'exit') { process.disconnect(); return }
    process.send({ id: command.id, value })
  } catch (error) { process.send({ id: command.id, error: error.code ?? error.message }) }
})
