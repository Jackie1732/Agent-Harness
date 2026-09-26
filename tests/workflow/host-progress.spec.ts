import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { workProtocolRecordedEvent } from '../../src/workflow/protocol.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { parseSessionId } from '../../src/session/ids.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { recoverWorkPrefix } from './prefix-fixture.js'
import { runnableWorkflowHost } from './host-fixture.js'

it.each(['progress', 'quota', 'oversized', 'budget'] as const)('routes %s through the work root and its reserved mailbox', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'work-progress-'))
  try {
    const base = runnableWorkflowHost(root)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('v3 fixture')
    const entry = base.workflows.definitions[0]!
    const grant = { models: 3, steps: 3, tools: 0, messages: kind === 'budget' ? 0 : 2, waits: 0, outputTokens: 768 }
    const members = base.members.map(member => {
      if (member.kind !== 'local' || member.spec.protocolVersion !== 3) throw new Error('v3 local fixture')
      return { ...member, model: { ...member.model, runnerLimits: { ...member.model.runnerLimits, maxToolCalls: 1 } },
        spec: { ...member.spec, budget: { ...member.spec.budget, messages: 2 }, workflow: { kind: 'participant' as const, toolNames: [], resourceIds: [], nativeActions: ['agent_report_work_progress' as const] } } }
    })
    const definition = decodeWorkflowDefinition({ ...entry.definition,
      budget: { ...grant, models: 6, steps: 6, messages: grant.messages * 2, outputTokens: 1536 },
      limits: { ...entry.definition.limits, maxProgress: 1, maxProtocolMessages: 14, maxTextBytes: 128 },
      roster: entry.definition.roster.map((member, index) => ({ ...member, ...workflowMemberFingerprints(members[index]!), budgetCeiling: grant })),
      nodes: entry.definition.nodes.map(node => ({ ...node, attempts: node.attempts.map(attempt => ({ ...attempt,
        workerGrant: grant, nativeActions: ['agent_report_work_progress'] })) })) })
    const spec = { ...base, members, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    await initializeHost(spec)
    let calls = 0
    const host = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission): AsyncGenerator<ModelFrame> {
        const writer = member.agentKey === 'writer'
        if (writer) calls++
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'work-progress-case' }
        if (writer && (calls === 1 || kind === 'quota' && calls === 2)) {
          expect(submission.request.tools.map(tool => tool.name)).toEqual(['agent_report_work_progress'])
          yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_report_work_progress', callId: 'progress-' + calls }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ text: kind === 'oversized' ? 'x'.repeat(129) : 'read 3 sources' }) }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
          return
        }
        if (writer && kind === 'quota') expect(JSON.stringify(submission.request)).toContain('work-progress-limit')
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: writer ? '{"text":"accepted upstream"}' : 'final report' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      } }) } })
    try {
      await host.workflow('research').resume({ requestKey: 'progress' }); await host.run()
      expect(host.workflow('research').report()).toMatchObject({ state: kind === 'budget' ? 'failed' : 'completed', closed: true,
        counts: { progress: kind === 'oversized' || kind === 'budget' ? 0 : 1 } })
      if (kind === 'progress') expect(host.workflow('research').report().progress[0]?.value).toMatchObject({ ordinal: 1, text: 'read 3 sources' })
    } finally { await host.shutdown() }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const session = await repository.open(parseSessionId(members[0]!.sessionId))
      const state = projectAgentSession(session.snapshot())
      expect(state.roots[0]?.budget.messages).toBe(kind === 'budget' ? 0 : kind === 'quota' ? 2 : 1)
      expect(state.roots[0]?.budget.waits).toBe(0)
      if (kind === 'progress') {
        const snapshot = session.snapshot()
        const events = snapshot.history.at(-1)!.events
        const progress = events.find(event => event.kind === 'known' && event.stored.type === workProtocolRecordedEvent.type
          && typeof workProtocolRecordedEvent.decode(event.payload).source !== 'string')!
        for (const count of [progress.stored.sequence - 1, progress.stored.sequence, progress.stored.sequence + 1]) {
          const recovered = await recoverWorkPrefix(snapshot, count, spec.storage.maxRecordBytes)
          expect(recovered.result.kind).toBe('recovered')
          expect(recovered.state.actions[0]?.payload.result).toMatchObject(count < progress.stored.sequence
            ? { kind: 'not-started' } : { kind: 'protocol-accepted', protocol: progress.stored.eventId })
          expect(recovered.added.some(event => ['model/invocation-prepared', 'communication/outbox-accepted', 'artifact/published'].includes(event.stored.type))).toBe(false)
        }
        const changed = { ...snapshot, history: snapshot.history.map(segment => ({ ...segment, events: segment.events.map(event => {
          if (event.kind !== 'known' || event.stored.type !== workProtocolRecordedEvent.type) return event
          const value = workProtocolRecordedEvent.decode(event.payload)
          if (typeof value.source === 'string') return event
          const payload = { ...value, commands: value.commands.map(command => ({ ...command, payload: { ...command.payload as object, text: 'invented progress' } })) }
          return { ...event, payload, stored: { ...event.stored, payload } }
        }) })) }
        expect(() => projectAgentSession(changed)).toThrow('work-action-command-mismatch')
      }
    } finally { await repository.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
