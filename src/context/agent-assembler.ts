import { pendingOutboxContext } from './communication-history.js'
import { subagentObligationUnits } from './subagent-obligations.js'
import type { SessionSnapshot } from '../session/types.js'
import { projectAgentSession } from '../agent/projection.js'
import { agentNativeToolDefinitions } from '../agent/native-actions.js'
import { inputKey } from '../agent/input-codec.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import { snapshotModelRequest } from '../model/request.js'
import type { ModelRequest } from '../model/contract.js'
import type { AgentContextAssembly, AgentContextConsumer } from './agent-contract.js'
import { decodeAgentContextAssembly, decodeAgentContextConsumer } from './agent-codec.js'
import { agentDataMessage, agentTurnUnits } from './agent-sources.js'
import type { AgentContextUnit } from './agent-sources.js'
import { measureAssemblyEnvelope, measureContextRequest, requestBudgetFailure } from './budget.js'
import type { ContextBuildFailure, ContextCapturedFacts, ContextSelectionSpec } from './contract.js'
import { invalidSource } from './errors.js'
import { retrieveSessionMemory } from './memory.js'
import { memoryReferences } from './material-state.js'
import { resolveSelectedCompactions } from './compaction-replay.js'
import { prepareContextFacts } from './prepare.js'
import { decodeAgentContextProfile, decodeSubagentContextProfile, decodeWorkflowContextProfile } from './profile.js'
import { decodeCapturedFacts } from './surface-codec.js'
import { digest, equalJson } from './validation.js'
import { knownEvent, requireSourceIndex } from './sources.js'

export type AgentContextBuild = { readonly kind: 'ready'; readonly assembly: AgentContextAssembly; readonly request: ModelRequest } | ContextBuildFailure

/** Pure v2 compiler. Only a committed claim and its root's closed exchanges can supply required task data. */
export function assembleAgentContext(snapshot: SessionSnapshot, consumerInput: AgentContextConsumer, capturedInput: ContextCapturedFacts, sessionMaxRecordBytes: number): AgentContextBuild {
  const consumer = decodeAgentContextConsumer(consumerInput)
  const state = projectAgentSession(snapshot)
  const spec = state.spec
  const turn = state.turns.find(item => item.started.stored.eventId === consumer.turn)
  const step = state.steps.find(item => item.opened.stored.eventId === consumer.step)
  if (spec?.stored.eventId !== consumer.spec || state.openRun !== consumer.run || state.openTurn !== consumer.turn
    || turn?.started.payload.run !== consumer.run || step?.opened.payload.turn !== consumer.turn || step.decided !== null) invalidSource('agent-context-consumer')
  const rawProfile = knownEvent(requireSourceIndex(snapshot), spec.payload.profileEventId, 'context/profile-recorded')
  if (rawProfile.stored.payloadVersion !== (spec.payload.protocolVersion + 1)) invalidSource('agent-profile-version')
  const profile = spec.payload.protocolVersion === 3 ? decodeWorkflowContextProfile(rawProfile.payload) : spec.payload.protocolVersion === 1 ? decodeAgentContextProfile(rawProfile.payload) : decodeSubagentContextProfile(rawProfile.payload)
  if (profile.tokenAccounting.mode === 'exact-required') return { kind: 'blocked', reason: 'estimator-unavailable', references: [] }
  if (profile.budget.outputReserveTokens < spec.payload.target.maxOutputTokens) invalidSource('agent-output-reserve')
  const facts = prepareContextFacts(snapshot, profile)
  if ('kind' in facts) return facts
  const root = state.roots.find(item => item.id === turn.root)!
  const isWork = root.source.kind === 'workflow'
  const rootMemory = isWork ? { required: [], query: { requiredTags: [], queryTags: [], topK: 0 } } : spec.payload.context.memory
  const captured = decodeCapturedFacts(capturedInput)
  if (!equalJson(captured.tools.map(tool => tool.definition.name), root.allowedTools)) return { kind: 'blocked', reason: 'tool-unavailable', references: [] }
  const chain = state.turns.filter(item => item.root === turn.root)
  const required = [...agentTurnUnits(snapshot, state, chain), ...subagentObligationUnits(state, turn.root)]
  const optional: AgentContextUnit[][] = []
  const historyPolicy = spec.payload.context.history
  const historyRoots = isWork || historyPolicy.mode === 'none' || historyPolicy.maxRoots === 0 ? []
    : state.roots.filter(root => root.outcome === 'completed' && root.id !== turn.root).slice(-historyPolicy.maxRoots).map(root => root.id)
  for (const id of historyRoots) {
    const root = state.roots.find(item => item.id === id)
    if (root?.outcome !== 'completed' || root.id === turn.root) invalidSource('agent-history-root-not-complete')
    optional.push([...agentTurnUnits(snapshot, state, state.turns.filter(item => item.root === id))])
  }
  const protectedIds = new Set(required.flatMap(unit => unit.sourceEventIds))
  const allowedIds = new Set([...protectedIds, ...optional.flatMap(units => units.flatMap(unit => unit.sourceEventIds))])
  const safeMemoryIds = new Set<import('../session/ids.js').SessionEventId>()
  for (const revision of facts.local.material.memoryRevisions) {
    if (memoryReferences(revision.payload).every(ref => allowedIds.has(ref.eventId) || safeMemoryIds.has(ref.eventId))) safeMemoryIds.add(revision.stored.eventId)
  }
  const safeMemory = facts.local.material.memory.filter(head => head.record !== null && safeMemoryIds.has(head.record.stored.eventId))
  const memory: AgentContextUnit[] = []
  const memoryUnit = (id: import('../session/ids.js').SessionEventId): AgentContextUnit => {
    const entry = safeMemory.find(head => head.record?.stored.eventId === id)?.record
    if (entry === undefined || entry === null) return invalidSource('agent-memory-outside-selected-history')
    return { reference: { eventId: id, selector: 'memory' }, sourceEventIds: [id], messages: [agentDataMessage('memory', id, entry.payload)] }
  }
  for (const ref of rootMemory.required) memory.push(memoryUnit(ref.eventId))
  const candidates = retrieveSessionMemory(safeMemory, rootMemory.query)
  if (candidates.length > profile.budget.maxMemoryCandidates) return { kind: 'resource-limit', limit: 'memory-candidates', maximum: profile.budget.maxMemoryCandidates }
  const comm = projectCommunicationFacts(snapshot)
  const pendingWaits = state.waits.filter(wait => wait.settled === null && (!isWork || wait.created.payload.result.kind === 'wait' && wait.created.payload.result.descriptor.root === root.id)).map(wait => ({ reference: wait.reference,
    kind: wait.created.payload.result.kind === 'wait' ? wait.created.payload.result.descriptor.kind : 'unavailable',
    root: wait.created.payload.result.kind === 'wait' ? wait.created.payload.result.descriptor.root : null,
    deadline: wait.created.payload.result.kind === 'wait' ? wait.created.payload.result.descriptor.deadline : null }))
  const pendingOutbox = isWork ? [] : pendingOutboxContext(comm, snapshot)
  required.unshift({ reference: { eventId: step.opened.stored.eventId, selector: 'diagnostic' },
    sourceEventIds: [spec.stored.eventId, step.opened.stored.eventId, ...pendingOutbox.map(item => item.acceptedEventId), ...state.waits.filter(wait => wait.settled === null && (!isWork || wait.created.payload.result.kind === 'wait' && wait.created.payload.result.descriptor.root === root.id)).map(wait => wait.created.stored.eventId)],
    messages: [agentDataMessage('agent-runtime', { spec: spec.stored.eventId, step: step.opened.stored.eventId }, {
      label: spec.payload.label, responsibility: spec.payload.responsibility, nonGoals: spec.payload.nonGoals, peers: isWork ? [] : spec.payload.peers, messageKinds: isWork ? [] : spec.payload.messages,
      ...(spec.payload.protocolVersion !== 1 && (!isWork || root.allowedNativeActions.includes('agent_spawn_subagent')) ? { delegationAuthority: spec.payload.subagents } : {}),
      root: turn.root, budgetUsed: state.roots.find(item => item.id === turn.root)!.budget, budgetLimits: root.limit, pendingWaits, pendingOutbox,
    })] })
  const selectedInputs = new Set(chain.map(item => inputKey(item.started.payload.input)))
  for (const input of state.inputs.filter(item => selectedInputs.has(inputKey(item.reference)) && item.message !== null)) {
    if (!captured.messageSupport.some(item => item.type === input.message!.type && item.payloadVersion === input.message!.payloadVersion && item.supported)) {
      return { kind: 'blocked', reason: 'unsupported-message', references: [{ eventId: input.reference.eventId, selector: 'peer-message' }] }
    }
  }
  const selection: ContextSelectionSpec = { profileEventId: spec.payload.profileEventId, target: spec.payload.target,
    requiredInputs: [], observations: [], history: { mode: 'local-suffix', representation: 'raw' }, compactions: isWork ? [] : spec.payload.context.compactions, memory: rootMemory,
    inbox: comm.inbox.filter(item => item.status === 'pending').map(item => ({ messageId: item.messageId,
      action: selectedInputs.has(inputKey({ kind: 'peer', eventId: item.acceptedEventId })) ? 'include-full' : 'defer' })), outboxPayloads: [], compactionSource: null }
  const base = spec.payload.target
  const compactions = resolveSelectedCompactions({ facts, profile, selection })
  if ('kind' in compactions) return { kind: 'blocked', reason: 'history-unrepresentable', references: [] }
  for (const item of compactions) {
    if (item.leaves.some(leaf => leaf.sourceEventIds.some(id => protectedIds.has(id)))) invalidSource('agent-compaction-protected-source')
    if (optional.some(units => units.some(unit => item.leaves.some(leaf => leaf.sourceEventIds.some(id => unit.sourceEventIds.includes(id)))))) invalidSource('agent-compaction-overlapping-history')
    optional.unshift([{ reference: item.unit.reference, sourceEventIds: item.unit.sourceEventIds, messages: item.unit.rawMessages }])
  }
  const render = (history: readonly AgentContextUnit[], memories: readonly AgentContextUnit[]): ModelRequest => snapshotModelRequest({
    model: base.model, instructions: profile.sections.map(section => section.text), tools: [...captured.tools.map(tool => tool.model), ...agentNativeToolDefinitions(root.allowedNativeActions)],
    messages: [...history, ...memories, ...required].flatMap(unit => unit.messages), maxOutputTokens: base.maxOutputTokens,
    ...(base.temperature === undefined ? {} : { temperature: base.temperature }), ...(base.topP === undefined ? {} : { topP: base.topP }), ...(base.profile === undefined ? {} : { profile: base.profile }),
  })
  let history: AgentContextUnit[] = []
  let request = render(history, memory)
  let measured = measureContextRequest(request, profile)
  if ('kind' in measured) return measured
  const failure = requestBudgetFailure(measured, profile, required.map(unit => unit.reference))
  if (failure !== undefined) return failure
  const memoryTokens = (items: readonly AgentContextUnit[]) => Math.ceil(Buffer.byteLength(JSON.stringify(items.flatMap(unit => unit.messages))) / profile.tokenAccounting.bytesPerEstimatedToken)
  if (memoryTokens(memory) > profile.budget.maxMemoryEstimatedTokens && memory.length > 0) return { kind: 'budget-exceeded', limit: 'input-tokens', required: memoryTokens(memory), available: profile.budget.maxMemoryEstimatedTokens, references: memory.map(unit => unit.reference) }
  const omitted: AgentContextAssembly['omitted'][number][] = []
  for (const units of [...optional].reverse()) {
    const trial = render([...units, ...history], memory)
    const measure = measureContextRequest(trial, profile)
    if ('kind' in measure || requestBudgetFailure(measure, profile, []) !== undefined) omitted.push(...units.map(unit => ({ reference: unit.reference, reason: 'history-budget' as const })))
    else { history = [...units, ...history]; request = trial; measured = measure }
  }
  for (const candidate of candidates) {
    if (memory.some(unit => unit.reference.eventId === candidate.reference.eventId)) continue
    if (!candidate.withinTopK) { omitted.push({ reference: candidate.reference, reason: 'memory-top-k' }); continue }
    const unit = memoryUnit(candidate.reference.eventId)
    const trial = render(history, [...memory, unit]); const measure = measureContextRequest(trial, profile)
    if ('kind' in measure || requestBudgetFailure(measure, profile, []) !== undefined || memoryTokens([...memory, unit]) > profile.budget.maxMemoryEstimatedTokens) omitted.push({ reference: candidate.reference, reason: 'memory-budget' })
    else { memory.push(unit); request = trial; measured = measure }
  }
  const units = [...history, ...memory, ...required]
  if (units.length > profile.budget.maxUnits) return { kind: 'resource-limit', limit: 'units', maximum: profile.budget.maxUnits }
  const provenance: AgentContextAssembly['provenance'][number][] = []
  profile.sections.forEach((section, i) => provenance.push({ location: `instructions[${i}]`, source: { kind: 'profile-section', eventId: rawProfile.stored.eventId, name: section.name }, sourceDigest: digest(section) }))
  request.tools.forEach((tool, i) => provenance.push({ location: `tools[${i}]`, source: { kind: 'tool-surface', name: tool.name }, sourceDigest: digest(tool) }))
  for (const field of ['model', 'maxOutputTokens', 'temperature', 'topP', 'profile'] as const) if (request[field] !== undefined) provenance.push({ location: field, source: { kind: 'inline-control', field }, sourceDigest: digest(request[field]!) })
  let messageIndex = 0
  for (const unit of units) for (const message of unit.messages) {
    const source = { kind: 'unit' as const, reference: unit.reference, eventIds: unit.sourceEventIds, representation: 'raw' as const }
    message.content.forEach((block, i) => provenance.push({ location: `messages[${messageIndex}].content[${i}]`, source, sourceDigest: digest(block) }))
    if (message.role === 'assistant' && message.continuation !== undefined) provenance.push({ location: `messages[${messageIndex}].continuation`, source, sourceDigest: digest(message.continuation) })
    messageIndex++
  }
  if (provenance.length > profile.budget.maxProvenanceEntries) return { kind: 'resource-limit', limit: 'provenance', maximum: profile.budget.maxProvenanceEntries }
  const assembly: AgentContextAssembly = { purpose: 'generation', rendererVersion: profile.rendererVersion, consumer, claimedInput: turn.started.payload.input,
    requiredTurns: chain.map(item => item.started.stored.eventId), historyRoots,
    deferredInputs: state.inputs.filter(item => !selectedInputs.has(inputKey(item.reference)) && ['queued', 'reserved', 'claimed'].includes(item.status)).map(item => item.reference),
    coverage: facts.index.coverage, selection, captured, required: required.map(unit => unit.reference),
    selected: units.map(unit => ({ reference: unit.reference, sourceEventIds: unit.sourceEventIds,
      placement: required.includes(unit) ? 'required' : memory.includes(unit) ? 'memory' : 'history', representation: 'raw' })),
    omitted, deferred: comm.inbox.filter(item => item.status === 'pending' && !selectedInputs.has(inputKey({ kind: 'peer', eventId: item.acceptedEventId }))).map(item => ({
      messageId: item.messageId, acceptedEventId: item.acceptedEventId, sender: item.envelope.sender, recipient: item.envelope.recipient, channelId: item.envelope.channelId,
      channelSequence: item.envelope.channelSequence, correlationId: item.envelope.correlationId, causationId: item.envelope.causationId ?? null, replyTo: item.envelope.replyTo ?? null,
      status: 'pending', reason: 'not-selected-this-assembly' })), pendingOutbox, memoryCandidates: candidates.map(({ text: _text, ...item }) => item), provenance, request, requestDigest: digest(request),
    budget: { accounting: 'neutral-json-utf8-estimate/v1', precision: 'estimate', requestBytes: measured.bytes, estimatedInputTokens: measured.estimatedTokens,
      availableInputTokens: measured.availableTokens, memoryEstimatedTokens: memory.length === 0 ? 0 : memoryTokens(memory), assemblyEnvelopeUpperBoundBytes: 0, sessionMaxRecordBytes,
      sourceEvents: facts.index.sourceEvents, sourceBytes: facts.index.sourceBytes, units: units.length } }
  const measuredAssembly = measureAssemblyEnvelope(snapshot.header, snapshot.localPosition, assembly) as AgentContextAssembly
  for (const [limit, available] of [['assembly-bytes', profile.budget.maxAssemblyBytes], ['session-record-bytes', sessionMaxRecordBytes]] as const) {
    if (measuredAssembly.budget.assemblyEnvelopeUpperBoundBytes > available) return { kind: 'budget-exceeded', limit, required: measuredAssembly.budget.assemblyEnvelopeUpperBoundBytes, available, references: assembly.required }
  }
  return { kind: 'ready', assembly: decodeAgentContextAssembly(measuredAssembly, spec.payload.protocolVersion === 3 ? 4 : spec.payload.protocolVersion === 1 ? 2 : 3), request }
}
