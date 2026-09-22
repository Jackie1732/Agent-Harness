import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { subagentConfig, clock, delegationRequest, action, final } from './subagent-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'harness-shared-workspace-'))
let host
try {
  const storage = join(root, 'storage'); const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'out'), { recursive: true }); await writeFile(join(workspace, 'out/evidence.txt'), 'shared evidence')
  const config = await subagentConfig(storage)
  const parent = config.members[0]; const child = config.subagents.templates[0]
  const grant = { ...child.spec.budget, tools: 2 }
  const capabilities = { ...child.capabilities, tools: ['read_text', 'write_text'], workspaces: [{ resourceId: 'research-files',
    modes: ['shared-read', 'exclusive-write'], readPrefixes: ['out'], writePrefixes: ['out'] }] }
  const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
  const tools = { kind: 'workspace-text', read: true, write: true, maxReadBytes: 4096, maxWriteBytes: 4096,
    maxBaselineFiles: 8, maxBaselineBytes: 8192, maxPathBytes: 1024, maxArgumentsBytes: 8192, maxResultBytes: 8192, schemaLimits,
    invocationLimits: { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 8192, maxJsonDepth: 24,
      maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 } }
  config.members = ['reader-a', 'reader-b', 'writer'].map((agentKey, index) => ({ ...structuredClone(parent), agentKey,
    sessionId: `90000000-0000-4000-8000-00000000000${index + 1}` }))
  config.routes = config.members.map(member => ({ ...config.routes[0], memberKey: member.agentKey }))
  config.subagents.templates = [false, true].map(write => ({ ...child, templateKey: write ? 'writer' : 'reader', capabilities,
    tools: { ...tools, write }, profile: { ...child.profile, toolNames: write ? ['read_text', 'write_text'] : ['read_text'] },
    spec: { ...child.spec, toolNames: write ? ['read_text', 'write_text'] : ['read_text'], budget: grant } }))
  config.subagents.parents = config.members.map(member => ({ ...config.subagents.parents[0], agentKey: member.agentKey, capabilities,
    templates: [{ templateKey: 'reader', templateVersion: 1 }, { templateKey: 'writer', templateVersion: 1 }], maxGrant: grant }))
  config.subagents.workspaceResources = [{ resourceId: 'research-files', rootPath: workspace, mode: 'exclusive-write',
    protectedRoots: [], readPrefixes: ['out'], writePrefixes: ['out'], maxBaselineFiles: 8, maxBaselineBytes: 8192 }]
  const spec = h.resolveHostConfig(h.decodeHostConfig(config, storage))
  await h.initializeHost(spec, { clock })
  const calls = new Map(); let writerProviders = 0
  host = await h.openHost(spec, { clock, bindings: { createModelProvider: member => {
    const parent = config.members.some(item => item.agentKey === member.agentKey)
    const writer = parent ? member.agentKey === 'writer' : member.spec.toolNames.includes('write_text')
    if (!parent && writer) writerProviders++
    return new h.ScriptedModelProvider({ ...member.model, script: async function* () {
      const call = calls.get(member.agentKey) ?? 0; calls.set(member.agentKey, call + 1)
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'workspace' }
      if (parent && (call === 0 || writer && call === 2)) yield* action('agent_spawn_subagent', { ...delegationRequest(),
        templateKey: writer ? 'writer' : 'reader', requestedBudget: grant, workspace: { kind: writer ? 'exclusive-write' : 'shared-read',
          resourceId: 'research-files', readFiles: ['out/evidence.txt'], writePrefixes: writer ? ['out'] : [] } })
      else if (parent && !writer) yield* action('agent_ask_user', { question: 'Keep this read lease until reviewed?', timeoutMs: 60000 })
      else if (!parent && call === 0) yield* action(writer ? 'write_text' : 'read_text', writer
        ? { path: 'out/result.txt', text: 'verified output' } : { path: 'out/evidence.txt' })
      else if (!parent && !writer) yield* action('agent_ask_parent', { question: 'Evidence read; keep the lease?', timeoutMs: 60000 })
      else yield* final(parent ? 'Writer request settled.' : 'Created the verified file.')
    } })
  } } })
  for (const member of config.members) await host.submitTask(member.agentKey, 'Use the bounded workspace')
  await host.run()
  assert.equal(host.delegationReport().count, 2)
  assert.equal(host.delegationReport().active, 2)
  assert.equal(writerProviders, 0)
  await assert.rejects(readFile(join(workspace, 'out/result.txt')), { code: 'ENOENT' })
  for (const relation of host.delegationReport().delegations) await host.cancel(relation.parentKey, relation.parentRoot)
  await host.run()
  assert.equal(host.delegationReport().unresolved, 0)
  await host.submitTask('writer', 'Create after both readers have released')
  await host.run()
  assert.equal(writerProviders, 1)
  assert.equal(host.delegationReport().unresolved, 0)
  assert.equal(await readFile(join(workspace, 'out/result.txt'), 'utf8'), 'verified output')
  process.stdout.write(JSON.stringify({ example: 'subagent-workspace', sharedReaders: 2, conflictingWriterAcquisitions: 0, laterWriterAcquisitions: writerProviders, contentVerified: true }) + '\n')
} finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
