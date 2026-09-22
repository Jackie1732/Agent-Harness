import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import { mkdtemp, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireHostStorageLock, unlockHostStorage } from '../dist/host/index.js'

function peer(root) {
  const child = fork(new URL('./fixtures/host-lock-child.mjs', import.meta.url), [root], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const pending = new Map()
  let sequence = 0
  child.on('message', message => pending.get(`${message.id}:${message.barrier === true}`)?.(message))
  function send(kind, options = {}) {
    const id = ++sequence
    let atBarrier
    const done = new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); pending.delete(`${id}:false`); child.off('exit', lost) }
      const lost = () => { cleanup(); reject(new Error(`child exited: ${kind}`)) }
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`child timeout: ${kind}`)) }, 15_000)
      child.once('exit', lost)
      pending.set(`${id}:false`, message => { cleanup(); resolve(message) })
    })
    if (options.pause) atBarrier = new Promise(resolve => pending.set(`${id}:true`, message => { pending.delete(`${id}:true`); resolve(message) }))
    child.send({ id, kind, ...options })
    return { done, atBarrier }
  }
  return { send, continue: () => child.send({ kind: 'continue' }),
    async exit() { child.send({ kind: 'exit' }); assert.equal(await exited, 0) },
    async kill() { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited } }
}

test('concurrent unlock and acquire cannot delete a successor marker across real processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-lock-process-'))
  const predecessor = peer(root)
  const token = (await predecessor.send('acquire').done).value
  await predecessor.exit()
  const first = peer(root); const second = peer(root); const successor = peer(root)
  try {
    const delayed = first.send('unlock', { token, pause: true }); await delayed.atBarrier
    assert.equal((await second.send('unlock', { token }).done).error, 'HOST_LOCKED')
    assert.equal((await successor.send('acquire').done).error, 'HOST_LOCKED')
    first.continue(); assert.equal((await delayed.done).error, undefined)
    const fresh = (await successor.send('acquire').done).value; assert.ok(fresh); assert.notEqual(fresh, token)
    assert.equal((await second.send('unlock', { token }).done).error, 'HOST_LOCKED')
    assert.equal((await first.send('acquire').done).error, 'HOST_LOCKED')
    assert.equal(JSON.parse(await readFile(join(root, '.atomic-harness.lock'), 'utf8')).token, fresh)
    const releasing = successor.send('dispose', { pause: true }); await releasing.atBarrier
    assert.equal((await first.send('acquire').done).error, 'HOST_LOCKED')
    successor.continue(); assert.equal((await releasing.done).error, undefined)
    assert.ok((await first.send('acquire').done).value)
    assert.equal((await successor.send('dispose').done).error, undefined)
    assert.equal((await second.send('acquire').done).error, 'HOST_LOCKED')
    assert.equal((await first.send('dispose').done).error, undefined)
  } finally { await Promise.all([first.kill(), second.kill(), successor.kill()]) }
})

test('interrupted management fails closed until externally quiesced offline recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-lock-interrupted-'))
  const predecessor = peer(root)
  const token = (await predecessor.send('acquire').done).value
  await predecessor.exit()
  const manager = peer(root)
  const delayed = manager.send('unlock', { token, pause: true }); await delayed.atBarrier
  // A killed operation has no settlement response; consume its watchdog rejection.
  void delayed.done.catch(() => undefined)
  await manager.kill()
  await assert.rejects(acquireHostStorageLock(root, 'successor'), { code: 'HOST_LOCKED' })
  await assert.rejects(unlockHostStorage(root, { predecessorStopped: true, expectedToken: token }), { code: 'HOST_LOCKED' })
  // All children have exited; this test owns the newly created private root exclusively.
  await unlink(join(root, '.atomic-harness.lock.management'))
  await unlockHostStorage(root, { predecessorStopped: true, expectedToken: token })
  const successor = await acquireHostStorageLock(root, 'successor')
  await successor.dispose()
})
