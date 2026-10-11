import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import type { ModelInvocationId } from '../model/ids.js'
import { parseModelInvocationId } from '../model/ids.js'
import { snapshotInputPrecondition } from '../model/input-precondition.js'
import { SessionError } from '../session/errors.js'
import type { SessionEventId, SessionLogPosition } from '../session/ids.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent, DurableEventDefinition } from '../session/index.js'
import type { ToolRegistry } from '../tool/registry.js'
import { buildCapturedContext } from './assembler.js'
import { assembleAgentContext } from './agent-assembler.js'
import { decodeAgentContextConsumer } from './agent-codec.js'
import type { AgentContextConsumer } from './agent-contract.js'
import { decodeAgentContextProfile, decodeSubagentContextProfile, decodeWorkflowContextProfile } from './profile.js'
import { agentContextProfileRecordedEvent, agentContextAssemblyCommittedEvent, subagentContextProfileRecordedEvent, subagentContextAssemblyCommittedEvent, workflowContextProfileRecordedEvent, workflowContextAssemblyCommittedEvent } from './session-events.js'
import { projectAgentSession } from '../agent/projection.js'
import { subagentMessageDefinitions } from '../subagent/messages.js'
import { workflowQuestionMessage, workflowAnswerMessage } from '../workflow/interaction-events.js'
import { workflowGroupMessage } from '../workflow/group-events.js'
import { describeToolForModel } from '../tool/model-bridge.js'
import { decodeMessagePayload } from '../communication/message-catalog.js'
import { captureContextFacts } from './capture.js'
import { previewCompaction as previewRuleCompaction } from './compaction-preview.js'
import { modelCompactionCandidate } from './compaction-replay.js'
import type {
  CommittedCompactionResult,
  CommittedContextBuildResult,
  ContextCompactionResult,
  ContextInput,
  ContextMemoryRecord,
  ContextMemoryRetraction,
  ContextProfile,
  ContextSelectionSpec,
  ContextUnitReference,
  RuleCompactionRequest,
} from './contract.js'
import { ContextError, invalidContext, invalidSource } from './errors.js'
import { collectContextFacts } from './history.js'
import type { ContextFacts } from './history.js'
import { decodeContextInput } from './input.js'
import { decodeContextMemory, decodeMemoryRetraction } from './memory.js'
import { prepareContextSources } from './prepare.js'
import { decodeContextProfile } from './profile.js'
import { projectContextSession } from './projection.js'
import { validateAllMaterialSources, validateMemorySources } from './references.js'
import { decodeRuleCompactionRequest, decodeContextSelection } from './selection.js'
import {
  contextAssemblyCommittedEvent,
  contextCompactionCommittedEvent,
  contextInputRecordedEvent,
  contextMemoryRecordedEvent,
  contextMemoryRetractedEvent,
  contextProfileRecordedEvent,
  legacyContextSessionEventDefinitions,
} from './session-events.js'
import { requireSourceIndex } from './sources.js'
import { contextJson, digest, record, unitReferences } from './validation.js'

export type SessionContextStatus = 'accepting' | 'disposing' | 'faulted' | 'disposed'

/** Borrowed runtime surfaces used by one Session-local Context coordinator. */
export interface SessionContextOptions {
  readonly session: SessionHandle
  readonly messageCatalog: MessageCatalog
  readonly toolRegistry?: ToolRegistry
  /** Capture the owning Component Scope signal during activation. */
  readonly signal?: AbortSignal
}

/** Cancellation can stop an operation only before its Session append is accepted. */
export interface ContextOperationOptions {
  readonly signal?: AbortSignal
}

interface SessionContextRuntime {
  readonly session: SessionHandle
  readonly messageCatalog: MessageCatalog
  readonly toolRegistry: ToolRegistry | undefined
  readonly lifetime: AbortSignal | undefined
}

/** Session-local Context admission, conditional commits, and lifecycle ownership. */
export class SessionContext {
  #runtime: SessionContextRuntime | undefined
  #status: SessionContextStatus = 'accepting'
  #active: Promise<unknown> | undefined
  #disposeTask: Promise<void> | undefined
  #failure: ContextError | undefined

  constructor(options: SessionContextOptions) {
    if (options.session.status !== 'open' || options.session.snapshot().lifecycle !== 'active') {
      throw new ContextError('CONTEXT_INACTIVE', 'session-not-active')
    }
    if (legacyContextSessionEventDefinitions.some(definition => !options.session.supportsEventDefinition(definition))) {
      throw new ContextError('CONTEXT_STATE_INVALID', 'session-catalog-incompatible')
    }
    projectContextSession(options.session.snapshot())
    this.#runtime = { session: options.session, messageCatalog: options.messageCatalog,
      toolRegistry: options.toolRegistry, lifetime: options.signal }
  }

  get status(): SessionContextStatus {
    return this.#status === 'accepting' && this.#runtime?.lifetime?.aborted === true ? 'disposing' : this.#status
  }

  /** Read only committed Context facts. */
  snapshot(): ReturnType<typeof projectContextSession> {
    const runtime = this.#assertAccepting()
    return projectContextSession(runtime.session.snapshot())
  }

  /** Append one complete Profile revision after checking its exact local head. */
  recordProfile(value: ContextProfile, options: ContextOperationOptions = {}): Promise<CommittedSessionEvent<ContextProfile>> {
    return this.#start(options, async (runtime, assertNotCancelled) => {
      const copied = record(contextJson(value))
      const definition = copied.rendererVersion === 'context-neutral/v4' ? workflowContextProfileRecordedEvent : copied.rendererVersion === 'context-neutral/v3' ? subagentContextProfileRecordedEvent
        : copied.rendererVersion === 'context-neutral/v2' ? agentContextProfileRecordedEvent : contextProfileRecordedEvent
      const profile = definition === workflowContextProfileRecordedEvent ? decodeWorkflowContextProfile(copied) : definition === subagentContextProfileRecordedEvent ? decodeSubagentContextProfile(copied)
        : definition === agentContextProfileRecordedEvent ? decodeAgentContextProfile(copied) : decodeContextProfile(copied)
      const snapshot = runtime.session.snapshot()
      const state = projectContextSession(snapshot)
      const current = state.profileHeads.find(item => item.profileKey === profile.profileKey)?.eventId ?? null
      if (current !== profile.previousEventId) throw new ContextError('CONTEXT_REVISION_CONFLICT', 'profile-head')
      assertNotCancelled()
      return await this.#append(runtime, snapshot.localPosition, definition, profile, 'CONTEXT_REVISION_CONFLICT')
    })
  }

  /** Append one bounded input whose referenced historical material is already visible. */
  recordInput(value: ContextInput, options: ContextOperationOptions = {}): Promise<CommittedSessionEvent<ContextInput>> {
    return this.#start(options, async (runtime, assertNotCancelled) => {
      const input = decodeContextInput(value)
      const snapshot = runtime.session.snapshot()
      projectContextSession(snapshot)
      if (input.kind === 'legacy-model-input') {
        const facts = this.#facts(snapshot)
        const invocation = facts.segments.flatMap(segment => segment.models.invocations)
          .find(item => item.prepared.stored.eventId === input.preparedEventId)
        if (invocation === undefined || input.toMessage > invocation.prepared.payload.submission.request.messages.length) {
          invalidSource('legacy-message-range')
        }
      }
      assertNotCancelled()
      return await this.#append(runtime, snapshot.localPosition, contextInputRecordedEvent, input, 'CONTEXT_SOURCE_CHANGED')
    })
  }

  /** Append one exact Memory revision after validating its closed source references. */
  recordMemory(value: ContextMemoryRecord, options: ContextOperationOptions = {}): Promise<CommittedSessionEvent<ContextMemoryRecord>> {
    return this.#start(options, async (runtime, assertNotCancelled) => {
      const memory = decodeContextMemory(value)
      const snapshot = runtime.session.snapshot()
      const facts = this.#facts(snapshot)
      const current = facts.local.material.memory.find(item => item.key === memory.key)?.headEventId ?? null
      if (current !== memory.previousEventId) throw new ContextError('CONTEXT_REVISION_CONFLICT', 'memory-head')
      validateMemorySources(facts, memory)
      assertNotCancelled()
      return await this.#append(runtime, snapshot.localPosition, contextMemoryRecordedEvent, memory, 'CONTEXT_REVISION_CONFLICT')
    })
  }

  /** Retract only the exact active Memory revision named by the caller. */
  retractMemory(value: ContextMemoryRetraction, options: ContextOperationOptions = {}): Promise<CommittedSessionEvent<ContextMemoryRetraction>> {
    return this.#start(options, async (runtime, assertNotCancelled) => {
      const retraction = decodeMemoryRetraction(value)
      const snapshot = runtime.session.snapshot()
      const state = projectContextSession(snapshot)
      const current = state.memory.find(item => item.key === retraction.key)
      if (current?.record === null || current?.headEventId !== retraction.previousEventId) {
        throw new ContextError('CONTEXT_REVISION_CONFLICT', 'memory-head')
      }
      assertNotCancelled()
      return await this.#append(runtime, snapshot.localPosition, contextMemoryRetractedEvent, retraction, 'CONTEXT_REVISION_CONFLICT')
    })
  }

  /** Compile and conditionally commit one generation request without invoking its Model. */
  assemble(value: ContextSelectionSpec, options: ContextOperationOptions = {}): Promise<CommittedContextBuildResult> {
    return this.#assemble(value, 'generation', options)
  }

  /** Capture metadata once, then commit the exact v2 request at its source cut. */
  assembleAgent(value: AgentContextConsumer, options: ContextOperationOptions = {}): Promise<CommittedContextBuildResult> {
    const consumer = decodeAgentContextConsumer(value)
    return this.#start(options, async (runtime, assertNotCancelled) => {
      const snapshot = runtime.session.snapshot()
      const state = projectAgentSession(snapshot)
      if (state.spec === null) invalidSource('agent-spec-missing')
      const registry = runtime.toolRegistry?.snapshot() ?? []
      const turn = state.turns.find(item => item.started.stored.eventId === consumer.turn)
      const root = state.roots.find(item => item.id === turn?.root)
      if (root === undefined) invalidSource('agent-context-root')
      const tools = root.allowedTools.flatMap(name => {
        const item = registry.find(item => item.definition.name === name && item.status === 'active')
        return item === undefined ? [] : [{ definition: item.definition, provider: item.provider, model: describeToolForModel(item.definition) }]
      })
      const messageKinds = state.spec.payload.protocolVersion === 1 ? state.spec.payload.messages : [...state.spec.payload.messages, ...subagentMessageDefinitions,
        ...(state.spec.payload.protocolVersion === 3 ? [workflowQuestionMessage, workflowAnswerMessage, workflowGroupMessage] : [])]
      const messageSupport = messageKinds.map(kind => {
        const definition = runtime.messageCatalog.resolve(kind.type, kind.payloadVersion)
        if (definition !== undefined) for (const input of state.inputs) {
          if (input.status === 'claimed' && input.message?.type === kind.type && input.message.payloadVersion === kind.payloadVersion) decodeMessagePayload(definition, input.message.payload)
        }
        return { type: kind.type, payloadVersion: kind.payloadVersion, supported: definition !== undefined }
      })
      const built = assembleAgentContext(snapshot, consumer, { tools, messageSupport }, runtime.session.maxRecordBytes)
      if (built.kind !== 'ready') return built
      assertNotCancelled()
      const committed = await this.#append(runtime, snapshot.localPosition, state.spec.payload.protocolVersion === 3 ? workflowContextAssemblyCommittedEvent : state.spec.payload.protocolVersion === 1 ? agentContextAssemblyCommittedEvent : subagentContextAssemblyCommittedEvent, built.assembly, 'CONTEXT_SOURCE_CHANGED')
      return { kind: 'ready', committed, request: built.request, inputPrecondition: snapshotInputPrecondition({ sessionId: snapshot.header.sessionId,
        expectedLocalPosition: committed.stored.sequence, expectedProviderDescriptor: built.assembly.selection.target.provider }),
        committedEnvelopeBytes: canonicalJsonBytes(committed.stored as unknown as JsonValue).byteLength }
    })
  }

  /** Compile and conditionally commit one model-summary input without invoking its Model. */
  prepareCompactionInput(value: ContextSelectionSpec, options: ContextOperationOptions = {}): Promise<CommittedContextBuildResult> {
    return this.#assemble(value, 'compaction', options)
  }

  /** Evaluate deterministic excerpt compaction at the current committed cut. */
  previewCompaction(value: RuleCompactionRequest): ContextCompactionResult {
    const runtime = this.#assertAccepting()
    const request = decodeRuleCompactionRequest(value)
    const snapshot = runtime.session.snapshot()
    const profile = this.#profile(snapshot, request.profileEventId)
    return previewRuleCompaction({ snapshot, profile, request })
  }

  /** Commit deterministic excerpt compaction only when it has measured byte savings. */
  compact(value: RuleCompactionRequest, options: ContextOperationOptions = {}): Promise<CommittedCompactionResult> {
    return this.#start(options, async (runtime, assertNotCancelled) => {
      const request = decodeRuleCompactionRequest(value)
      const snapshot = runtime.session.snapshot()
      const profile = this.#profile(snapshot, request.profileEventId)
      const result = previewRuleCompaction({ snapshot, profile, request })
      if (result.kind !== 'ready') return result
      assertNotCancelled()
      const committed = await this.#append(runtime, snapshot.localPosition, contextCompactionCommittedEvent, result.compaction, 'CONTEXT_SOURCE_CHANGED')
      return Object.freeze({ kind: 'committed' as const, committed })
    })
  }

  /** Adopt one already settled, adjacent model summary and commit no caller-supplied text. */
  adoptModelCompaction(
    invocationId: ModelInvocationId,
    protectedRefs: readonly ContextUnitReference[],
    options: ContextOperationOptions = {},
  ): Promise<CommittedCompactionResult> {
    return this.#start(options, async (runtime, assertNotCancelled) => {
      const parsed = parseModelInvocationId(invocationId)
      const protections = unitReferences(contextJson(protectedRefs, 64 * 1024))
      const snapshot = runtime.session.snapshot()
      const candidate = modelCompactionCandidate(this.#facts(snapshot), parsed, protections)
      if (candidate.kind === 'unsupported') invalidSource('compaction-version-unsupported')
      if (candidate.kind !== 'ready') return candidate
      assertNotCancelled()
      const committed = await this.#append(runtime, snapshot.localPosition, contextCompactionCommittedEvent, candidate.compaction, 'CONTEXT_SOURCE_CHANGED')
      return Object.freeze({ kind: 'committed' as const, committed })
    })
  }

  /** Close admission, join accepted commits, and retire references without disposing borrowed resources. */
  dispose(): Promise<void> {
    if (this.#disposeTask === undefined) {
      this.#status = 'disposing'
      const active = this.#active
      const task = Promise.resolve().then(async () => {
        if (active !== undefined) await active.catch(() => undefined)
        this.#runtime = undefined
        this.#status = 'disposed'
        if (this.#failure !== undefined) throw this.#failure
      })
      this.#disposeTask = task
      void task.catch(() => undefined)
    }
    return this.#disposeTask
  }

  #assemble(
    value: ContextSelectionSpec,
    purpose: ContextProfile['purpose'],
    options: ContextOperationOptions,
  ): Promise<CommittedContextBuildResult> {
    return this.#start(options, async (runtime, assertNotCancelled) => {
      const selection = decodeContextSelection(value)
      const snapshot = runtime.session.snapshot()
      const profile = this.#profile(snapshot, selection.profileEventId)
      if (profile.payload.purpose !== purpose) invalidContext('profile-purpose')
      const prepared = prepareContextSources(snapshot, profile, selection)
      if ('kind' in prepared) return prepared
      const captured = captureContextFacts(prepared.facts, prepared.profile, prepared.selection, runtime.messageCatalog, runtime.toolRegistry)
      const built = buildCapturedContext(prepared, captured, runtime.session.maxRecordBytes)
      if (built.kind !== 'ready') return built
      assertNotCancelled()
      const committed = await this.#append(runtime, snapshot.localPosition, contextAssemblyCommittedEvent, built.assembly, 'CONTEXT_SOURCE_CHANGED')
      return Object.freeze({
        kind: 'ready' as const,
        committed,
        request: built.request,
        inputPrecondition: snapshotInputPrecondition({
          sessionId: runtime.session.header.sessionId,
          expectedLocalPosition: committed.stored.sequence,
          expectedProviderDescriptor: selection.target.provider,
        }),
        committedEnvelopeBytes: canonicalJsonBytes(committed.stored as unknown as JsonValue).byteLength,
      })
    })
  }

  #profile(snapshot: ReturnType<SessionHandle['snapshot']>, id: SessionEventId): CommittedSessionEvent<ContextProfile> {
    const profile = projectContextSession(snapshot).profiles.find(item => item.stored.eventId === id)
    if (profile === undefined) invalidSource('profile-pin')
    return profile
  }

  #facts(snapshot: ReturnType<SessionHandle['snapshot']>): ContextFacts {
    const index = requireSourceIndex(snapshot)
    const result = collectContextFacts(index, { maxUnits: 10_000 })
    if ('kind' in result) invalidSource('context-source-unit-limit')
    validateAllMaterialSources(result)
    return result
  }

  #start<T>(options: ContextOperationOptions, operation: (runtime: SessionContextRuntime, assertNotCancelled: () => void) => Promise<T>): Promise<T> {
    const signal = options.signal
    const runtime = this.#assertAccepting(signal)
    if (this.#active !== undefined) throw new ContextError('CONTEXT_SESSION_BUSY', 'operation-overlap')
    const assertNotCancelled = this.#assertNotCancelled.bind(this, runtime.lifetime, signal)
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const task = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    this.#active = task
    void task.then(
      () => { if (this.#active === task) this.#active = undefined },
      () => { if (this.#active === task) this.#active = undefined },
    )
    try { void operation(runtime, assertNotCancelled).then(resolve, reject) }
    catch (reason) { reject(reason) }
    return task
  }

  async #append<T extends JsonValue>(
    runtime: SessionContextRuntime,
    expected: SessionLogPosition,
    definition: DurableEventDefinition<T>,
    payload: T,
    conflict: 'CONTEXT_REVISION_CONFLICT' | 'CONTEXT_SOURCE_CHANGED',
  ): Promise<CommittedSessionEvent<T>> {
    try {
      return await runtime.session.appendIfPosition(expected, definition, payload)
    } catch (reason) {
      if (reason instanceof SessionError && reason.code === 'SESSION_PRECONDITION_FAILED') {
        throw new ContextError(conflict, conflict === 'CONTEXT_REVISION_CONFLICT' ? 'revision-head-changed' : 'source-cut-changed', {
          sessionId: runtime.session.header.sessionId,
          expectedLocalPosition: expected,
          eventType: definition.type,
        })
      }
      const unknown = !(reason instanceof SessionError) || reason.code === 'SESSION_APPEND_OUTCOME_UNKNOWN'
      const error = new ContextError(
        unknown ? 'CONTEXT_JOURNAL_COMMIT_UNKNOWN' : 'CONTEXT_JOURNAL_WRITE_FAILED',
        unknown ? 'commit-outcome-unknown' : 'commit-not-written',
        {
          sessionId: runtime.session.header.sessionId,
          expectedLocalPosition: expected,
          eventType: definition.type,
          payloadDigest: digest(payload),
          ...(reason instanceof SessionError ? { sessionCode: reason.code } : {}),
        },
      )
      if (unknown) {
        this.#failure ??= error
        this.#status = 'faulted'
      }
      throw error
    }
  }

  #assertAccepting(signal?: AbortSignal): SessionContextRuntime {
    const runtime = this.#runtime
    if (this.status !== 'accepting' || runtime === undefined || runtime.session.status !== 'open'
      || runtime.session.snapshot().lifecycle !== 'active' || signal?.aborted === true) {
      throw new ContextError('CONTEXT_INACTIVE', signal?.aborted === true ? 'operation-cancelled' : 'context-not-accepting')
    }
    return runtime
  }

  #assertNotCancelled(lifetime: AbortSignal | undefined, signal: AbortSignal | undefined): void {
    if (signal?.aborted === true || lifetime?.aborted === true) {
      throw new ContextError('CONTEXT_INACTIVE', 'operation-cancelled-before-commit')
    }
  }
}
