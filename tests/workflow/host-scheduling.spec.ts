import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runnableWorkflowHost } from './host-fixture.js'
import { workspaceWorkflowHost } from './workspace-fixture.js'
import { delegatedWorkflowHost } from './subagent-fixture.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { assembleHost } from '../../src/host/assembly.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'

it('finishes both independent peers with one admitted batch and one scanned slot per run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-fairness-'))
  try {
    const base = runnableWorkflowHost(directory)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('v3 fixture')
    const entry = base.workflows.definitions[0]!
    const definition = decodeWorkflowDefinition({ ...entry.definition, nodes: entry.definition.nodes.map(node => ({ ...node,
      dependencies: [], inputs: [], inputSchema: entry.definition.nodes[0]!.inputSchema })) })
    const spec = { ...base, scheduling: { ...base.scheduling, maxBatchesPerRun: 1, maxSlotsPerScan: 1 },
      workflows: { ...base.workflows, maxBusinessConcurrency: 2 as const, definitions: [{ ...entry, definition }] } }
    const now = Date.now(), clock = { now: () => now }
    await initializeHost(spec, { clock })
    const host = await openHost(spec, { clock })
    try {
      await host.workflow('research').resume({ requestKey: 'fair' })
      const business: string[] = []
      let acceptedBatches = 0
      for (let run = 0; run < 100 && !host.workflow('research').report().closed; run++) {
        const before = host.report().members.map(member => member.agent.roots.length)
        const report = await host.run()
        expect(report.batches).toBeLessThanOrEqual(1)
        acceptedBatches += report.batches
        report.members.forEach((member, index) => { if (member.agent.roots.length > before[index]!) business.push(member.agentKey) })
      }
      expect(business).toEqual(['writer', 'reviewer'])
      expect(acceptedBatches).toBeLessThan(80)
      expect(host.workflow('research').report()).toMatchObject({ state: 'completed', closed: true, counts: { accepted: 2 } })
    } finally { await host.shutdown({ mode: 'drain' }) }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60000)

it.each(['readonly', 'custom', 'write', 'delegate'] as const)('classifies installed %s work and defers a held write lease without faulting', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-execution-class-'))
  try {
    const storage = join(directory, 'sessions'), workspace = join(directory, 'work')
    if (mode === 'write') {
      await mkdir(join(workspace, 'out/attempt-1'), { recursive: true })
      await mkdir(join(workspace, 'in')); await writeFile(join(workspace, 'in/source.txt'), 'input')
    }
    const spec = mode === 'write' ? workspaceWorkflowHost(storage, workspace)
      : mode === 'delegate' ? await delegatedWorkflowHost(storage) : runnableWorkflowHost(storage)
    const now = Date.now(), clock = { now: () => now }
    await initializeHost(spec, { clock })
    const assembly = await assembleHost(spec, clock, {}, mode === 'custom' ? { createModelProvider: member =>
      new ScriptedModelProvider({ ...member.model, script: async function* () { yield { kind: 'complete', stopReason: 'stop' } } }) } : {})
    try {
      const domain = assembly.workflows!
      expect(domain.businessMode(assembly.slots[0]!)).toBe('exclusive')
      await domain.controls.request('research', 'resume', { requestKey: 'classify' })
      if (mode === 'write') {
        const lease = domain.workspaceAuthority.reserve({ kind: 'exclusive-write', resourceId: 'files',
          readFiles: [], writePrefixes: ['out/attempt-1'] }, 8, 8192)
        expect(domain.nextAction()).toBeUndefined()
        expect(domain.report('research').counts.assignments).toBe(0)
        await lease.dispose()
      }
      for (let action = 0; action < 30 && assembly.slots[0]!.selection?.kind !== 'workflow'; action++) {
        await domain.nextAction()?.()
        for (const slot of assembly.protocolSlots) await slot.dispatcher.dispatch()
        for (const slot of assembly.slots) if (slot.agent.status === 'accepting') await slot.agent.maintain()
      }
      expect(assembly.slots[0]!.selection?.kind).toBe('workflow')
      expect(domain.businessMode(assembly.slots[0]!)).toBe(mode === 'readonly' ? 'readonly' : 'exclusive')
    } finally { await assembly.dispose() }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60000)
