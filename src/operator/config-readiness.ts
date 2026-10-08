import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createSecureContext } from 'node:tls'
import type { ResolvedHostSpec } from '../host/config.js'
import { decodeHostConfig, resolveHostConfig } from '../host/config.js'
import { validateHostMemberSnapshot } from '../host/binding.js'
import { hostRuntimeEventCatalog } from '../host/initialization.js'
import { scanHostInventory } from '../host/inventory.js'
import { discoverHostDelegations } from '../host/delegation-discovery.js'
import { discoverHostWorkflows } from '../host/workflow-discovery.js'
import { FileSessionBackend } from '../session/file-backend.js'
import { SessionRepository } from '../session/repository.js'
import { parseSessionId } from '../session/ids.js'
import { SessionError } from '../session/errors.js'
import { HostError } from '../host/errors.js'
import { EffectOwner } from '../effect/owner.js'
import { decodeOperatorProfile, resolveOperatorProfile } from './profile.js'
import { decodeApiConfig } from '../api/config.js'
import { decodeUiConfig, resolveUiConfig } from '../ui/config.js'
import { decodeAutomationConfig, resolveAutomationConfig } from '../automation/config.js'
import { decodeExperimentDefinition } from '../experiment/definition.js'
import type { ConfigKind, ConfigReadiness } from './config-types.js'
import { readConfigDocument } from './config-check.js'
import { readConfigBytes } from './config-files.js'

export function configFailure(cause: unknown): { readonly code: string; readonly message: string } {
  if (cause instanceof HostError || cause instanceof SessionError) return { code: cause.code, message: cause.message }
  if (cause !== null && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') return { code: cause.code, message: 'configuration-material-unavailable' }
  return { code: 'HOST_CONFIG_INVALID', message: 'configuration-material-invalid' }
}
/** Read original binding rules from snapshots without a Writer, storage lock, or Provider. */
export async function checkOfflineHostBindings(spec: ResolvedHostSpec): Promise<{ readonly status: 'compatible' | 'incompatible' | 'not-initialized'; readonly reason: string | null }> {
  try { if (!(await stat(join(spec.storage.root, 'sessions'))).isDirectory()) return { status: 'not-initialized', reason: 'host-sessions-missing' } }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'not-initialized', reason: 'host-sessions-missing' }; throw cause }
  const owner = new EffectOwner('operator-readiness')
  try {
    await owner.run('snapshot-bindings', async effect => {
      const repository = await effect.apply('reader-repository', () => new SessionRepository({ backend: new FileSessionBackend({ root: spec.storage.root,
        maxRecordBytes: spec.storage.maxRecordBytes }), catalog: hostRuntimeEventCatalog, maxLineageDepth: spec.storage.maxLineageDepth }), value => value.dispose())
      const inventory = await scanHostInventory(spec, repository)
      await discoverHostDelegations(spec, repository, inventory)
      if (spec.schemaVersion === 3) discoverHostWorkflows(spec, inventory)
      for (const member of spec.members) if (member.kind === 'local') validateHostMemberSnapshot(await repository.read(parseSessionId(member.sessionId)), spec.hostKey, member,
        { bindingVersion: spec.schemaVersion === 3 ? 2 : 1 })
    })
    return { status: 'compatible', reason: null }
  } catch (cause) {
    return { status: 'incompatible', reason: configFailure(cause).message }
  } finally { await owner.dispose() }
}
/** Check explicit material availability and immutable bindings; this does not prove network authorization. */
export async function configReadiness(profilePath: string, kind: ConfigKind, credentials: Readonly<Record<string, string | undefined>> = process.env): Promise<ConfigReadiness> {
  const document = await readConfigDocument(profilePath, kind)
  if (document.check.status !== 'valid') return { kind, status: document.check.status, evidence: [] }
  const evidence: ConfigReadiness['evidence'][number][] = []
  const file = async (subject: string, path: string): Promise<Buffer | null> => {
    try {
      const result = await readConfigBytes(path, 16 * 1024 * 1024)
      evidence.push({ subject, status: 'available', reason: null })
      return result
    } catch (cause) { evidence.push({ subject, status: 'missing', reason: configFailure(cause).message }); return null }
  }
  const credential = (subject: string, name: string) => evidence.push({ subject, status: credentials[name] ? 'available' : 'missing', reason: credentials[name] ? null : 'credential-missing' })
  const tls = async (paths: { readonly ca?: string; readonly cert: string; readonly key: string }, subject: string) => {
    const cert = await file(`${subject}.cert`, paths.cert), key = await file(`${subject}.key`, paths.key), ca = paths.ca === undefined ? undefined : await file(`${subject}.ca`, paths.ca)
    if (cert === null || key === null || ca === null) return
    try { createSecureContext({ cert, key, ...(ca === undefined ? {} : { ca }) }); evidence.push({ subject, status: 'compatible', reason: null }) }
    catch { evidence.push({ subject, status: 'incompatible', reason: 'tls-material-invalid' }) }
  }
  const value = document.check.normalized
  if (kind === 'host') {
    const host = resolveHostConfig(decodeHostConfig(value, dirname(document.path)))
    const models = [...host.members.flatMap(member => member.kind === 'local' ? [member.model] : []),
      ...(host.schemaVersion !== 1 && host.subagents.kind === 'enabled' ? host.subagents.templates.map(template => template.model) : [])]
    for (const model of models) if (model.kind !== 'scripted-fixed') credential(`model.${model.providerId}`, model.credentialRef)
    if (host.https.kind !== 'disabled') {
      await tls({ ca: host.https.caFile, cert: host.https.serverCertFile, key: host.https.serverKeyFile }, 'host.server-tls')
      await tls({ ca: host.https.caFile, cert: host.https.clientCertFile, key: host.https.clientKeyFile }, 'host.client-tls')
    }
    const binding = await checkOfflineHostBindings(host)
    evidence.push({ subject: 'host.bindings', status: binding.status === 'compatible' ? 'compatible' : 'incompatible', reason: binding.reason })
  } else if (kind === 'operator') {
    const profile = resolveOperatorProfile(decodeOperatorProfile(value), profilePath)
    if (profile.connection.kind === 'remote') await tls(profile.connection.tlsFiles, 'remote.tls')
    else {
      const host = await configReadiness(profilePath, 'host', credentials)
      evidence.push(...host.evidence)
      if (host.status !== 'ready') return { kind, status: host.status, evidence }
    }
  } else if (kind === 'api') {
    const api = decodeApiConfig(value)
    await tls({ ca: api.tls.caFile, cert: api.tls.serverCertFile, key: api.tls.serverKeyFile }, 'api.tls')
  } else if (kind === 'ui') {
    const ui = resolveUiConfig(decodeUiConfig(value), document.path)
    credential('ui.password', ui.passwordEnv)
    await tls({ ca: ui.remote.caFile, cert: ui.remote.certFile, key: ui.remote.keyFile }, 'ui.tls')
  } else if (kind === 'automation') {
    const automation = resolveAutomationConfig(decodeAutomationConfig(value), document.path)
    credential('automation.webhook-token', automation.webhook.bearerTokenEnv)
    await tls({ ca: automation.client.tls.caFile, cert: automation.client.tls.certFile, key: automation.client.tls.keyFile }, 'automation.client-tls')
    await tls({ cert: automation.webhook.tls.certFile, key: automation.webhook.tls.keyFile }, 'automation.webhook-tls')
  } else {
    const definition = decodeExperimentDefinition(value, document.path)
    for (const item of definition.dataset.cases) for (const material of item.materials) if (material.source.kind === 'file') await file(`experiment.${item.caseKey}.${material.logicalPath}`, material.source.path)
  }
  return { kind, status: evidence.some(item => item.status === 'missing' || item.status === 'incompatible') ? 'not-ready'
    : kind === 'host' || kind === 'operator' && (value as { connection?: { kind?: string } }).connection?.kind === 'local' ? 'admission-check-required' : 'ready', evidence }
}
