import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { JsonObject, JsonValue } from '../../src/foundation/json.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { exportHostConfig } from '../../src/host/config-export.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { decodeExperimentPlan } from '../../src/experiment/plan-codec.js'
import { experimentJsonDigest } from '../../src/experiment/parsing.js'
import { runExperiment } from '../../src/experiment/runner.js'
import { createExperimentStorage, readExperimentStorage } from '../../src/experiment/storage.js'
import { buildOperatorProfile } from '../../src/operator/profile.js'
import { buildHostPreset } from '../../src/operator/config-presets.js'
import { setupOperator, createOperatorConfig, configReadiness } from '../../src/operator/config-operations.js'
import { deepSeekModelDescriptor } from '../../src/model/providers/deepseek.js'
import { experimentDefinition } from './definition-fixture.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'
import { subagentHostConfig } from '../host/subagent-fixture.js'

const roots: string[] = []
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-audit-preflight-'))
  roots.push(root)
  return root
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function reviewedDefinition(root: string, maximum: number): JsonObject {
  const base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
  const recipe = runnableWorkflowConfig(join(root, 'template')), entry = recipe.workflows.definitions[0]!
  const producer = entry.definition.nodes[0]!
  const grant = { models: 1, steps: 1, tools: 0, messages: 0, waits: 0, outputTokens: 256 }
  return { ...base, repetitions: 1, comparisons: [], variants: [{ ...variant, recipe: { ...recipe,
    workflows: { ...recipe.workflows, definitions: [{ ...entry, definition: { ...entry.definition,
      roster: entry.definition.roster.map(peer => ({ ...peer, canReview: peer.memberKey === 'reviewer' })),
      nodes: [{ ...producer, output: { kind: 'text', name: 'report' }, acceptance: { kind: 'reviewed-all', reviewers: ['reviewer'] },
        attempts: producer.attempts.map(attempt => ({ ...attempt, reviewerGrants: [{ memberKey: 'reviewer', grant }] })) }],
      requiredOutputs: ['read'], limits: { ...entry.definition.limits, maxActiveAssignments: maximum },
      communication: { ask: [], groups: [], disclosures: [{ nodeKey: 'read', recipients: ['coordinator', 'reviewer'] }] },
    } }] } }, bindings: [{ caseKey: 'question', kind: 'workflow', inputMode: 'inline', workflowKey: 'research', durationMs: 60_000,
    materials: [], nodeTasks: [{ nodeKey: 'read', prefix: '' }], output: { kind: 'workflow-artifact', nodeKey: 'read', artifactName: 'report' } }] }] }
}

function historicalLowCapacityPlan(value: JsonObject) {
  const update = (recipe: JsonObject): JsonObject => {
    const workflows = recipe.workflows as JsonObject
    return { ...recipe, workflows: { ...workflows, definitions: (workflows.definitions as readonly JsonObject[]).map(entry => {
      const definition = entry.definition as JsonObject
      return { ...entry, definition: { ...definition, limits: { ...(definition.limits as JsonObject), maxActiveAssignments: 1 } } }
    }) } }
  }
  const unsigned: JsonObject = { ...value, variants: (value.variants as readonly JsonObject[]).map(variant => ({ ...variant, recipe: update(variant.recipe as JsonObject) })),
    units: (value.units as readonly JsonObject[]).map(unit => {
      const config = decodeHostConfig(update(unit.config as JsonObject), unit.hostRoot as string), recipe = resolveHostConfig(config)
      return { ...unit, config: config as unknown as JsonValue, recipe: recipe as unknown as JsonValue,
        recipeDigest: experimentJsonDigest(recipe as unknown as JsonValue), comparisonFingerprint: exportHostConfig(recipe).fingerprint }
    }) }
  const { planDigest: _prior, ...content } = unsigned
  return decodeExperimentPlan({ ...content, planDigest: experimentJsonDigest(content) })
}

it('rejects a new experiment whose reviewed Workflow cannot initialize before creating either root', async () => {
  const root = await directory()
  await expect(planExperiment(reviewedDefinition(root, 1))).rejects.toMatchObject({ code: 'HOST_CONFIG_INVALID', message: 'workflow-review-capacity-insufficient' })
  await expect(stat(join(root, 'control'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(root, 'work'))).rejects.toMatchObject({ code: 'ENOENT' })
  const valid = await planExperiment(reviewedDefinition(root, 2))
  expect(decodeExperimentPlan(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
})

it('keeps historical low-capacity Plans readable and refuses their new execution before storage or started', async () => {
  const root = await directory(), valid = await planExperiment(reviewedDefinition(root, 2))
  const historical = historicalLowCapacityPlan(JSON.parse(JSON.stringify(valid)) as JsonObject)
  expect(historical.units[0]!.recipe.schemaVersion).toBe(3)
  await expect(runExperiment(historical)).rejects.toMatchObject({ code: 'HOST_CONFIG_INVALID', message: 'workflow-review-capacity-insufficient' })
  await expect(stat(historical.storage.controlRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(historical.storage.workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  const storage = await createExperimentStorage(historical)
  await storage.dispose()
  const journalPath = join(historical.storage.controlRoot, 'journal-store', 'sessions', historical.journalSessionId, 'events.log')
  const before = await readFile(journalPath)
  expect((await readExperimentStorage(historical.storage.controlRoot)).state!.units[0]!.started).toBeNull()
  await expect(runExperiment(historical.storage.controlRoot, { continueUnstarted: true })).rejects.toMatchObject({ code: 'HOST_CONFIG_INVALID', message: 'workflow-review-capacity-insufficient' })
  expect(await readFile(journalPath)).toEqual(before)
  expect((await readExperimentStorage(historical.storage.controlRoot)).state!.units[0]!.started).toBeNull()
  await expect(stat(join(historical.storage.controlRoot, '.atomic-harness.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(historical.storage.workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('uses the Host initialization record budget while planning ordinary Agent observations', async () => {
  const root = await directory(), base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
  const recipe = variant.recipe as JsonObject, member = (recipe.members as readonly JsonObject[])[0]!, profile = member.profile as JsonObject
  const input = { ...base, variants: [{ ...variant, recipe: { ...recipe, storage: { ...(recipe.storage as JsonObject), maxRecordBytes: 4096 },
    members: [{ ...member, profile: { ...profile, sections: [{ ...(profile.sections as readonly JsonObject[])[0]!, text: 'x'.repeat(5000) }] } }] } }], comparisons: [], repetitions: 1 }
  await expect(planExperiment(input)).rejects.toMatchObject({ code: 'HOST_CONFIG_INVALID', message: 'initialization-record-too-large' })
  expect(await readdir(root)).toEqual([])
})

async function experimentProfile(root: string, definition: JsonValue): Promise<string> {
  const path = join(root, 'profile.json')
  await setupOperator({ profilePath: path, profile: buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' }),
    host: buildHostPreset('solo-scripted', { hostKey: 'host', storageRoot: join(root, 'host-store') }) })
  await createOperatorConfig(path, 'experiment', definition, join(root, 'experiment.json'))
  return path
}

it('reports live experiment credentials as missing or available without creating a Plan or Host', async () => {
  const root = await directory(), base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
  const recipe = buildHostPreset('solo-http', { hostKey: 'research', storageRoot: join(root, 'template'),
    http: { kind: 'deepseek', endpoint: 'https://example.invalid/v1/chat/completions', credentialRef: 'RESEARCH_KEY', model: 'deepseek-chat' } })
  const path = await experimentProfile(root, { ...base, variants: [{ ...variant, recipe }], comparisons: [],
    runPolicy: { ...(base.runPolicy as JsonObject), mode: 'live' } })
  for (const credentials of [{}, { RESEARCH_KEY: '   ' }]) {
    const result = await configReadiness(path, 'experiment', credentials)
    expect(result.status).toBe('not-ready')
    expect(result.evidence).toContainEqual({ subject: 'experiment.a.model.writer-provider', status: 'missing', reason: 'credential-missing' })
  }
  const present = await configReadiness(path, 'experiment', { RESEARCH_KEY: 'secret-live-value' })
  expect(present.status).toBe('ready')
  expect(present.evidence).toContainEqual({ subject: 'experiment.a.model.writer-provider', status: 'available', reason: null })
  expect(JSON.stringify(present)).not.toContain('secret-live-value')
  await expect(stat(join(root, 'control'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(root, 'work'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(root, 'host-store'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('includes cloud Child template credentials in explicit experiment readiness', async () => {
  const root = await directory(), base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
  const recipe = decodeHostConfig(await subagentHostConfig(join(root, 'template')), root)
  if (recipe.schemaVersion !== 2 || recipe.subagents.kind !== 'enabled') throw new Error('Subagent fixture')
  const template = recipe.subagents.templates[0]!
  if (template.model.kind !== 'scripted-fixed') throw new Error('Scripted fixture')
  const { kind: _kind, text: _text, ...common } = template.model
  const cloud = { ...common, kind: 'deepseek' as const, endpoint: 'https://example.invalid/v1/chat/completions', credentialRef: 'CHILD_KEY' }
  const configured = { ...recipe, subagents: { ...recipe.subagents, templates: [{ ...template, model: cloud,
    spec: { ...template.spec, target: { ...template.spec.target, provider: deepSeekModelDescriptor(cloud) } } }] } }
  const path = await experimentProfile(root, { ...base, comparisons: [], variants: [{ ...variant, recipe: configured as unknown as JsonValue }],
    runPolicy: { ...(base.runPolicy as JsonObject), mode: 'live' } })
  const missing = await configReadiness(path, 'experiment', {})
  expect(missing.status).toBe('not-ready')
  expect(missing.evidence).toContainEqual({ subject: `experiment.a.model.${cloud.providerId}`, status: 'missing', reason: 'credential-missing' })
  const present = await configReadiness(path, 'experiment', { CHILD_KEY: 'secret-child-value' })
  expect(present.status).toBe('ready')
  expect(JSON.stringify(present)).not.toContain('secret-child-value')
  await expect(stat(join(root, 'control'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(root, 'work'))).rejects.toMatchObject({ code: 'ENOENT' })
})
