import { subagentSessionEventDefinitions } from '../subagent/session-events.js'
import { workflowSessionEventDefinitions } from '../workflow/session-events.js'
import type { WorkflowDefinition } from '../workflow/types.js'
import { preflightWorkflowInitialization, initializeWorkflowCoordinator } from './workflow-initialization.js'
import type { HostWorkflowInitializationResult } from './workflow-initialization.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { Clock } from '../foundation/clock.js'
import { systemClock } from '../foundation/clock.js'
import type { JsonObject } from '../foundation/json.js'
import { createMessageCatalog } from '../communication/message-catalog.js'
import { communicationSessionEventDefinitions } from '../communication/session-events.js'
import { SessionContext } from '../context/session-context.js'
import { contextSessionEventDefinitions } from '../context/session-events.js'
import { projectContextSession } from '../context/projection.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { ContextProfile } from '../context/contract.js'
import { modelSessionEventDefinitions } from '../model/session-events.js'
import { toolSessionEventDefinitions } from '../tool/session-events.js'
import { agentSessionEventDefinitions } from '../agent/session-events.js'
import { installAgentSpec } from '../agent/session-agent.js'
import { projectAgentSession } from '../agent/projection.js'
import { assertAgentExecutionQuiescent } from '../agent/execution-health.js'
import { createDurableEventCatalog } from '../session/event-catalog.js'
import { encodeStoredSessionEvent } from '../session/codec.js'
import { FileSessionBackend } from '../session/file-backend.js'
import { SessionError } from '../session/errors.js'
import { SessionRepository } from '../session/repository.js'
import { formatSessionEventId, parseSessionId, sessionSequence } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionHeader } from '../session/types.js'
import type { AgentSpec } from '../agent/contract.js'
import { agentSpecRecordedEvent, subagentAgentSpecRecordedEvent } from '../agent/session-events.js'
import { agentContextProfileRecordedEvent, subagentContextProfileRecordedEvent } from '../context/session-events.js'
import { SESSION_ENVELOPE_VERSION } from '../session/types.js'
import type { StoredSessionEvent } from '../session/types.js'
import { isLocalHostMember } from './config.js'
import type { ResolvedHostLocalMember, ResolvedHostSpec } from './config.js'
import { HostError } from './errors.js'
import { fingerprintHostRecipe, hostSessionEventDefinitions, hostSessionPlannedEvent, hostSessionReadyEvent } from './session-events.js'
import { projectHostSession } from './session-projection.js'
import { acquireHostStorageLock } from './storage-lock.js'

export const hostRuntimeEventCatalog = createDurableEventCatalog([
  ...subagentSessionEventDefinitions, ...hostSessionEventDefinitions, ...contextSessionEventDefinitions, ...modelSessionEventDefinitions,
  ...toolSessionEventDefinitions, ...communicationSessionEventDefinitions, ...agentSessionEventDefinitions,
  ...workflowSessionEventDefinitions,
])

export interface HostInitializationResult {
  readonly kind?: 'agent'
  readonly agentKey: string
  readonly sessionId: string
  readonly mode: 'initialized' | 'adopted' | 'existing'
  readonly readyEventId: SessionEventId
}

function preflightInitialization(hostKey: string, member: ResolvedHostLocalMember, maximum: number): void {
  const sessionId = parseSessionId(member.sessionId)
  const eventId = (sequence: number) => formatSessionEventId(sessionId, sessionSequence(sequence))
  const recipeValue = recipe(member)
  const planned = hostSessionPlannedEvent.decode({ hostKey, agentKey: member.agentKey,
    recipe: recipeValue, fingerprint: fingerprintHostRecipe(recipeValue) })
  const profileDefinition = member.spec.protocolVersion === 1 ? agentContextProfileRecordedEvent : subagentContextProfileRecordedEvent
  const specDefinition = member.spec.protocolVersion === 1 ? agentSpecRecordedEvent : subagentAgentSpecRecordedEvent
  const profile = profileDefinition.decode(member.profile)
  const spec = specDefinition.decode(installedSpec(member, eventId(2)))
  const ready = hostSessionReadyEvent.decode({ hostKey, agentKey: member.agentKey, mode: 'initialized', planned: eventId(1),
    profile: eventId(2), spec: eventId(3), through: 3 })
  const values = [
    [hostSessionPlannedEvent, planned], [profileDefinition, profile],
    [specDefinition, spec], [hostSessionReadyEvent, ready],
  ] as const
  values.forEach(([definition, payload], index) => {
    const sequence = sessionSequence(index + 1)
    const stored: StoredSessionEvent = { envelopeVersion: SESSION_ENVELOPE_VERSION, sessionId,
      eventId: formatSessionEventId(sessionId, sequence), sequence, recordedAt: '9999-12-31T23:59:59.999Z',
      type: definition.type, payloadVersion: definition.payloadVersion, payload }
    const bytes = encodeStoredSessionEvent(stored).byteLength
    if (bytes > maximum) throw new HostError('HOST_CONFIG_INVALID', 'initialization-record-too-large', {
      agentKey: member.agentKey, type: definition.type, recordBytes: bytes, maxRecordBytes: maximum,
    })
  })
}

function same(a: object, b: object): boolean {
  return Buffer.from(canonicalJsonBytes(a as JsonObject)).equals(Buffer.from(canonicalJsonBytes(b as JsonObject)))
}
function recipe(member: ResolvedHostLocalMember): JsonObject {
  return { profile: member.profile as unknown as JsonObject, spec: member.spec as unknown as JsonObject }
}
function installedSpec(member: ResolvedHostLocalMember, profileEventId: SessionEventId): AgentSpec {
  return Object.freeze({ ...member.spec, profileEventId })
}
function profileEvent(session: SessionHandle, eventId: SessionEventId): CommittedSessionEvent<ContextProfile> | undefined {
  const event = session.snapshot().history.at(-1)?.events.find(item => item.kind === 'known' && item.stored.eventId === eventId)
  if (event?.kind !== 'known' || event.stored.type !== 'context/profile-recorded' || ![2, 3].includes(event.stored.payloadVersion)) return undefined
  return event as CommittedSessionEvent<ContextProfile>
}

/** Initialize or explicitly adopt every local member, then release all Writers. */
export async function initializeHost(
  spec: ResolvedHostSpec,
  options: { readonly clock?: Clock; readonly resume?: boolean } = {},
): Promise<readonly (HostInitializationResult | HostWorkflowInitializationResult)[]> {
  for (const member of spec.members.filter(isLocalHostMember)) {
    if (member.mode === 'create') preflightInitialization(spec.hostKey, member, spec.storage.maxRecordBytes)
  }
  if (spec.schemaVersion === 3 && spec.workflows.kind === 'enabled') {
    for (const entry of spec.workflows.definitions) {
      if (entry.sessionId === null) throw new HostError('HOST_CONFIG_INVALID', 'unplanned-workflow-identity')
      preflightWorkflowInitialization(spec.hostKey, entry.definition as unknown as WorkflowDefinition, spec.storage.maxRecordBytes)
    }
  }
  const storageLock = await acquireHostStorageLock(spec.storage.root, spec.hostKey)
  const backend = new FileSessionBackend({ root: storageLock.root, maxRecordBytes: spec.storage.maxRecordBytes })
  const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog,
    maxLineageDepth: spec.storage.maxLineageDepth, clock: options.clock ?? systemClock })
  const results: (HostInitializationResult | HostWorkflowInitializationResult)[] = []
  try {
    for (const member of spec.members.filter(isLocalHostMember)) {
      const result = member.mode === 'create'
        ? await initializeMember(repository, spec.hostKey, member, options.clock ?? systemClock, options.resume === true)
        : await adoptMember(repository, spec.hostKey, member)
      results.push(spec.schemaVersion === 3 ? { ...result, kind: 'agent' } : result)
    }
    if (spec.schemaVersion === 3 && spec.workflows.kind === 'enabled') {
      for (const entry of spec.workflows.definitions) {
        results.push(await initializeWorkflowCoordinator(repository, spec.hostKey,
          entry.definition as unknown as WorkflowDefinition, spec.storage.maxRecordBytes, options.resume === true))
      }
    }
    return Object.freeze(results)
  } finally {
    await repository.dispose()
    await storageLock.dispose()
  }
}

async function initializeMember(
  repository: SessionRepository,
  hostKey: string,
  member: ResolvedHostLocalMember,
  clock: Clock,
  resume: boolean,
  adoptEmptyHeader?: SessionHeader,
): Promise<HostInitializationResult> {
  let session: SessionHandle
  let created = false
  try {
    session = await repository.create({ sessionId: parseSessionId(member.sessionId) })
    created = true
  }
  catch (error) {
    if (!(error instanceof SessionError) || error.code !== 'SESSION_ALREADY_EXISTS') throw error
    session = await repository.open(parseSessionId(member.sessionId))
  }
  try {
    const expectedRecipe = recipe(member); const fingerprint = fingerprintHostRecipe(expectedRecipe)
    let binding = projectHostSession(session.snapshot())
    if (binding.ready !== null) {
      if (binding.ready.payload.hostKey !== hostKey || binding.ready.payload.agentKey !== member.agentKey
        || binding.planned === null || !same(binding.planned.payload.recipe, expectedRecipe)) conflict('ready-config-mismatch')
      assertInstalledSources(session, member, binding.ready.payload.profile, binding.ready.payload.spec)
      return Object.freeze({ agentKey: member.agentKey, sessionId: member.sessionId, mode: 'existing', readyEventId: binding.ready.stored.eventId })
    }
    if (binding.planned === null) {
      if (!created && (adoptEmptyHeader === undefined || session.snapshot().localPosition !== 0
        || !same(session.snapshot().header, adoptEmptyHeader))) {
        throw new HostError('HOST_BOOTSTRAP_AMBIGUOUS', session.snapshot().localPosition === 0 ? 'header-only-session' : 'unbound-nonempty-session')
      }
      await session.append(hostSessionPlannedEvent, { hostKey, agentKey: member.agentKey, recipe: expectedRecipe, fingerprint })
      binding = projectHostSession(session.snapshot())
    } else if (binding.planned.payload.hostKey !== hostKey || binding.planned.payload.agentKey !== member.agentKey
      || binding.planned.payload.fingerprint !== fingerprint || !same(binding.planned.payload.recipe, expectedRecipe)) conflict('planned-config-mismatch')
    else if (!resume) throw new HostError('HOST_RECOVERY_REQUIRED', 'matching-initialization-prefix-requires-resume')
    const localRecords = session.snapshot().history.at(-1)!.events
    if (localRecords.some(event => event.kind !== 'known')) conflict('opaque-initialization-prefix')
    const local = localRecords.filter(event => event.kind === 'known')
    const allowed = ['host/session-planned', 'context/profile-recorded', 'agent/spec-recorded']
    if (local.some((event, index) => event.stored.type !== allowed[index])) conflict('initialization-prefix')
    const context = new SessionContext({ session, messageCatalog: createMessageCatalog() })
    try {
      const profileHead = projectContextSession(session.snapshot()).profileHeads.find(item => item.profileKey === member.profile.profileKey)
      let profile = profileHead === undefined ? null : profileEvent(session, profileHead.eventId) ?? null
      if (profile === null) profile = await context.recordProfile(member.profile)
      else if (!same(profile.payload, member.profile)) conflict('profile-mismatch')
      let agent = projectAgentSession(session.snapshot()).spec
      const expected = installedSpec(member, profile.stored.eventId)
      if (agent === null) agent = await installAgentSpec(session, expected, clock)
      else if (!same(agent.payload, expected)) conflict('agent-spec-mismatch')
      const planned = binding.planned!
      const ready = await session.append(hostSessionReadyEvent, { hostKey, agentKey: member.agentKey, mode: 'initialized',
        planned: planned.stored.eventId, profile: profile.stored.eventId, spec: agent.stored.eventId, through: session.snapshot().localPosition })
      return Object.freeze({ agentKey: member.agentKey, sessionId: member.sessionId, mode: 'initialized', readyEventId: ready.stored.eventId })
    } finally { await context.dispose() }
  } finally { await session.dispose() }
}

/** Explicitly claim one exact Header-only Session after the predecessor is known stopped. */
export async function adoptEmptyHostMember(
  spec: ResolvedHostSpec,
  agentKey: string,
  options: { readonly predecessorStopped: true; readonly expectedHeader: SessionHeader; readonly clock?: Clock },
): Promise<HostInitializationResult> {
  if (options.predecessorStopped !== true) throw new HostError('HOST_BOOTSTRAP_AMBIGUOUS', 'adopt-empty-confirmation-required')
  const member = spec.members.filter(isLocalHostMember).find(item => item.agentKey === agentKey)
  if (member === undefined || member.mode !== 'create') throw new HostError('HOST_CONFIG_INVALID', 'adopt-empty-member-invalid')
  preflightInitialization(spec.hostKey, member, spec.storage.maxRecordBytes)
  const lock = await acquireHostStorageLock(spec.storage.root, spec.hostKey)
  const backend = new FileSessionBackend({ root: lock.root, maxRecordBytes: spec.storage.maxRecordBytes })
  const clock = options.clock ?? systemClock
  const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog,
    maxLineageDepth: spec.storage.maxLineageDepth, clock })
  try {
    return await initializeMember(repository, spec.hostKey, member, clock, true, options.expectedHeader)
  } finally {
    await repository.dispose()
    await lock.dispose()
  }
}

async function adoptMember(repository: SessionRepository, hostKey: string, member: ResolvedHostLocalMember): Promise<HostInitializationResult> {
  const session = await repository.open(parseSessionId(member.sessionId))
  try {
    const binding = projectHostSession(session.snapshot())
    if (binding.ready !== null) {
      if (binding.ready.payload.hostKey !== hostKey || binding.ready.payload.agentKey !== member.agentKey) conflict('ready-config-mismatch')
      assertInstalledSources(session, member, binding.ready.payload.profile, binding.ready.payload.spec)
      return Object.freeze({ agentKey: member.agentKey, sessionId: member.sessionId, mode: 'existing', readyEventId: binding.ready.stored.eventId })
    }
    if (binding.planned !== null) conflict('planned-session-requires-init')
    assertAgentExecutionQuiescent(session.snapshot())
    const agent = projectAgentSession(session.snapshot())
    if (agent.spec === null || agent.openRun !== null || agent.openRecovery !== null || agent.closing !== null
      || agent.controls.some(control => control.settled === null && control.supersededBy === null)) conflict('adopt-session-not-quiescent')
    const context = projectContextSession(session.snapshot())
    const profileHead = context.profileHeads.find(item => item.eventId === agent.spec!.payload.profileEventId)
    const profile = profileHead === undefined ? undefined : profileEvent(session, profileHead.eventId)
    if (profile === undefined || !same(profile.payload, member.profile)
      || !same(agent.spec.payload, installedSpec(member, agent.spec.payload.profileEventId))) conflict('adopt-recipe-mismatch')
    const ready = await session.append(hostSessionReadyEvent, { hostKey, agentKey: member.agentKey, mode: 'adopted', planned: null,
      profile: profile.stored.eventId, spec: agent.spec.stored.eventId, through: session.snapshot().localPosition })
    return Object.freeze({ agentKey: member.agentKey, sessionId: member.sessionId, mode: 'adopted', readyEventId: ready.stored.eventId })
  } finally { await session.dispose() }
}

function assertInstalledSources(
  session: SessionHandle,
  member: ResolvedHostLocalMember,
  profileEventId: SessionEventId,
  specEventId: SessionEventId,
): void {
  const profile = profileEvent(session, profileEventId)
  const agent = projectAgentSession(session.snapshot()).spec
  if (profile === undefined || agent === null || agent.stored.eventId !== specEventId
    || !same(profile.payload, member.profile)
    || !same(agent.payload, installedSpec(member, profileEventId))) conflict('ready-source-mismatch')
}

function conflict(reason: string): never { throw new HostError('HOST_BINDING_CONFLICT', reason) }
