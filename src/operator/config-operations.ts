import { dirname, join, relative, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { decodeHostConfig, planHostConfig, resolveHostConfig } from '../host/config.js'
import type { HostIdentitySource } from '../host/config.js'
import { exportHostConfig } from '../host/config-export.js'
import { HostError } from '../host/errors.js'
import { decodeAutomationConfig, resolveAutomationConfig, automationConfigDigest } from '../automation/config.js'
import { readOperatorProfile, decodeOperatorProfile, resolveOperatorProfile, operatorProfileBinding } from './profile.js'
import type { OperatorProfile, ResolvedOperatorProfile } from './profile.js'
import type { ConfigKind, ConfigOperation, ConfigCheck, ConfigDocument, ConfigEditableDocument, ConfigWriteOptions, ConfigMutationResult, ConfigDiff, ConfigWriteStep } from './config-types.js'
import { readConfigFile, publishConfigFile } from './config-files.js'
import { applyConfigTreeOperations, changedConfigPointers } from './config-tree.js'
import { configLimits, checkConfigCandidate, readConfigDocument, readEditableConfigDocument, operatorConfigPath, hostNeedsPlan } from './config-check.js'
import { rebuildWorkflowBindings, cloneHostCandidate } from './config-workflows.js'
import { checkOfflineHostBindings, configFailure } from './config-readiness.js'

export { readConfigDocument, readEditableConfigDocument, checkConfigCandidate, checkAllOperatorConfigs, CONFIG_KINDS } from './config-check.js'
export { applyConfigTreeOperations, decodeConfigOperations } from './config-tree.js'
export { configReadiness } from './config-readiness.js'
export type * from './config-types.js'

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause }
}
function requirePublishableConfig(check: ConfigCheck): void {
  if (check.status === 'dependency-needs-plan') throw new HostError('HOST_NOT_READY', 'dependency-needs-plan')
  if (check.kind === 'host' && check.status === 'needs-plan' && (check.normalized as { workflows?: { kind?: string } }).workflows?.kind === 'enabled') {
    throw new HostError('HOST_NOT_READY', 'workflow-bindings-required')
  }
}
function assertConfigDestination(profile: ResolvedOperatorProfile, kind: ConfigKind, path: string, allowSelected = true): void {
  const files: readonly [ConfigKind, string | null][] = [['operator', profile.profilePath], ['host', profile.connection.kind === 'local' ? profile.connection.hostConfig : null],
    ...Object.entries(profile.files) as [ConfigKind, string | null][]]
  if (files.some(([owner, file]) => file !== null && relative(file, path) === '' && (!allowSelected || owner !== kind))) throw new HostError('HOST_CONFIG_INVALID', 'configuration-file-reference-collision')
}
/** Classify saved candidates through original snapshot checks rather than a durable-field list. */
export async function diffConfigCandidate(profilePath: string, kind: ConfigKind, candidate: JsonValue, candidateDirectory?: string): Promise<ConfigDiff> {
  const document = await readEditableConfigDocument(profilePath, kind), profile = (await readOperatorProfile(profilePath)).profile
  const check = await checkConfigCandidate(kind, candidate, candidateDirectory ?? dirname(document.path), profile)
  return classifyDifference(document, check.normalized)
}
async function classifyDifference(document: ConfigDocument | ConfigEditableDocument, normalized: JsonValue): Promise<ConfigDiff> {
  const changedPointers = changedConfigPointers(document.check?.normalized ?? document.value, normalized)
  let effect: ConfigDiff['effect'] = changedPointers.length === 0 ? 'unchanged' : 'restart'
  let binding: ConfigDiff['binding'] = 'not-checked', reason: string | null = null
  if (changedPointers.length !== 0) {
    if (document.kind === 'experiment') effect = 'new-experiment-plan'
    else if (document.kind === 'automation') effect = 'new-journal'
    else if (document.kind === 'operator') {
      const old = resolveOperatorProfile(decodeOperatorProfile(document.check?.normalized ?? document.value), document.path), next = resolveOperatorProfile(decodeOperatorProfile(normalized), document.path)
      if (relative(old.journal.root, next.journal.root) !== '' || old.journal.sessionId !== next.journal.sessionId) effect = 'new-journal'
      else if (changedPointers.every(pointer => pointer.startsWith('/display/'))) effect = 'reload-display'
    }
    else if (document.kind === 'host') {
      const config = decodeHostConfig(normalized, dirname(document.path))
      if (hostNeedsPlan(config)) return { revision: document.revision, changedPointers, effect: 'admission-check-required', binding, reason: 'needs-plan' }
      try {
        const checked = await checkOfflineHostBindings(resolveHostConfig(config))
        binding = checked.status === 'compatible' ? 'compatible' : checked.status === 'incompatible' ? 'incompatible' : 'not-checked'
        reason = checked.reason
      } catch (cause) { binding = 'incompatible'; reason = configFailure(cause).message }
      if (binding !== 'compatible') effect = 'admission-check-required'
    }
  }
  return { revision: document.revision, changedPointers, effect, binding, reason }
}
async function preservePersistentBindings(kind: ConfigKind, before: JsonValue, after: JsonValue, path: string): Promise<void> {
  if (kind === 'operator') {
    const old = resolveOperatorProfile(decodeOperatorProfile(before), path), next = resolveOperatorProfile(decodeOperatorProfile(after), path)
    const sameJournal = relative(old.journal.root, next.journal.root) === '' && old.journal.sessionId === next.journal.sessionId
    if (sameJournal
      && !Buffer.from(canonicalJsonBytes(operatorProfileBinding(old))).equals(Buffer.from(canonicalJsonBytes(operatorProfileBinding(next))))
      && await exists(join(old.journal.root, 'sessions', old.journal.sessionId))) throw new HostError('HOST_BINDING_CONFLICT', 'operator-journal-identity-bound')
    if (!sameJournal
      && await exists(join(next.journal.root, 'sessions', next.journal.sessionId))) throw new HostError('HOST_BINDING_CONFLICT', 'operator-target-journal-already-bound')
  } else if (kind === 'automation') {
    const old = resolveAutomationConfig(decodeAutomationConfig(before), dirname(path)), next = resolveAutomationConfig(decodeAutomationConfig(after), dirname(path))
    if (relative(old.journal.root, next.journal.root) === '' && old.journal.sessionId === next.journal.sessionId
      && automationConfigDigest(old) !== automationConfigDigest(next) && await exists(join(old.journal.root, 'sessions', old.journal.sessionId))) {
      throw new HostError('HOST_BINDING_CONFLICT', 'automation-config-requires-new-journal')
    }
  }
}
async function saveCandidate(document: ConfigDocument | ConfigEditableDocument, candidate: JsonValue, profile: ResolvedOperatorProfile, expectedRevision: string): Promise<ConfigMutationResult> {
  await preservePersistentBindings(document.kind, document.value, candidate, document.path)
  const check = await checkConfigCandidate(document.kind, candidate, dirname(document.path), profile)
  requirePublishableConfig(check)
  const diff = await classifyDifference(document, check.normalized)
  const revision = await publishConfigFile(document.path, candidate, { replace: true, expectedRevision }, configLimits(document.kind), async () => {
    requirePublishableConfig(await checkConfigCandidate(document.kind, candidate, dirname(document.path), profile))
    await preservePersistentBindings(document.kind, document.value, candidate, document.path)
  })
  const result: ConfigDocument = { kind: document.kind, path: document.path, value: snapshotJson(candidate), revision, check }
  return { document: result, diff, steps: [{ kind: document.kind, path: document.path, revision }], failure: null }
}
/** Validate a complete candidate after all typed edits, then replace the original revision once. */
export async function applyConfigOperations(profilePath: string, kind: ConfigKind, operations: readonly ConfigOperation[], options: { readonly expectedRevision: string }): Promise<ConfigMutationResult> {
  const document = await readEditableConfigDocument(profilePath, kind), profile = (await readOperatorProfile(profilePath)).profile
  return saveCandidate(document, applyConfigTreeOperations(document.value, operations), profile, options.expectedRevision)
}
/** Allocate only missing Host identities and save the exact planned file. */
export async function planOperatorHost(profilePath: string, options: { readonly expectedRevision: string; readonly identities?: HostIdentitySource }): Promise<ConfigMutationResult> {
  const document = await readConfigDocument(profilePath, 'host'), profile = (await readOperatorProfile(profilePath)).profile
  const planned = planHostConfig(decodeHostConfig(document.value, dirname(document.path)), options.identities)
  return saveCandidate(document, planned as unknown as JsonValue, profile, options.expectedRevision)
}
/** Repair roster values in the same unpublished candidate that changes its members. */
export async function rebindOperatorWorkflows(profilePath: string, operations: readonly ConfigOperation[] | undefined,
  options: { readonly expectedRevision: string; readonly identities?: HostIdentitySource }): Promise<ConfigMutationResult> {
  const profile = (await readOperatorProfile(profilePath)).profile, path = operatorConfigPath(profile, 'host')
  const file = await readConfigFile(path, configLimits('host'))
  const candidate = operations === undefined ? file.value : applyConfigTreeOperations(file.value, operations)
  const planned = rebuildWorkflowBindings(candidate, dirname(path), options.identities)
  const previous = decodeHostConfig({ ...(file.value as JsonObject), workflows: { kind: 'disabled' } }, dirname(path))
  const document: ConfigDocument = { kind: 'host', ...file, check: await checkConfigCandidate('host', previous as unknown as JsonValue, dirname(path), profile) }
  return saveCandidate(document, planned as unknown as JsonValue, profile, options.expectedRevision)
}
/** Create an independent local Host recipe without changing the profile or copying durable data. */
export async function cloneOperatorHost(profilePath: string, options: ConfigWriteOptions & { readonly newStorage: string; readonly output: string; readonly hostKey: string; readonly identities?: HostIdentitySource }): Promise<ConfigMutationResult> {
  const document = await readConfigDocument(profilePath, 'host'), profile = (await readOperatorProfile(profilePath)).profile
  assertConfigDestination(profile, 'host', resolve(options.output), false)
  const output = resolve(options.output), candidate = cloneHostCandidate(decodeHostConfig(document.value, dirname(document.path)), resolve(options.newStorage), options.hostKey, dirname(output), options.identities)
  const check = await checkConfigCandidate('host', candidate as unknown as JsonValue, dirname(output), profile)
  const revision = await publishConfigFile(output, candidate as unknown as JsonValue, options, configLimits('host'))
  return { document: { kind: 'host', path: output, revision, value: candidate as unknown as JsonValue, check }, diff: await classifyDifference(document, check.normalized),
    steps: [{ kind: 'host', path: output, revision }], failure: null }
}
async function linkProfile(profilePath: string, kind: Exclude<ConfigKind, 'operator'>, file: string, expectedRevision: string): Promise<ConfigWriteStep> {
  const current = await readOperatorProfile(profilePath)
  if (kind === 'host' && current.profile.connection.kind !== 'local' || kind === 'api' && current.profile.connection.kind !== 'local') throw new HostError('HOST_CONFIG_INVALID', 'remote-server-configuration-unavailable')
  const raw = current.value as JsonObject
  const candidate = kind === 'host' ? { ...raw, connection: { ...(raw.connection as JsonObject), hostConfig: file } }
    : { ...raw, files: { ...(raw.files as JsonObject), [kind]: file } }
  const decoded = decodeOperatorProfile(candidate)
  await preservePersistentBindings('operator', current.value, decoded as unknown as JsonValue, profilePath)
  const revision = await publishConfigFile(profilePath, decoded as unknown as JsonValue, { replace: true, expectedRevision }, configLimits('operator'))
  return { kind: 'operator', path: resolve(profilePath), revision }
}
/** Publish a valid original-format file, then register its path; report either completed step. */
export async function createOperatorConfig(profilePath: string, kind: Exclude<ConfigKind, 'operator'>, value: JsonValue, outputInput: string, options: ConfigWriteOptions = {}): Promise<ConfigMutationResult> {
  const current = await readOperatorProfile(profilePath), output = resolve(outputInput)
  if ((kind === 'host' || kind === 'api') && current.profile.connection.kind !== 'local') throw new HostError('HOST_CONFIG_INVALID', 'remote-server-configuration-unavailable')
  const check = await checkConfigCandidate(kind, value, dirname(output), current.profile)
  requirePublishableConfig(check)
  assertConfigDestination(current.profile, kind, output)
  let previous: JsonValue | undefined
  if (kind === 'automation' && await exists(output)) previous = (await readConfigFile(output, configLimits(kind))).value
  const revision = await publishConfigFile(output, value, options, configLimits(kind), async () => {
    requirePublishableConfig(await checkConfigCandidate(kind, value, dirname(output), current.profile))
    if (previous !== undefined) await preservePersistentBindings(kind, previous, value, output)
  })
  const steps: ConfigWriteStep[] = [{ kind, path: output, revision }]
  let failure: ConfigMutationResult['failure'] = null
  try { steps.push(await linkProfile(profilePath, kind, output, current.revision)) }
  catch (cause) { failure = configFailure(cause) }
  return { document: { kind, path: output, revision, value: snapshotJson(value), check },
    diff: { revision: options.expectedRevision ?? '', changedPointers: [''], effect: 'admission-check-required', binding: 'not-checked', reason: null }, steps, failure }
}
/** Validate an existing file before registering it; no file contents are rewritten. */
export async function linkOperatorConfig(profilePath: string, kind: Exclude<ConfigKind, 'operator'>, input: string, options: { readonly expectedRevision?: string } = {}): Promise<ConfigMutationResult> {
  const current = await readOperatorProfile(profilePath), path = resolve(input), file = await readConfigFile(path, configLimits(kind))
  assertConfigDestination(current.profile, kind, path)
  const check = await checkConfigCandidate(kind, file.value, dirname(path), current.profile)
  requirePublishableConfig(check)
  const step = await linkProfile(profilePath, kind, path, options.expectedRevision ?? current.revision)
  return { document: { kind, ...file, check }, diff: { revision: current.revision, changedPointers: [kind === 'host' ? '/connection/hostConfig' : `/files/${kind}`],
    effect: 'restart', binding: 'not-checked', reason: null }, steps: [step], failure: null }
}
/** Set up explicit complete candidates; each published step remains visible after a later failure. */
export async function setupOperator(input: { readonly profilePath: string; readonly profile: OperatorProfile | JsonValue; readonly host: JsonValue | null;
  readonly writeOptions?: ConfigWriteOptions; readonly hostWriteOptions?: ConfigWriteOptions }): Promise<{ readonly steps: readonly ConfigWriteStep[]; readonly profile: ResolvedOperatorProfile; readonly failure: ConfigMutationResult['failure'] }> {
  const path = resolve(input.profilePath), profile = resolveOperatorProfile(decodeOperatorProfile(input.profile), path), steps: ConfigWriteStep[] = []
  if (profile.connection.kind === 'local' ? input.host === null : input.host !== null) throw new HostError('HOST_CONFIG_INVALID', 'setup-mode-host-mismatch')
  if (profile.connection.kind === 'local') {
    const host = input.host!
    requirePublishableConfig(await checkConfigCandidate('host', host, dirname(profile.connection.hostConfig), profile))
  }
  const declared = Object.entries(profile.files).filter((entry): entry is [string, string] => entry[1] !== null)
  const paths = [path, ...(profile.connection.kind === 'local' ? [profile.connection.hostConfig] : []), ...declared.map(([, file]) => file)]
  if (paths.some((path, index) => paths.slice(0, index).some(previous => relative(previous, path) === ''))) throw new HostError('HOST_CONFIG_INVALID', 'setup-file-reference-collision')
  for (const [kind, file] of declared) {
    const check = await checkConfigCandidate(kind as ConfigKind, (await readConfigFile(file, configLimits(kind as ConfigKind))).value, dirname(file), profile,
      profile.connection.kind === 'local' ? { value: input.host!, baseDirectory: dirname(profile.connection.hostConfig) } : undefined)
    if (check.status === 'dependency-needs-plan') throw new HostError('HOST_NOT_READY', 'dependency-needs-plan')
  }
  let previousProfile: JsonValue | undefined
  if (await exists(path)) {
    previousProfile = (await readConfigFile(path, configLimits('operator'))).value
    await preservePersistentBindings('operator', previousProfile, input.profile as unknown as JsonValue, path)
  }
  let failure: ConfigMutationResult['failure'] = null
  try {
    if (profile.connection.kind === 'local') {
      const revision = await publishConfigFile(profile.connection.hostConfig, input.host!, input.hostWriteOptions ?? {}, configLimits('host'))
      steps.push({ kind: 'host', path: profile.connection.hostConfig, revision })
    }
    if (profile.files.api !== null) {
      const api = await readConfigFile(profile.files.api, configLimits('api')), check = await checkConfigCandidate('api', api.value, dirname(api.path), profile)
      if (check.status !== 'valid') throw new HostError('HOST_NOT_READY', 'dependency-needs-plan')
    }
    const { directory: _directory, profilePath: _path, callerNamespace: _caller, ...candidate } = profile
    const revision = await publishConfigFile(path, candidate as unknown as JsonValue, input.writeOptions ?? {}, configLimits('operator'), async () => {
      if (previousProfile !== undefined) await preservePersistentBindings('operator', previousProfile, candidate as unknown as JsonValue, path)
    })
    steps.push({ kind: 'operator', path, revision })
  } catch (cause) { failure = configFailure(cause); if (steps.length === 0) throw cause }
  return { steps, profile, failure }
}
/** Import a complete file through its original parser, keeping all resolved path targets. */
export async function importOperatorConfig(profilePath: string, kind: ConfigKind, value: JsonValue, sourceDirectory: string,
  options: { readonly expectedRevision: string }): Promise<ConfigMutationResult> {
  const profile = (await readOperatorProfile(profilePath)).profile, document = await readEditableConfigDocument(profilePath, kind)
  const check = await checkConfigCandidate(kind, value, sourceDirectory, profile)
  return saveCandidate(document, check.normalized, profile, options.expectedRevision)
}
/** Export executable JSON; comparison material is explicitly separate and never used for imports. */
export async function exportOperatorConfig(profilePath: string, kind: ConfigKind, options: ConfigWriteOptions & { readonly output?: string; readonly redacted?: boolean } = {}): Promise<{ readonly executable: boolean; readonly value: JsonValue; readonly revision: string | null }> {
  const document = await readConfigDocument(profilePath, kind)
  if (options.output !== undefined) assertConfigDestination((await readOperatorProfile(profilePath)).profile, kind, resolve(options.output))
  let value = document.check.normalized
  if (options.redacted) {
    if (kind === 'host' && document.check.status === 'valid') value = snapshotJson(exportHostConfig(resolveHostConfig(decodeHostConfig(value, dirname(document.path)))) as unknown as JsonValue)
    else value = { redacted: true, executable: false, config: value }
  }
  const revision = options.output === undefined ? null : await publishConfigFile(options.output, value, options, configLimits(kind))
  return { executable: !options.redacted, value, revision }
}
