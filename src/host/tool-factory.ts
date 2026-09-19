import { CapabilityRegistry } from '../capability/registry.js'
import type { Scope } from '../extension/types.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { ToolPolicy, ToolProvider } from '../tool/contract.js'
import { createReadTextDefinition, createWorkspaceReadTextProvider } from '../tool/providers/workspace-read.js'
import { ToolRegistry } from '../tool/registry.js'
import type { ToolRegistration } from '../tool/registry.js'
import { SessionToolRunner } from '../tool/runner.js'
import type { ResolvedHostLocalMember } from './config.js'

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
  storageRoot: string,
): Promise<HostToolResources | undefined> {
  if (member.tools.kind === 'none') return undefined
  const capabilities = new CapabilityRegistry()
  const scope = capabilities.scope.derive(`agent-tools:${member.agentKey}`)
  const registry = new ToolRegistry(member.tools.schemaLimits)
  const policyLife = new AbortController()
  let provider: ToolProvider | undefined
  let registration: ToolRegistration | undefined
  let runner: SessionToolRunner | undefined
  try {
    provider = await createWorkspaceReadTextProvider({
      rootId: member.tools.rootId,
      rootPath: member.tools.rootPath,
      protectedRoots: [...member.tools.protectedRoots, storageRoot],
      maxReadBytes: member.tools.maxReadBytes,
      maxPathBytes: member.tools.maxPathBytes,
      maxArgumentsBytes: member.tools.maxArgumentsBytes,
      maxResultBytes: member.tools.maxResultBytes,
      schemaLimits: member.tools.schemaLimits,
    })
    registration = registry.register(scope, createReadTextDefinition(member.tools.schemaLimits), provider)
    const configuredPolicy = member.tools.policy
    const policy: ToolPolicy = Object.freeze({
      policyId: configuredPolicy.policyId,
      version: configuredPolicy.version,
      signal: policyLife.signal,
      decide: () => Object.freeze({ kind: configuredPolicy.decision, reasonCode: configuredPolicy.reasonCode }),
    })
    runner = new SessionToolRunner({ session, registry, scope, policy, limits: member.tools.invocationLimits })
    let disposeTask: Promise<void> | undefined
    return Object.freeze({
      runner,
      registry,
      scope,
      dispose() {
        if (disposeTask === undefined) {
          policyLife.abort()
          disposeTask = disposeResources([registration!, registry, provider!, scope, capabilities])
          void disposeTask.catch(() => undefined)
        }
        return disposeTask
      },
    })
  } catch (cause) {
    policyLife.abort()
    try { await disposeResources([runner, registration, registry, provider, scope, capabilities]) }
    catch (cleanup) { throw new AggregateError([cause, cleanup], 'Host tool assembly and rollback failed') }
    throw cause
  }
}

async function disposeResources(resources: readonly ({ dispose(): Promise<void> } | undefined)[]): Promise<void> {
  const failures: unknown[] = []
  for (const resource of resources) {
    if (resource === undefined) continue
    try { await resource.dispose() }
    catch (cause) { failures.push(cause) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Host tool resources failed to close')
}
