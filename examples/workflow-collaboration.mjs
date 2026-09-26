import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { workflowConfig, resolveWorkflowConfig, configureWorkGrant } from './workflow-fixture.mjs'
import { action, final, protocolInput } from './subagent-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'workflow-collaboration-'))
let host
try {
  const raw = await workflowConfig(root), definition = raw.workflows.definitions[0].definition
  const offline = structuredClone(raw.members[1]); offline.agentKey = 'offline'; offline.sessionId = '70000000-0000-4000-8000-000000000103'
  raw.members.push(offline); raw.routes.push({ memberKey: 'offline', ownerHost: raw.hostKey, origin: null, serverName: null })
  definition.roster.push({ ...definition.roster[1], memberKey: 'offline', address: 'ah-session:' + offline.sessionId })
  definition.nodes.push({ ...structuredClone(definition.nodes[1]), nodeKey: 'offline', executor: 'offline' })
  definition.communication.disclosures.push({ nodeKey: 'offline', recipients: ['coordinator'] }); definition.requiredOutputs.push('offline')
  configureWorkGrant(raw, { models: 6, steps: 6, tools: 0, messages: 4, waits: 3, outputTokens: 1536 },
    ['agent_ask_work_peer', 'agent_answer_work_peer', 'agent_await_work_message', 'agent_send_work_group'])
  Object.assign(definition.limits, { maxActiveAssignments: 3, maxQuestions: 1, maxIncomingQuestions: 1, maxGroups: 1, maxGroupRecipients: 2,
    maxIncomingGroupMessages: 1, maxProtocolMessages: 96 })
  definition.communication.ask = [{ from: 'reviewer', to: 'writer' }]
  definition.communication.groups = [{ from: 'writer', recipients: ['reviewer', 'offline'] }]
  const spec = resolveWorkflowConfig(raw), calls = new Map()
  let now = Date.now()
  const clock = { now: () => now }
  let outcomes
  await h.initializeHost(spec, { clock })
  host = await h.openHost(spec, { clock, bindings: { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
    script: async function* (submission) {
      const call = (calls.get(member.agentKey) ?? 0) + 1; calls.set(member.agentKey, call)
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'collaboration' }
      if (member.agentKey === 'writer') {
        if (call === 1) yield* action('agent_await_work_message', { kind: 'question', timeoutMs: 60000 })
        else if (call === 2) yield* action('agent_answer_work_peer', { questionMessageId: protocolInput(submission, 'workflow-question').messageId, outcome: 'answered', text: 'Use source 3.' })
        else if (call === 3) yield* action('agent_send_work_group', { targetNodeKeys: ['reviewer', 'offline'], text: 'Shared criteria.', completion: 'collect-outcomes', timeoutMs: 1000 })
        else { outcomes = protocolInput(submission, 'workflow-group-result'); yield* final('Shared evidence delivered where available.') }
      } else if (member.agentKey === 'reviewer' && call === 1) yield* action('agent_ask_work_peer', { targetNodeKey: 'writer', text: 'Which source?', timeoutMs: 60000 })
      else if (member.agentKey === 'reviewer' && call === 2) yield* action('agent_await_work_message', { kind: 'group', timeoutMs: 60000 })
      else yield* final('Independent recipient result.')
    } }) } })
  for (const member of raw.members) host.pause(member.agentKey)
  await host.workflow('research').resume({ requestKey: 'start' }); await host.run()
  await host.setMailboxOnline('offline', false)
  host.resume('writer'); await host.run(); host.resume('reviewer'); await host.run()
  now += 1001; await host.run()
  outcomes = host.workflow('research').report().work.flatMap(item => item.groups)[0]
  assert.ok(JSON.stringify(outcomes).includes('delivered')); assert.ok(JSON.stringify(outcomes).includes('abandoned'))
  assert.equal(host.workflow('research').report().counts.pendingQuestions, 0)
  await host.setMailboxOnline('offline', true); host.resume('offline'); await host.run()
  assert.equal(host.workflow('research').report().closed, true)
  console.log(JSON.stringify({ example: 'workflow-collaboration', group: outcomes, report: host.workflow('research').report() }))
} finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
