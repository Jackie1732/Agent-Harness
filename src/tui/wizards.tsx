/** Finite configuration journeys publish complete candidates through the original file owners. */
import { dirname, join, resolve } from 'node:path'
import { useRef, useState } from 'react'
import { Box, Text } from 'ink'
import type { HostCliIo } from '../host/cli.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { ClientLimits } from '../client/config.js'
import type { ConfigEditableDocument, ConfigKind, ConfigOperation, ConfigWriteOptions } from '../operator/config-types.js'
import { applyConfigOperations, createOperatorConfig, diffConfigCandidate, readEditableConfigDocument, rebindOperatorWorkflows, setupOperator } from '../operator/config-operations.js'
import { buildOperatorProfile, readOperatorProfile } from '../operator/profile.js'
import { configFailure } from '../operator/config-readiness.js'
import { operatorFailure } from '../operator/errors.js'
import { buildConfigPreset, buildHostPreset, configPresetParameters } from '../operator/config-presets.js'
import type { HostPresetParams } from '../operator/config-presets.js'
import { TreeEditor } from './tree.js'
import { Picker } from './picker.js'
import { runTerminalDialog } from './lifecycle.js'
import { displayValue, plainText } from './text.js'
import { powershellCommand } from './command-cards.js'
import { ResultPanel } from './panels.js'

type Track = (task: Promise<unknown>) => void
const presets = (kind: Exclude<ConfigKind, 'operator'>) => kind === 'host' ? ['solo-scripted', 'solo-http', 'collaboration']
  : kind === 'api' ? ['mtls'] : kind === 'ui' ? ['gateway'] : kind === 'automation' ? ['webhook', 'utc'] : ['fixture']

function hostParameters(directory: string, preset: string): JsonObject {
  return { hostKey: 'local-host', storageRoot: join(directory, 'host-store'), agentKey: 'writer',
    ...(preset === 'solo-http' ? { http: { kind: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', credentialRef: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' } }
      : { text: 'Offline scripted response.' }) }
}
function hostPreset(preset: string, value: JsonValue, directory: string): JsonValue {
  const params = value as unknown as HostPresetParams
  return buildHostPreset(preset as 'solo-scripted' | 'solo-http' | 'collaboration', { ...params, storageRoot: resolve(directory, params.storageRoot) }, directory)
}
function remoteTemplate(directory: string): JsonValue {
  const params = configPresetParameters('ui', 'gateway', directory), ui = buildConfigPreset('ui', 'gateway', params, directory) as JsonObject
  const remote = ui.remote as JsonObject, tls = params.tls as JsonObject
  return buildOperatorProfile({ kind: 'remote', origin: String(params.origin), serverName: String(params.serverName),
    tlsFiles: { ca: String(tls.caFile), cert: String(tls.certFile), key: String(tls.keyFile) }, limits: remote.limits as unknown as ClientLimits,
    targets: { agentKeys: ['writer'], workflowKeys: [] } }) as unknown as JsonValue
}

function SetupDialog(props: { readonly path: string; readonly mode: 'local' | 'remote'; readonly finish: (code?: number) => void; readonly track: Track }) {
  const directory = dirname(resolve(props.path))
  const [preset, setPreset] = useState<string | null>(null), [candidate, setCandidate] = useState<JsonValue | null>(() => props.mode === 'remote' ? { profile: remoteTemplate(directory), host: null } : null)
  const [result, setResult] = useState<Awaited<ReturnType<typeof setupOperator>> | null>(null), [error, setError] = useState<unknown>(null), [working, setWorking] = useState(false)
  const savedSteps = useRef<Awaited<ReturnType<typeof setupOperator>>['steps']>([])
  const publish = (value: JsonValue) => {
    const record = value as JsonObject; setCandidate(value); setWorking(true)
    const previousHost = savedSteps.current.find(step => step.kind === 'host'), previousProfile = savedSteps.current.find(step => step.kind === 'operator')
    const task = setupOperator({ profilePath: props.path, profile: record.profile!, host: record.host!,
      ...(previousHost === undefined ? {} : { hostWriteOptions: { replace: true, expectedRevision: previousHost.revision } }),
      ...(previousProfile === undefined ? {} : { writeOptions: { replace: true, expectedRevision: previousProfile.revision } }) })
    props.track(task)
    void task.then(value => { savedSteps.current = [...savedSteps.current.filter(step => !value.steps.some(next => next.kind === step.kind)), ...value.steps]; setResult(value) })
      .catch(cause => setError(configFailure(cause))).finally(() => setWorking(false))
  }
  if (working) return <Text>正在发布已确认候选；每个文件的实际结果将分别显示</Text>
  if (result !== null) return <Box flexDirection="column" flexGrow={1} flexBasis={0}>
    <ResultPanel label="实际发布结果" text={[...savedSteps.current.flatMap(step => [`已发布 ${step.kind}`, plainText(step.path), `revision ${step.revision}`]),
      result.failure === null ? '失败：无' : displayValue(result.failure, 4096), '后续明确步骤：',
      ...(props.mode === 'local' ? [['config', 'check', '--kind', 'host'], ['config', 'plan', '--kind', 'host', '--yes'], ['init'], ['tui']] : [['connection', 'probe'], ['tui']]).map(argv =>
        powershellCommand(['atomic-harness', ...argv, '--profile', resolve(props.path)]))].join('\n')} maxTextBytes={65536} secrets={[]} />
    <Picker title={result.failure === null ? '配置已保存；尚未初始化或启动' : '部分文件已保存；保留同一候选和身份'} compact
      items={[{ label: '结束', value: 'done' }, ...(result.failure === null ? [] : [{ label: '继续同一候选（保留已发布revision）', value: 'retry' }])]}
      onSelect={value => { if (value === 'retry') { setResult(null); setError(null) } else props.finish(result.failure === null ? 0 : 1) }} onCancel={() => props.finish(result.failure === null ? 0 : 1)} /></Box>
  if (candidate !== null) return <Box flexDirection="column" flexGrow={1} flexBasis={0}>{error !== null && <Text color="red">{displayValue(error, 4096)}</Text>}
    <TreeEditor key="complete-setup" title={`${props.mode} setup · profile 与完整 Host 候选`} initial={candidate} maxTextBytes={65536} submitLabel="保存这些文件" onSubmit={publish} onCancel={() => props.finish()} /></Box>
  if (preset === null) return <Picker title="本地建立模板" items={presets('host').map(value => ({ label: value, value }))} onSelect={setPreset} onCancel={() => props.finish()} />
  return <Box flexDirection="column" flexGrow={1} flexBasis={0}>{error !== null && <Text color="red">{displayValue(error, 4096)}</Text>}
    <TreeEditor key="setup-parameters" title="常用部署字段；下一步完整配置仍可编辑" initial={hostParameters(directory, preset)} maxTextBytes={65536} onCancel={() => setPreset(null)} onSubmit={value => {
      try { setCandidate({ profile: buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'cancel' }) as unknown as JsonValue,
        host: hostPreset(preset, value, directory) }); setError(null) } catch (cause) { setError(configFailure(cause)) }
    }} /></Box>
}

function CreateDialog(props: { readonly profilePath: string; readonly kind: Exclude<ConfigKind, 'operator'>; readonly output: string; readonly finish: (code?: number) => void; readonly track: Track;
  readonly writeOptions: ConfigWriteOptions }) {
  const [preset, setPreset] = useState<string | null>(null), [candidate, setCandidate] = useState<JsonValue | null>(null)
  const [result, setResult] = useState<unknown>(null), [working, setWorking] = useState(false)
  const [resultCode, setResultCode] = useState(0)
  const directory = dirname(resolve(props.output))
  if (working) return <Text>正在发布完整配置与登记引用…</Text>
  if (result !== null) return <Box flexDirection="column" flexGrow={1} flexBasis={0}><ResultPanel result={result} maxTextBytes={65536} secrets={[]} /><Picker title="实际发布结果" compact items={[{ label: '结束', value: true }, { label: '返回同一候选', value: false }]}
    onSelect={done => { if (done) props.finish(resultCode); else setResult(null) }} onCancel={() => props.finish(resultCode)} /></Box>
  if (candidate !== null) return <TreeEditor key="complete-create" title={`${props.kind} 完整原格式候选 · ${props.output}`} initial={candidate} maxTextBytes={65536} submitLabel="创建并登记" onCancel={() => setCandidate(null)} onSubmit={value => {
    setCandidate(value); setWorking(true)
    const task = createOperatorConfig(props.profilePath, props.kind, value, props.output, props.writeOptions); props.track(task)
    void task.then(value => { setResult(value); setResultCode(value.failure === null ? 0 : 1) })
      .catch(cause => { setResult(configFailure(cause)); setResultCode(operatorFailure(cause).exitCode) }).finally(() => setWorking(false))
  }} />
  if (preset === null) return <Picker title="选择建立模板" items={presets(props.kind).map(value => ({ label: value, value }))} onSelect={setPreset} onCancel={() => props.finish()} />
  return <TreeEditor key="create-parameters" title="完整部署参数；下一步可编辑全部原字段" initial={props.kind === 'host' ? hostParameters(directory, preset) : configPresetParameters(props.kind, preset, directory)} maxTextBytes={65536}
    onCancel={() => setPreset(null)} onSubmit={value => {
      try { setCandidate(props.kind === 'host' ? hostPreset(preset, value, directory) : buildConfigPreset(props.kind, preset, value as JsonObject, directory)) }
      catch (cause) { setResult(configFailure(cause)); setResultCode(operatorFailure(cause).exitCode) }
    }} />
}

function EditDialog(props: { readonly profilePath: string; readonly document: ConfigEditableDocument; readonly finish: (code?: number) => void; readonly track: Track; readonly rebind?: boolean }) {
  const [document, setDocument] = useState(props.document), [candidate, setCandidate] = useState(props.document.value)
  const [pending, setPending] = useState<{ readonly candidate: JsonValue; readonly operations: readonly ConfigOperation[]; readonly diff: unknown } | null>(null)
  const [result, setResult] = useState<unknown>(null), [working, setWorking] = useState(false)
  const [resultCode, setResultCode] = useState(0)
  if (working) return <Text>正在验证/发布当前候选…</Text>
  if (result !== null) return <Box flexDirection="column" flexGrow={1} flexBasis={0}><ResultPanel result={result} maxTextBytes={65536} secrets={[]} /><Picker title="配置操作结果" compact items={[{ label: '结束', value: true }, { label: '继续候选编辑', value: false }]}
    onSelect={done => { if (done) props.finish(resultCode); else { setResult(null); setPending(null) } }} onCancel={() => props.finish(resultCode)} /></Box>
  if (pending !== null) return <Box flexDirection="column" flexGrow={1} flexBasis={0}><ResultPanel label="候选差异" result={pending.diff} maxTextBytes={65536} secrets={[]} />
    <Picker title="采用差异；保存不更改当前运行实例" compact items={[{ label: '发布候选', value: true }, { label: '返回', value: false }]} onCancel={() => setPending(null)} onSelect={yes => {
      if (!yes) { setPending(null); return }
      setWorking(true)
      const operations = [{ op: 'set' as const, pointer: '', value: pending.candidate }]
      const task = props.rebind ? rebindOperatorWorkflows(props.profilePath, operations, { expectedRevision: document.revision })
        : applyConfigOperations(props.profilePath, document.kind, operations, { expectedRevision: document.revision })
      props.track(task); void task.then(value => { setResult(value); setDocument({ ...value.document, failure: null }); setCandidate(value.document.value); setResultCode(value.failure === null ? 0 : 1) })
        .catch(cause => { setResult(configFailure(cause)); setResultCode(operatorFailure(cause).exitCode) }).finally(() => setWorking(false))
    }} /></Box>
  return <TreeEditor title={`${document.kind} · ${document.check?.status ?? document.failure?.code ?? 'invalid'} · revision ${document.revision}`} initial={candidate} maxTextBytes={65536}
    onCancel={() => props.finish()} onSubmit={(candidate, operations) => {
      setCandidate(candidate)
      const task = props.rebind ? Promise.resolve({ effect: 'admission-check-required', binding: 'not-checked', revision: document.revision })
        : diffConfigCandidate(props.profilePath, document.kind, candidate)
      props.track(task); void task.then(diff => setPending({ candidate, operations, diff }))
        .catch(cause => { setResult(configFailure(cause)); setResultCode(operatorFailure(cause).exitCode) })
    }} />
}

/** @param profilePath Explicit output profile. @param mode Selected connection mode. @param io Borrowed TTY. @param environment Invocation environment. @returns Dialog exit status. */
export async function runSetupWizard(profilePath: string, mode: 'local' | 'remote', io: HostCliIo, _environment: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  return runTerminalDialog(io, (finish, track) => <SetupDialog path={profilePath} mode={mode} finish={finish} track={track} />)
}
/** @param profilePath Existing profile. @param kind Owner format. @param output Explicit target. @param io Borrowed TTY. @param environment Invocation environment. @param options Explicit replacement revision. @returns Dialog exit status. */
export async function runConfigCreate(profilePath: string, kind: Exclude<ConfigKind, 'operator'>, output: string, io: HostCliIo,
  _environment: Readonly<Record<string, string | undefined>> = process.env, options: ConfigWriteOptions = {}): Promise<number> {
  await readOperatorProfile(profilePath)
  return runTerminalDialog(io, (finish, track) => <CreateDialog profilePath={profilePath} kind={kind} output={output} finish={finish} track={track} writeOptions={options} />)
}
/** @param profilePath Existing profile. @param kind Owner format. @param io Borrowed TTY. @param environment Invocation environment. @returns Dialog exit status. */
export async function runConfigEditor(profilePath: string, kind: ConfigKind, io: HostCliIo, _environment: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const document = await readEditableConfigDocument(profilePath, kind)
  return runTerminalDialog(io, (finish, track) => <EditDialog profilePath={profilePath} document={document} finish={finish} track={track} />)
}
/** @param profilePath Existing profile. @param io Borrowed TTY. @returns Dialog exit status after one candidate roster/rebinding publication. */
export async function runWorkflowBindingsEditor(profilePath: string, io: HostCliIo): Promise<number> {
  const document = await readEditableConfigDocument(profilePath, 'host')
  return runTerminalDialog(io, (finish, track) => <EditDialog profilePath={profilePath} document={document} finish={finish} track={track} rebind />)
}
