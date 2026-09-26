import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { parseSessionId } from '../../src/session/ids.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { workspaceWorkflowHost } from './workspace-fixture.js'
import { prepareWorkWorkspace } from '../../src/host/workflow-workspace.js'
import { WorkspaceAuthority } from '../../src/subagent/workspace.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'

it.each(['allow', 'deny'] as const)('uses granted file tools and %s policy, then publishes only confirmed immutable bytes', async decision => {
  const base = await mkdtemp(join(tmpdir(), 'work-files-'))
  const workspace = join(base, 'work')
  try {
    await mkdir(join(workspace, 'out/attempt-1'), { recursive: true })
    await mkdir(join(workspace, 'in')); await writeFile(join(workspace, 'in/source.txt'), 'original input')
    const spec = workspaceWorkflowHost(join(base, 'sessions'), workspace, decision)
    await initializeHost(spec)
    let writerCalls = 0
    const host = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission): AsyncGenerator<ModelFrame> {
        const writer = member.agentKey === 'writer'
        if (writer) {
          writerCalls++
          expect(submission.request.tools.map(tool => tool.name)).toEqual(['write_text'])
        }
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'work-files' }
        if (writer && writerCalls === 1) {
          yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'write', name: 'write_text' }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ path: 'out/attempt-1/result.txt', text: 'verified 文件\n' }) }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          yield { kind: 'block-start', index: 0, block: 'text' }
          yield { kind: 'text-delta', index: 0, text: writer ? '{"text":"accepted upstream"}' : 'final report' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } }) } })
    try {
      await host.workflow('research').resume({ requestKey: 'files' }); await host.run()
      expect(host.workflow('research').report()).toMatchObject({ state: decision === 'allow' ? 'completed' : 'failed', closed: true })
    } finally { await host.shutdown() }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const state = projectWorkflowSession(await repository.read(parseSessionId('87000000-0000-4000-8000-000000000001')))
      expect(state.assignments[0]?.payload.workspaceBaseline?.entries[0]).toMatchObject({ path: 'in/source.txt', byteLength: 14 })
      const candidate = state.proposals[0]!.payload.message
      if (decision === 'allow') {
        expect(await readFile(join(workspace, 'out/attempt-1/result.txt'), 'utf8')).toBe('verified 文件\n')
        await writeFile(join(workspace, 'out/attempt-1/result.txt'), 'external edit')
        expect(candidate.artifacts[0]?.value).toMatchObject({ text: 'verified 文件\n', source: { kind: 'write-text' } })
        const reopened = await openHost(spec)
        try { expect(reopened.workflow('research').readArtifact(candidate.artifacts[0]!.ref).value.text).toBe('verified 文件\n') }
        finally { await reopened.shutdown() }
      } else {
        await expect(readFile(join(workspace, 'out/attempt-1/result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(candidate.value).toMatchObject({ outcome: 'failed', artifacts: [] })
      }
    } finally { await repository.dispose() }
  } finally { await rm(base, { recursive: true, force: true }) }
}, 30000)

it('requires prepared output directories before writing any member or coordinator log', async () => {
  const base = await mkdtemp(join(tmpdir(), 'work-missing-dir-'))
  try {
    const workspace = join(base, 'work'); await mkdir(join(workspace, 'in'), { recursive: true })
    await writeFile(join(workspace, 'in/source.txt'), 'input')
    const spec = workspaceWorkflowHost(join(base, 'sessions'), workspace)
    await expect(initializeHost(spec)).rejects.toThrow()
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try { await expect(repository.read(parseSessionId('70000000-0000-4000-8000-000000000101'))).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' }) }
    finally { await repository.dispose() }
  } finally { await rm(base, { recursive: true, force: true }) }
})

it('rejects changed input bytes on reacquisition and overlapping retry output directories', async () => {
  const base = await mkdtemp(join(tmpdir(), 'work-baseline-'))
  try {
    await mkdir(join(base, 'out/attempt-1'), { recursive: true }); await mkdir(join(base, 'in'))
    await writeFile(join(base, 'in/source.txt'), 'original')
    const spec = workspaceWorkflowHost(join(base, 'sessions'), base)
    if (spec.schemaVersion !== 3 || spec.workflows.kind !== 'enabled') throw new Error('v3 fixture')
    const definition = spec.workflows.definitions[0]!.definition
    const node = definition.nodes[0]!, attempt = node.attempts[0]!
    const member = spec.members[0]!
    if (member.kind !== 'local') throw new Error('local fixture')
    const authority = await WorkspaceAuthority.create(spec.workspaceResources, [], [], { now: () => Date.now() })
    try {
      const first = (await prepareWorkWorkspace(member, attempt, authority))!
      const baseline = await first.baseline(); await first.dispose()
      await writeFile(join(base, 'in/source.txt'), 'modified')
      await expect(prepareWorkWorkspace(member, attempt, authority, baseline))
        .rejects.toMatchObject({ code: 'HOST_BINDING_CONFLICT', message: 'work-baseline-changed' })
      const second = (await prepareWorkWorkspace(member, attempt, authority))!
      await second.dispose()
    } finally { await authority.dispose() }
    expect(() => decodeWorkflowDefinition({ ...definition, nodes: [{ ...node, attempts: [attempt, attempt] }, definition.nodes[1]] }))
      .toThrow('attempt-output-overlap')
  } finally { await rm(base, { recursive: true, force: true }) }
})
