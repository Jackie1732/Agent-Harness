import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { formatSessionAddress, parseSessionId } from '../../src/session/ids.js'
import type { SessionEventId } from '../../src/session/ids.js'
import type { JsonObject } from '../../src/foundation/json.js'
import { subagentHostConfig } from './subagent-fixture.js'
import { controlClock, controlRequest } from './subagent-control-fixture.js'

it('admits another Child after adopting and closing its predecessor while the same Root retains a user Wait and budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-serial-child-'))
  try {
    const raw = await subagentHostConfig(directory), member = (raw.members as JsonObject[])[0]!
    const spec = resolveHostConfig(decodeHostConfig({ ...raw, members: [{ ...member,
      spec: { ...(member.spec as JsonObject), nativeActions: [...((member.spec as JsonObject).nativeActions as string[]), 'agent_ask_user'] } }] }, directory))
    await initializeHost(spec, { clock: controlClock })
    let parentCalls = 0, firstId: SessionEventId
    const host = await openHost(spec, { clock: controlClock, bindings: { createModelProvider: entry => new ScriptedModelProvider({ ...entry.model,
      script: async function* () {
        yield { kind: 'message-start', responseId: 'serial-child', reportedModel: entry.spec.target.model }
        if (entry.agentKey === 'writer') {
          const name = parentCalls++ === 1 ? 'agent_await_subagent' : 'agent_ask_user'
          const args = name === 'agent_await_subagent' ? { delegationId: firstId, timeoutMs: 30000 } : { question: 'Continue?', timeoutMs: 30000 }
          yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'wait', name }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(args) }
        } else {
          yield { kind: 'block-start', index: 0, block: 'text' }
          yield { kind: 'text-delta', index: 0, text: 'Child result' }
        }
        yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: entry.agentKey === 'writer' ? 'tool-calls' : 'stop' }
      } }) } })
    try {
      await host.submitTask('writer', 'Research')
      const initial = (await host.run()).members[0]!.agent
      const root = initial.roots[0]!.id, parent = host.bindParent(formatSessionAddress(parseSessionId(spec.members[0]!.sessionId)), root)
      firstId = (await parent.spawn('first-child', controlRequest)).delegationId
      await host.run()
      await host.submitAnswer('writer', initial.waits[0]!.reference, 'Adopt first result')
      await host.run()
      expect(parent.inspect(firstId)).toMatchObject({ adopted: true, closed: true })
      expect(host.read().root('writer', root)).toMatchObject({ outcome: null, waits: [expect.any(Object)] })
      const second = await parent.spawn('second-child', controlRequest)
      expect(second.delegationId).not.toBe(firstId)
      expect(parent.inspect(firstId)).toMatchObject({ adopted: true, closed: true })
      await host.cancel('writer', root)
      await host.run()
      expect(parent.inspect(second.delegationId).closed).toBe(true)
    } finally { await host.shutdown() }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30000)
