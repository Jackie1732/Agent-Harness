import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { snapshotJson } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'
import { parseSessionId } from '../session/ids.js'
import { parseChannelId } from '../communication/ids.js'
import type { SessionId } from '../session/ids.js'
import { resolveHostConfig } from '../host/config.js'
import { exportHostConfig } from '../host/config-export.js'
import type { ExperimentDefinition, ExperimentLimits, ExperimentUnit, ExperimentVariant, FrozenExperimentCase } from './definition-types.js'
import { canonicalExperimentPath, experimentPathsOverlap } from './materials.js'
import { experimentJsonDigest, invalidExperiment } from './parsing.js'
import { relocateExperimentRecipe } from './recipe-relocation.js'

/** Preallocate a new Host recipe and verify authorized roots against canonical protected paths. */
export async function planExperimentUnit(item: FrozenExperimentCase, variant: ExperimentVariant, repetition: number, ordinal: number,
  journalId: SessionId, storage: ExperimentDefinition['storage'], limits: ExperimentLimits): Promise<ExperimentUnit> {
  const tuple = { caseKey: item.caseKey, variantKey: variant.variantKey, repetition }
  const unitKey = `unit-${experimentJsonDigest(tuple).slice(0, 32)}`
  const hostRoot = join(storage.controlRoot, 'runs', unitKey, 'host-store')
  const workspaceRoot = join(storage.workspaceRoot, journalId, unitKey)
  const config = relocateExperimentRecipe(item, variant, { hostRoot, workspaceRoot, controlRoot: storage.controlRoot }, limits, {
    nextSessionId: () => parseSessionId(randomUUID()), nextChannelId: () => parseChannelId(randomUUID()),
  })
  const recipe = resolveHostConfig(config)
  const resources = recipe.schemaVersion === 3 ? recipe.workspaceResources
    : recipe.schemaVersion === 2 && recipe.subagents.kind === 'enabled' ? recipe.subagents.workspaceResources : []
  const actualRoots = [...recipe.members.flatMap(member => member.kind !== 'local' || member.tools.kind === 'none' ? [] : [{ root: member.tools.rootPath, protected: member.tools.protectedRoots }]),
    ...resources.map(resource => ({ root: resource.rootPath, protected: resource.protectedRoots }))]
  for (const access of actualRoots) {
    if (access.protected.length > 64) invalidExperiment('protected-roots-limit')
    for (const protectedRoot of access.protected) if (experimentPathsOverlap(await canonicalExperimentPath(access.root), await canonicalExperimentPath(protectedRoot))) invalidExperiment('authorized-protected-root-overlap')
  }
  const entry = variant.bindings.find(binding => binding.caseKey === item.caseKey)!
  return snapshotJson({ ...tuple, unitKey, ordinal, hostRoot, workspaceRoot, config, recipe,
    recipeDigest: experimentJsonDigest(recipe as unknown as JsonValue), comparisonFingerprint: exportHostConfig(recipe).fingerprint, entry }) as unknown as ExperimentUnit
}
