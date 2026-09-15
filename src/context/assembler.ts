import type { ContextAssemblyInput, ContextBuildResult, ContextCapturedFacts, ContextProfile, ContextSelectionSpec } from './contract.js'
import type { CommittedSessionEvent, SessionSnapshot } from '../session/types.js'
import { buildContextFromSources } from './assembly-core.js'
import { resolveSelectedCompactions } from './compaction-replay.js'
import { invalidSource } from './errors.js'
import { contextArgumentFields, prepareContextSources } from './prepare.js'
import type { PreparedContextSources } from './prepare.js'
import { decodeCapturedFacts } from './surface-codec.js'
import { integer } from './validation.js'

/** Same pure pipeline is used by previews and the Session-owned capture/commit path. */
export function buildCapturedContext(prepared: PreparedContextSources, capturedInput: ContextCapturedFacts, sessionMaxRecordBytes: number): ContextBuildResult {
  const captured = decodeCapturedFacts(capturedInput)
  const compactions = resolveSelectedCompactions(prepared)
  if ('kind' in compactions) invalidSource('compaction-version-unsupported')
  return buildContextFromSources(prepared, captured, sessionMaxRecordBytes, compactions)
}
/** No clock, files, model invocation, registry access, message decoding, or durable writes. */
export function assembleContext(input: ContextAssemblyInput): ContextBuildResult {
  const fields = contextArgumentFields(input, ['snapshot', 'profile', 'selection', 'captured', 'sessionMaxRecordBytes'])
  const maximum = integer(fields.sessionMaxRecordBytes, 1, Number.MAX_SAFE_INTEGER)
  const prepared = prepareContextSources(fields.snapshot as SessionSnapshot, fields.profile as CommittedSessionEvent<ContextProfile>, fields.selection as ContextSelectionSpec)
  if ('kind' in prepared) return prepared
  return buildCapturedContext(prepared, fields.captured as ContextCapturedFacts, maximum)
}
