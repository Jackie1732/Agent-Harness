import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { publishConfigFile, readConfigFile } from '../src/operator/config-files.js'

const roots: string[] = []
const limits = { maxBytes: 65536, maxDepth: 16, maxNodes: 10000 }
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'operator-config-files-')); roots.push(root); return { root, path: join(root, 'config.json') } }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('configuration publication ownership', () => {
  it('uses the exact previous bytes for replacement even when the destination JSON is invalid', async () => {
    const { root, path } = await fixture(), source = 'incomplete JSON'
    await writeFile(path, source)
    const expectedRevision = createHash('sha256').update(source).digest('hex')
    await publishConfigFile(path, { value: 1 }, { replace: true, expectedRevision }, limits)
    expect((await readConfigFile(path, limits)).value).toEqual({ value: 1 })
    expect(await readdir(root)).toEqual(['config.json'])
  })
  it('refuses an existing target and a changed byte revision and cleans temporary ownership', async () => {
    const { root, path } = await fixture()
    const revision = await publishConfigFile(path, { value: 1 }, {}, limits)
    await expect(publishConfigFile(path, { value: 2 }, {}, limits)).rejects.toMatchObject({ message: 'config-revision-conflict' })
    await writeFile(path, '{"value":1}\n')
    await expect(publishConfigFile(path, { value: 2 }, { replace: true, expectedRevision: revision }, limits)).rejects.toMatchObject({ message: 'config-revision-conflict' })
    expect(await readFile(path, 'utf8')).toBe('{"value":1}\n')
    expect(await readdir(root)).toEqual(['config.json'])
  })
  it('excludes another cooperating saver and detects an external edit during validation', async () => {
    const { root, path } = await fixture(), revision = await publishConfigFile(path, { value: 1 }, {}, limits)
    let entered!: () => void, resume!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), released = new Promise<void>(resolve => { resume = resolve })
    const first = publishConfigFile(path, { value: 2 }, { replace: true, expectedRevision: revision }, limits, async () => { entered(); await released })
    await ready
    try {
      await expect(publishConfigFile(path, { value: 3 }, { replace: true, expectedRevision: revision }, limits)).rejects.toMatchObject({ code: 'HOST_LOCKED' })
      await writeFile(path, '{"external":true}\n')
    } finally { resume() }
    await expect(first).rejects.toMatchObject({ message: 'config-revision-conflict' })
    expect((await readConfigFile(path, limits)).value).toEqual({ external: true })
    expect(await readdir(root)).toEqual(['config.json'])
  })
  it('validates before allocating a temporary file and leaves invalid candidates unpublished', async () => {
    const { root, path } = await fixture(), revision = await publishConfigFile(path, { value: 1 }, {}, limits)
    await expect(publishConfigFile(path, { value: 2 }, { replace: true, expectedRevision: revision }, limits, () => { throw new Error('invalid') })).rejects.toThrow('invalid')
    expect((await readConfigFile(path, limits)).revision).toBe(revision)
    expect(await readdir(root)).toEqual(['config.json'])
  })
})
