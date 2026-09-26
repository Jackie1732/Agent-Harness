import type { ToolInvocationLimits, ToolSchemaLimits } from './contract.js'
import { object, exact, choice, integer, invalid, readLimits, readSchemaLimits } from './validation.js'

/** Tool options name logical roots. Only Host resource configuration contains native paths. */
export type WorkspaceToolConfig =
  | { readonly kind: 'none' }
  | { readonly kind: 'workspace-text'; readonly read: boolean; readonly write: boolean;
    readonly maxReadBytes: number; readonly maxWriteBytes: number; readonly maxBaselineFiles: number; readonly maxBaselineBytes: number; readonly maxPathBytes: number;
    readonly maxArgumentsBytes: number; readonly maxResultBytes: number;
    readonly schemaLimits: ToolSchemaLimits; readonly invocationLimits: ToolInvocationLimits }

/** Decode limits shared by Host work and child workspace tools. */
export function decodeWorkspaceToolConfig(value: unknown): WorkspaceToolConfig {
  const input = object(value)
  if (input.kind === 'none') { exact(input, ['kind']); return { kind: 'none' } }
  choice(input.kind, ['workspace-text'])
  exact(input, ['kind', 'read', 'write', 'maxReadBytes', 'maxWriteBytes', 'maxBaselineFiles', 'maxBaselineBytes', 'maxPathBytes', 'maxArgumentsBytes', 'maxResultBytes', 'schemaLimits', 'invocationLimits'])
  if (typeof input.read !== 'boolean' || typeof input.write !== 'boolean' || !input.read && !input.write) throw new Error('tool-selection')
  for (const key of ['maxReadBytes', 'maxWriteBytes', 'maxPathBytes', 'maxArgumentsBytes', 'maxResultBytes']) integer(input[key], 1)
  if (integer(input.maxBaselineFiles, 0) > 10000) invalid(); integer(input.maxBaselineBytes, 0)
  const schema = readSchemaLimits(object(input.schemaLimits)); const limits = readLimits(object(input.invocationLimits))
  if (limits.maxArgumentsBytes > Number(input.maxArgumentsBytes) || limits.maxResultBytes > Number(input.maxResultBytes)
    || schema.maxSchemaBytes !== limits.maxSchemaBytes || schema.maxSchemaDepth !== limits.maxSchemaDepth || schema.maxSchemaNodes !== limits.maxSchemaNodes) throw new Error('tool-limits')
  return input as WorkspaceToolConfig
}
