import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import type { ResolvedHostSpec } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import type { ApiPrincipal } from '../../src/api/config.js'
import { createHarnessClient } from '../../src/client/client.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'
import { apiConfig, certificateDirectory, clientOptions } from './fixtures.js'

function questionSpec(directory: string): ResolvedHostSpec {
  const base = resolveHostConfig(decodeHostConfig(runnableWorkflowConfig(join(directory, 'store')), directory))
  if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('Workflow fixture requires v3')
  const grant = { models: 2, steps: 2, tools: 0, messages: 0, waits: 1, outputTokens: 512 }
  const members = base.members.map(member => {
    if (member.kind !== 'local' || member.spec.protocolVersion !== 3) throw new Error('Workflow fixture requires local participants')
    return { ...member, model: { ...member.model, runnerLimits: { ...member.model.runnerLimits, maxToolCalls: 1 } },
      spec: { ...member.spec, nativeActions: [...member.spec.nativeActions, 'agent_ask_user' as const],
        workflow: { ...member.spec.workflow, nativeActions: ['agent_ask_user' as const] } } }
  })
  const entry = base.workflows.definitions[0]!
  const definition = decodeWorkflowDefinition({ ...entry.definition,
    budget: { ...grant, models: 4, steps: 4, waits: 2, outputTokens: 1024 },
    roster: entry.definition.roster.map((member, index) => ({ ...member,
      ...workflowMemberFingerprints(members[index]!), budgetCeiling: grant })),
    nodes: entry.definition.nodes.map(node => ({ ...node,
      attempts: node.attempts.map(attempt => ({ ...attempt, workerGrant: grant, nativeActions: ['agent_ask_user'] })) })) })
  return { ...base, members, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
}

async function seedQuestion(spec: ResolvedHostSpec, workflow: boolean) {
  const host = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    script: async function* (): AsyncGenerator<ModelFrame> {
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'permission-question' }
      yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'permission-question' }
      yield { kind: 'arguments-delta', index: 0, text: '{"question":"Confirm?","timeoutMs":60000}' }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
    } }) } })
  try {
    if (workflow) await host.workflow('research').resume({ requestKey: 'seed-work-question' })
    else await host.submitTask('writer', 'An ordinary confirmation')
    await host.run()
    const report = host.read().agent('writer').report
    const selected = report.roots.find(root => root.outcome === null && root.source?.kind === (workflow ? 'workflow' : 'ordinary'))
    if (selected === undefined) throw new Error('Question fixture has no pending Root')
    const root = host.read().root('writer', selected.id), wait = root.waits[0]!
    expect(wait.descriptor.kind).toBe('user')
    return { rootId: root.rootId, wait: wait.reference }
  } finally { await host.shutdown({ mode: 'drain' }) }
}

async function serve(spec: ResolvedHostSpec, directory: string, workflows: readonly string[], viewer = false) {
  const raw = await apiConfig()
  const researcher: ApiPrincipal = { ...raw.principals[0]!, workflowKeys: workflows,
    methods: ['agent.get', 'input.get', 'input.answer', 'root.get', 'root.cancel', 'host.run', 'workflow.resume', 'session.events'] }
  const principals: ApiPrincipal[] = [researcher]
  if (viewer) {
    const fingerprint = new X509Certificate(await readFile(`${certificateDirectory}client-b.pem`)).fingerprint256.replaceAll(':', '').toLowerCase()
    principals.push({ principalKey: 'workflow_viewer', certificateFingerprints: [fingerprint],
      methods: ['workflow.get', 'session.events'], agentKeys: [], workflowKeys: ['research'] })
  }
  const api = resolveApiConfig(decodeApiConfig({ ...raw, principals }), spec, directory)
  const service = await openHarnessApiServer({ host: spec, api, credentials: {} })
  const client = createHarnessClient(await clientOptions(service.ready.listen.port))
  const peer = viewer ? createHarnessClient(await clientOptions(service.ready.listen.port, 'client-b')) : undefined
  return { service, client, peer, async close() { await client.close(); await peer?.close(); await service.dispose() } }
}

it('requires the actual working Wait Workflow grant and keeps coordinator and participant event grants separate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-work-permission-'))
  let api: Awaited<ReturnType<typeof serve>> | undefined
  try {
    const spec = questionSpec(directory)
    await initializeHost(spec)
    const question = await seedQuestion(spec, true)
    api = await serve(spec, directory, [], true)
    await expect(api.client.request('input.answer', { agentKey: 'writer', submissionKey: 'denied-work-answer', wait: question.wait, text: 'Confirmed' }))
      .rejects.toMatchObject({ code: 'API_FORBIDDEN', acceptance: 'not-accepted' })
    await expect(api.client.request('root.cancel', { agentKey: 'writer', rootId: question.rootId, reason: 'cancel' }))
      .rejects.toMatchObject({ code: 'API_FORBIDDEN', acceptance: 'not-accepted' })
    await expect(api.client.request('input.get', { agentKey: 'writer', submissionKey: 'denied-work-answer' }))
      .rejects.toMatchObject({ code: 'API_TARGET_NOT_FOUND' })
    expect((await api.peer!.request('workflow.get', { workflowKey: 'research' })).workflowKey).toBe('research')
    expect((await api.peer!.request('session.events', { target: { kind: 'workflow', workflowKey: 'research' }, maxEvents: 2 })).events).toHaveLength(2)
    await expect(api.peer!.request('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 2 }))
      .rejects.toMatchObject({ code: 'API_FORBIDDEN' })
    const raw = await apiConfig()
    expect(() => resolveApiConfig(decodeApiConfig({ ...raw, principals: [{ ...raw.principals[0]!, methods: ['agent.pause'], workflowKeys: [] }] }), spec, directory))
      .toThrowError(/member-workflow-grant/)
  } finally { await api?.close(); await rm(directory, { recursive: true, force: true }) }
}, 30000)

it('reauthorizes a prior working answer after its Wait settled even when a replay substitutes an ordinary Wait', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-answer-reauthorize-'))
  let api: Awaited<ReturnType<typeof serve>> | undefined
  try {
    const spec = questionSpec(directory)
    await initializeHost(spec)
    const work = await seedQuestion(spec, true)
    api = await serve(spec, directory, ['research'])
    const request = { agentKey: 'writer', submissionKey: 'work-answer', wait: work.wait, text: 'Confirmed' }
    const receipt = await api.client.request('input.answer', request)
    await api.client.request('workflow.resume', { workflowKey: 'research', requestKey: 'resume-after-question', reason: '' })
    await api.client.request('host.run', { expectedInstanceId: api.service.ready.instanceId })
    expect((await api.client.request('root.get', { agentKey: 'writer', rootId: work.rootId })).outcome).toBe('completed')
    expect(await api.client.request('input.answer', request)).toEqual({ ...receipt, reused: true })
    await api.close(); api = undefined
    const ordinary = await seedQuestion(spec, false)
    api = await serve(spec, directory, [])
    await expect(api.client.request('input.answer', request)).rejects.toMatchObject({ code: 'API_FORBIDDEN', acceptance: 'not-accepted' })
    await expect(api.client.request('input.answer', { ...request, wait: ordinary.wait }))
      .rejects.toMatchObject({ code: 'API_FORBIDDEN', acceptance: 'not-accepted' })
    expect((await api.client.request('input.get', { agentKey: 'writer', submissionKey: request.submissionKey })).inputEventId).toBe(receipt.inputEventId)
    expect((await api.client.request('input.answer', { ...request, submissionKey: 'ordinary-answer', wait: ordinary.wait })).reused).toBe(false)
  } finally { await api?.close(); await rm(directory, { recursive: true, force: true }) }
}, 30000)
