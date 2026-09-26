import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceWorkflowHost } from './workspace-fixture.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { SessionRepository } from '../../src/session/repository.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { parseSessionId } from '../../src/session/ids.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'

it('retries a known delivery failure in the next declared directory and preserves the earlier written file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-retry-file-')), workspace = join(root, 'work')
  try {
    for (const path of ['in', 'out/attempt-1', 'out/attempt-2']) await mkdir(join(workspace, path), { recursive: true })
    await writeFile(join(workspace, 'in/source.txt'), 'fixed source')
    const base = workspaceWorkflowHost(join(root, 'sessions'), workspace)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
    const entry = base.workflows.definitions[0]!, node = entry.definition.nodes[0]!
    if (node.output.kind !== 'json') throw new Error('json output fixture')
    const next = { ...node.attempts[0]!, workspace: { kind: 'exclusive-write', resourceId: 'files', readFiles: ['in/source.txt'], writePrefixes: ['out/attempt-2'] } }
    const candidate = { ...entry.definition, budget: { ...entry.definition.budget, models: 6, steps: 6, tools: 2, outputTokens: 1536 },
      limits: { ...entry.definition.limits, maxProtocolMessages: 18 }, nodes: [{ ...node, attempts: [node.attempts[0], next],
        output: { ...node.output, artifacts: [{ name: 'written', source: { kind: 'write-text', paths: ['out/attempt-1/result.txt', 'out/attempt-2/result.txt'] } }] } }, entry.definition.nodes[1]] }
    expect(() => decodeWorkflowDefinition({ ...candidate, nodes: [{ ...candidate.nodes[0], output: node.output }, candidate.nodes[1]] }))
      .toThrow('artifact-attempt-path-count')
    const definition = decodeWorkflowDefinition(candidate)
    const spec = { ...base, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    await initializeHost(spec)
    let calls = 0
    const host = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission) {
        const writer = member.agentKey === 'writer'
        if (writer) calls++
        if (writer && calls === 3) {
          expect(JSON.stringify(submission.request)).toContain('out/attempt-2/result.txt')
          expect(JSON.stringify(submission.request)).not.toContain('out/attempt-1/result.txt')
        }
        yield { kind: 'message-start', responseId: 'file-attempt', reportedModel: member.spec.target.model }
        if (writer && calls % 2 === 1) {
          const attempt = calls === 1 ? 1 : 2
          yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'write_text', callId: 'write' }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ path: `out/attempt-${attempt}/result.txt`, text: `attempt ${attempt} bytes` }) }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          yield { kind: 'block-start', index: 0, block: 'text' }
          yield { kind: 'text-delta', index: 0, text: !writer ? 'final report' : calls === 2 ? 'invalid output' : '{"text":"second attempt"}' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } }) } })
    try {
      const workflow = host.workflow('research')
      await workflow.resume({ requestKey: 'write' }); await host.run()
      expect(workflow.report()).toMatchObject({ state: 'retry-awaiting-decision', counts: { assignments: 1 } })
      expect(await readFile(join(workspace, 'out/attempt-1/result.txt'), 'utf8')).toBe('attempt 1 bytes')
      await workflow.retry({ requestKey: 'write-again', nodeKey: 'read', failedAssignment: workflow.report().assignments[0]!.ref })
      await host.run()
      expect(workflow.report()).toMatchObject({ state: 'completed', closed: true, reservedBudget: { models: 6, tools: 2 } })
      expect(await readFile(join(workspace, 'out/attempt-1/result.txt'), 'utf8')).toBe('attempt 1 bytes')
      expect(await readFile(join(workspace, 'out/attempt-2/result.txt'), 'utf8')).toBe('attempt 2 bytes')
    } finally { await host.shutdown() }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const state = projectWorkflowSession(await repository.read(parseSessionId(entry.sessionId)))
      expect(state.proposals[0]?.payload.message.artifacts).toHaveLength(0)
      expect(state.proposals[1]?.payload.message.artifacts[0]?.value).toMatchObject({ text: 'attempt 2 bytes', source: { kind: 'write-text' } })
    } finally { await repository.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)
