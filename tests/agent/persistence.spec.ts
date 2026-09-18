import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSessionBackend, SessionModelRunner, SessionAgent, SessionRepository, createDurableEventCatalog, contextSessionEventDefinitions,
  modelSessionEventDefinitions, toolSessionEventDefinitions, communicationSessionEventDefinitions, agentSessionEventDefinitions, recoverAgentSession } from '../../src/index.js'
import { parseSessionId, formatSessionAddress, parseChannelId, projectCommunicationFacts } from '../../src/index.js'
import { agentFixture, clock } from './fixtures.js'
import { emptyMessageCatalog, runnerLimits, scriptedModel } from '../context/fixtures.js'
import { loseFirstCommitAcknowledgement } from '../communication/fixtures.js'
import { createCommunicationService, messageCatalog, channelIds } from '../communication/fixtures.js'

for (const window of ['agent/run-started', 'context/assembly-committed', 'model/invocation-prepared', 'model/invocation-started', 'model/invocation-settled', 'agent/step-decided', 'agent/turn-settled', 'agent/run-settled']) {
  it(`reopens a file journal after acknowledgement loss at ${window} without generating again`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-agent-recovery-'))
    const counters = { prepare: 0, acquire: 0, start: 0 }
    const provider = scriptedModel('done', counters)
    const f = await agentFixture({}, provider, emptyMessageCatalog,
      loseFirstCommitAcknowledgement(new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }), window))
    const model = new SessionModelRunner({ session: f.session, provider, limits: runnerLimits })
    const agent = new SessionAgent({ session: f.session, model, context: f.context, messageCatalog: emptyMessageCatalog, clock })
    let reopened: SessionRepository | undefined
    try {
      await agent.submitInput({ kind: 'task', text: 'one irreversible opportunity', originLabel: 'test' })
      await expect(agent.start()).rejects.toBeDefined()
      const issued = counters.start
      await agent.dispose().catch(() => undefined); await f.close().catch(() => undefined)
      reopened = new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }), maxLineageDepth: 8,
        catalog: createDurableEventCatalog([...contextSessionEventDefinitions, ...modelSessionEventDefinitions, ...toolSessionEventDefinitions, ...communicationSessionEventDefinitions, ...agentSessionEventDefinitions]), clock })
      const session = await reopened.open(f.session.header.sessionId)
      const result = await recoverAgentSession(session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 30, maxJournalConflicts: 4, clock })
      expect(['recovered', 'nothing-to-recover']).toContain(result.kind)
      expect(result.report.openRun).toBeNull()
      expect(result.report.openTurn).toBeNull()
      expect(counters.start).toBe(issued)
      if (window === 'agent/run-started') expect(result.report.inputs[0]?.status).toBe('queued')
      else expect(result.report.inputs[0]?.status).not.toBe('queued')
      if (['model/invocation-settled', 'agent/step-decided', 'agent/turn-settled', 'agent/run-settled'].includes(window)) {
        expect(result.report.roots[0]?.outcome).toBe('completed')
        expect(result.report.final?.text).toBe('done')
      }
    } finally {
      await agent.dispose().catch(() => undefined); await f.close().catch(() => undefined); await reopened?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const window of ['agent/command-accepted', 'communication/outbox-accepted', 'agent/action-settled']) {
  it(`recovers a direct command at ${window} without creating or delivering another message`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-agent-command-'))
    const f = await agentFixture({ messages: [{ type: 'test/request', payloadVersion: 1, requiresReply: false }],
      peers: [{ key: 'peer', address: formatSessionAddress(parseSessionId('30000000-0000-4000-8000-000000000102')), channelId: parseChannelId(channelIds[0]) }] },
      undefined, messageCatalog, loseFirstCommitAcknowledgement(new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }), window))
    const { service, policy } = createCommunicationService()
    const agent = new SessionAgent({ session: f.session, context: f.context, model: new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits }),
      communication: { service, policy }, messageCatalog, clock })
    let reopened: SessionRepository | undefined
    try {
      await expect(agent.sendMessage({ kind: 'send', peerKey: 'peer', type: 'test/request', payloadVersion: 1, payloadJson: '{"text":"once"}' })).rejects.toBeDefined()
      await agent.dispose().catch(() => undefined); await service.dispose(); await f.close().catch(() => undefined)
      reopened = new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }), maxLineageDepth: 8,
        catalog: createDurableEventCatalog([...contextSessionEventDefinitions, ...modelSessionEventDefinitions, ...toolSessionEventDefinitions, ...communicationSessionEventDefinitions, ...agentSessionEventDefinitions]), clock })
      const session = await reopened.open(f.session.header.sessionId)
      const before = projectCommunicationFacts(session.snapshot()).outbox
      const result = await recoverAgentSession(session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 30, maxJournalConflicts: 4, clock })
      const after = projectCommunicationFacts(session.snapshot()).outbox
      expect(after).toEqual(before)
      expect(after).toHaveLength(window === 'agent/command-accepted' ? 0 : 1)
      expect(after.every(item => item.attemptCount === 0)).toBe(true)
      expect(result.report.openRun).toBeNull()
      expect(result.report.roots).toHaveLength(0)
    } finally {
      await agent.dispose().catch(() => undefined); await service.dispose(); await f.close().catch(() => undefined); await reopened?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}
