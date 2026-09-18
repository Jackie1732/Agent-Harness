import * as h from '../../dist/index.js'

export { h }
export const schemaLimits = Object.freeze({ maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 })
export const toolLimits = Object.freeze({ ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536,
  maxArgumentsBytes: 4096, maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 })
export const modelLimits = Object.freeze({ maxInputBytes: 65536, maxNormalizedResultBytes: 16384,
  maxOutputBlocks: 16, maxToolCalls: 8, maxJournalConflicts: 4 })
export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export function echoDefinition(overrides = {}) {
  return h.createToolDefinition({ name: 'echo', version: 1, description: 'Return the authorized input without modification.',
    operationClass: 'external', inputSchema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false }, ...overrides }, schemaLimits)
}
export function descriptor(definition, capacity = 1, overrides = {}) {
  return { providerId: 'test-tool', adapterVersion: '1', resourceId: 'ledger', tools: [{ name: definition.name, version: definition.version }],
    maxConcurrentExecutions: capacity, maxArgumentsBytes: 4096, maxResultBytes: 8192, ...overrides }
}
export function catalog(extra = []) {
  return h.createDurableEventCatalog([...h.toolSessionEventDefinitions, ...h.modelSessionEventDefinitions, ...extra])
}
export function toolEvents(session) { return session.snapshot().history.at(-1).events.filter(event => event.stored.type.startsWith('tool/')) }

/** Every test owns a fresh object graph. Finalizers release only resources created here. */
export async function fixture(body, options = {}) {
  const capabilities = new h.CapabilityRegistry()
  const scope = capabilities.scope.derive('tool-test')
  const registry = new h.ToolRegistry(options.schemaLimits ?? schemaLimits)
  const backend = options.backend ?? new h.MemorySessionBackend({ maxRecordBytes: options.maxRecordBytes ?? 262144 })
  const repository = new h.SessionRepository({ backend, catalog: options.catalog ?? catalog(), maxLineageDepth: 8, ...(options.clock === undefined ? {} : { clock: options.clock }) })
  const session = await repository.create()
  const definition = options.definition ?? echoDefinition()
  const trace = { prepares: 0, approvals: 0, acquisitions: 0, starts: 0, closes: 0, ledger: 0, plans: [], approved: [], signals: [] }
  const policyLife = new AbortController()
  const policy = { policyId: 'test-policy', version: 1, signal: policyLife.signal,
    decide: async (input, { signal }) => {
      trace.approvals++; trace.approved.push(input)
      return options.decide === undefined ? { kind: 'allow', reasonCode: 'research' } : options.decide(input, signal)
    },
  }
  const provider = options.provider ?? new h.ScriptedToolProvider({
    descriptor: descriptor(definition, options.capacity ?? 1, options.descriptorOverrides),
    onPrepare: plan => { trace.prepares++; options.onPrepare?.(plan) },
    acquire: async (plan, signal) => {
      trace.acquisitions++; trace.signals.push(signal)
      if (options.acquire !== undefined) return options.acquire(plan, signal, trace)
      return h.createScriptedToolExecution(async () => {
        trace.starts++; trace.ledger++; trace.plans.push(plan)
        return options.execute === undefined ? { kind: 'success', value: plan.input } : options.execute(plan, signal, trace)
      }, async () => { trace.closes++; await options.close?.(plan, signal, trace) })
    },
  })
  const runners = [], providers = [provider], registrations = [], unblock = []
  const makeRunner = (overrides = {}) => {
    const runner = new h.SessionToolRunner({ session, registry, scope, policy, limits: options.limits ?? toolLimits, ...overrides })
    runners.push(runner); return runner
  }
  const registration = options.noRegister ? undefined : registry.register(scope, definition, provider)
  if (registration !== undefined) registrations.push(registration)
  const runner = options.noRunner ? undefined : makeRunner()
  const f = { capabilities, scope, registry, repository, session, definition, provider, policy, policyLife, trace,
    registration, runner, runners, providers, registrations, makeRunner,
    releaseOnCleanup: gate => { unblock.push(() => gate.resolve()) },
  }
  let bodyFailure
  try { await body(f) } catch (reason) { bodyFailure = reason }
  const failures = []
  for (const release of unblock) release()
  for (const resource of [...runners].reverse().concat([...registrations].reverse(), registry, [...providers].reverse(), scope, capabilities, repository)) {
    try { await resource.dispose() } catch (reason) { failures.push(reason) }
  }
  if (bodyFailure !== undefined) throw bodyFailure
  if (failures.length !== 0 && !options.allowCleanupFailure) throw new AggregateError(failures, 'test cleanup failed')
}

/** Narrow, explicit backend seam. It does not alter the Session implementation or global fs. */
export class FaultBackend {
  constructor(base, before = async () => {}, after = async () => {}) {
    this.base = base; this.before = before; this.after = after; this.unknown = new Set()
  }
  get maxRecordBytes() { return this.base.maxRecordBytes }
  create(header) { return this.base.create(header) }
  async openWriter(id) {
    const writer = await this.base.openWriter(id)
    return { header: writer.header, readCommitted: () => writer.readCommitted(),
      append: async (position, event) => {
        try {
          await this.before(event)
          const committed = await writer.append(position, event)
          await this.after(event)
          return committed
        } catch (reason) {
          if (reason instanceof h.SessionError && reason.code === 'SESSION_APPEND_OUTCOME_UNKNOWN') this.unknown.add(id)
          throw reason
        }
      },
      dispose: async () => { try { await writer.dispose() } finally { this.unknown.delete(id) } },
    }
  }
  readPrefix(id, through) {
    if (this.unknown.has(id)) throw new h.SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'injected unknown writer boundary')
    return this.base.readPrefix(id, through)
  }
  dispose() { return this.base.dispose() }
}

export function scriptedModel(f, calls = [{ name: f.definition.name, argumentsText: '{"n":1}' }], options = {}) {
  const provider = new h.ScriptedModelProvider({ providerId: 'tool-source-model', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 8192, maxStreamBytes: 65536, maxFrames: 64 },
    onClose: options.onClose,
    script: async function* () {
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'source-response' }
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index]
        yield { kind: 'block-start', index, block: 'tool-call', callId: `call-${index}`, name: call.name }
        yield { kind: 'arguments-delta', index, text: call.argumentsText }
        yield { kind: 'block-end', index }
      }
      await options.beforeComplete?.()
      yield { kind: 'complete', stopReason: options.stopReason ?? 'tool-calls' }
    },
  })
  const runner = new h.SessionModelRunner({ session: f.session, provider, limits: modelLimits })
  f.providers.push(provider); f.runners.push(runner)
  const request = { model: 'fixture-model', instructions: [], tools: options.tools ?? [h.describeToolForModel(f.definition)], maxOutputTokens: 128,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Test explicit tool intent.' }] }] }
  return { provider, runner, request, invoke: invocationOptions => runner.invoke(request, invocationOptions) }
}
