import {
  SessionContext,
  assembleContext,
  contextSessionEventDefinitions,
  decodeProviderDescriptor,
  decodeToolProviderDescriptor,
  previewCompaction,
  projectCommunicationFacts,
  rebuildAssembly,
  snapshotModelRequest,
} from '../../src/index.js'
import type {
  ContextBuildResult,
  ContextProfile,
  ContextSelectionSpec,
  ModelInputPrecondition,
} from '../../src/index.js'

void SessionContext
void assembleContext
void contextSessionEventDefinitions
void decodeProviderDescriptor
void decodeToolProviderDescriptor
void previewCompaction
void projectCommunicationFacts
void rebuildAssembly
void snapshotModelRequest

declare const build: ContextBuildResult
if (build.kind === 'ready') {
  const request = build.request
  void request
}

declare const profile: ContextProfile
declare const selection: ContextSelectionSpec
declare const precondition: ModelInputPrecondition
void profile
void selection
void precondition

// @ts-expect-error Internal source units are not part of the root public surface.
import type { ContextUnit } from '../../src/index.js'
void (undefined as unknown as ContextUnit)

// @ts-expect-error Inbox decisions are closed to include-full or defer.
const invalidSelection: ContextSelectionSpec = { ...selection, inbox: [{ messageId: 'not-an-id', action: 'drop' }] }
void invalidSelection
