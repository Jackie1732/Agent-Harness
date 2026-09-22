import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { subagentConfig, clock, delegationRequest, action, final, protocolInput } from './subagent-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'harness-delegation-'))
let host
try {
  const spec = h.resolveHostConfig(h.decodeHostConfig(await subagentConfig(root), root))
  await h.initializeHost(spec, { clock })
  let parentCalls = 0; let childCalls = 0
  host = await h.openHost(spec, { clock, bindings: { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
    script: async function* (submission) {
      const parent = member.agentKey === 'writer'; const call = parent ? parentCalls++ : childCalls++
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'roundtrip' }
      if (parent && call === 0) yield* action('agent_spawn_subagent', delegationRequest())
      else {
        if (parent) assert.equal(protocolInput(submission, 'subagent-result').payload.summary.text, 'Child checked the evidence.')
        yield* final(parent ? 'Parent adopted the evidence.' : 'Child checked the evidence.')
      }
    },
  }) } })
  await host.submitTask('writer', 'Delegate one bounded check.')
  assert.equal((await host.run()).members[0].agent.final.text, 'Parent adopted the evidence.')
  assert.equal(host.delegationReport().unresolved, 0)
  assert.equal(parentCalls, 2); assert.equal(childCalls, 1)
  const relation = host.delegationReport().delegations[0]
  const parent = host.bindParent(h.formatSessionAddress(h.parseSessionId(spec.members[0].sessionId)), relation.parentRoot)
  assert.equal((await parent.wait(relation.delegationId, { until: 'closed' })).adopted, true)
  assert.equal((await parent.cancel(relation.delegationId, 'already-closed')).kind, 'already-closed')
  process.stdout.write(JSON.stringify({ example: 'subagent-roundtrip', parentCalls, childCalls, closed: true }) + '\n')
} finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
