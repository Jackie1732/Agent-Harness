import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject, JsonValue } from '../src/foundation/json.js'
import { buildOperatorProfile } from '../src/operator/profile.js'
import { setupOperator, readConfigDocument, readEditableConfigDocument, applyConfigOperations, applyConfigTreeOperations, rebindOperatorWorkflows, cloneOperatorHost } from '../src/operator/config-operations.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import { checkWorkflowRoster } from '../src/operator/config-workflows.js'
import { hostConfig } from './host/fixtures.js'
import { runnableWorkflowConfig } from './workflow/host-fixture.js'

const roots: string[] = []
async function fixture(version: 1 | 2 | 3 = 3) {
  const root = await mkdtemp(join(tmpdir(), 'operator-config-workflow-')); roots.push(root)
  const path = join(root, 'profile.json'), profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' })
  const host = version === 3 ? runnableWorkflowConfig(join(root, 'store')) : { ...hostConfig(join(root, 'store')), schemaVersion: version, ...(version === 2 ? { subagents: { kind: 'disabled' } } : {}) }
  await setupOperator({ profilePath: path, profile, host: host as unknown as JsonValue })
  return { root, path }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('real Workflow bindings and generation-preserving clones', () => {
  it('refuses stale fingerprints and publishes member edits plus rebinding in one candidate', async () => {
    const { path } = await fixture(), document = await readConfigDocument(path, 'host')
    const ops = [{ op: 'set' as const, pointer: '/members/0/profile/sections/0/text', value: 'Updated member instructions.' }]
    await expect(applyConfigOperations(path, 'host', ops, { expectedRevision: document.revision })).rejects.toMatchObject({ message: 'stale-workflow-roster' })
    expect((await readConfigDocument(path, 'host')).revision).toBe(document.revision)
    const rebound = await rebindOperatorWorkflows(path, ops, { expectedRevision: document.revision })
    const spec = resolveHostConfig(decodeHostConfig(rebound.document.value, join(path, '..')))
    expect(() => checkWorkflowRoster(spec)).not.toThrow()
    expect(rebound.steps).toHaveLength(1)
    expect((await readConfigDocument(path, 'host')).check.status).toBe('valid')
  })
  it('keeps externally stale JSON editable and repairs it with one publication', async () => {
    const { path } = await fixture(), document = await readConfigDocument(path, 'host'), value = applyConfigTreeOperations(document.value,
      [{ op: 'set', pointer: '/members/0/profile/sections/0/text', value: 'Externally changed profile' }])
    await writeFile(document.path, JSON.stringify(value))
    const editable = await readEditableConfigDocument(path, 'host')
    expect(editable.check).toBeNull()
    expect(editable.failure?.message).toBe('stale-workflow-roster')
    const repaired = await rebindOperatorWorkflows(path, undefined, { expectedRevision: editable.revision })
    expect(repaired.steps).toHaveLength(1)
    expect(repaired.document.check.status).toBe('valid')
  })
  it('refuses clone destinations that reuse current storage or selected configuration files', async () => {
    const { root, path } = await fixture(), document = await readConfigDocument(path, 'host'), before = await readFile(document.path)
    await expect(cloneOperatorHost(path, { newStorage: join(root, 'store'), output: join(root, 'clone.json'), hostKey: 'new-host' })).rejects.toMatchObject({ message: 'clone-storage-must-change' })
    await expect(cloneOperatorHost(path, { newStorage: join(root, 'new-store'), output: document.path, hostKey: 'new-host', replace: true,
      expectedRevision: document.revision })).rejects.toMatchObject({ message: 'configuration-file-reference-collision' })
    expect(await readFile(document.path)).toEqual(before)
  })
  it('cannot bypass roster checking by clearing a coordinator identity in the same edit', async () => {
    const { path } = await fixture(), document = await readConfigDocument(path, 'host')
    const operations = [{ op: 'set' as const, pointer: '/members/0/profile/sections/0/text', value: 'Changed instructions' },
      { op: 'set' as const, pointer: '/workflows/definitions/0/sessionId', value: null },
      { op: 'set' as const, pointer: '/workflows/definitions/0/definition/coordinator', value: null }]
    await expect(applyConfigOperations(path, 'host', operations, { expectedRevision: document.revision })).rejects.toMatchObject({ message: 'workflow-bindings-required' })
    expect((await readConfigDocument(path, 'host')).revision).toBe(document.revision)
    expect((await rebindOperatorWorkflows(path, operations, { expectedRevision: document.revision })).document.check.status).toBe('valid')
  })
  it.each([1, 2, 3] as const)('clones Host v%i with new identity and storage while preserving source bytes', async version => {
    const { root, path } = await fixture(version), original = await readConfigDocument(path, 'host'), before = await readFile(original.path)
    const clone = await cloneOperatorHost(path, { newStorage: join(root, 'new-store'), output: join(root, 'clone.json'), hostKey: 'clone-host' })
    const config = decodeHostConfig(clone.document.value, root)
    expect(config.schemaVersion).toBe(version)
    expect(config.hostKey).toBe('clone-host')
    expect(config.members[0]!.sessionId).not.toBe((original.value as JsonObject).members && ((original.value as JsonObject).members as JsonObject[])[0]!.sessionId)
    if (config.schemaVersion === 3 && config.workflows.kind === 'enabled') {
      expect(config.workflows.definitions[0]!.sessionId).not.toBe('87000000-0000-4000-8000-000000000001')
      expect(() => checkWorkflowRoster(resolveHostConfig(config))).not.toThrow()
    }
    expect(await readFile(original.path)).toEqual(before)
    expect((await readConfigDocument(path, 'host')).path).toBe(original.path)
  })
  it('rejects old log dependencies rather than discarding them', async () => {
    const { root, path } = await fixture(1), original = await readConfigDocument(path, 'host')
    const changed = await applyConfigOperations(path, 'host', [{ op: 'set', pointer: '/members/0/profile/previousEventId', value: 'ah-event:70000000-0000-4000-8000-000000000101:1' }], { expectedRevision: original.revision })
    await expect(cloneOperatorHost(path, { newStorage: join(root, 'new-store'), output: join(root, 'clone.json'), hostKey: 'clone-host' })).rejects.toMatchObject({ message: 'clone-log-references-unsupported', details: { fields: '/members/0/profile/previousEventId' } })
    expect((await readConfigDocument(path, 'host')).revision).toBe(changed.document.revision)
  })
})
