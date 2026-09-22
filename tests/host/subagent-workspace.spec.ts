import { rm, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost, FileSessionBackend, SessionRepository, hostRuntimeEventCatalog, parseSessionId } from '../../src/index.js'
import type { JsonObject } from '../../src/foundation/json.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { subagentHostConfig } from './subagent-fixture.js'
import { hostSessionId } from './fixtures.js'

const clock = { now: () => Date.parse('2026-09-22T00:00:00Z') }

it.each(['single', 'file-limit', 'duplicate-path'] as const)('exports confirmed files and enforces %s before later filesystem execution', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'host-child-write-'))
  const storage = join(root, 'sessions'); const workspace = join(root, 'work')
  await mkdir(join(workspace, 'out'), { recursive: true }); await mkdir(join(workspace, 'in')); await writeFile(join(workspace, 'in/evidence.txt'), 'bounded evidence')
  const raw = await subagentHostConfig(storage)
  const domain = raw.subagents as JsonObject
  const template = (domain.templates as JsonObject[])[0]!
  const grant = { ...((template.spec as JsonObject).budget as JsonObject), models: 3, steps: 3, outputTokens: 768, tools: 2 }
  const rights = { ...(template.capabilities as JsonObject), tools: ['read_text', 'write_text'], workspaces: [{ resourceId: 'research-files', modes: ['exclusive-write'], readPrefixes: ['in'], writePrefixes: ['out'] }] }
  const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
  const toolConfig = { kind: 'workspace-text', read: true, write: true, maxReadBytes: 4096, maxWriteBytes: 4096, maxBaselineFiles: 8, maxBaselineBytes: 8192,
    maxPathBytes: 1024, maxArgumentsBytes: 8192, maxResultBytes: 8192, schemaLimits,
    invocationLimits: { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 8192, maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 } }
  const configured = { ...raw, subagents: { ...domain, templates: [{ ...template, capabilities: rights, tools: toolConfig,
    limits: { ...(template.limits as JsonObject), maxFileEntries: mode === 'file-limit' ? 1 : 8 },
    profile: { ...(template.profile as JsonObject), toolNames: ['read_text', 'write_text'] },
    spec: { ...(template.spec as JsonObject), toolNames: ['read_text', 'write_text'], budget: grant } }],
    parents: (domain.parents as JsonObject[]).map(parent => ({ ...parent, capabilities: rights, maxGrant: grant })),
    workspaceResources: [{ resourceId: 'research-files', rootPath: workspace, mode: 'exclusive-write', protectedRoots: [], readPrefixes: ['in'], writePrefixes: ['out'], maxBaselineFiles: 8, maxBaselineBytes: 8192 }] } }
  const spec = resolveHostConfig(decodeHostConfig(configured, storage))
  await initializeHost(spec, { clock })
  const calls = new Map<string, number>()
  const host = await openHost(spec, { clock, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    script: async function* (submission): AsyncGenerator<ModelFrame> {
      const number = calls.get(member.agentKey) ?? 0; calls.set(member.agentKey, number + 1)
      const parent = member.agentKey === 'writer'
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'work' }
      if (number === 0 || !parent && number === 1 && mode !== 'single') {
        const name = parent ? 'agent_spawn_subagent' : 'write_text'
        const args = parent ? { templateKey: 'research', templateVersion: 1, task: 'Write the verified result', materials: [], requestedBudget: grant,
          workspace: { kind: 'exclusive-write', resourceId: 'research-files', readFiles: ['in/evidence.txt'], writePrefixes: ['out'] } }
          : { path: number === 0 ? 'out/result.txt' : mode === 'file-limit' ? 'out/second.txt' : 'OUT/RESULT.TXT', text: 'verified result' }
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'work', name }
        yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(args) }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } else {
        if (parent) expect(JSON.stringify(submission.request)).toContain('out/result.txt')
        yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: parent ? 'delivery adopted' : 'file ready' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      }
    },
  }) } })
  try {
    await host.submitTask('writer', 'Delegate file creation')
    const run = await host.run()
    expect(run.members[0]?.agent.final, JSON.stringify(run)).toMatchObject({ text: 'delivery adopted' })
    expect(await readFile(join(workspace, 'out/result.txt'), 'utf8')).toBe('verified result')
    await expect(readFile(join(workspace, 'out/second.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await host.dispose() }
  const repository = new SessionRepository({ backend: new FileSessionBackend({ root: storage, maxRecordBytes: spec.storage.maxRecordBytes }), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
  try {
    const parent = projectAgentSession(await repository.read(parseSessionId(hostSessionId)))
    const result = parent.inputs.find(input => input.protocol?.kind === 'result')!.message!
    expect(result.payload).toMatchObject({ files: [{ resourceId: 'research-files', path: 'out/result.txt', byteLength: 15 }], uncertainFiles: [], executionRelease: { outcome: 'released' } })
    const child = projectAgentSession(await repository.read(parent.subagents.delegations[0]!.payload.childSessionId))
    expect(child.subagents.baselines[0]?.payload.baseline.entries).toMatchObject([{ path: 'in/evidence.txt' }])
    expect(child.roots[0]?.budget.tools).toBe(mode === 'single' ? 1 : 2)
  } finally { await repository.dispose(); await rm(root, { recursive: true, force: true }) }
}, 30000)
