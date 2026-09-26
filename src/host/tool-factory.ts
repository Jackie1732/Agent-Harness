import type { HostExecutionExtensions } from './slot.js'
import { createWorkspaceWriteTextProvider, createWriteTextDefinition } from '../tool/providers/workspace-write.js'
import { EffectOwner } from '../effect/owner.js'
import type { Scope } from '../extension/types.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { ToolPolicy } from '../tool/contract.js'
import { createReadTextDefinition, createWorkspaceReadTextProvider } from '../tool/providers/workspace-read.js'
import { ToolRegistry } from '../tool/registry.js'
import { SessionToolRunner } from '../tool/runner.js'
import type { ResolvedHostLocalMember } from './config.js'
import { HostError } from './errors.js'

export interface HostToolResources {
  readonly runner: SessionToolRunner
  readonly registry: ToolRegistry
  readonly scope: Scope
  dispose(): Promise<void>
}

/** Assemble the configured read-only tool and retain its Host-owned resources. */
export async function createHostTools(
  session: SessionHandle,
  member: ResolvedHostLocalMember,
  protectedRoots: readonly string[],
  scope: Scope,
  extensions: HostExecutionExtensions = {},
): Promise<HostToolResources | undefined> {
  const { workspaceAccess: access, childTools, workspaceLease } = extensions
  const child = childTools?.kind === 'workspace-text' ? childTools : undefined
  if ((extensions.toolConfig ?? member.tools).kind === 'none' && child === undefined) return undefined
  const configured = child !== undefined && workspaceLease !== undefined ? { ...child, rootId: workspaceLease.request.resourceId, rootPath: workspaceLease.root.path,
    protectedRoots: [], policy: { policyId: 'delegated-workspace', version: 1, decision: 'allow' as const, reasonCode: 'delegation-grant' } } : extensions.toolConfig ?? member.tools
  if (configured.kind === 'none') return undefined
  const owner = new EffectOwner(`tools:${member.agentKey}`)
  const policyLife = new AbortController()
  let handedOff = false
  try {
    const lease = await owner.run('tool resources', async effect => {
      const registry = await effect.apply('registry', () => new ToolRegistry(configured.schemaLimits), value => value.dispose())
      if (child?.read !== false) {
      const provider = await effect.apply('read provider', () => createWorkspaceReadTextProvider({
        ...(access === undefined ? {} : { access }),
        rootId: configured.rootId,
        rootPath: configured.rootPath,
        protectedRoots: [...configured.protectedRoots, ...protectedRoots],
        maxReadBytes: configured.maxReadBytes,
        maxPathBytes: configured.maxPathBytes,
        maxArgumentsBytes: configured.maxArgumentsBytes,
        maxResultBytes: configured.maxResultBytes,
        schemaLimits: configured.schemaLimits,
      }), value => value.dispose())
      await effect.apply('registration', () => registry.register(scope, createReadTextDefinition(configured.schemaLimits), provider), value => value.dispose())
      }
      if (child?.write && access !== undefined) {
        const writer = await effect.apply('write provider', () => createWorkspaceWriteTextProvider({ ...configured, maxWriteBytes: child.maxWriteBytes, access, protectedRoots: [...configured.protectedRoots, ...protectedRoots] }), value => value.dispose())
        await effect.apply('write registration', () => registry.register(scope, createWriteTextDefinition(configured.schemaLimits), writer), value => value.dispose())
      }
      const configuredPolicy = configured.policy
      const policy: ToolPolicy = Object.freeze({
        policyId: configuredPolicy.policyId,
        version: configuredPolicy.version,
        signal: policyLife.signal,
        decide: () => Object.freeze({ kind: configuredPolicy.decision, reasonCode: configuredPolicy.reasonCode }),
      })
      const runner = await effect.apply('runner', () => new SessionToolRunner({ session, registry, scope, policy, limits: configured.invocationLimits }),
        value => handedOff ? undefined : value.dispose())
      return { runner, registry, scope }
    })
    handedOff = true
    return Object.freeze({ ...lease.value, dispose() { policyLife.abort(); return owner.dispose() } })
  } catch (cause) {
    policyLife.abort()
    try { await owner.dispose() }
    catch (cleanup) { throw new HostError('HOST_CLEANUP_FAILED', 'tool-assembly-rollback-incomplete', {}, { cause: new AggregateError([cause, cleanup]) }) }
    throw cause
  }
}
