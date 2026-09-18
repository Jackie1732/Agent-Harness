import { expect, it } from 'vitest'
import { parseChannelId, parseSessionId, formatSessionAddress } from '../../src/index.js'
import { agentFixture } from './fixtures.js'
import { auditedAgent } from './audit-fixtures.js'
import { createCommunicationService, messageCatalog, channelIds } from '../communication/fixtures.js'
import * as events from '../../src/agent/session-events.js'

for (const maximum of [0, 1]) it('keeps full counts and pending outbox facts in a bounded report; maximum=' + maximum, async () => {
  const defaults = await agentFixture(); const limits = { ...defaults.spec.limits, maxReportEntries: maximum, maxDispatchRunsPerRun: 0 }; await defaults.close()
  const f = await agentFixture({ limits, messages: [{ type: 'test/request', payloadVersion: 1, requiresReply: false }],
    peers: [{ key: 'peer', address: formatSessionAddress(parseSessionId('30000000-0000-4000-8000-000000000102')), channelId: parseChannelId(channelIds[0]) }] }, undefined, messageCatalog)
  const { service, policy } = createCommunicationService(); const mailbox = await service.attach(f.session, { catalog: messageCatalog, policy })
  const agent = auditedAgent(f, { mailbox, messageCatalog })
  try {
    for (let index = 0; index < 2; index++) await agent.sendMessage({ kind: 'send', peerKey: 'peer', type: 'test/request', payloadVersion: 1, payloadJson: '{"text":"private body"}' })
    const idle = await agent.start(); expect(idle.run?.settled?.payload.stoppedBy).toBe('idle')
    expect(idle.nextWakeAt).toBeNull(); expect(idle.counts.pendingOutbox).toBe(2); expect(idle.pendingOutbox).toHaveLength(maximum); expect(idle.truncated.pendingOutbox).toBe(true)
    for (let index = 0; index < 2; index++) {
      const input = await agent.submitInput({ kind: 'task', text: 'private input', originLabel: 'audit' })
      await f.journal.append(events.agentInputAbandonRequestedEvent, () => ({ kind: 'abandon-input' as const, input: { kind: 'user' as const, eventId: input.stored.eventId }, reason: 'audit' }))
    }
    const report = agent.report()
    expect(report.counts.pendingControls).toBe(2); expect(report.pendingControls).toHaveLength(maximum)
    expect(report.truncated.pendingControls).toBe(true); expect(report.counts.pendingInputs).toBe(2); expect(report.counts.queuedInputs).toBe(2)
    expect(JSON.stringify(report)).not.toContain('private body'); expect(JSON.stringify(report)).not.toContain('private input')
  } finally { await agent.dispose(); await service.dispose(); await f.close() }
})

it('reports current Run turn references independently from truncated root history', async () => {
  const defaults = await agentFixture(); const limits = { ...defaults.spec.limits, maxReportEntries: 1 }; await defaults.close()
  const f = await agentFixture({ limits }); const agent = auditedAgent(f)
  try {
    for (let index = 0; index < 2; index++) await agent.submitInput({ kind: 'task', text: 'task', originLabel: 'audit' })
    const report = await agent.start(); expect(report.counts.turns).toBe(2); expect(report.turns).toHaveLength(1); expect(report.truncated.turns).toBe(true)
    expect(report.turns[0]?.outcome).toBe('completed'); expect(report.counts.pendingInputs).toBe(0)
  } finally { await agent.dispose(); await f.close() }
})
