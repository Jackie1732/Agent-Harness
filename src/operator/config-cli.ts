import { dirname, resolve } from 'node:path'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { HostError } from '../host/errors.js'
import type { ResolvedOperatorProfile } from './profile.js'
import { readOperatorProfile, decodeOperatorProfile } from './profile.js'
import type { ConfigKind, ConfigWriteOptions } from './config-types.js'
import { readConfigFile } from './config-files.js'
import { configLimits, CONFIG_KINDS } from './config-check.js'
import { setupOperator, readConfigDocument, readEditableConfigDocument, applyConfigOperations, decodeConfigOperations, planOperatorHost, rebindOperatorWorkflows,
  cloneOperatorHost, createOperatorConfig, linkOperatorConfig, importOperatorConfig, exportOperatorConfig, diffConfigCandidate, checkAllOperatorConfigs, configReadiness } from './config-operations.js'

export interface ConfigCommandResult {
  readonly result: JsonValue
  readonly profile: ResolvedOperatorProfile | null
  readonly rawConfig: JsonValue | null
}
function option(options: ReadonlyMap<string, string | true>, name: string, allowEmpty = false): string {
  const value = options.get(name)
  if (typeof value !== 'string' || !allowEmpty && value.length === 0) throw new HostError('HOST_CONFIG_INVALID', 'configuration-option-required', { option: name })
  return value
}
function kindOption(options: ReadonlyMap<string, string | true>): ConfigKind {
  const kind = option(options, '--kind')
  if (!CONFIG_KINDS.includes(kind as ConfigKind)) throw new HostError('HOST_CONFIG_INVALID', 'configuration-kind-invalid')
  return kind as ConfigKind
}
function writeOptions(options: ReadonlyMap<string, string | true>): ConfigWriteOptions {
  const revision = options.get('--expected-revision')
  if (revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) throw new HostError('HOST_CONFIG_INVALID', 'configuration-revision-invalid')
  return { ...(options.has('--replace') ? { replace: true } : {}), ...(revision === undefined ? {} : { expectedRevision: revision as string }) }
}
/** Execute a parsed noninteractive configuration command; the caller owns grammar, confirmation, stdin and output. */
export async function executeConfigCommand(command: readonly string[], options: ReadonlyMap<string, string | true>, input: () => Promise<JsonValue>): Promise<ConfigCommandResult> {
  const profilePath = resolve(option(options, '--profile'))
  let initialProfile: ResolvedOperatorProfile | null = null
  const complete = async (result: unknown, rawConfig: JsonValue | null = null, fallback: ResolvedOperatorProfile | null = initialProfile): Promise<ConfigCommandResult> => {
    let profile = fallback
    try { profile = (await readOperatorProfile(profilePath)).profile }
    catch (cause) { if (fallback === null && command[0] !== 'setup') throw cause }
    return { result: snapshotJson(result as JsonValue), profile, rawConfig }
  }
  if (command[0] === 'setup') {
    const data = await input()
    if (data === null || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 2
      || !Object.hasOwn(data, 'profile') || !Object.hasOwn(data, 'host')) throw new HostError('HOST_CONFIG_INVALID', 'setup-input-fields')
    const setup = data as JsonObject, profile = decodeOperatorProfile(setup.profile)
    if (option(options, '--mode') !== profile.connection.kind) throw new HostError('HOST_CONFIG_INVALID', 'setup-mode-profile-mismatch')
    const result = await setupOperator({ profilePath, profile, host: setup.host!, writeOptions: writeOptions(options) })
    return complete(result, null, result.profile)
  }
  if (command[0] !== 'config') throw new HostError('HOST_CONFIG_INVALID', 'configuration-command-invalid')
  initialProfile = (await readOperatorProfile(profilePath)).profile
  const action = command[1]
  if (action === 'check' && options.has('--all')) return complete(await checkAllOperatorConfigs(profilePath))
  const kind = kindOption(options), writes = writeOptions(options)
  const revision = async (): Promise<string> => writes.expectedRevision ?? (await readEditableConfigDocument(profilePath, kind)).revision
  switch (action) {
    case 'show': return complete(options.has('--redacted') ? await exportOperatorConfig(profilePath, kind, { redacted: true }) : await readConfigDocument(profilePath, kind))
    case 'check': return complete((await readConfigDocument(profilePath, kind)).check)
    case 'readiness': return complete(await configReadiness(profilePath, kind))
    case 'set': return complete(await applyConfigOperations(profilePath, kind,
      [{ op: 'set', pointer: option(options, '--pointer', true), value: await input() }], { expectedRevision: await revision() }))
    case 'apply': return complete(await applyConfigOperations(profilePath, kind, decodeConfigOperations(await input()), { expectedRevision: await revision() }))
    case 'plan': {
      if (kind !== 'host') throw new HostError('HOST_CONFIG_INVALID', 'configuration-plan-requires-host')
      return complete(await planOperatorHost(profilePath, { expectedRevision: await revision() }))
    }
    case 'workflow-bindings': {
      if (kind !== 'host') throw new HostError('HOST_CONFIG_INVALID', 'workflow-bindings-requires-host')
      const profile = (await readOperatorProfile(profilePath)).profile
      if (profile.connection.kind !== 'local') throw new HostError('HOST_CONFIG_INVALID', 'remote-server-configuration-unavailable')
      const file = await readConfigFile(profile.connection.hostConfig, configLimits('host'))
      return complete(await rebindOperatorWorkflows(profilePath, options.has('--ops-stdin') ? decodeConfigOperations(await input()) : undefined,
        { expectedRevision: writes.expectedRevision ?? file.revision }))
    }
    case 'clone': {
      if (kind !== 'host') throw new HostError('HOST_CONFIG_INVALID', 'configuration-clone-requires-host')
      return complete(await cloneOperatorHost(profilePath, { ...writes, newStorage: option(options, '--new-storage'), output: option(options, '--output'), hostKey: option(options, '--host-key') }))
    }
    case 'create': {
      if (kind === 'operator') throw new HostError('HOST_CONFIG_INVALID', 'operator-create-requires-setup')
      return complete(await createOperatorConfig(profilePath, kind, await input(), option(options, '--output'), writes))
    }
    case 'link': {
      if (kind === 'operator') throw new HostError('HOST_CONFIG_INVALID', 'operator-link-requires-setup')
      return complete(await linkOperatorConfig(profilePath, kind, option(options, '--file'), writes))
    }
    case 'import': {
      const document = await readEditableConfigDocument(profilePath, kind)
      const source = options.get('--source')
      const file = typeof source === 'string' ? await readConfigFile(source, configLimits(kind)) : null
      return complete(await importOperatorConfig(profilePath, kind, file?.value ?? await input(), file === null ? dirname(document.path) : dirname(file.path),
        { expectedRevision: writes.expectedRevision ?? document.revision }))
    }
    case 'export': {
      const output = options.get('--output')
      const result = await exportOperatorConfig(profilePath, kind, { ...writes, ...(options.has('--redacted') ? { redacted: true } : {}), ...(typeof output === 'string' ? { output } : {}) })
      return complete({ executable: result.executable, revision: result.revision }, typeof output === 'string' ? null : result.value)
    }
    case 'diff': {
      const file = await readConfigFile(option(options, '--candidate'), configLimits(kind))
      return complete(await diffConfigCandidate(profilePath, kind, file.value, dirname(file.path)))
    }
    default: throw new HostError('HOST_CONFIG_INVALID', 'configuration-command-invalid')
  }
}
