import { mkdtemp, open, readFile, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildOperatorProfile, decodeOperatorProfile, readOperatorProfile, resolveOperatorProfile } from '../src/operator/profile.js'
import { buildHostPreset, buildConfigPreset, configPresetParameters } from '../src/operator/config-presets.js'
import { setupOperator, readConfigDocument, planOperatorHost, applyConfigOperations, checkAllOperatorConfigs, createOperatorConfig, linkOperatorConfig, exportOperatorConfig, importOperatorConfig, configReadiness } from '../src/operator/config-operations.js'
import { initializeHost } from '../src/host/initialization.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import type { JsonObject, JsonValue } from '../src/foundation/json.js'
import { apiConfig, certificateDirectory } from './api/fixtures.js'
import { config as automationConfig } from './automation/fixtures.js'
import { uiConfig } from './ui/fixtures.js'
import { experimentDefinition } from './experiment/definition-fixture.js'

const roots: string[] = []
async function fixture(draft = true) {
  const root = await mkdtemp(join(tmpdir(), 'operator-config-profile-')); roots.push(root)
  const path = join(root, 'profile.json'), profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' })
  const host = buildHostPreset('solo-scripted', { hostKey: 'test-host', storageRoot: join(root, 'store') })
  await setupOperator({ profilePath: path, profile, host })
  if (!draft) { const file = await readConfigDocument(path, 'host'); await planOperatorHost(path, { expectedRevision: file.revision }) }
  return { root, path }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('OperatorProfile and original configuration adapters', () => {
  it('keeps local namespace and relative paths stable at the selected profile directory', () => {
    const raw = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'drain' })
    const resolved = resolveOperatorProfile(raw, join(tmpdir(), 'profile-owner', 'profile.json'))
    expect(resolved.callerNamespace).toBe(`local:${raw.profileKey}`)
    expect(resolved.callerNamespace!.length).toBe(42)
    expect(resolved.connection.kind === 'local' && resolved.connection.hostConfig).toBe(join(tmpdir(), 'profile-owner', 'host.json'))
    expect(() => decodeOperatorProfile({ ...raw, profileKey: 'friendly-name' })).toThrow()
    expect(() => decodeOperatorProfile({ ...raw, journal: { ...raw.journal, maxEvents: 1 } })).toThrow()
    expect(() => decodeOperatorProfile({ ...raw, journal: { ...raw.journal, maxRecordBytes: 32767 } })).toThrow()
    expect(decodeOperatorProfile({ ...raw, journal: { ...raw.journal, maxRecordBytes: 32768 } }).journal.maxRecordBytes).toBe(32768)
    expect(() => decodeOperatorProfile({ ...raw, secret: 'not-supported' })).toThrow()
  })
  it('establishes drafts, explicitly plans identities, and preserves them on a repeated plan', async () => {
    const { root, path } = await fixture()
    const draft = await readConfigDocument(path, 'host')
    expect(draft.check.status).toBe('needs-plan')
    await expect(stat(join(root, 'store'))).rejects.toMatchObject({ code: 'ENOENT' })
    const planned = await planOperatorHost(path, { expectedRevision: draft.revision })
    expect(planned.document.check.status).toBe('valid')
    const repeated = await planOperatorHost(path, { expectedRevision: planned.document.revision })
    expect(repeated.document.value).toEqual(planned.document.value)
    expect((await checkAllOperatorConfigs(path)).filter(item => 'status' in item)).toHaveLength(4)
  })
  it('validates each kind with its owner and refuses API publication while the Host needs plan', async () => {
    const { root, path } = await fixture(), api = await apiConfig()
    await expect(createOperatorConfig(path, 'api', api as unknown as JsonValue, join(root, 'api.json'))).rejects.toMatchObject({ message: 'dependency-needs-plan' })
    await expect(stat(join(root, 'api.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const file = await readConfigDocument(path, 'host'); await planOperatorHost(path, { expectedRevision: file.revision })
    for (const [kind, candidate] of [['api', api], ['ui', uiConfig(8443)], ['automation', automationConfig(root, 8443)], ['experiment', experimentDefinition(root)]] as const) {
      const result = await createOperatorConfig(path, kind, candidate as unknown as JsonValue, join(root, `${kind}.json`))
      expect(result.failure).toBeNull()
      expect((await readConfigDocument(path, kind)).check.status).toBe('valid')
    }
  })
  it('rejects invalid complete edits without changing file revision', async () => {
    const { path } = await fixture(false), file = await readConfigDocument(path, 'host')
    await expect(applyConfigOperations(path, 'host', [{ op: 'set', pointer: '/members/0/model/kind', value: 'deepseek' }], { expectedRevision: file.revision })).rejects.toThrow()
    expect((await readConfigDocument(path, 'host')).revision).toBe(file.revision)
    const valid = await applyConfigOperations(path, 'host', [
      { op: 'set', pointer: '/members/0/model/kind', value: 'deepseek' }, { op: 'remove', pointer: '/members/0/model/text' },
      { op: 'insert', pointer: '/members/0/model/endpoint', value: 'https://api.deepseek.com/chat/completions' },
      { op: 'insert', pointer: '/members/0/model/credentialRef', value: 'DEEPSEEK_API_KEY' },
    ], { expectedRevision: file.revision })
    expect(valid.document.check.status).toBe('valid')
  })
  it('validates draft AgentSpec fields without assigning identities or creating runtime storage', async () => {
    const { root, path } = await fixture(), file = await readConfigDocument(path, 'host')
    for (const [pointer, value] of [['/members/0/spec/budget/models', -1], ['/members/0/spec/nativeActions/0', 'unknown-action'],
      ['/members/0/spec/target/maxOutputTokens', 0]] as const) {
      await expect(applyConfigOperations(path, 'host', [{ op: 'set', pointer, value }], { expectedRevision: file.revision })).rejects.toMatchObject({ code: 'HOST_CONFIG_INVALID' })
    }
    const current = await readConfigDocument(path, 'host')
    expect(current.revision).toBe(file.revision)
    expect(((current.value as JsonObject).members as JsonObject[])[0]!.sessionId).toBeNull()
    await expect(stat(join(root, 'store'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('exports executable absolute targets and imports them at another directory', async () => {
    const { root, path } = await fixture(false), file = await readConfigDocument(path, 'host')
    const exported = await exportOperatorConfig(path, 'host', { output: join(root, 'exported', 'host.json') })
    expect(exported.executable).toBe(true)
    const imported = await importOperatorConfig(path, 'host', exported.value, join(root, 'exported'), { expectedRevision: file.revision })
    expect((imported.document.check.normalized as JsonObject).storage).toEqual((file.check.normalized as JsonObject).storage)
    const redacted = await exportOperatorConfig(path, 'host', { redacted: true })
    expect(redacted.executable).toBe(false)
    expect((redacted.value as JsonObject).redacted).toBe(true)
  })
  it('checks old Session bindings by pure snapshots and classifies a changed profile', async () => {
    const { root, path } = await fixture(false), file = await readConfigDocument(path, 'host')
    const host = resolveHostConfig(decodeHostConfig(file.value, dirname(file.path))); await initializeHost(host)
    const events = join(root, 'store', 'sessions', host.members[0]!.sessionId, 'events.log'), before = await readFile(events)
    const ready = await configReadiness(path, 'host', {})
    expect(ready.status).toBe('admission-check-required')
    const edited = await applyConfigOperations(path, 'host', [{ op: 'set', pointer: '/members/0/profile/sections/0/text', value: 'Changed instructions.' }], { expectedRevision: file.revision })
    expect(edited.diff.binding).toBe('incompatible')
    expect((await configReadiness(path, 'host', {})).status).toBe('not-ready')
    expect(await readFile(events)).toEqual(before)
    await expect(stat(join(root, 'store', '.atomic-harness.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('loads credential references and real TLS pairs only for explicit readiness', async () => {
    const { root, path } = await fixture(false), candidate = uiConfig(8443)
    await createOperatorConfig(path, 'ui', candidate as unknown as JsonValue, join(root, 'ui.json'))
    expect((await configReadiness(path, 'ui', {})).status).toBe('not-ready')
    expect((await configReadiness(path, 'ui', { [candidate.passwordEnv]: 'present' })).status).toBe('ready')
    const document = await readConfigDocument(path, 'ui')
    await applyConfigOperations(path, 'ui', [{ op: 'set', pointer: '/remote/keyFile', value: `${certificateDirectory}server-key.pem` }],
      { expectedRevision: document.revision })
    const checked = await configReadiness(path, 'ui', { [candidate.passwordEnv]: 'present' })
    expect(checked.status).toBe('not-ready')
    expect(checked.evidence).toContainEqual({ subject: 'ui.tls', status: 'incompatible', reason: 'tls-material-invalid' })
    await expect(stat(join(root, 'store'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('builds all service preset candidates from typed deployment parameters', () => {
    for (const [kind, preset] of [['api', 'mtls'], ['ui', 'gateway'], ['automation', 'webhook'], ['automation', 'utc'], ['experiment', 'fixture']] as const) {
      const params = configPresetParameters(kind, preset)
      const candidate = buildConfigPreset(kind, preset, kind === 'api' ? { ...params, certificateFingerprints: ['a'.repeat(64)] } : params, tmpdir())
      expect(candidate).toBeTypeOf('object')
    }
  })
  it('runs the original type-specific resolver checks before publishing invalid files', async () => {
    const { root, path } = await fixture(false), api = await apiConfig()
    const candidates = [
      ['api', { ...api, principals: [{ ...api.principals[0]!, agentKeys: ['missing-agent'] }] }],
      ['ui', { ...uiConfig(8443), remote: { ...uiConfig(8443).remote, serverName: '127.0.0.1' } }],
      ['automation', { ...automationConfig(root, 8443), journal: { ...automationConfig(root, 8443).journal, maxEvents: 1 } }],
      ['experiment', { ...experimentDefinition(root), evaluators: [] }],
    ] as const
    for (const [kind, value] of candidates) {
      const output = join(root, `${kind}.json`)
      await expect(createOperatorConfig(path, kind, value as unknown as JsonValue, output)).rejects.toThrow()
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
  it('checks registered API targets against a Host edit and validates newly selected profile files', async () => {
    const { root, path } = await fixture(false)
    await createOperatorConfig(path, 'api', await apiConfig() as unknown as JsonValue, join(root, 'api.json'))
    const host = await readConfigDocument(path, 'host')
    await expect(applyConfigOperations(path, 'host', [{ op: 'set', pointer: '/members/0/agentKey', value: 'new-writer' },
      { op: 'set', pointer: '/routes/0/memberKey', value: 'new-writer' }], { expectedRevision: host.revision })).rejects.toThrow()
    expect((await readConfigDocument(path, 'host')).revision).toBe(host.revision)
    const operator = await readConfigDocument(path, 'operator')
    await expect(applyConfigOperations(path, 'operator', [{ op: 'set', pointer: '/files/ui', value: './missing-ui.json' }],
      { expectedRevision: operator.revision })).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readConfigDocument(path, 'operator')).revision).toBe(operator.revision)
  })
  it('rejects invalid inline message schemas before saving a draft', async () => {
    const { path } = await fixture(), document = await readConfigDocument(path, 'host')
    await expect(applyConfigOperations(path, 'host', [{ op: 'insert', pointer: '/messages/-', value: {
      type: 'operator/example', payloadVersion: 1, schema: { type: 'object', unknownSchemaKeyword: true },
    } }], { expectedRevision: document.revision })).rejects.toMatchObject({ code: 'HOST_CONFIG_INVALID' })
    expect((await readConfigDocument(path, 'host')).revision).toBe(document.revision)
  })
  it('reports every declared kind when one referenced file fails static validation', async () => {
    const { root, path } = await fixture(false)
    await createOperatorConfig(path, 'ui', uiConfig(8443) as unknown as JsonValue, join(root, 'ui.json'))
    const ui = await open(join(root, 'ui.json'), 'w')
    try { await ui.writeFile('{}') } finally { await ui.close() }
    const results = await checkAllOperatorConfigs(path)
    expect(results).toHaveLength(6)
    expect(results.find(item => item.kind === 'ui')).toMatchObject({ status: 'invalid' })
    expect(results.find(item => item.kind === 'automation')).toEqual({ kind: 'automation', status: 'not-configured' })
  })
  it('keeps a created file and reports the completed step when profile linking conflicts', async () => {
    const { root, path } = await fixture(false), leasePath = join(root, '.profile.json.operator-lease'), lease = await open(leasePath, 'wx')
    try {
      const result = await createOperatorConfig(path, 'ui', uiConfig(8443) as unknown as JsonValue, join(root, 'ui.json'))
      expect(result.steps).toHaveLength(1)
      expect(result.failure?.code).toBe('HOST_LOCKED')
      expect((await readOperatorProfile(path)).profile.files.ui).toBeNull()
      expect(await stat(join(root, 'ui.json'))).toBeDefined()
    } finally { await lease.close(); await unlink(leasePath) }
    await linkOperatorConfig(path, 'ui', join(root, 'ui.json'))
    expect((await readConfigDocument(path, 'ui')).check.status).toBe('valid')
  })
})
