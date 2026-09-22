import { scriptedModelDescriptor } from '../model/providers/scripted.js'
import { deepSeekModelDescriptor } from '../model/providers/deepseek.js'
import { anthropicModelDescriptor } from '../model/providers/anthropic.js'
import type { ChildAgentSpecTemplate } from '../agent/contract.js'
import { decodeChildAgentSpecTemplate } from '../agent/spec-codec.js'
import { agentJson, array, choice, equal, exact, integer, record, text } from '../agent/validation.js'
import type { ContextProfile } from '../context/contract.js'
import { decodeSubagentContextProfile } from '../context/profile.js'
import type { HostModelConfig } from '../host/config-types.js'
import type { ModelRunnerLimits, ModelStreamLimits } from '../model/contract.js'
import type { ToolInvocationLimits, ToolSchemaLimits } from '../tool/contract.js'
import { readLimits, readSchemaLimits } from '../tool/validation.js'
import type { DelegationCapabilities, SubagentLimits } from './contract.js'
import { decodeDelegationCapabilities } from './role-codec.js'
import { decodeSubagentLimits } from './request.js'
import { SubagentError } from './errors.js'

/** Tool options name logical roots. Only Host resource configuration contains native paths. */
export type ChildToolConfig =
  | { readonly kind: 'none' }
  | { readonly kind: 'workspace-text'; readonly read: boolean; readonly write: boolean;
    readonly maxReadBytes: number; readonly maxWriteBytes: number; readonly maxBaselineFiles: number; readonly maxBaselineBytes: number; readonly maxPathBytes: number;
    readonly maxArgumentsBytes: number; readonly maxResultBytes: number;
    readonly schemaLimits: ToolSchemaLimits; readonly invocationLimits: ToolInvocationLimits }

/** Full non-secret recipe; equal key/version requires equal content when reopening. */
export type ChildTemplate = {
  readonly templateKey: string
  readonly templateVersion: number
  readonly profile: ContextProfile
  readonly spec: ChildAgentSpecTemplate
  readonly model: HostModelConfig
  readonly tools: ChildToolConfig
  readonly capabilities: DelegationCapabilities
  readonly maxQuestions: number
  readonly maxProgress: number
  readonly limits: SubagentLimits
}

function modelConfig(value: unknown): HostModelConfig {
  const input = record(value)
  const kind = choice(input.kind, ['scripted-fixed', 'deepseek', 'anthropic'] as const)
  exact(input, ['kind', 'providerId', 'maxConcurrentExchanges', 'streamLimits', 'runnerLimits',
    ...(kind === 'scripted-fixed' ? ['text'] : ['endpoint', 'credentialRef'])])
  const stream = record(input.streamLimits); exact(stream, ['maxFrameBytes', 'maxStreamBytes', 'maxFrames'])
  for (const value of Object.values(stream)) integer(value, 1)
  const runner = record(input.runnerLimits)
  exact(runner, ['maxInputBytes', 'maxNormalizedResultBytes', 'maxOutputBlocks', 'maxToolCalls', 'maxJournalConflicts'])
  for (const [key, value] of Object.entries(runner)) integer(value, ['maxToolCalls', 'maxJournalConflicts'].includes(key) ? 0 : 1)
  const common = { providerId: text(input.providerId, 128), maxConcurrentExchanges: integer(input.maxConcurrentExchanges, 1),
    streamLimits: stream as unknown as ModelStreamLimits, runnerLimits: runner as unknown as ModelRunnerLimits }
  if (kind === 'scripted-fixed') return { kind, ...common, text: text(input.text, 65536) }
  const endpoint = text(input.endpoint, 2048)
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '' || url.search !== '') throw new Error('endpoint')
  return { kind, ...common, endpoint, credentialRef: text(input.credentialRef, 128) }
}

function toolConfig(value: unknown): ChildToolConfig {
  const input = record(value)
  if (input.kind === 'none') { exact(input, ['kind']); return { kind: 'none' } }
  choice(input.kind, ['workspace-text'])
  exact(input, ['kind', 'read', 'write', 'maxReadBytes', 'maxWriteBytes', 'maxBaselineFiles', 'maxBaselineBytes', 'maxPathBytes', 'maxArgumentsBytes', 'maxResultBytes', 'schemaLimits', 'invocationLimits'])
  if (typeof input.read !== 'boolean' || typeof input.write !== 'boolean' || !input.read && !input.write) throw new Error('tool-selection')
  for (const key of ['maxReadBytes', 'maxWriteBytes', 'maxPathBytes', 'maxArgumentsBytes', 'maxResultBytes']) integer(input[key], 1)
  integer(input.maxBaselineFiles, 0, 10000); integer(input.maxBaselineBytes)
  const schema = readSchemaLimits(record(input.schemaLimits)); const limits = readLimits(record(input.invocationLimits))
  if (limits.maxArgumentsBytes > Number(input.maxArgumentsBytes) || limits.maxResultBytes > Number(input.maxResultBytes)
    || schema.maxSchemaBytes !== limits.maxSchemaBytes || schema.maxSchemaDepth !== limits.maxSchemaDepth || schema.maxSchemaNodes !== limits.maxSchemaNodes) throw new Error('tool-limits')
  return input as ChildToolConfig
}

/** Validate a complete child recipe before recording it as a durable accepted obligation. */
export function decodeChildTemplate(value: unknown): ChildTemplate {
  try {
    const input = record(agentJson(value))
    exact(input, ['templateKey', 'templateVersion', 'profile', 'spec', 'model', 'tools', 'capabilities', 'maxQuestions', 'maxProgress', 'limits'])
    text(input.templateKey, 128); integer(input.templateVersion, 1)
    const profile = decodeSubagentContextProfile(input.profile)
    const spec = decodeChildAgentSpecTemplate(input.spec)
    if (spec.limits.maxPendingInputs === 0) throw new Error('child-task-capacity')
    const model = modelConfig(input.model); const tools = toolConfig(input.tools)
    const descriptor = model.kind === 'scripted-fixed' ? scriptedModelDescriptor(model) : model.kind === 'deepseek' ? deepSeekModelDescriptor(model) : anthropicModelDescriptor(model)
    const names = tools.kind === 'none' ? [] : [...(tools.read ? ['read_text'] : []), ...(tools.write ? ['write_text'] : [])]
    if (!equal(profile.toolNames, names) || !equal(spec.toolNames, names) || profile.previousEventId !== null
      || !equal(descriptor, spec.target.provider) || profile.budget.outputReserveTokens < spec.target.maxOutputTokens) throw new Error('template-binding')
    const capabilities = decodeDelegationCapabilities(input.capabilities)
    integer(input.maxQuestions); integer(input.maxProgress); decodeSubagentLimits(input.limits)
    if (spec.maxDirectSendCommandsPerSession !== 0 || array(spec.messages).length !== 0) throw new Error('child-direct-communication')
    return agentJson({ ...input, profile, spec, model, tools, capabilities }) as ChildTemplate
  } catch { throw new SubagentError('SUBAGENT_REQUEST_INVALID', 'invalid-template') }
}
