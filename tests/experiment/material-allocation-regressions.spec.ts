import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { decodeExperimentPlan } from '../../src/experiment/plan-codec.js'
import { createExperimentStorage } from '../../src/experiment/storage.js'
import { experimentDefinition } from './definition-fixture.js'

const roots: string[] = []
async function directory() { const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-material-allocation-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function definition(root: string, logicalPaths: readonly string[], destinations?: readonly string[]): JsonObject {
  const base = experimentDefinition(root), dataset = base.dataset as JsonObject, item = (dataset.cases as readonly JsonObject[])[0]!
  const variant = (base.variants as readonly JsonObject[])[0]!, recipe = variant.recipe as JsonObject
  const member = (recipe.members as readonly JsonObject[])[0]!, profile = member.profile as JsonObject, spec = member.spec as JsonObject
  const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
  return { ...base, comparisons: [], repetitions: 1,
    dataset: { ...dataset, cases: [{ ...item, materials: logicalPaths.map(logicalPath => ({ logicalPath,
      mediaType: 'text/plain', source: { kind: 'inline', text: '42' }, expectedSha256: null })) }] },
    variants: [{ ...variant,
      recipe: destinations === undefined ? recipe : { ...recipe, members: [{ ...member,
        profile: { ...profile, toolNames: ['read_text'] }, spec: { ...spec, toolNames: ['read_text'], budget: { ...(spec.budget as JsonObject), tools: 1 } },
        tools: { kind: 'workspace-read-text', rootId: 'research', rootPath: `${root}/template-files`, protectedRoots: [],
          maxReadBytes: 4096, maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 8192, schemaLimits,
          invocationLimits: { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096,
            maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 },
          policy: { policyId: 'read', version: 1, decision: 'allow', reasonCode: 'configured-read' } },
      }] },
      bindings: [{ caseKey: 'question', kind: 'agent', agentKey: 'writer', inputMode: destinations === undefined ? 'inline' : 'workspace',
        materials: destinations === undefined ? [] : logicalPaths.map((logicalPath, index) => ({ logicalPath, relativePath: destinations[index]!, resourceId: null })),
        output: { kind: 'root-final' } }],
    }] }
}

describe('material file allocation is checked during planning', () => {
  it('rejects a frozen input file that also names another input directory before creating the control root', async () => {
    const root = await directory()
    await expect(planExperiment(definition(root, ['data/notes.txt', 'DATA-other', 'Data'])))
      .rejects.toThrow('material-path-file-directory-overlap')
    await expect(stat(join(root, 'control'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects overlapping workspace material destinations before admitting a unit', async () => {
    const root = await directory()
    await expect(planExperiment(definition(root, ['first.txt', 'second.txt'], ['data', 'DATA/notes.txt'])))
      .rejects.toThrow('binding-path-file-directory-overlap')
    await expect(stat(join(root, 'control'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, 'work'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps sibling files and shared directories valid through frozen decoding and input publication', async () => {
    const plan = await planExperiment(definition(await directory(), ['data.txt', 'data/one.txt', 'data/two.txt']))
    expect(decodeExperimentPlan(JSON.parse(JSON.stringify(plan))).planDigest).toBe(plan.planDigest)
    const storage = await createExperimentStorage(plan)
    try {
      for (const material of plan.dataset.cases[0]!.materials) {
        expect((await stat(join(plan.storage.controlRoot, 'inputs', 'question', material.logicalPath))).isFile()).toBe(true)
      }
    } finally { await storage.dispose() }
  })
})
