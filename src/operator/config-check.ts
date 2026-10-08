import { dirname, resolve } from 'node:path'
import type { JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { decodeHostConfig, resolveHostConfig, HOST_CONFIG_LIMITS } from '../host/config.js'
import type { HostConfig } from '../host/config.js'
import { compileHostMessageCatalog } from '../host/message-catalog.js'
import { decodeApiConfig, resolveApiConfig } from '../api/config.js'
import { decodeUiConfig, resolveUiConfig } from '../ui/config.js'
import { decodeAutomationConfig, resolveAutomationConfig, AUTOMATION_CONFIG_LIMITS } from '../automation/config.js'
import { decodeExperimentDefinition } from '../experiment/definition.js'
import { HostError } from '../host/errors.js'
import type { JsonValidationLimits } from '../schema/bounded-json.js'
import { decodeOperatorProfile, resolveOperatorProfile, OPERATOR_PROFILE_LIMITS, readOperatorProfile } from './profile.js'
import type { ResolvedOperatorProfile } from './profile.js'
import type { ConfigCheck, ConfigDocument, ConfigEditableDocument, ConfigKind } from './config-types.js'
import { readConfigFile } from './config-files.js'
import { checkWorkflowRoster } from './config-workflows.js'

export const CONFIG_KINDS: readonly ConfigKind[] = ['operator', 'host', 'api', 'ui', 'automation', 'experiment']
/** Each adapter uses its original parser's finite input budget. */
export function configLimits(kind: ConfigKind): JsonValidationLimits {
  if (kind === 'operator') return OPERATOR_PROFILE_LIMITS
  if (kind === 'automation') return AUTOMATION_CONFIG_LIMITS
  if (kind === 'experiment') return { maxBytes: 16 * 1024 * 1024, maxDepth: 64, maxNodes: 200000 }
  return HOST_CONFIG_LIMITS
}
/** Select only an explicitly registered file. */
export function operatorConfigPath(profile: ResolvedOperatorProfile, kind: ConfigKind): string {
  if (kind === 'operator') return profile.profilePath
  if (kind === 'host') {
    if (profile.connection.kind !== 'local') throw new HostError('HOST_CONFIG_INVALID', 'remote-host-configuration-unavailable')
    return profile.connection.hostConfig
  }
  const path = profile.files[kind]
  if (path === null || kind === 'api' && profile.connection.kind !== 'local') throw new HostError('HOST_CONFIG_INVALID', 'configuration-not-configured', { kind })
  return path
}
export function hostNeedsPlan(config: HostConfig): boolean {
  return config.members.some(member => member.kind === 'local' && member.sessionId === null) || config.channels.some(channel => channel.channelId === null)
    || config.schemaVersion === 3 && config.workflows.kind === 'enabled' && config.workflows.definitions.some(entry => entry.sessionId === null)
}
/** Validate the original configuration format and its declared local dependencies without acquiring runtime resources. */
export async function checkConfigCandidate(kind: ConfigKind, value: JsonValue, baseDirectory: string, profile?: ResolvedOperatorProfile,
  hostCandidate?: { readonly value: JsonValue; readonly baseDirectory: string }): Promise<ConfigCheck> {
  const checked = (normalized: unknown, status: ConfigCheck['status'] = 'valid', protocolVersion: ConfigCheck['protocolVersion'] = null): ConfigCheck => ({ kind, status, protocolVersion,
    normalized: snapshotJson(normalized as JsonValue) })
  switch (kind) {
    case 'operator': {
      const resolved = resolveOperatorProfile(decodeOperatorProfile(value), resolve(baseDirectory, 'profile.json'))
      if (resolved.connection.kind === 'local') {
        const host = await readConfigFile(resolved.connection.hostConfig, HOST_CONFIG_LIMITS)
        await checkConfigCandidate('host', host.value, dirname(host.path), resolved)
      }
      for (const [owner, path] of Object.entries(resolved.files)) if (path !== null) {
        const kind = owner as Exclude<ConfigKind, 'operator' | 'host'>, file = await readConfigFile(path, configLimits(kind))
        if ((await checkConfigCandidate(kind, file.value, dirname(file.path), resolved)).status === 'dependency-needs-plan') throw new HostError('HOST_NOT_READY', 'dependency-needs-plan')
      }
      const { directory: _directory, profilePath: _path, callerNamespace: _caller, ...config } = resolved
      return checked(config)
    }
    case 'host': {
      const config = decodeHostConfig(value, baseDirectory)
      compileHostMessageCatalog(config.messages)
      if (hostNeedsPlan(config)) return checked(config, 'needs-plan', config.schemaVersion)
      const resolved = resolveHostConfig(config)
      checkWorkflowRoster(resolved)
      if (profile?.connection.kind === 'local' && profile.files.api !== null) {
        const api = await readConfigFile(profile.files.api, configLimits('api'))
        resolveApiConfig(decodeApiConfig(api.value), resolved, dirname(api.path))
      }
      return checked(config, 'valid', config.schemaVersion)
    }
    case 'api': {
      const config = decodeApiConfig(value)
      if (profile?.connection.kind !== 'local') throw new HostError('HOST_CONFIG_INVALID', 'api-local-host-dependency-required')
      const hostFile = hostCandidate === undefined ? await readConfigFile(profile.connection.hostConfig, HOST_CONFIG_LIMITS) : null
      const host = decodeHostConfig(hostCandidate?.value ?? hostFile!.value, hostCandidate?.baseDirectory ?? dirname(hostFile!.path))
      compileHostMessageCatalog(host.messages)
      if (hostNeedsPlan(host)) return checked(config, 'dependency-needs-plan')
      const resolvedHost = resolveHostConfig(host)
      checkWorkflowRoster(resolvedHost)
      const { protectedRoots: _protectedRoots, ...resolved } = resolveApiConfig(config, resolvedHost, baseDirectory)
      return checked(resolved)
    }
    case 'ui': return checked(resolveUiConfig(decodeUiConfig(value), baseDirectory))
    case 'automation': return checked(resolveAutomationConfig(decodeAutomationConfig(value), baseDirectory))
    case 'experiment': return checked(decodeExperimentDefinition(value, baseDirectory))
  }
}
/** Capture the editable original bytes and the full type-specific check at one selected path. */
export async function readConfigDocument(profilePath: string, kind: ConfigKind): Promise<ConfigDocument> {
  const profileFile = await readOperatorProfile(profilePath), path = operatorConfigPath(profileFile.profile, kind)
  const file = kind === 'operator' ? profileFile : await readConfigFile(path, configLimits(kind))
  return { kind, path: file.path, revision: file.revision, value: file.value,
    check: await checkConfigCandidate(kind, file.value, dirname(file.path), profileFile.profile) }
}
/** Capture an editable file and report validation failure without discarding its revision or data. */
export async function readEditableConfigDocument(profilePath: string, kind: ConfigKind): Promise<ConfigEditableDocument> {
  const profileFile = await readOperatorProfile(profilePath), path = operatorConfigPath(profileFile.profile, kind)
  const file = kind === 'operator' ? profileFile : await readConfigFile(path, configLimits(kind))
  try { return { kind, path: file.path, revision: file.revision, value: file.value,
    check: await checkConfigCandidate(kind, file.value, dirname(file.path), profileFile.profile), failure: null } }
  catch (cause) { return { kind, path: file.path, revision: file.revision, value: file.value, check: null,
    failure: cause instanceof HostError ? { code: cause.code, message: cause.message } : { code: 'HOST_CONFIG_INVALID', message: 'configuration-file-invalid' } } }
}
/** Report null references separately from declared configuration files. */
export async function checkAllOperatorConfigs(profilePath: string): Promise<readonly ({ readonly kind: ConfigKind; readonly status: 'not-configured' | 'invalid'; readonly error?: { readonly code: string; readonly message: string } } | ConfigDocument)[]> {
  const profile = (await readOperatorProfile(profilePath)).profile
  const result: ({ readonly kind: ConfigKind; readonly status: 'not-configured' | 'invalid'; readonly error?: { readonly code: string; readonly message: string } } | ConfigDocument)[] = []
  for (const kind of CONFIG_KINDS) {
    if (kind === 'host' && profile.connection.kind === 'remote' || kind !== 'operator' && kind !== 'host' && profile.files[kind] === null) result.push({ kind, status: 'not-configured' })
    else {
      try { result.push(await readConfigDocument(profilePath, kind)) }
      catch (cause) { result.push({ kind, status: 'invalid', error: cause instanceof HostError ? { code: cause.code, message: cause.message } : { code: 'HOST_CONFIG_INVALID', message: 'configuration-file-unavailable' } }) }
    }
  }
  return result
}
