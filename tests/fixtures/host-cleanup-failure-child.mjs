import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import assert from 'node:assert/strict'
import { decodeHostConfig, resolveHostConfig, openHost, ScriptedModelProvider } from '../../dist/index.js'

const path = process.argv[2]
const spec = resolveHostConfig(decodeHostConfig(JSON.parse(await readFile(path, 'utf8')), dirname(path)))
const released = []
const constructed = []
let prepared = 0
const rollback = process.argv[3] === 'rollback'
let failCleanup = !rollback
let wrongDescriptor = false
const host = await openHost(spec, { bindings: { createModelProvider(member) {
  constructed.push(member.agentKey)
  const provider = new ScriptedModelProvider({ ...member.model, script: async function* () {} })
  return { descriptor: wrongDescriptor && member.agentKey === 'reviewer' ? { ...provider.descriptor, providerId: 'wrong' } : provider.descriptor,
    prepare: request => { prepared++; return provider.prepare(request) }, async dispose() {
    await provider.dispose(); released.push(member.agentKey)
    if (member.agentKey === 'reviewer' && failCleanup) throw new Error('injected uncertain cleanup')
  } }
} } })
if (rollback) {
  await host.setMailboxOnline('reviewer', false)
  failCleanup = true; wrongDescriptor = true
  await assert.rejects(host.setMailboxOnline('reviewer', true), { code: 'HOST_CLEANUP_FAILED' })
} else await assert.rejects(host.setMailboxOnline('reviewer', false))
assert.equal(host.report().counts.blockedMembers, 1)
const before = [...constructed]
for (let attempt = 0; attempt < 3; attempt++) {
  await assert.rejects(host.setMailboxOnline('reviewer', true), error => {
    assert.equal(error.code, 'HOST_CLEANUP_FAILED')
    assert.equal(error.details.agentKey, 'reviewer')
    assert.equal(error.details.generation, rollback ? 2 : 1)
    return true
  })
  host.resume('reviewer')
  assert.equal(host.report().counts.blockedMembers, 1)
}
assert.deepEqual(constructed, before)
assert.equal(prepared, 0)
const first = host.shutdown()
assert.equal(host.shutdown(), first)
await assert.rejects(first, { code: 'HOST_CLEANUP_FAILED' })
assert.equal(host.status, 'failed')
assert.deepEqual(released.sort(), rollback ? ['reviewer', 'reviewer', 'writer'] : ['reviewer', 'writer'])
await assert.rejects(openHost(spec), { code: 'HOST_LOCKED' })
process.send({ kind: 'result', requestId: 'cleanup-failure', value: { released, retainedLock: true } })
process.disconnect()
