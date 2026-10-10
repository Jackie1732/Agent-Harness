import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { StatOptions } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { expect, it } from 'vitest'
import { createReadTextDefinition, createWorkspaceReadTextProvider, createWorkspaceReadTextProviderWithIO } from '../../src/tool/providers/workspace-read.js'
import { createWriteTextDefinition, createWorkspaceWriteTextProvider } from '../../src/tool/providers/workspace-write.js'
import { nodeWorkspaceIO } from '../../src/tool/providers/workspace-io.js'

const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
const limits = { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536,
  maxArgumentsBytes: 4096, maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 65536, maxJournalConflicts: 4 }
class Resource { readonly value = 'workspace-authority' }
async function collect(): Promise<void> { await setImmediate(); queryObjects(Resource, { format: 'count' }) }
async function remove(root: string): Promise<void> { expect(dirname(root)).toBe(tmpdir()); await rm(root, { recursive: true }) }

it('keeps the read authority fixed across async configuration and execution-time borrowing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-tool-binding-')), seen: string[] = []
  const access = (name: string) => ({ assert() { seen.push(`${name}:assert`) },
    async borrow() { seen.push(`${name}:borrow`); return { release() { seen.push(`${name}:release`) } } } })
  const options = { rootId: 'work', rootPath: root, protectedRoots: [], maxReadBytes: 1024,
    maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 65536, schemaLimits, access: access('original') }
  let provider: Awaited<ReturnType<typeof createWorkspaceReadTextProvider>> | undefined
  try {
    await writeFile(join(root, 'data.txt'), 'abc')
    const creating = createWorkspaceReadTextProvider(options)
    options.access = access('replacement')
    provider = await creating
    const binding = provider.prepare(createReadTextDefinition(schemaLimits), { path: 'data.txt' }, limits)
    options.access = access('executing')
    const execution = await binding.acquire(binding.plan, new AbortController().signal)
    try { expect(await execution.start()).toMatchObject({ kind: 'success', value: { text: 'abc', byteLength: 3 } }) }
    finally { await execution.close() }
    expect(seen).toEqual(['original:assert', 'original:borrow', 'original:release'])
  } finally { await provider?.dispose(); await remove(root) }
})

it.each(['read', 'write'] as const)('retires native %s authority with a terminal Provider and unused binding retained', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-tool-retention-'))
  async function fixture() {
    const resource = new Resource()
    const access = { assert() { void resource.value }, async borrow() { return { release() { void resource.value } } } }
    const options = { rootId: 'work', rootPath: root, protectedRoots: [], maxReadBytes: 1024, maxWriteBytes: 1024,
      maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 65536, schemaLimits, access }
    const provider = await (mode === 'read' ? createWorkspaceReadTextProvider(options) : createWorkspaceWriteTextProvider(options))
    const selected = mode === 'read' ? createReadTextDefinition(schemaLimits) : createWriteTextDefinition(schemaLimits)
    const input = mode === 'read' ? { path: 'data.txt' } : { path: 'data.txt', text: 'hello' }
    const binding = provider.prepare(selected, input, limits)
    await provider.dispose()
    return { provider, binding, ref: new WeakRef(resource) }
  }
  try {
    const retained = await fixture(); await collect()
    expect(retained.ref.deref()).toBeUndefined()
    expect(retained.provider.dispose()).toBe(retained.provider.dispose())
    await expect(retained.binding.acquire(retained.binding.plan, new AbortController().signal)).rejects.toMatchObject({ code: 'TOOL_PROVIDER_INACTIVE' })
  } finally { await remove(root) }
})

it('confirms a newly written native file across path and Handle metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-tool-write-metadata-'))
  const text = '科研 observation', bytes = Buffer.from(text)
  const provider = await createWorkspaceWriteTextProvider({ rootId: 'work', rootPath: root, protectedRoots: [], maxWriteBytes: 1024,
    maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 65536, schemaLimits,
    access: { assert() {}, async borrow() { return { release() {} } } } })
  try {
    const binding = provider.prepare(createWriteTextDefinition(schemaLimits), { path: 'data.txt', text }, limits)
    const execution = await binding.acquire(binding.plan, new AbortController().signal)
    try {
      expect(await execution.start()).toEqual({ kind: 'success', value: { path: 'data.txt', byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') } })
    } finally { await execution.close() }
    expect(await readFile(join(root, 'data.txt'))).toEqual(bytes)
  } finally { await provider.dispose(); await remove(root) }
})

it.each(['device', 'inode'] as const)('rejects conflicting known file %s metadata', async field => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-tool-file-identity-'))
  let provider: Awaited<ReturnType<typeof createWorkspaceReadTextProvider>> | undefined
  try {
    await writeFile(join(root, 'data.txt'), 'abc')
    provider = await createWorkspaceReadTextProviderWithIO({ rootId: 'work', rootPath: root, protectedRoots: [], maxReadBytes: 1024,
      maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 65536, schemaLimits }, {
      ...nodeWorkspaceIO,
      open: async (path, flags) => {
        const handle = await nodeWorkspaceIO.open(path, flags)
        const stat = (async (options?: StatOptions) => {
          const observed = await handle.stat(options)
          const previous = field === 'device' ? observed.dev : observed.ino
          const value = field === 'device' ? (typeof previous === 'bigint' ? 2n : 2)
            : typeof previous === 'bigint' ? previous + 1n : previous + 1
          Object.defineProperty(observed, field === 'device' ? 'dev' : 'ino', { value })
          return observed
        }) as typeof handle.stat // Preserve Node's bigint-dependent overloads.
        return { read: handle.read.bind(handle), close: handle.close.bind(handle), stat }
      },
      lstat: async path => {
        const stat = await nodeWorkspaceIO.lstat(path)
        if (field !== 'device' || !path.endsWith('data.txt')) return stat
        // Both observations deliberately carry known, conflicting serials even on legacy Windows.
        Object.defineProperty(stat, 'dev', { value: 1n })
        return stat
      },
    })
    const binding = provider.prepare(createReadTextDefinition(schemaLimits), { path: 'data.txt' }, limits)
    const execution = await binding.acquire(binding.plan, new AbortController().signal)
    try { expect(await execution.start()).toEqual({ kind: 'error', code: 'TOOL_SOURCE_CHANGED' }) }
    finally { await execution.close() }
  } finally { await provider?.dispose(); await remove(root) }
})
