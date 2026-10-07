import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject, JsonValue } from '../../src/foundation/json.js'
import { planExperiment } from '../../src/experiment/definition.js'
import type { ExperimentPlan } from '../../src/experiment/definition-types.js'
import { runExperimentUnit } from '../../src/experiment/runner-unit.js'
import { runExperimentCli } from '../../src/experiment/cli.js'
import { createExperimentStorage, readExperimentStorage } from '../../src/experiment/storage.js'
import { publishExperimentArtifact } from '../../src/experiment/artifacts.js'
import { experimentJsonDigest } from '../../src/experiment/parsing.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { RunExperimentOptions } from '../../src/experiment/runner-types.js'
import * as hostRuntime from '../../src/host/runtime.js'
import { experimentDefinition } from './definition-fixture.js'
import { textFrames } from '../model/fixtures.js'

const roots: string[] = []
async function directory() { const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-cli-continuation-')); roots.push(root); return root }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function streams() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  let text = ''
  stdout.on('data', chunk => { text += String(chunk) }); stdin.end()
  return { stdin, stdout, stderr, json: () => JSON.parse(text) }
}

function definition(root: string, live: boolean): JsonObject {
  const base = experimentDefinition(root)
  return { ...base, repetitions: 1, runPolicy: { ...(base.runPolicy as JsonObject), mode: live ? 'live' : 'fixture' },
    variants: (base.variants as readonly JsonObject[]).map((variant, index) => ({ ...variant,
      fixture: !live && index === 0 ? { kind: 'programmatic', fixtureKey: 'retired', version: '1', sourceSha256: 'a'.repeat(64) } : { kind: 'builtin' },
      recipe: { ...(variant.recipe as JsonObject), members: ((variant.recipe as JsonObject).members as readonly JsonObject[]).map(member => {
        const model = member.model as JsonObject
        if (!live || index !== 0) return { ...member, model: { ...model, text: '42' } }
        const { text: _text, ...http } = model
        return { ...member, model: { ...http, kind: 'deepseek', endpoint: 'https://api.example.invalid', credentialRef: 'RETIRED_CREDENTIAL' } }
      }) } })) }
}

async function sealFirst(plan: ExperimentPlan, options: RunExperimentOptions = {}): Promise<void> {
  const storage = await createExperimentStorage(plan), unit = plan.units[0]!
  try {
    const result = await runExperimentUnit(plan, unit, storage, options)
    expect(result.closure).toBe('confirmed')
    expect(result.evidence?.coverage.complete).toBe(true)
    const evidence = await publishExperimentArtifact(plan.storage.controlRoot, `runs/${unit.unitKey}/evidence.json`,
      result.evidence as unknown as JsonValue, plan.evidenceLimits.maxEvidenceBytes)
    await storage.journal.sealUnit({ unitKey: unit.unitKey, outcome: result.outcome, reason: result.reason, closure: 'confirmed',
      evidenceDigest: experimentJsonDigest(result.evidence as unknown as JsonValue), evidence, measurement: null })
  } finally { await storage.dispose() }
}

describe('CLI continuation uses pending runtime dependencies', () => {
  it('continues builtin units after a sealed programmatic treatment has retired', async () => {
    const plan = await planExperiment(definition(await directory(), false))
    let providers = 0
    await sealFirst(plan, { fixtureBindings: { retired: { createModelProvider: member => {
      providers++
      return new ScriptedModelProvider({ ...member.model, script: () => textFrames('42') })
    } } } })
    const io = streams()
    expect(await runExperimentCli(['run', '--root', plan.storage.controlRoot, '--mode', 'fixture', '--continue-unstarted'], io, {})).toBe(0)
    expect(providers).toBe(1)
    expect(io.json().units.every((unit: { sealed: { payload: { outcome: string } } }) => unit.sealed.payload.outcome === 'completed')).toBe(true)
  }, 30_000)

  it('continues a local unit without the credential of a sealed cloud treatment', async () => {
    const plan = await planExperiment(definition(await directory(), true))
    const open = vi.spyOn(hostRuntime, 'openHost').mockRejectedValueOnce(new Error('retired provider unavailable'))
    await sealFirst(plan, { credentials: { RETIRED_CREDENTIAL: 'unused-test-key' } })
    expect(open).toHaveBeenCalledTimes(1)
    open.mockRestore()
    const io = streams()
    expect(await runExperimentCli(['run', '--root', plan.storage.controlRoot, '--mode', 'live', '--continue-unstarted'], io, {})).toBe(2)
    expect(io.json()).toMatchObject({ finalized: true, stoppedBy: 'completed', units: [
      { sealed: { payload: { outcome: 'failed' } } }, { sealed: { payload: { outcome: 'completed' } } },
    ] })
    expect((await readExperimentStorage(plan.storage.controlRoot)).state!.evaluations).toHaveLength(2)
  }, 30_000)

  it('still rejects a missing pending credential before Journal changes or Host creation', async () => {
    const root = await directory(), base = definition(root, true)
    const plan = await planExperiment({ ...base, variants: [...(base.variants as readonly JsonObject[])].reverse(), order: 'declared' })
    await sealFirst(plan)
    const before = (await readExperimentStorage(plan.storage.controlRoot)).state!.position
    await expect(runExperimentCli(['run', '--root', plan.storage.controlRoot, '--mode', 'live', '--continue-unstarted'], streams(), {}))
      .rejects.toThrow('credential-reference-unavailable')
    expect((await readExperimentStorage(plan.storage.controlRoot)).state!.position).toBe(before)
    await expect(stat(plan.units[1]!.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)
})
