import { mkdtemp, open, readFile, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject, JsonValue } from '../src/foundation/json.js'
import { executeConfigCommand } from '../src/operator/config-cli.js'
import { buildOperatorProfile } from '../src/operator/profile.js'
import { buildHostPreset } from '../src/operator/config-presets.js'
import { readConfigDocument } from '../src/operator/config-operations.js'
import { uiConfig } from './ui/fixtures.js'
import { decodeHostConfig, planHostConfig } from '../src/host/config.js'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'operator-config-cli-')); roots.push(root)
  const path = join(root, 'profile.json'), profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' })
  const host = buildHostPreset('solo-scripted', { hostKey: 'cli-host', storageRoot: './store' }, root)
  const call = (command: readonly string[], values: Readonly<Record<string, string | true>> = {}, input: JsonValue = null) => executeConfigCommand(command,
    new Map(Object.entries({ '--profile': path, ...values })), async () => input)
  const setup = await call(['setup'], { '--mode': 'local' }, { profile, host } as unknown as JsonValue)
  return { root, path, call, setup }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('parsed noninteractive configuration commands', () => {
  it('continues a Host-only setup by retaining the exact saved bytes, revision and identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-config-setup-resume-')); roots.push(root)
    const path = join(root, 'profile.json'), hostPath = join(root, 'host.json'), marker = join(root, '.profile.json.operator-lease')
    const profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' })
    const host = planHostConfig(decodeHostConfig(buildHostPreset('solo-scripted', { hostKey: 'resume-host', storageRoot: './store' }, root), root)) as unknown as JsonObject
    const options = new Map<string, string | true>([['--profile', path], ['--mode', 'local']])
    const lease = await open(marker, 'wx')
    let first!: Awaited<ReturnType<typeof executeConfigCommand>>
    try { first = await executeConfigCommand(['setup'], options, async () => ({ profile, host } as unknown as JsonValue)) }
    finally { await lease.close(); await unlink(marker) }
    expect(first.result).toMatchObject({ steps: [{ kind: 'host', path: hostPath }], failure: { code: 'HOST_LOCKED' } })
    const before = await readFile(hostPath), modified = (await stat(hostPath)).mtimeMs
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    const candidate = Object.fromEntries(Object.entries(host).reverse()) as JsonObject
    const resumed = await executeConfigCommand(['setup'], options, async () => ({ profile, host: candidate } as unknown as JsonValue))
    expect(resumed.result).toMatchObject({ steps: [{ kind: 'host', path: hostPath }, { kind: 'operator', path }], failure: null })
    expect(((resumed.result as JsonObject).steps as JsonObject[])[0]!.revision).toBe(((first.result as JsonObject).steps as JsonObject[])[0]!.revision)
    expect(await readFile(hostPath)).toEqual(before)
    expect((await stat(hostPath)).mtimeMs).toBe(modified)
    expect((await readConfigDocument(path, 'host')).value).toEqual(host)
  })
  it('refuses a changed Host candidate when continuing a partial setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-config-setup-conflict-')); roots.push(root)
    const path = join(root, 'profile.json'), hostPath = join(root, 'host.json'), marker = join(root, '.profile.json.operator-lease')
    const profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' })
    const host = buildHostPreset('solo-scripted', { hostKey: 'resume-host', storageRoot: './store' }, root)
    const options = new Map<string, string | true>([['--profile', path], ['--mode', 'local']])
    const lease = await open(marker, 'wx')
    try {
      const first = await executeConfigCommand(['setup'], options, async () => ({ profile, host } as unknown as JsonValue))
      expect(first.result).toMatchObject({ steps: [{ kind: 'host' }], failure: { code: 'HOST_LOCKED' } })
    } finally { await lease.close(); await unlink(marker) }
    const before = await readFile(hostPath), candidate = { ...(host as JsonObject), hostKey: 'changed-host',
      routes: [{ memberKey: 'writer', ownerHost: 'changed-host', origin: null, serverName: null }] }
    await expect(executeConfigCommand(['setup'], options, async () => ({ profile, host: candidate } as unknown as JsonValue)))
      .rejects.toMatchObject({ code: 'HOST_BINDING_CONFLICT', message: 'config-revision-conflict' })
    expect(await readFile(hostPath)).toEqual(before)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('establishes complete candidates and forwards plan, root set, typed edits and explicit revision conflicts', async () => {
    const { path, call, setup } = await fixture()
    expect((setup.result as JsonObject).steps).toHaveLength(2)
    expect(setup.profile?.callerNamespace).toMatch(/^local:/)
    const planned = await call(['config', 'plan'], { '--kind': 'host' })
    expect((planned.result as JsonObject).failure).toBeNull()
    const original = await readConfigDocument(path, 'host')
    await call(['config', 'set'], { '--kind': 'host', '--pointer': '' }, original.value)
    const saved = await call(['config', 'apply'], { '--kind': 'host' }, [{ op: 'set', pointer: '/members/0/model/text', value: 'Chinese 中文' }])
    expect((saved.result as JsonObject).failure).toBeNull()
    await expect(call(['config', 'apply'], { '--kind': 'host', '--expected-revision': original.revision }, [
      { op: 'set', pointer: '/members/0/model/text', value: 'Conflicting edit' },
    ])).rejects.toMatchObject({ message: 'config-revision-conflict' })
    const members = ((await readConfigDocument(path, 'host')).value as JsonObject).members as readonly JsonObject[]
    expect((members[0]!.model as JsonObject).text).toBe('Chinese 中文')
  })
  it('creates and links an original-format file and returns executable stdout separately from metadata', async () => {
    const { root, path, call } = await fixture()
    const created = await call(['config', 'create'], { '--kind': 'ui', '--output': join(root, 'ui.json') }, uiConfig(8443) as unknown as JsonValue)
    expect((created.result as JsonObject).steps).toHaveLength(2)
    expect(created.profile?.files.ui).toBe(join(root, 'ui.json'))
    const exported = await call(['config', 'export'], { '--kind': 'ui' })
    expect((exported.result as JsonObject).executable).toBe(true)
    expect(exported.rawConfig).toEqual((await readConfigDocument(path, 'ui')).check.normalized)
    const redacted = await call(['config', 'export'], { '--kind': 'ui', '--redacted': true })
    expect((redacted.result as JsonObject).executable).toBe(false)
    expect((redacted.rawConfig as JsonObject).redacted).toBe(true)
    const output = join(root, 'elsewhere', 'ui.json')
    const saved = await call(['config', 'export'], { '--kind': 'ui', '--output': output })
    expect(saved.rawConfig).toBeNull()
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(exported.rawConfig)
    const profile = await readConfigDocument(path, 'operator')
    await expect(call(['config', 'export'], { '--kind': 'ui', '--output': path, '--replace': true, '--expected-revision': profile.revision })).rejects.toMatchObject({ message: 'configuration-file-reference-collision' })
    expect((await readConfigDocument(path, 'operator')).revision).toBe(profile.revision)
    const imported = await call(['config', 'import'], { '--kind': 'ui', '--source': output })
    expect((imported.result as JsonObject).failure).toBeNull()
    const checked = await call(['config', 'check'], { '--all': true })
    expect(checked.result).toHaveLength(6)
  })
  it('rejects incomplete setup and a mismatched mode before creating files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-config-cli-invalid-')); roots.push(root)
    const path = join(root, 'profile.json'), options = new Map<string, string | true>([['--profile', path], ['--mode', 'remote']])
    const profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' })
    await expect(executeConfigCommand(['setup'], options, async () => ({ profile } as unknown as JsonValue))).rejects.toMatchObject({ message: 'setup-input-fields' })
    await expect(executeConfigCommand(['setup'], options, async () => ({ profile, host: null } as unknown as JsonValue))).rejects.toMatchObject({ message: 'setup-mode-profile-mismatch' })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
