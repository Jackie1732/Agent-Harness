/** Configuration interaction owns drafts and confirmations; original adapters own validation and files. */
import { dirname, join, resolve } from 'node:path'
import { useEffect, useState } from 'react'
import { Box, Text, useInput, useWindowSize } from 'ink'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { ConfigEditableDocument, ConfigKind, ConfigOperation } from '../operator/config-types.js'
import { CONFIG_KINDS, applyConfigOperations, cloneOperatorHost, configReadiness, createOperatorConfig,
  diffConfigCandidate, exportOperatorConfig, importOperatorConfig, linkOperatorConfig, planOperatorHost, readConfigDocument, readEditableConfigDocument, rebindOperatorWorkflows } from '../operator/config-operations.js'
import { configLimits } from '../operator/config-check.js'
import { readConfigFile } from '../operator/config-files.js'
import { configFailure } from '../operator/config-readiness.js'
import { buildConfigPreset, buildHostPreset, configPresetParameters } from '../operator/config-presets.js'
import type { HostPresetParams } from '../operator/config-presets.js'
import type { ResolvedOperatorProfile } from '../operator/profile.js'
import { TreeEditor } from './tree.js'
import { DraftInput } from './input.js'
import { Picker } from './picker.js'
import { displayValue, plainText } from './text.js'
import { CommandCardsPanel } from './panels.js'
import { serviceCommandCards, powershellCommand } from './command-cards.js'

type ConfigModal = { readonly kind: 'field'; readonly label: string; readonly initial?: string; readonly confirm: (text: string) => void }
  | { readonly kind: 'tree'; readonly title: string; readonly value: JsonValue; readonly confirm: (value: JsonValue, ops: readonly ConfigOperation[]) => void }
  | { readonly kind: 'confirm'; readonly title: string; readonly detail: unknown; readonly run: () => Promise<unknown> }
  | { readonly kind: 'preset'; readonly items: readonly string[]; readonly choose: (preset: string) => void }

function commandFields(value: JsonValue): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('command-fields-required')
  const strings = ['triggerKey', 'expectedToken', 'plan', 'root', 'unitKey', 'evaluatorKey', 'comparisonKey', 'otherRoot', 'variantA', 'variantB', 'sessionId', 'fixtureOutput', 'reportKey', 'evidenceKey', 'evidenceFile', 'sourceFile']
  for (const [key, field] of Object.entries(value)) {
    if (key === 'finalize' ? typeof field !== 'boolean' : key === 'mode' ? field !== 'fixture' && field !== 'live' : !strings.includes(key) || typeof field !== 'string') throw new Error('command-field-invalid')
  }
  return value as JsonObject
}

export interface ConfigurationPageProps {
  readonly profile: ResolvedOperatorProfile
  readonly secrets: readonly string[]
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly onEditing: (editing: boolean) => void
  readonly onResult: (result: unknown) => void
  readonly onWork: (task: Promise<unknown>) => void
  readonly initialKind?: ConfigKind
  readonly onDone?: () => void
}

/**
 * Manage every declared configuration with common fields and an unrestricted typed tree.
 * @param props Captured profile and display callbacks; saving never reloads a running Host.
 * @returns Configuration selection, original-format operations and service command cards.
 */
export function ConfigurationPage(props: ConfigurationPageProps) {
  const [selected, setSelected] = useState(CONFIG_KINDS.indexOf(props.initialKind ?? 'host'))
  const [document, setDocument] = useState<ConfigEditableDocument | null>(null), [modal, setModal] = useState<ConfigModal | null>(null)
  const [working, setWorking] = useState(false), [notice, setNotice] = useState<unknown>(null)
  const [treeError, setTreeError] = useState<unknown>(null)
  const [noticeOffset, setNoticeOffset] = useState(0), { rows } = useWindowSize()
  const [cardForms, setCardForms] = useState<Readonly<Record<'automation' | 'experiment', JsonObject>>>({ automation: {}, experiment: {} })
  const kind = CONFIG_KINDS[selected]!, profilePath = props.profile.profilePath
  const cardFields = kind === 'automation' || kind === 'experiment' ? cardForms[kind] : {}
  useEffect(() => { props.onEditing(modal !== null || working); return () => props.onEditing(false) }, [modal, working, props.onEditing])
  useEffect(() => { setTreeError(null) }, [modal])
  const perform = async (operation: () => Promise<unknown>) => {
    setModal(null); setWorking(true); setNoticeOffset(0)
    try { const task = operation(); props.onWork(task); const result = await task; setNotice(result); props.onResult(result) }
    catch (cause) { const failure = configFailure(cause); setNotice(failure); props.onResult(failure) }
    finally { setWorking(false) }
  }
  const confirm = (title: string, detail: unknown, run: () => Promise<unknown>) => setModal({ kind: 'confirm', title, detail, run })
  const load = async (): Promise<ConfigEditableDocument> => {
    const read = await readEditableConfigDocument(profilePath, kind); setDocument(read); return read
  }
  const editDocument = async () => {
    const read = await load()
    setModal({ kind: 'tree', title: `${kind} · ${read.check?.status ?? read.failure?.code ?? 'invalid'} · revision ${read.revision}`, value: read.value,
      confirm: (candidate, operations) => {
        void (async () => {
          try {
            const diff = await diffConfigCandidate(profilePath, kind, candidate)
            confirm('保存此候选；当前实例仍使用已捕获配置', diff, async () => {
              const result = await applyConfigOperations(profilePath, kind, operations.length === 0 ? [{ op: 'set', pointer: '', value: candidate }] : operations, { expectedRevision: read.revision })
              setDocument({ ...result.document, failure: null }); return result
            })
          } catch (cause) { const failure = configFailure(cause); setNotice(failure); setTreeError(failure) }
        })()
      } })
  }
  const create = () => {
    if (kind === 'operator') { setNotice({ message: 'Operator profile 由 setup 建立；当前文件可直接编辑' }); return }
    setModal({ kind: 'field', label: '完整配置的目标路径（默认拒绝已有文件）', initial: join(props.profile.directory, `${kind}.json`), confirm: output => {
      const items = kind === 'host' ? ['solo-scripted', 'solo-http', 'collaboration'] : kind === 'api' ? ['mtls'] : kind === 'ui' ? ['gateway'] : kind === 'automation' ? ['webhook', 'utc'] : ['fixture']
      setModal({ kind: 'preset', items, choose: preset => {
        const value: JsonValue = kind === 'host' ? { hostKey: 'local-host', storageRoot: './host-store', agentKey: 'writer',
          ...(preset === 'solo-http' ? { http: { kind: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', credentialRef: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' } } : { text: 'Offline scripted response.' }) }
          : configPresetParameters(kind, preset, dirname(output))
        setModal({ kind: 'tree', title: `${kind} ${preset} · 完整部署参数`, value, confirm: params => {
          try {
            const candidate = kind === 'host' ? buildHostPreset(preset as 'solo-scripted' | 'solo-http' | 'collaboration', { ...params as unknown as HostPresetParams, storageRoot: resolve(dirname(output), String((params as JsonObject).storageRoot)) }, dirname(output))
              : buildConfigPreset(kind, preset, params as JsonObject, dirname(output))
            setModal({ kind: 'tree', title: '完整原格式配置；可继续编辑全部字段', value: candidate, confirm: edited => confirm('创建配置并登记引用（两步）', { kind, output },
              () => createOperatorConfig(profilePath, kind, edited, output)) })
          } catch (cause) { const failure = configFailure(cause); setNotice(failure); setTreeError(failure) }
        } })
      } })
    } })
  }
  useInput((input, key) => {
    if (key.pageDown) setNoticeOffset(current => current + Math.max(1, rows - 18))
    else if (key.pageUp) setNoticeOffset(current => Math.max(0, current - Math.max(1, rows - 18)))
    else if (key.upArrow) { setSelected(current => Math.max(0, current - 1)); setDocument(null) }
    else if (key.downArrow) { setSelected(current => Math.min(CONFIG_KINDS.length - 1, current + 1)); setDocument(null) }
    else if (key.return) void editDocument().catch(cause => setNotice(configFailure(cause)))
    else if (key.escape) props.onDone?.()
    else if (input === 'k') void perform(async () => { const read = await readConfigDocument(profilePath, kind); setDocument({ ...read, failure: null }); return read.check })
    else if (input === 'y') void perform(() => configReadiness(profilePath, kind, props.environment))
    else if (input === 'p' && kind === 'host') void load().then(read => confirm('分配并保存尚缺 Host 身份', read.check,
      () => planOperatorHost(profilePath, { expectedRevision: read.revision }))).catch(cause => setNotice(configFailure(cause)))
    else if (input === 'w' && kind === 'host') void load().then(read => setModal({ kind: 'tree', title: '编辑成员与 Workflow；同一候选重绑定', value: read.value,
      confirm: (_candidate, operations) => confirm('完整检查并重算 Workflow 绑定', { revision: read.revision, operations }, () => rebindOperatorWorkflows(profilePath, operations.length === 0 ? undefined : operations, { expectedRevision: read.revision })) })).catch(cause => setNotice(configFailure(cause)))
    else if (input === 'c') create()
    else if (input === 'l' && kind !== 'operator') setModal({ kind: 'field', label: '已有配置文件路径', confirm: file => confirm('验证后登记文件', { kind, file }, () => linkOperatorConfig(profilePath, kind, file)) })
    else if (input === 'm') setModal({ kind: 'field', label: '导入完整原格式文件路径', confirm: source => {
      void load().then(async read => { const file = await readConfigFile(source, configLimits(kind)); confirm('导入并保留解析目标', { kind, source, revision: read.revision },
        () => importOperatorConfig(profilePath, kind, file.value, dirname(file.path), { expectedRevision: read.revision })) }).catch(cause => setNotice(configFailure(cause)))
    } })
    else if (input === 'o') setModal({ kind: 'field', label: '导出可执行配置的文件路径（拒绝已有文件）', confirm: output => confirm('导出可再次导入的配置', { kind, output }, () => exportOperatorConfig(profilePath, kind, { output })) })
    else if (input === 'h' && kind === 'host') setModal({ kind: 'tree', title: '建立独立 Host（保留原配置与Session）', value: { newStorage: './new-host-store', output: join(props.profile.directory, 'new-host.json'), hostKey: 'new-host' },
      confirm: value => { const fields = value as JsonObject; confirm('Clone 为新身份/存储；不自动切换 profile', fields, () => cloneOperatorHost(profilePath,
        { newStorage: String(fields.newStorage), output: String(fields.output), hostKey: String(fields.hostKey) })) } })
    else if (input === 'v' && (kind === 'automation' || kind === 'experiment')) setModal({ kind: 'tree', title: '另一终端命令的完整参数；不执行命令',
      value: kind === 'automation' ? { triggerKey: '', expectedToken: '', ...cardFields } : { plan: join(props.profile.directory, 'experiment-plan.json'), root: '', mode: 'fixture',
        unitKey: '', evaluatorKey: '', comparisonKey: '', otherRoot: '', variantA: '', variantB: '', sessionId: '', fixtureOutput: '',
        reportKey: 'report', finalize: false, expectedToken: '', evidenceKey: '', evidenceFile: '', sourceFile: '', ...cardFields },
      confirm: value => {
        try { const fields = commandFields(value); setCardForms(current => ({ ...current, [kind]: fields })); setNoticeOffset(0); setModal(null) }
        catch { const failure = { message: '命令字段需为字符串；mode为fixture/live，finalize为boolean。候选保留供修正。Esc 继续编辑' }; setNotice(failure); setTreeError(failure) }
      } })
  }, { isActive: modal === null && !working })
  if (modal?.kind === 'field') return <DraftInput label={modal.label} secrets={props.secrets} {...(modal.initial === undefined ? {} : { initial: modal.initial })} onConfirm={modal.confirm} onCancel={() => setModal(null)} />
  if (modal?.kind === 'tree') return <Box flexDirection="column">{treeError !== null && <Text color="red">{displayValue(treeError, props.profile.display.maxTextBytes, props.secrets)}</Text>}
    <TreeEditor key={modal.title} title={modal.title} initial={modal.value} maxTextBytes={props.profile.display.maxTextBytes} secrets={props.secrets} onSubmit={modal.confirm} onCancel={() => setModal(null)} /></Box>
  if (modal?.kind === 'preset') return <Picker title="选择建立模板；全部字段随后可编辑" items={modal.items.map(value => ({ label: value, value }))} onSelect={modal.choose} onCancel={() => setModal(null)} />
  if (modal?.kind === 'confirm') return <Box flexDirection="column"><Text>{displayValue(modal.detail, props.profile.display.maxTextBytes, props.secrets)}</Text>
    <Picker title={modal.title} items={[{ label: '采用', value: true }, { label: '返回', value: false }]} onSelect={accepted => { if (accepted) void perform(modal.run); else setModal(null) }} onCancel={() => setModal(null)} /></Box>
  const raw = document?.value as JsonObject | undefined, storage = raw?.storage as JsonObject | undefined
  const cards = serviceCommandCards({ automation: kind === 'automation' ? props.profile.files.automation : null,
    definition: kind === 'experiment' ? props.profile.files.experiment : null,
    plan: kind === 'experiment' ? join(props.profile.directory, 'experiment-plan.json') : null,
    root: kind === 'experiment' && typeof storage?.controlRoot === 'string' ? resolve(dirname(document!.path), storage.controlRoot) : null, reportKey: 'report',
    ...Object.fromEntries(Object.entries(cardFields).filter(([, value]) => typeof value !== 'string' || value.length > 0)) })
  return <Box flexDirection="column"><Text bold>配置 · 文件保存与运行事实分别显示{working ? ' · 正在操作' : ''}</Text>
    {CONFIG_KINDS.map((item, index) => <Text key={item} inverse={index === selected}>{item}</Text>)}
    {document !== null && <><Text>{plainText(document.path, props.secrets)} · {document.check?.status ?? document.failure?.code ?? 'invalid'}</Text><Text dimColor>revision {document.revision}</Text></>}
    <Text dimColor>Enter 字段/结构编辑 · c 创建 · l 登记 · k 检查 · y readiness · p plan · w Workflow重绑定 · m 导入 · o 导出 · h clone</Text>
    <Text dimColor>{powershellCommand(['atomic-harness', 'init', '--profile', profilePath])}</Text>
    <Text dimColor>init/恢复由明确维护命令拥有；运行中的本地Host需先退出释放锁</Text>
    {(kind === 'automation' || kind === 'experiment') && <><Text dimColor>v 编辑未知run/残锁/实验动作参数 · PgUp/PgDn 阅读卡片</Text>
      <CommandCardsPanel cards={cards} maxTextBytes={props.profile.display.maxTextBytes} offset={noticeOffset} rows={Math.max(1, rows - 18)} secrets={props.secrets} /></>}
    {notice !== null && <><Text dimColor>操作结果 · PgUp/PgDn 阅读 · 起始行 {noticeOffset + 1}</Text>
      <Text>{displayValue(notice, props.profile.display.maxTextBytes, props.secrets).split('\n').slice(noticeOffset, noticeOffset + Math.max(1, rows - 18)).join('\n')}</Text></>}
  </Box>
}
