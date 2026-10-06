import { join } from 'node:path'
import { projectAgentSession } from '../agent/projection.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { decodeHostConfig, resolveHostConfig } from '../host/config.js'
import type { ResolvedHostSpec } from '../host/config.js'
import { projectHostSession } from '../host/session-projection.js'
import { projectHostWorkflowSession } from '../host/workflow-binding.js'
import type { SessionSnapshot } from '../session/types.js'
import { validateDelegationCausality } from '../subagent/causality.js'
import { publishExperimentArtifact, readExperimentArtifact } from './artifacts.js'
import { decodeExperimentEvidence } from './evidence-codec.js'
import type { ExperimentEvidence } from './evidence-types.js'
import { collectExperimentEvidence, verifyExperimentEvidence } from './evidence.js'
import type { ExperimentPlan, ExperimentUnit } from './definition-types.js'
import type { ExperimentUnitState } from './journal-types.js'
import { decodeExperimentDerivedFrom } from './journal-events.js'
import { renderExperimentTask } from './input.js'
import { openExperimentStorage, readExperimentFile } from './storage.js'
import { experimentArray, experimentBytesDigest, experimentJsonDigest, experimentKey, experimentObject, experimentText } from './parsing.js'
import { ExperimentError } from './errors.js'

/**
 * Authenticate a reviewed source copy before recording its relation to one original disposition.
 * @param root Existing experiment controller root.
 * @param options Explicit evidence, unit and original-source identities.
 * @returns The original or newly committed derived evidence registration.
 */
export async function registerDerivedEvidence(root: string, options: { readonly unitKey: string; readonly evidenceKey: string;
  readonly evidence: unknown; readonly derivedFrom: JsonObject }) {
  const storage = await openExperimentStorage(root)
  try {
    const state = storage.journal.snapshot(), plan = state.plan!, evidenceKey = experimentKey(options.evidenceKey, 'evidence-key')
    const evidence = decodeExperimentEvidence(options.evidence, plan.evidenceLimits)
    const derivedFrom = decodeExperimentDerivedFrom(options.derivedFrom)
    const unit = state.units.find(unit => unit.unitKey === options.unitKey)
    const planned = plan.units.find(unit => unit.unitKey === options.unitKey)
    if (planned === undefined || unit?.started === null || unit === undefined) conflict('unit-not-started')
    const original = unit.sealed ?? unit.unresolved
    if (original === null || derivedFrom.originalDisposition.address !== plan.experimentId
      || derivedFrom.originalDisposition.eventId !== original.stored.eventId
      || !equal(derivedFrom.originalEvidence, original.payload.evidence)) conflict('derived-original-disposition-or-evidence')
    if (derivedFrom.sourceRoot !== evidence.source.root || derivedFrom.recipeDigest !== unit.started.payload.recipeDigest) conflict('derived-source-recipe-or-root')
    const actualRecipe = await readActualRecipe(root, plan, planned, unit)
    if (evidence.scope !== 'unit-local/v1' || evidence.mode !== plan.runPolicy.mode
      || evidence.source.maxRecordBytes !== actualRecipe.storage.maxRecordBytes
      || evidence.source.maxLineageDepth !== actualRecipe.storage.maxLineageDepth) conflict('derived-source-settings')
    if ((await verifyExperimentEvidence(evidence, plan.evidenceLimits.maxEvidenceBytes)).length > 0) {
      throw new ExperimentError('EXPERIMENT_EVIDENCE_INCOMPLETE', 'derived-source-changed')
    }
    const recipe = { ...actualRecipe, storage: { ...actualRecipe.storage, root: evidence.source.root } }
    const collected = await collectExperimentEvidence({ recipe, limits: plan.evidenceLimits, scope: evidence.scope, mode: evidence.mode,
      selected: evidence.selections.map(item => ({ sessionId: item.sessionId, ...(item.through === null ? {} : { through: item.through }) })),
      ...(evidence.target === null ? {} : { target: evidence.target }) })
    if (!equal(collected.evidence, evidence)) conflict('derived-evidence-not-reproducible')
    verifyUnitSource(plan, planned, actualRecipe, evidence, collected.snapshots)
    if (derivedFrom.originalEvidence !== null) {
      const originalEvidence = decodeExperimentEvidence(await readExperimentArtifact(root, derivedFrom.originalEvidence, plan.evidenceLimits.maxEvidenceBytes), plan.evidenceLimits)
      if (!equal(originalEvidence.target, evidence.target)
        || originalEvidence.sessions.some(cut => !evidence.sessions.some(copy => copy.sessionId === cut.sessionId && copy.through >= cut.through))) conflict('derived-original-cut-or-target')
      for (const cut of originalEvidence.sessions) {
        const copy = evidence.sessions.find(copy => copy.sessionId === cut.sessionId)!
        const bytes = await readExperimentFile(join(evidence.source.root, copy.log.path), plan.evidenceLimits.maxEvidenceBytes)
        if (copy.header.sha256 !== cut.header.sha256 || experimentBytesDigest(bytes.subarray(0, cut.committedBytes)) !== cut.committedSha256) conflict('derived-original-prefix-changed')
      }
    }
    const evidenceDigest = experimentJsonDigest(evidence as unknown as JsonValue)
    const reference = await publishExperimentArtifact(root, `derived/${evidenceKey}/evidence.json`, evidence as unknown as JsonValue, plan.evidenceLimits.maxEvidenceBytes)
    return await storage.journal.recordEvidence({ unitKey: options.unitKey, evidenceKey, evidenceDigest, evidence: reference, derivedFrom })
  } finally { await storage.dispose() }
}

async function readActualRecipe(root: string, plan: ExperimentPlan, planned: ExperimentUnit, unit: ExperimentUnitState): Promise<ResolvedHostSpec> {
  const started = unit.started!.payload
  const raw = experimentObject(await readExperimentArtifact(root, started.recipe, plan.evidenceLimits.maxRecipeBytes), 'actual-recipe')
  let expected = planned.recipe
  if (planned.entry.kind === 'workflow' && planned.config.schemaVersion === 3 && planned.config.workflows.kind === 'enabled') {
    const workflowKey = planned.entry.workflowKey
    const workflows = experimentObject(raw.workflows, 'actual-workflows')
    const records = experimentArray(workflows.definitions, 'actual-workflow-definitions')
    const selected = records.map(item => experimentObject(item, 'actual-workflow-record')).find(record => {
      return experimentObject(record.definition, 'actual-workflow-definition').workflowKey === workflowKey
    })
    if (selected === undefined) conflict('derived-actual-workflow-missing')
    const deadline = experimentText(experimentObject(selected.definition, 'actual-workflow-definition').deadline, 'actual-deadline', 32)
    const config = { ...planned.config, workflows: { ...planned.config.workflows,
      definitions: planned.config.workflows.definitions.map(record => record.definition.workflowKey !== workflowKey ? record
        : { ...record, definition: { ...record.definition, deadline } }) } }
    expected = resolveHostConfig(decodeHostConfig(config, planned.hostRoot))
  }
  if (experimentJsonDigest(raw as unknown as JsonValue) !== started.recipeDigest || !equal(raw, expected)) conflict('derived-actual-recipe-changed')
  return expected
}

function verifyUnitSource(plan: ExperimentPlan, unit: ExperimentUnit, recipe: ResolvedHostSpec, evidence: ExperimentEvidence,
  snapshots: readonly SessionSnapshot[]): void {
  const members = recipe.members.filter(member => member.kind === 'local')
  const workflows = recipe.schemaVersion === 3 && recipe.workflows.kind === 'enabled' ? recipe.workflows.definitions : []
  const staticIds = new Set([...members.map(member => member.sessionId), ...workflows.map(record => record.sessionId)])
  const byId = new Map(snapshots.map(snapshot => [snapshot.header.sessionId, snapshot]))
  if (evidence.coverage.complete && [...staticIds].some(id => !evidence.selectedSessionIds.some(selected => selected === id))) conflict('derived-static-sessions-missing')
  for (const member of members) {
    const snapshot = snapshots.find(snapshot => snapshot.header.sessionId === member.sessionId)
    if (snapshot === undefined || snapshot.localPosition === 0) continue
    const binding = projectHostSession(snapshot)
    if (binding.planned === null || binding.planned.payload.hostKey !== recipe.hostKey || binding.planned.payload.agentKey !== member.agentKey
      || !equal(binding.planned.payload.recipe, { profile: member.profile, spec: member.spec })) conflict('derived-member-recipe')
    const agent = projectAgentSession(snapshot)
    if (agent.spec !== null && !equal(agent.spec.payload, { ...member.spec, profileEventId: agent.spec.payload.profileEventId })) conflict('derived-member-spec')
    if (agent.spec !== null) {
      const profile = snapshot.history.at(-1)!.events.find(event => event.stored.eventId === agent.spec!.payload.profileEventId)
      if (profile?.kind !== 'known' || !equal(profile.payload, member.profile)) conflict('derived-member-profile')
    }
    if (binding.ready !== null && (binding.ready.payload.hostKey !== recipe.hostKey || binding.ready.payload.agentKey !== member.agentKey)) conflict('derived-member-binding')
  }
  for (const record of workflows) {
    const snapshot = snapshots.find(snapshot => snapshot.header.sessionId === record.sessionId)
    if (snapshot === undefined || snapshot.localPosition === 0) continue
    const binding = projectHostWorkflowSession(snapshot)
    if (binding.planned === null || binding.planned.payload.hostKey !== recipe.hostKey
      || !equal(binding.planned.payload.recipe.definition, record.definition)) conflict('derived-workflow-recipe')
  }
  const parents = snapshots.filter(snapshot => members.some(member => member.sessionId === snapshot.header.sessionId))
  const delegations = parents.flatMap(parent => projectAgentSession(parent).subagents.delegations.map(requested => ({ parent, requested })))
  const childIds = new Set<string>()
  for (const { parent, requested } of delegations) {
    if (childIds.has(requested.payload.childSessionId) || staticIds.has(requested.payload.childSessionId)) conflict('derived-child-identity')
    const template = recipe.schemaVersion !== 1 && recipe.subagents.kind === 'enabled' ? recipe.subagents.templates.find(template =>
      template.templateKey === requested.payload.request.templateKey && template.templateVersion === requested.payload.request.templateVersion) : undefined
    if (template === undefined || !equal(template, requested.payload.effectivePlan.template)) conflict('derived-child-template')
    childIds.add(requested.payload.childSessionId)
    const child = byId.get(requested.payload.childSessionId) ?? null
    if (child !== null) {
      const bound = projectAgentSession(child).subagents.bound
      if (child.header.parent !== undefined || child.localPosition !== 0 && (bound?.payload.delegation !== requested.stored.eventId
        || !equal(bound.payload.requested, requested.payload))) conflict('derived-child-binding')
    }
    validateDelegationCausality(parent, child, requested)
  }
  if (snapshots.some(snapshot => !staticIds.has(snapshot.header.sessionId) && !childIds.has(snapshot.header.sessionId))) conflict('derived-session-not-unit-owned')
  const target = evidence.target, entry = unit.entry
  if (target === null) return
  const item = plan.dataset.cases.find(item => item.caseKey === unit.caseKey)!
  if (target.kind !== entry.kind || target.mediaType !== item.output.mediaType || !equal(target.selector, entry.output)) conflict('derived-entry-target')
  if (entry.kind === 'agent' && target.kind === 'agent') {
    const member = members.find(member => member.agentKey === entry.agentKey)!
    if (target.sessionId !== member.sessionId) conflict('derived-entry-target')
    const snapshot = byId.get(target.sessionId)
    if (snapshot === undefined) conflict('derived-entry-session-missing')
    const input = projectAgentSession(snapshot).inputs.find(input => input.reference.kind === 'user' && input.reference.eventId === target.inputEventId)
    if (input?.input?.kind !== 'task' || input.input.text !== renderExperimentTask(item, entry)
      || input.input.originLabel !== 'experiment-case') conflict('derived-agent-input-source')
  } else if (entry.kind === 'workflow' && target.kind === 'workflow') {
    if (target.sessionId !== workflows.find(record => record.definition.workflowKey === entry.workflowKey)!.sessionId) conflict('derived-entry-target')
  }
}

function conflict(reason: string): never { throw new ExperimentError('EXPERIMENT_CONFLICT', reason) }

/** Values have already passed their owning decoder or are typed resolved recipe values. */
function equal(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(left as JsonValue)).equals(Buffer.from(canonicalJsonBytes(right as JsonValue)))
}
