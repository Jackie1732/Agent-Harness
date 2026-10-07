import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost } from '../../src/host/index.js'
import { decodeResult } from '../../src/protocol/index.js'
import { twoMemberHostConfig } from '../host/fixtures.js'
import { waitingDelegations } from '../host/subagent-control-fixture.js'
import { runnableWorkflowHost } from '../workflow/host-fixture.js'
import { jsonLimits } from './fixtures.js'

it('decodes actual Host, Agent, input, Root and message producers through their complete execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'protocol-producers-'))
  const spec = resolveHostConfig(decodeHostConfig(twoMemberHostConfig(directory), directory))
  await initializeHost(spec)
  const host = await openHost(spec)
  try {
    expect(decodeResult('host.status', host.read().status(), jsonLimits)).toEqual(host.read().status())
    const input = await host.submitKeyedInput('writer', { kind: 'task', text: 'Produce a result', originLabel: 'api:researcher' }, { namespace: 'api:researcher', key: 'task' })
    expect(decodeResult('input.submit', input, jsonLimits)).toEqual(input)
    const report = await host.run()
    expect(decodeResult('host.run', { instanceId: host.instanceId, report, cuts: report.cuts! }, jsonLimits)).toHaveProperty('report.businessRuns', report.businessRuns)
    const observed = host.read().input('writer', { inputEventId: input.inputEventId })
    expect(decodeResult('input.get', observed, jsonLimits)).toEqual(observed)
    expect(decodeResult('agent.get', host.read().agent('writer'), jsonLimits)).toHaveProperty('report.final.text', 'writer answer')
    expect(decodeResult('root.get', host.read().root('writer', observed.rootId!), jsonLimits)).toHaveProperty('final.text', 'writer answer')
    const sent = await host.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"Review"}' })
    const accepted = { agentKey: 'writer', sessionId: observed.sessionId, instanceId: host.instanceId, cuts: sent.cuts,
      ...sent.command }
    expect(decodeResult('message.send', accepted, jsonLimits)).toHaveProperty('status', 'outbox-accepted')
    expect(decodeResult('message.get', host.read().message('writer', sent.command.messageId!, 'outbox'), jsonLimits)).toHaveProperty('fact.status', 'pending')
    await host.run()
    expect(decodeResult('message.get', host.read().message('writer', sent.command.messageId!, 'outbox'), jsonLimits)).toHaveProperty('fact.status', 'delivered')
    expect(decodeResult('message.get', host.read().message('reviewer', sent.command.messageId!, 'inbox'), jsonLimits)).toHaveProperty('fact.status', 'processed')
    const page = await host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 1000 })
    expect(decodeResult('session.events', page, jsonLimits)).toEqual(page)
  } finally { await host.shutdown(); await rm(directory, { recursive: true, force: true }) }
})

it('decodes the original Parent reports before and after a real Child settles', async () => {
  const fixture = await waitingDelegations({ count: 1, childResponse: 'child result' })
  try {
    const parent = fixture.parents[0]!, receipt = fixture.receipts[0]!, root = parent.inspect(receipt.delegationId).parentRoot
    const accepted = { ...receipt, instanceId: fixture.host.instanceId, cuts: fixture.host.read().delegation('writer', root, receipt.delegationId).cuts }
    expect(decodeResult('delegation.spawn', accepted, jsonLimits)).toEqual(accepted)
    const pending = fixture.host.read().delegation('writer', root, receipt.delegationId)
    expect(decodeResult('delegation.get', pending, jsonLimits)).toHaveProperty('businessResolved', false)
    await fixture.host.run()
    const result = fixture.host.read().delegation('writer', root, receipt.delegationId)
    expect(decodeResult('delegation.get', result, jsonLimits)).toHaveProperty('resultAvailable', true)
    expect(result.childResources).not.toHaveLength(0)
  } finally { await fixture.close() }
}, 40000)

it('decodes original Workflow reports, work budgets and accepted output through a real run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'protocol-workflow-'))
  const spec = runnableWorkflowHost(directory)
  await initializeHost(spec)
  const host = await openHost(spec)
  try {
    if (spec.schemaVersion !== 3 || spec.workflows.kind !== 'enabled') throw new Error('Workflow fixture required')
    const workflowKey = spec.workflows.definitions[0]!.definition.workflowKey
    expect(decodeResult('workflow.get', host.read().workflow(workflowKey), jsonLimits)).toHaveProperty('state', 'paused')
    const resumed = await host.workflow(workflowKey).resume({ requestKey: 'protocol-compatibility' })
    expect(decodeResult('workflow.resume', { ...resumed, instanceId: host.instanceId, cuts: host.read().workflow(workflowKey).cuts }, jsonLimits)).toHaveProperty('status', 'resumed')
    await host.run()
    const result = host.read().workflow(workflowKey)
    expect(decodeResult('workflow.get', result, jsonLimits)).toHaveProperty('state', 'completed')
    expect(result.work).toHaveLength(2)
    expect(decodeResult('workflow.output', host.read().output(workflowKey, 'read'), jsonLimits)).toHaveProperty('status', 'available')
    const acceptedRef = host.read().workflow(workflowKey).artifacts[0]!.ref
    expect(decodeResult('workflow.artifact', host.read().artifact(workflowKey, acceptedRef), jsonLimits)).toHaveProperty('mediaType', 'text/plain')
  } finally { await host.shutdown(); await rm(directory, { recursive: true, force: true }) }
}, 40000)
