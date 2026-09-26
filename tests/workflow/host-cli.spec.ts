import { expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runnableWorkflowConfig, runnableWorkflowHost } from './host-fixture.js'
import { recoveryScenarioSpec, recoveryClock as clock } from './recovery-scenarios.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { inspectHost } from '../../src/host/inspection.js'
import { runHostCli } from '../../src/host/cli.js'
import { executeCommand } from '../../src/host/cli-protocol.js'
import { hostExitCode } from '../../src/host/cli-interactive.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { parseSessionId } from '../../src/session/ids.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'

function streams(commands: unknown[] = []) {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdin.end(commands.map(item => JSON.stringify(item)).join('\n'))
  return { stdin, stdout, stderr, records: () => output.trim().split('\n').map(line => JSON.parse(line)) }
}
const command = (kind: string, requestId = kind) => ({ protocolVersion: 3, requestId, kind, workflowKey: 'research' })

it('inspects Workflow state without truncating an interrupted log tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-inspect-tail-'))
  try {
    const spec = runnableWorkflowHost(root); await initializeHost(spec)
    const paths = [spec.members[0]!.sessionId, '87000000-0000-4000-8000-000000000001'].map(id => join(root, 'sessions', id, 'events.log'))
    for (const path of paths) await appendFile(path, Buffer.from('123\t'))
    const before = await Promise.all(paths.map(path => readFile(path)))
    expect((await inspectHost(spec, { protocolVersion: 3 })).workflows.count).toBe(1)
    for (const [index, path] of paths.entries()) expect(await readFile(path)).toEqual(before[index])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('adopts an explicitly identified coordinator Header through v3 CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-cli-adopt-'))
  try {
    const raw = runnableWorkflowConfig(join(root, 'store')), spec = resolveHostConfig(decodeHostConfig(raw, root))
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    const session = await repository.create({ sessionId: parseSessionId(raw.workflows.definitions[0]!.sessionId) })
    const header = session.header
    await repository.dispose()
    const path = join(root, 'host.json'); await writeFile(path, JSON.stringify(raw))
    const args = ['adopt-empty', '--config', path, '--protocol-version', '3', '--workflow-key', 'research',
      '--predecessor-stopped', '--expected-header', JSON.stringify(header)]
    expect(await runHostCli(args, streams())).toBe(0)
    await expect(runHostCli(args, streams())).rejects.toMatchObject({ code: 'HOST_BOOTSTRAP_AMBIGUOUS' })
    expect(await runHostCli(['init', '--config', path, '--protocol-version', '3'], streams())).toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('counts an undisplayed paused Workflow before classifying completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-truncated-'))
  try {
    const base = runnableWorkflowConfig(root), first = base.workflows.definitions[0]!
    const sessionId = '87000000-0000-4000-8000-000000000009'
    const spec = resolveHostConfig(decodeHostConfig({ ...base, scheduling: { ...base.scheduling, maxReportEntries: 1 },
      workflows: { ...base.workflows, definitions: [first, { sessionId,
        definition: { ...first.definition, workflowKey: 'later', coordinator: 'ah-session:' + sessionId } }] } }, root))
    await initializeHost(spec)
    const host = await openHost(spec)
    try {
      await host.workflow('research').resume({ requestKey: 'start' })
      const report = await host.run(), workflows = host.workflowReport()
      expect(workflows).toMatchObject({ count: 2, unclosed: 1, truncated: true })
      expect(workflows.reports).toHaveLength(1)
      expect(workflows.reports[0]).toMatchObject({ state: 'completed', closed: true })
      expect(hostExitCode(report, workflows)).toBe(10)
    } finally { await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

it.each(['paused', 'completed', 'cancelled', 'failed', 'batch-budget'] as const)('classifies v3 %s from complete counts', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-cli-'))
  try {
    const base = runnableWorkflowConfig(join(root, 'store'), scenario === 'failed' ? 'invalid JSON' : undefined)
    const raw = { ...base, scheduling: { ...base.scheduling, maxReportEntries: 1 } }
    if (scenario === 'batch-budget') raw.scheduling.maxBatchesPerRun = 1
    const path = join(root, 'host.json'); await writeFile(path, JSON.stringify(raw))
    const args = ['--config', path, '--protocol-version', '3']
    expect(await runHostCli(['init', ...args], streams())).toBe(0)
    const commands = scenario === 'paused' ? [] : [{ ...command(scenario === 'cancelled' ? 'workflow-cancel' : 'workflow-resume'), requestKey: 'operator-choice' }]
    const io = streams(commands)
    expect(await runHostCli(['run', ...args], io)).toBe({ paused: 10, completed: 0, cancelled: 0, failed: 11, 'batch-budget': 12 }[scenario])
    const last = io.records().at(-1)
    expect(last).toMatchObject({ protocolVersion: 3, kind: 'complete', report: { workflows: { count: 1 } } })
    const inspected = streams(); await runHostCli(['inspect', ...args], inspected)
    expect(inspected.records()[0]).toMatchObject({ workflows: { count: 1 }, recovery: { domainSupersedes: expect.any(Object) } })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

it('uses durable control keys independently of request IDs and returns disclosed artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-cli-control-'))
  try {
    const spec = runnableWorkflowHost(root); await initializeHost(spec)
    const host = await openHost(spec)
    try {
      const request = { ...command('workflow-resume'), requestKey: 'start' }
      const first = await executeCommand(host, request, 3), again = await executeCommand(host, { ...request, requestId: 'second' }, 3)
      expect(again).toMatchObject({ ...(first as object), requestId: 'second' })
      await executeCommand(host, { ...command('workflow-pause'), requestKey: 'pause' }, 3)
      await executeCommand(host, { ...request, requestId: 'old-start' }, 3); await host.run()
      expect(host.workflow('research').report().counts.assignments).toBe(0)
      await executeCommand(host, { ...request, requestId: 'new-start', requestKey: 'new-start' }, 3); await host.run()
      const report = host.workflow('research').report()
      expect(report.usage).toMatchObject({ modelCalls: 2, unknownCalls: 0, inputTokens: 0, outputTokens: 0 })
      expect(report.counts.pendingResources).toBe(0)
      const artifact = report.artifacts[0]!
      expect(await executeCommand(host, { ...command('workflow-artifact'), artifactRef: artifact.ref }, 3)).toMatchObject({ artifact: { ref: artifact.ref, value: { name: artifact.name } } })
      await expect(executeCommand(host, { ...command('workflow-artifact'), artifactRef: {} }, 3)).rejects.toMatchObject({ code: 'HOST_PROTOCOL_INVALID' })
      await expect(executeCommand(host, { ...command('workflow-resume'), protocolVersion: 2, requestKey: 'invalid-v2' }, 2)).rejects.toMatchObject({ code: 'HOST_PROTOCOL_INVALID' })
    } finally { await host.shutdown() }
    expect((await inspectHost(spec, { protocolVersion: 3 })).workflows.reports[0]?.closed).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

it('retries through the CLI adapter and does not classify an archived failed attempt as the final outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-cli-retry-'))
  try {
    const spec = await recoveryScenarioSpec('review-retry', root, root); let reviews = 0
    await initializeHost(spec, { clock })
    const host = await openHost(spec, { clock, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* () {
        yield { kind: 'message-start', responseId: 'review', reportedModel: member.spec.target.model }
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: member.agentKey === 'writer' ? '{"text":"candidate"}' : JSON.stringify({ decision: ++reviews === 1 ? 'reject' : 'accept', reason: 'checked' }) }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      } }) } })
    try {
      await executeCommand(host, { ...command('workflow-resume'), requestKey: 'start' }, 3); await host.run()
      const failedAssignment = host.workflow('research').report().assignments[0]!.ref
      await executeCommand(host, { ...command('workflow-retry'), requestKey: 'retry', nodeKey: 'read', failedAssignment }, 3)
      const report = await host.run()
      expect(hostExitCode(report, host.workflowReport())).toBe(0)
      expect(host.workflow('research').report().usage.unknownCalls).toBe(4)
      expect(host.workflow('research').report().usage.inputTokens).toBeNull()
    } finally { await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 45000)

it.each(['retry', 'cancel'] as const)('closes an exhausted continuation before %s without retaining an operator error', async outcome => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-cli-exhausted-'))
  try {
    const base = runnableWorkflowHost(root)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
    const entry = base.workflows.definitions[0]!, first = entry.definition.nodes[0]!
    const grant = { models: 1, steps: 1, tools: 0, messages: 0, waits: 1, outputTokens: 256 }
    const attempt = { ...first.attempts[0]!, workerGrant: grant, nativeActions: ['agent_ask_user'] }
    const members = base.members.map(member => {
      if (member.kind !== 'local' || member.spec.protocolVersion !== 3) throw new Error('workflow fixture')
      return { ...member, spec: { ...member.spec, budget: grant,
        workflow: { kind: 'participant' as const, toolNames: [], resourceIds: [], nativeActions: ['agent_ask_user' as const] } },
        model: { ...member.model, runnerLimits: { ...member.model.runnerLimits, maxToolCalls: 1 } } }
    })
    const definition = decodeWorkflowDefinition({ ...entry.definition,
        roster: entry.definition.roster.map(peer => ({ ...peer, budgetCeiling: grant,
          ...workflowMemberFingerprints(members.find(member => member.agentKey === peer.memberKey)!) })),
        nodes: [{ ...first, attempts: [attempt, attempt] }], requiredOutputs: [first.nodeKey],
        communication: { ask: [], groups: [], disclosures: [{ nodeKey: first.nodeKey, recipients: ['coordinator'] }] },
        budget: { ...grant, models: 2, steps: 2, waits: 2, outputTokens: 512 } })
    const configured = { ...base, members, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    let calls = 0
    await initializeHost(configured)
    const host = await openHost(configured, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* () {
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'exhausted' }
        if (++calls === 1) {
          yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'confirm' }
          yield { kind: 'arguments-delta', index: 0, text: '{"question":"Confirm?","timeoutMs":60000}' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          yield { kind: 'block-start', index: 0, block: 'text' }
          yield { kind: 'text-delta', index: 0, text: '{"text":"revised evidence"}' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } }) } })
    try {
      const workflow = host.workflow('research')
      await workflow.resume({ requestKey: 'start' }); await host.run()
      const wait = host.report().members.find(member => member.agentKey === 'writer')!.agent.waits[0]!
      await host.submitAnswer('writer', wait.reference, 'Confirmed'); await host.run()
      expect(workflow.report()).toMatchObject({ state: 'retry-awaiting-decision', counts: { exhausted: 1 } })
      expect(host.report().counts.reviewRequiredInputs).toBe(0)
      if (outcome === 'retry') await workflow.retry({ nodeKey: first.nodeKey, failedAssignment: workflow.report().assignments[0]!.ref, requestKey: 'retry' })
      else await workflow.cancel({ requestKey: 'cancel' })
      const report = await host.run()
      expect(workflow.report()).toMatchObject({ state: outcome === 'retry' ? 'completed' : 'cancelled', closed: true, counts: { exhausted: 1 } })
      expect(hostExitCode(report, host.workflowReport())).toBe(0)
      expect(report.counts).toMatchObject({ pendingInputs: 0, reviewRequiredInputs: 0 })
      expect(calls).toBe(outcome === 'retry' ? 2 : 1)
    } finally { await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
