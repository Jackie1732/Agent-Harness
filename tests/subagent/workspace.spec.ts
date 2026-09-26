import { mkdtemp, mkdir, readFile, writeFile, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorkspaceAuthority } from '../../src/subagent/workspace.js'
import { createWorkspaceWriteTextProviderWithIO, createWriteTextDefinition } from '../../src/tool/providers/workspace-write.js'
import { nodeWorkspaceIO } from '../../src/tool/providers/workspace-io.js'
import { clock } from '../agent/fixtures.js'

const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
const limits = { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096, maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delegation-workspace-'))
  await mkdir(join(root, 'out')); await mkdir(join(root, 'in')); await writeFile(join(root, 'in/source.txt'), 'source')
  const authority = await WorkspaceAuthority.create([{ resourceId: 'work', rootPath: root, mode: 'exclusive-write', protectedRoots: [],
    readPrefixes: ['in', 'out'], writePrefixes: ['out'], maxBaselineFiles: 4, maxBaselineBytes: 4096 }], [root], [], clock)
  return { root, authority, request: { kind: 'exclusive-write' as const, resourceId: 'work', readFiles: ['in/source.txt'], writePrefixes: ['out'] } }
}

it('shares a read gate with static parents, hashes exact input files and retains writer ownership until the final borrower closes', async () => {
  const f = await fixture()
  try {
    const read = await f.authority.staticAccess(f.root).borrow('out/existing.txt', 'read')
    expect(f.authority.available(f.request)).toBe(false)
    expect(() => f.authority.reserve(f.request, 4, 4096)).toThrow('workspace-busy')
    read.release(true); await Promise.resolve(); await Promise.resolve()
    expect(f.authority.available(f.request)).toBe(true)
    const lease = f.authority.reserve(f.request, 4, 4096)
    expect((await lease.baseline()).entries).toMatchObject([{ path: 'in/source.txt', byteLength: 6 }])
    const borrowed = await lease.borrow('out/new.txt', 'write')
    let closed = false; const close = lease.dispose().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false)
    expect(() => f.authority.reserve(f.request, 4, 4096)).toThrow('workspace-busy')
    borrowed.release(true); await close
    expect(f.authority.available(f.request)).toBe(true)
    const next = f.authority.reserve(f.request, 4, 4096); await next.dispose()
  } finally { await f.authority.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

it.each(['normal', 'short', 'zero', 'sync', 'close'] as const)('creates files exclusively and handles %s I/O honestly', async failure => {
  const f = await fixture()
  const lease = f.authority.reserve(f.request, 4, 4096)
  let writes = 0
  const provider = await createWorkspaceWriteTextProviderWithIO({ rootId: 'work', rootPath: f.root, protectedRoots: [], maxWriteBytes: 1024,
    maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 8192, schemaLimits, access: lease }, { ...nodeWorkspaceIO, open: async (path, flags) => {
      const handle = await open(path, flags)
      return { read: handle.read.bind(handle), stat: handle.stat.bind(handle),
        write: (async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          writes++
          if (failure === 'zero') return { bytesWritten: 0, buffer }
          return handle.write(buffer, offset, failure === 'short' ? Math.min(2, length) : length, position)
        }) as typeof handle.write,
        sync: async () => { if (failure === 'sync') throw new Error('injected sync'); await handle.sync() },
        close: async () => { await handle.close(); if (failure === 'close') throw new Error('injected close acknowledgement') },
      }
    } })
  const definition = createWriteTextDefinition(schemaLimits)
  try {
    const prepared = provider.prepare(definition, { path: 'out/result.txt', text: '结果 verified' }, limits)
    await expect(readFile(join(f.root, 'out/result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const execution = await prepared.acquire(prepared.plan, new AbortController().signal)
    const result = await execution.start()
    if (failure === 'zero' || failure === 'sync') expect(result.kind).toBe('error')
    else { expect(result.kind).toBe('success'); expect(await readFile(join(f.root, 'out/result.txt'), 'utf8')).toBe('结果 verified') }
    if (failure === 'short') expect(writes).toBeGreaterThan(1)
    if (failure === 'close') {
      await expect(execution.close()).rejects.toMatchObject({ code: 'TOOL_CLEANUP_FAILED' })
      await expect(lease.dispose()).rejects.toThrow('workspace-cleanup-incomplete')
      expect(() => f.authority.reserve(f.request, 4, 4096)).toThrow('workspace-busy')
    } else {
      await execution.close()
      const retry = provider.prepare(definition, { path: 'out/result.txt', text: 'must not overwrite' }, limits)
      const repeated = await retry.acquire(retry.plan, new AbortController().signal)
      expect(await repeated.start()).toEqual({ kind: 'error', code: 'already-exists' }); await repeated.close()
    }
  } finally {
    const results = await Promise.allSettled([provider.dispose(), lease.dispose(), f.authority.dispose()])
    expect(results.map(item => item.status)).toEqual(failure === 'close' ? ['rejected', 'rejected', 'rejected'] : ['fulfilled', 'fulfilled', 'fulfilled'])
    await rm(f.root, { recursive: true, force: true })
  }
})
