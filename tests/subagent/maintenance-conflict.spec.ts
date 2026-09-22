import { expect, it, vi } from 'vitest'
import { AgentError } from '../../src/agent/errors.js'
import { HostSubagents } from '../../src/host/subagents.js'
import type { ResolvedHostLocalMember } from '../../src/host/config.js'
import { createMessageCatalog } from '../../src/communication/message-catalog.js'
import { WorkspaceAuthority } from '../../src/subagent/workspace.js'
import { subagentMessageDefinitions } from '../../src/subagent/messages.js'
import { delegationRequestedEvent } from '../../src/subagent/session-events.js'
import { delegationFixture } from './fixtures.js'
import { clock } from '../agent/fixtures.js'
import { createCommunicationService } from '../communication/fixtures.js'

it('defers an uncommitted protocol conflict and retries the same child, while retaining its accepted identity', async () => {
  const f = await delegationFixture(); const c = createCommunicationService()
  const workspaces = await WorkspaceAuthority.create([], [], [], clock)
  let domain: HostSubagents | undefined
  try {
    const cp = await f.journal.append(delegationRequestedEvent, () => f.requested)
    const catalog = createMessageCatalog(subagentMessageDefinitions)
    const mailbox = await c.service.attach(f.session, { catalog, policy: c.policy })
    const { profileEventId: _profile, ...spec } = f.spec
    const member: ResolvedHostLocalMember = { kind: 'local', agentKey: 'parent', sessionId: f.session.header.sessionId,
      mode: 'create', enabled: true, profile: f.template.profile, spec, model: f.template.model, tools: { kind: 'none' } }
    domain = new HostSubagents({ config: { kind: 'enabled', templates: [f.template], parents: [], workspaceResources: [], limits: f.template.limits },
      repository: f.repo, communication: c.service, catalog, clock, credentials: {}, protectedRoots: [], bindings: {}, workspaces,
      slots: [{ member, session: f.session, mailbox, dispatcher: c.service.createDispatcher(mailbox), provider: f.base.provider, agent: f.agent, dispose: async () => {} }],
      localMembers: [{ member, session: f.session }], protocolSlots: [], childAddresses: new Set() })
    const accepted = await domain.admission.restore('parent', f.session, cp)
    const append = vi.spyOn(accepted.journal, 'append').mockRejectedValueOnce(new AgentError('AGENT_JOURNAL_CONFLICT', 'local-conflict-budget'))
    try {
      for (let step = 0; step < 20 && append.mock.calls.length === 0; step++) await domain.nextAction()?.()
      expect(append).toHaveBeenCalledOnce()
      expect(domain.report(1)).toMatchObject({ blocked: 0, failed: 0, count: 1 })
    } finally { append.mockRestore() }
    for (let step = 0; step < 20 && f.agent.snapshot().subagents.provisions.length === 0; step++) await domain.nextAction()?.()
    expect(f.agent.snapshot().subagents.provisions[0]?.payload).toMatchObject({ outcome: 'installed' })
    expect(f.agent.snapshot().subagents.delegations).toHaveLength(1)
    expect(domain.report(1).delegations[0]?.childSessionId).toBe(cp.payload.childSessionId)
  } finally {
    await domain?.dispose(); await c.service.dispose(); await c.transport.dispose(); await c.directory.dispose(); await workspaces.dispose(); await f.close()
  }
})
