import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { JsonObject, JsonValue } from '../src/foundation/json.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import { initializeHost, hostRuntimeEventCatalog } from '../src/host/initialization.js'
import { openHost } from '../src/host/runtime.js'
import { createHostModelProvider } from '../src/host/model-factory.js'
import { FileSessionBackend } from '../src/session/file-backend.js'
import { SessionRepository } from '../src/session/repository.js'
import { parseSessionId } from '../src/session/ids.js'
import { buildOperatorProfile } from '../src/operator/profile.js'
import { buildHostPreset } from '../src/operator/config-presets.js'
import { applyConfigOperations, cloneOperatorHost, configReadiness, createOperatorConfig, planOperatorHost, readConfigDocument, setupOperator } from '../src/operator/config-operations.js'
import { deepSeekModelDescriptor } from '../src/model/providers/deepseek.js'
import { runnableWorkflowConfig } from './workflow/host-fixture.js'
import { subagentHostConfig } from './host/subagent-fixture.js'
import { uiConfig } from './ui/fixtures.js'
import { config as automationConfig } from './automation/fixtures.js'

const roots: string[] = []
async function fixture(build?: (root: string) => JsonValue | Promise<JsonValue>) {
  const root = await mkdtemp(join(tmpdir(), 'atomic-operator-config-audit-')); roots.push(root)
  const path = join(root, 'profile.json')
  await setupOperator({ profilePath: path, profile: buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' }),
    host: await build?.(root) ?? buildHostPreset('solo-scripted', { hostKey: 'local-host', storageRoot: join(root, 'store') }, root) })
  return { root, path }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function oversizedHost(root: string): JsonValue {
  const value = buildHostPreset('solo-scripted', { hostKey: 'local-host', storageRoot: join(root, 'store') }, root) as JsonObject
  const member = (value.members as readonly JsonObject[])[0]!, profile = member.profile as JsonObject
  return { ...value, storage: { ...(value.storage as JsonObject), maxRecordBytes: 4096 }, members: [{ ...member,
    profile: { ...profile, sections: [{ ...(profile.sections as readonly JsonObject[])[0]!, text: 'x'.repeat(5000) }] } }] }
}

it('refuses explicit planning before publishing identities when initialization records cannot fit', async () => {
  const { root, path } = await fixture(oversizedHost), draft = await readConfigDocument(path, 'host'), bytes = await readFile(draft.path)
  expect(draft.check.status).toBe('needs-plan')
  await expect(planOperatorHost(path, { expectedRevision: draft.revision })).rejects.toMatchObject({ code: 'HOST_CONFIG_INVALID', message: 'initialization-record-too-large' })
  expect(await readFile(draft.path)).toEqual(bytes)
  expect((await readConfigDocument(path, 'host')).revision).toBe(draft.revision)
  await expect(stat(join(root, 'store'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(root)).toEqual(['host.json', 'profile.json'])
})

it('keeps structurally valid historical files editable while refusing a new clone that cannot initialize', async () => {
  const { root, path } = await fixture(), draft = await readConfigDocument(path, 'host')
  const planned = await planOperatorHost(path, { expectedRevision: draft.revision })
  const edited = await applyConfigOperations(path, 'host', [{ op: 'set', pointer: '/storage/maxRecordBytes', value: 4096 },
    { op: 'set', pointer: '/members/0/profile/sections/0/text', value: 'x'.repeat(5000) }], { expectedRevision: planned.document.revision })
  expect(edited.document.check.status).toBe('valid')
  const read = await readConfigDocument(path, 'host'), bytes = await readFile(read.path)
  expect(read.check.status).toBe('valid')
  const output = join(root, 'clone', 'host.json'), newStorage = join(root, 'clone-store')
  await expect(cloneOperatorHost(path, { hostKey: 'clone-host', newStorage, output })).rejects.toMatchObject({ message: 'initialization-record-too-large' })
  await expect(stat(join(root, 'clone'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(newStorage)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(read.path)).toEqual(bytes)
})

function reviewedHost(root: string): JsonValue {
  const value = runnableWorkflowConfig(join(root, 'store')), entry = value.workflows.definitions[0]!, producer = entry.definition.nodes[0]!
  const grant = { models: 1, steps: 1, tools: 0, messages: 0, waits: 0, outputTokens: 256 }
  return { ...value, workflows: { ...value.workflows, definitions: [{ ...entry, definition: { ...entry.definition,
    roster: entry.definition.roster.map(peer => ({ ...peer, canReview: peer.memberKey === 'reviewer' })),
    nodes: [{ ...producer, output: { kind: 'text', name: 'report' }, acceptance: { kind: 'reviewed-all', reviewers: ['reviewer'] },
      attempts: producer.attempts.map(attempt => ({ ...attempt, reviewerGrants: [{ memberKey: 'reviewer', grant }] })) }],
    requiredOutputs: ['read'], limits: { ...entry.definition.limits, maxActiveAssignments: 1 },
    communication: { ask: [], groups: [], disclosures: [{ nodeKey: 'read', recipients: ['coordinator', 'reviewer'] }] },
  } }] } } as unknown as JsonValue
}

it('preflights reviewed Workflow capacity for explicit plan and clone without changing historical checks', async () => {
  const { root, path } = await fixture(reviewedHost), document = await readConfigDocument(path, 'host'), bytes = await readFile(document.path)
  expect(document.check.status).toBe('valid')
  await expect(planOperatorHost(path, { expectedRevision: document.revision })).rejects.toMatchObject({ message: 'workflow-review-capacity-insufficient' })
  await expect(cloneOperatorHost(path, { hostKey: 'clone-host', newStorage: join(root, 'clone-store'), output: join(root, 'clone', 'host.json') }))
    .rejects.toMatchObject({ message: 'workflow-review-capacity-insufficient' })
  expect(await readFile(document.path)).toEqual(bytes)
  await expect(stat(join(root, 'store'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(root, 'clone'))).rejects.toMatchObject({ code: 'ENOENT' })
  const repaired = await applyConfigOperations(path, 'host', [{ op: 'set', pointer: '/workflows/definitions/0/definition/limits/maxActiveAssignments', value: 2 }], { expectedRevision: document.revision })
  const planned = await planOperatorHost(path, { expectedRevision: repaired.document.revision })
  expect(planned.document.value).toEqual(repaired.document.value)
  const clone = await cloneOperatorHost(path, { hostKey: 'clone-host', newStorage: join(root, 'clone-store'), output: join(root, 'clone', 'host.json') })
  expect(clone.document.check.status).toBe('valid')
  expect((clone.document.value as JsonObject).hostKey).toBe('clone-host')
})

function httpHost(root: string, enabled = true): JsonValue {
  const value = buildHostPreset('solo-http', { hostKey: 'local-host', storageRoot: join(root, 'store'), http: { kind: 'deepseek',
    endpoint: 'https://example.invalid/chat/completions', credentialRef: 'LOCAL_KEY', model: 'deepseek-chat' } }, root) as JsonObject
  return { ...value, members: (value.members as readonly JsonObject[]).map(member => ({ ...member, enabled })) }
}

it('does not demand a disabled local model credential that the real Host does not acquire', async () => {
  const { root, path } = await fixture(root => httpHost(root, false)), draft = await readConfigDocument(path, 'host')
  const planned = await planOperatorHost(path, { expectedRevision: draft.revision }), spec = resolveHostConfig(decodeHostConfig(planned.document.value, root))
  await initializeHost(spec)
  const host = await openHost(spec, { credentials: {} }); await host.shutdown({ mode: 'drain' })
  const events = join(spec.storage.root, 'sessions', spec.members[0]!.sessionId, 'events.log'), bytes = await readFile(events)
  const readiness = await configReadiness(path, 'host', {})
  expect(readiness).toEqual({ kind: 'host', status: 'admission-check-required', evidence: [{ subject: 'host.bindings', status: 'compatible', reason: null }] })
  expect(await readFile(events)).toEqual(bytes)
  await expect(stat(join(spec.storage.root, '.atomic-harness.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('accepts an ended disabled member in pure readiness while keeping enabled ended members incompatible', async () => {
  const { root, path } = await fixture(root => {
    const value = buildHostPreset('solo-scripted', { hostKey: 'local-host', storageRoot: join(root, 'store') }, root) as JsonObject
    return { ...value, members: (value.members as readonly JsonObject[]).map(member => ({ ...member, enabled: false })) }
  }), draft = await readConfigDocument(path, 'host')
  const planned = await planOperatorHost(path, { expectedRevision: draft.revision }), spec = resolveHostConfig(decodeHostConfig(planned.document.value, root))
  await initializeHost(spec)
  const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: spec.storage.maxLineageDepth })
  const session = await repository.open(parseSessionId(spec.members[0]!.sessionId))
  try { await session.end('disabled member archived') } finally { await session.dispose(); await repository.dispose() }
  const events = join(spec.storage.root, 'sessions', spec.members[0]!.sessionId, 'events.log'), bytes = await readFile(events)
  const host = await openHost(spec); await host.shutdown({ mode: 'drain' })
  const disabled = await configReadiness(path, 'host', {})
  expect(disabled.status).toBe('admission-check-required')
  expect(disabled.evidence).toContainEqual({ subject: 'host.bindings', status: 'compatible', reason: null })
  const enabled = await applyConfigOperations(path, 'host', [{ op: 'set', pointer: '/members/0/enabled', value: true }], { expectedRevision: planned.document.revision })
  const active = await configReadiness(path, 'host', {})
  expect(active.status).toBe('not-ready')
  expect(active.evidence).toContainEqual({ subject: 'host.bindings', status: 'incompatible', reason: 'session-ended' })
  await expect(openHost(resolveHostConfig(decodeHostConfig(enabled.document.value, root)))).rejects.toMatchObject({ code: 'HOST_NOT_READY', message: 'session-ended' })
  expect(await readFile(events)).toEqual(bytes)
  await expect(stat(join(spec.storage.root, '.atomic-harness.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports absent or blank enabled model credentials without outputting their values or constructing a Provider', async () => {
  const { root, path } = await fixture(httpHost), draft = await readConfigDocument(path, 'host')
  const planned = await planOperatorHost(path, { expectedRevision: draft.revision }), spec = resolveHostConfig(decodeHostConfig(planned.document.value, root))
  await initializeHost(spec)
  for (const credentials of [{}, { LOCAL_KEY: '' }, { LOCAL_KEY: '   ' }]) {
    const readiness = await configReadiness(path, 'host', credentials)
    expect(readiness.status).toBe('not-ready')
    expect(readiness.evidence).toContainEqual({ subject: 'model.writer-provider', status: 'missing', reason: 'credential-missing' })
  }
  const present = await configReadiness(path, 'host', { LOCAL_KEY: 'secret-model-value' })
  expect(present.status).toBe('admission-check-required')
  expect(present.evidence).toContainEqual({ subject: 'model.writer-provider', status: 'available', reason: null })
  expect(JSON.stringify(present)).not.toContain('secret-model-value')
  const member = spec.members[0]!
  if (member.kind !== 'local') throw new Error('local fixture')
  expect(() => createHostModelProvider(member.model, { LOCAL_KEY: '   ' })).toThrow('model credential must be nonempty printable ASCII without whitespace')
})

it('includes blank and present credentials for enabled Child templates even with a scripted parent', async () => {
  const { root, path } = await fixture(async root => {
    const config = decodeHostConfig(await subagentHostConfig(join(root, 'store')), root)
    if (config.schemaVersion !== 2 || config.subagents.kind !== 'enabled') throw new Error('child fixture')
    const template = config.subagents.templates[0]!
    if (template.model.kind !== 'scripted-fixed') throw new Error('scripted fixture')
    const { kind: _kind, text: _text, ...common } = template.model
    const model = { ...common, kind: 'deepseek' as const, endpoint: 'https://example.invalid/chat/completions', credentialRef: 'CHILD_KEY' }
    return { ...config, subagents: { ...config.subagents, templates: [{ ...template, model,
      spec: { ...template.spec, target: { ...template.spec.target, provider: deepSeekModelDescriptor(model) } } }] } } as unknown as JsonValue
  }), document = await readConfigDocument(path, 'host')
  await initializeHost(resolveHostConfig(decodeHostConfig(document.value, root)))
  const blank = await configReadiness(path, 'host', { CHILD_KEY: '   ' })
  expect(blank.status).toBe('not-ready')
  expect(blank.evidence).toContainEqual({ subject: 'model.delegation-fixture', status: 'missing', reason: 'credential-missing' })
  const present = await configReadiness(path, 'host', { CHILD_KEY: 'secret-child-value' })
  expect(present.status).toBe('admission-check-required')
  expect(present.evidence).toContainEqual({ subject: 'model.delegation-fixture', status: 'available', reason: null })
  expect(JSON.stringify(present)).not.toContain('secret-child-value')
})

it('retains original UI and Automation credential presence semantics', async () => {
  const { root, path } = await fixture(), ui = uiConfig(8443), automation = automationConfig(root, 8443)
  await createOperatorConfig(path, 'ui', ui as unknown as JsonValue, join(root, 'ui.json'))
  await createOperatorConfig(path, 'automation', automation as unknown as JsonValue, join(root, 'automation.json'))
  expect((await configReadiness(path, 'ui', { [ui.passwordEnv]: '   ' })).evidence).toContainEqual({ subject: 'ui.password', status: 'available', reason: null })
  const token = 'a'.repeat(32), ready = await configReadiness(path, 'automation', { [automation.webhook.bearerTokenEnv]: token })
  expect(ready.status).toBe('ready')
  expect(ready.evidence).toContainEqual({ subject: 'automation.webhook-token', status: 'available', reason: null })
  expect(JSON.stringify(ready)).not.toContain(token)
})
