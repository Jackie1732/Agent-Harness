import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runnableWorkflowHost } from './host-fixture.js'
import { groupWorkflowHost } from './group-fixture.js'
import { delegatedWorkflowHost } from './subagent-fixture.js'
import { workspaceWorkflowHost } from './workspace-fixture.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelRequest } from '../../src/model/contract.js'
import { captureWorkflowTrace } from './file-trace.js'

export const recoveryClock = { now: () => Date.parse('2026-09-26T00:00:00.000Z') }
export type RecoveryScenario = 'question' | 'group' | 'review-retry' | 'child-cancel' | 'file'

export async function recoveryScenarioSpec(kind: RecoveryScenario, root: string, workspace: string) {
  if (kind === 'group') return groupWorkflowHost(root)
  if (kind === 'child-cancel') return delegatedWorkflowHost(root)
  if (kind === 'file') return workspaceWorkflowHost(root, workspace, 'allow')
  const base = runnableWorkflowHost(root)
  if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
  const entry = base.workflows.definitions[0]!
  if (kind === 'review-retry') {
    const producer = entry.definition.nodes[0]!, grant = { models: 1, steps: 1, tools: 0, messages: 0, waits: 0, outputTokens: 256 }
    const attempt = { ...producer.attempts[0], reviewerGrants: [{ memberKey: 'reviewer', grant }] }
    const definition = decodeWorkflowDefinition({ ...entry.definition, requiredOutputs: ['read'],
      communication: { ...entry.definition.communication, disclosures: [entry.definition.communication.disclosures[0]] },
      roster: entry.definition.roster.map(member => ({ ...member, canReview: member.memberKey === 'reviewer' })),
      nodes: [{ ...producer, attempts: [attempt, attempt], acceptance: { kind: 'reviewed-all', reviewers: ['reviewer'] } }],
      budget: { ...entry.definition.budget, models: 6, steps: 6, outputTokens: 1536 }, limits: { ...entry.definition.limits, maxProtocolMessages: 24 } })
    return { ...base, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
  }
  const actions = ['agent_ask_work_peer', 'agent_await_work_message', 'agent_answer_work_peer'] as const
  const grant = { models: 5, steps: 5, tools: 0, messages: 3, waits: 3, outputTokens: 1280 }
  const members = base.members.map(member => {
    if (member.kind !== 'local' || member.spec.protocolVersion !== 3) throw new Error('participant fixture')
    return { ...member, model: { ...member.model, runnerLimits: { ...member.model.runnerLimits, maxToolCalls: 1 } },
      spec: { ...member.spec, budget: grant, workflow: { kind: 'participant' as const, toolNames: [], resourceIds: [], nativeActions: actions } } }
  })
  const definition = decodeWorkflowDefinition({ ...entry.definition, budget: { ...grant, models: 10, steps: 10, messages: 6, waits: 6, outputTokens: 2560 },
    limits: { ...entry.definition.limits, maxQuestions: 1, maxIncomingQuestions: 1, maxProtocolMessages: 16 },
    communication: { ...entry.definition.communication, ask: [{ from: 'reviewer', to: 'writer' }] },
    roster: entry.definition.roster.map((member, index) => ({ ...member, ...workflowMemberFingerprints(members[index]!), budgetCeiling: grant })),
    nodes: entry.definition.nodes.map(node => ({ ...node, dependencies: [], inputs: [], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      attempts: node.attempts.map(attempt => ({ ...attempt, workerGrant: grant, nativeActions: actions })) })) })
  return { ...base, members, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
}

function questionId(request: ModelRequest): string {
  for (const message of request.messages) for (const block of message.content) {
    if (block.kind !== 'text') continue
    let value
    try { value = JSON.parse(block.text) } catch { continue }
    if (value.kind === 'workflow-question') return value.data.messageId
  }
  throw new Error('missing claimed question')
}

/** Real File Sessions, model actions, mailbox deliveries, controls and resource release provide the cut points. */
export async function recordRecoveryScenario(kind: RecoveryScenario, root: string, workspace: string) {
  if (kind === 'file') {
    await mkdir(join(workspace, 'out/attempt-1'), { recursive: true }); await mkdir(join(workspace, 'in'))
    await writeFile(join(workspace, 'in/source.txt'), 'original input')
  }
  const spec = await recoveryScenarioSpec(kind, root, workspace)
  const calls = new Map<string, number>()
  const trace = await captureWorkflowTrace(async () => {
    await initializeHost(spec, { clock: recoveryClock })
    const host = await openHost(spec, { clock: recoveryClock, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission) {
        const count = (calls.get(member.agentKey) ?? 0) + 1; calls.set(member.agentKey, count)
        const writer = member.agentKey === 'writer', child = !['writer', 'reviewer'].includes(member.agentKey)
        let action: { name: string; args: unknown } | undefined
        if (kind === 'question') {
          if (count === 1) action = writer ? { name: 'agent_await_work_message', args: { kind: 'question', timeoutMs: 60000 } }
            : { name: 'agent_ask_work_peer', args: { targetNodeKey: 'read', text: 'Which source?', timeoutMs: 60000 } }
          else if (writer && count === 2) action = { name: 'agent_answer_work_peer', args: { questionMessageId: questionId(submission.request), outcome: 'answered', text: 'Source 3.' } }
        } else if (kind === 'group' && count === 1) action = writer
          ? { name: 'agent_send_work_group', args: { targetNodeKeys: ['write', 'note2', 'note3'], text: 'Shared criteria', completion: 'collect-outcomes', timeoutMs: 60000 } }
          : { name: 'agent_await_work_message', args: { kind: 'group', timeoutMs: 60000 } }
        else if (kind === 'child-cancel') {
          if (writer && count === 1) action = { name: 'agent_spawn_subagent', args: { templateKey: 'research', templateVersion: 1,
            task: 'Check evidence', materials: [], requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } } }
          if (child) action = { name: 'agent_ask_parent', args: { question: 'Choose source', timeoutMs: 10000 } }
          if (writer && count === 2) action = { name: 'agent_ask_user', args: { question: 'Continue?', timeoutMs: 10000 } }
        } else if (kind === 'file' && writer && count === 1) action = { name: 'write_text', args: { path: 'out/attempt-1/result.txt', text: 'Verified text' } }
        yield { kind: 'message-start', responseId: 'recovery-' + count, reportedModel: member.spec.target.model }
        if (action !== undefined) {
          yield { kind: 'block-start', index: 0, block: 'tool-call', name: action.name, callId: 'call-' + count }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(action.args) }; yield { kind: 'block-end', index: 0 }
          yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          const review = kind === 'review-retry' && !writer
          const text = review ? JSON.stringify({ decision: count === 1 ? 'reject' : 'accept', reason: 'checked candidate' })
            : kind === 'group' ? member.agentKey + ' result' : writer ? '{"text":"accepted upstream"}' : 'final report'
          yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } }) } })
    try {
      const workflow = host.workflow('research')
      if (kind === 'question' || kind === 'group') for (const member of spec.members) host.pause(member.agentKey)
      await workflow.resume({ requestKey: 'start' }); await host.run()
      if (kind === 'question') {
        host.resume('writer'); await host.run(); host.resume('reviewer'); await host.run()
      } else if (kind === 'group') {
        for (const member of spec.members.slice(1)) host.resume(member.agentKey)
        await host.run(); host.resume('writer'); await host.run()
      } else if (kind === 'review-retry') {
        await workflow.retry({ nodeKey: 'read', failedAssignment: workflow.report().assignments[0]!.ref, requestKey: 'retry' }); await host.run()
      } else if (kind === 'child-cancel') { await workflow.cancel({ requestKey: 'stop' }); await host.run() }
      if (!workflow.report().closed) throw new Error('trace did not close: ' + JSON.stringify(workflow.report()))
    } finally { await host.shutdown({ mode: 'drain' }) }
  })
  return trace
}
