import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { subagentConfig, clock, delegationRequest, action, final } from '../examples/subagent-fixture.mjs'
import { captureFileCommits, verifySubagentPrefixes } from './helpers/subagent-prefixes.mjs'

test('uncertain child file publication and every later parent/child recovery prefix never replay the write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-file-prefix-'))
  let host
  try {
    const workspace = join(root, 'workspace'); const storage = join(root, 'storage')
    await mkdir(join(workspace, 'out'), { recursive: true })
    const config = await subagentConfig(storage)
    const child = config.subagents.templates[0]
    const grant = { ...child.spec.budget, tools: 1 }
    const capabilities = { ...child.capabilities, tools: ['write_text'], workspaces: [{ resourceId: 'files',
      modes: ['exclusive-write'], readPrefixes: [], writePrefixes: ['out'] }] }
    const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
    const tools = { kind: 'workspace-text', read: false, write: true, maxReadBytes: 4096, maxWriteBytes: 4096,
      maxBaselineFiles: 8, maxBaselineBytes: 8192, maxPathBytes: 1024, maxArgumentsBytes: 8192, maxResultBytes: 8192, schemaLimits,
      invocationLimits: { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 8192, maxJsonDepth: 24,
        maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 } }
    config.subagents.templates = [{ ...child, capabilities, tools, profile: { ...child.profile, toolNames: ['write_text'] },
      spec: { ...child.spec, toolNames: ['write_text'], budget: grant } }]
    config.subagents.parents = config.subagents.parents.map(parent => ({ ...parent, capabilities, maxGrant: grant }))
    config.subagents.workspaceResources = [{ resourceId: 'files', rootPath: workspace, mode: 'exclusive-write',
      protectedRoots: [], readPrefixes: [], writePrefixes: ['out'], maxBaselineFiles: 8, maxBaselineBytes: 8192 }]
    let parentCalls = 0; let childCalls = 0
    const spec = h.resolveHostConfig(h.decodeHostConfig(config, storage))
    const frames = await captureFileCommits(async () => {
      await h.initializeHost(spec, { clock })
      host = await h.openHost(spec, { clock, bindings: { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
        script: async function* () {
          const parent = member.agentKey === config.members[0].agentKey
          const call = parent ? parentCalls++ : childCalls++
          yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'file-prefix' }
          if (parent && call === 0) yield* action('agent_spawn_subagent', { ...delegationRequest(), requestedBudget: grant,
            workspace: { kind: 'exclusive-write', resourceId: 'files', readFiles: [], writePrefixes: ['out'] } })
          else if (!parent && call === 0) yield* action('write_text', { path: 'out/result.txt', text: 'Published once.' })
          else yield* final(parent ? 'File adopted.' : 'File written.')
        },
      }) } })
      await host.submitTask(config.members[0].agentKey, 'Write a bounded file')
      await host.run()
      assert.equal(host.delegationReport().unresolved, 0)
      await host.shutdown()
    })
    assert.equal(parentCalls, 2); assert.equal(childCalls, 2)
    assert.equal(frames.filter(frame => frame.kind === 'event' && frame.event.type === 'tool/invocation-started').length, 1)
    const content = await readFile(join(workspace, 'out/result.txt'))
    assert.equal(content.toString(), 'Published once.')
    // A real published file paired with a CP1-only log is the legal unknown-outcome window before CP2.
    await verifySubagentPrefixes('child-file-publication', config, frames, clock, 'tool/invocation-started')
    assert.deepEqual(await readFile(join(workspace, 'out/result.txt')), content)
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
})
