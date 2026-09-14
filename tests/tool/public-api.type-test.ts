import type {
  ToolProvider, ToolPolicy, ToolInvocationId, SessionId, ModelIntentReference,
  PreparedToolCall, SessionToolRunner, ToolDefinition, ToolInvocationLimits, ToolExecution,
} from '../../src/index.js'
// @ts-expect-error internal journal is not part of the root API
import type { ToolJournal } from '../../src/index.js'
// @ts-expect-error internal execution borrow cannot be acquired through the root API
import type { ToolBorrow } from '../../src/index.js'

declare const runner: SessionToolRunner
declare const definition: ToolDefinition
declare const limits: ToolInvocationLimits
declare const sessionId: SessionId
declare const invocationId: ToolInvocationId
declare const provider: ToolProvider
declare const execution: ToolExecution

/** Compile-only; never invoked. Every negative expectation must be used by the real project tsc. */
export function checkToolPublicContract(): void {
  const binding: PreparedToolCall = provider.prepare(definition, {}, limits)
  void binding
  void execution.close()
  // @ts-expect-error Session and Tool invocation identities are not interchangeable
  const wrongId: ToolInvocationId = sessionId
  void wrongId
  // @ts-expect-error Model-origin entry accepts a reference, never a forged result
  void runner.invokeModelIntent({ invocationId, outputBlockIndex: 0, validJson: true })
  // @ts-expect-error callers cannot reuse a ToolInvocationId on direct execution
  void runner.invoke({ name: 'read_text', input: { path: 'note.txt' }, invocationId })
  // @ts-expect-error reference input is not a completed result object
  const reference: ModelIntentReference = { outcome: 'completed', result: { name: 'read_text' } }
  void reference
  // @ts-expect-error Policy must be lifecycle-bound and use a structured decision
  const policy: ToolPolicy = { policyId: 'bad', version: 1, decide: () => 'allow' }
  void policy
  // @ts-expect-error prepare must be synchronous, not an asynchronous discovery/request
  const invalidProvider: ToolProvider = { ...provider, prepare: async () => binding }
  void invalidProvider
}
// Keep type-only negative imports in use without introducing runtime authority.
export type RejectedPrivateImports = [ToolJournal, ToolBorrow]
