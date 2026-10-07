import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { decodeExperimentDefinition, planExperiment } from '../../src/experiment/definition.js'
import { decodeExperimentPlan } from '../../src/experiment/plan-codec.js'
import { experimentDefinition } from './definition-fixture.js'

const roots: string[] = []
async function directory() { const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-plan-format-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function definition(root: string, enumSize: number): JsonObject {
  const base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!, recipe = variant.recipe as JsonObject
  return { ...base, repetitions: 10, comparisons: [], variants: [{ ...variant, recipe: { ...recipe,
    messages: [{ type: 'research/observation', payloadVersion: 1,
      schema: { type: 'integer', enum: Array.from({ length: enumSize }, (_, index) => index) } }],
  } }], storage: { ...(base.storage as JsonObject), maxRecordBytes: 16 * 1024 * 1024 },
  evidenceLimits: { ...(base.evidenceLimits as JsonObject), maxUnits: 10, maxPlanBytes: 16 * 1024 * 1024 } }
}

describe('planned JSON remains readable by the frozen format', () => {
  it('rejects matrix expansion beyond the durable node budget before returning a Plan or creating runtime storage', async () => {
    const root = await directory(), input = definition(root, 50_000)
    expect(decodeExperimentDefinition(input, root).repetitions).toBe(10)
    await expect(planExperiment(input)).rejects.toMatchObject({ code: 'EXPERIMENT_LIMIT_EXCEEDED', message: 'plan-json-nodes-limit' })
    await expect(stat(join(root, 'control'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, 'work'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('keeps legal repetitions and schema values intact through frozen JSON decoding', async () => {
    const plan = await planExperiment(definition(await directory(), 1000))
    expect(plan.units).toHaveLength(10)
    expect(decodeExperimentPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan)
  })
})
