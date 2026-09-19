import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import assert from 'node:assert/strict'
import { decodeHostConfig, resolveHostConfig, openHost, ScriptedModelProvider } from '../../dist/index.js'

const path = process.argv[2]
const spec = resolveHostConfig(decodeHostConfig(JSON.parse(await readFile(path, 'utf8')), dirname(path)))
const released = []
const host = await openHost(spec, { bindings: { createModelProvider(member) {
  const provider = new ScriptedModelProvider({ ...member.model, script: async function* () {} })
  return { descriptor: provider.descriptor, prepare: request => provider.prepare(request), async dispose() {
    await provider.dispose(); released.push(member.agentKey)
    if (member.agentKey === 'reviewer') throw new Error('injected uncertain cleanup')
  } }
} } })
const first = host.shutdown()
assert.equal(host.shutdown(), first)
await assert.rejects(first, { code: 'HOST_CLEANUP_FAILED' })
assert.equal(host.status, 'failed')
assert.deepEqual(released.sort(), ['reviewer', 'writer'])
await assert.rejects(openHost(spec), { code: 'HOST_LOCKED' })
process.send({ kind: 'result', requestId: 'cleanup-failure', value: { released, retainedLock: true } })
process.disconnect()
