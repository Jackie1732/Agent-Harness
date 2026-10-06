import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { exportHostConfig } from '../../src/host/config-export.js'
import type { JsonObject, JsonValue } from '../../src/foundation/json.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { decodeExperimentPlan } from '../../src/experiment/plan-codec.js'
import { experimentJsonDigest } from '../../src/experiment/parsing.js'
import { experimentDefinition } from './definition-fixture.js'
import { twoMemberHostConfig } from '../host/fixtures.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function frozenPlan(twoMembers = false): Promise<JsonObject> {
  const path = await mkdtemp(join(tmpdir(), 'atomic-plan-integrity-'))
  roots.push(path)
  const base = experimentDefinition(path)
  const definition = twoMembers ? { ...base, variants: (base.variants as readonly JsonObject[]).map(variant => ({ ...variant, recipe: twoMemberHostConfig(`${path}/template`) })) } : base
  return JSON.parse(JSON.stringify(await planExperiment(definition))) as JsonObject
}

function resign(plan: JsonObject): JsonObject {
  const { planDigest: _old, ...unsigned } = plan
  return { ...unsigned, planDigest: experimentJsonDigest(unsigned) }
}

function replaceConfig(plan: JsonObject, update: (config: JsonObject) => JsonObject, index = 0): JsonObject {
  const units = plan.units as readonly JsonObject[]
  const original = units[index]!
  const config = decodeHostConfig(update(original.config as JsonObject), original.hostRoot as string)
  const recipe = resolveHostConfig(config)
  const unit = { ...original, config: config as unknown as JsonValue, recipe: recipe as unknown as JsonValue,
    recipeDigest: experimentJsonDigest(recipe as unknown as JsonValue), comparisonFingerprint: exportHostConfig(recipe).fingerprint }
  return resign({ ...plan, units: units.map((original, ordinal) => ordinal === index ? unit : original) })
}

describe('frozen plan semantic integrity', () => {
  it('rejects a self-consistent unit model that differs from its declared Variant', async () => {
    const changed = replaceConfig(await frozenPlan(), config => ({ ...config, members: (config.members as readonly JsonObject[]).map(member => ({
      ...member, model: { ...(member.model as JsonObject), text: 'A different treatment' },
    })) }))
    expect(() => decodeExperimentPlan(changed)).toThrow('unit-recipe-template')
  })

  it('enforces frozen input bytes even when all content digests remain valid', async () => {
    const plan = await frozenPlan()
    const changed = resign({ ...plan, evidenceLimits: { ...(plan.evidenceLimits as JsonObject), maxInputBytes: 1 } })
    expect(() => decodeExperimentPlan(changed)).toThrow('input-bytes-limit')
  })

  it('rejects a self-consistent cloud provider substituted into a fixture treatment', async () => {
    const changed = replaceConfig(await frozenPlan(), config => ({ ...config, members: (config.members as readonly JsonObject[]).map(member => {
      const { kind: _kind, text: _text, ...common } = member.model as JsonObject
      return { ...member, model: { ...common, kind: 'deepseek', endpoint: 'https://example.invalid/v1/chat/completions', credentialRef: 'test-key' } }
    }) }))
    expect(() => decodeExperimentPlan(changed)).toThrow('unit-recipe-template')
  })

  it('rejects changed treatment instructions even when the resolved recipe and comparison hash agree', async () => {
    const changed = replaceConfig(await frozenPlan(), config => ({ ...config, members: (config.members as readonly JsonObject[]).map(member => {
      const profile = member.profile as JsonObject
      return { ...member, profile: { ...profile, sections: (profile.sections as readonly JsonObject[]).map(section => ({ ...section, text: 'Different instructions' })) } }
    }) }))
    expect(() => decodeExperimentPlan(changed)).toThrow('unit-recipe-template')
  })

  it('enforces resolved recipe bytes and total static Session count while decoding', async () => {
    const plan = await frozenPlan(true)
    expect(() => decodeExperimentPlan(resign({ ...plan, evidenceLimits: { ...(plan.evidenceLimits as JsonObject), maxRecipeBytes: 1 } }))).toThrow('recipe-bytes-limit')
    expect(() => decodeExperimentPlan(resign({ ...plan, evidenceLimits: { ...(plan.evidenceLimits as JsonObject), maxSessionCount: 1 } }))).toThrow('recipe-session-count-limit')
  })

  it('rejects a Channel reused by two otherwise valid unit recipes', async () => {
    const plan = await frozenPlan(true), units = plan.units as readonly JsonObject[]
    const channels = (units[0]!.config as JsonObject).channels!
    const changed = replaceConfig(plan, config => ({ ...config, channels }), 1)
    expect(() => decodeExperimentPlan(changed)).toThrow('unit-channel-reused')
  })

  it('rejects overlap between the experiment control and workspace roots', async () => {
    const plan = await frozenPlan(), storage = plan.storage as JsonObject
    expect(() => decodeExperimentPlan(resign({ ...plan, storage: { ...storage, workspaceRoot: join(storage.controlRoot as string, 'nested') } }))).toThrow('experiment-roots-overlap')
  })
})
