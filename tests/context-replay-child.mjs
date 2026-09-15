import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { rebuildAssembly } from '../dist/index.js'

const path = process.argv[2]
if (path === undefined) throw new Error('snapshot path is required')
const input = JSON.parse(await readFile(path, 'utf8'))
const rebuilt = rebuildAssembly(input.snapshot, input.assemblyEventId)
assert.equal(rebuilt.kind, 'rebuilt')
assert.equal(rebuilt.assembly.requestDigest, input.requestDigest)
process.stdout.write('context-replay-child: ok\n')
