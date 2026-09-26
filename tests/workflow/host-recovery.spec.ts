import { beforeAll, afterAll, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runnableWorkflowHost } from './host-fixture.js'
import { captureWorkflowTrace, seedWorkflowTrace } from './file-trace.js'
import type { FileTraceEntry } from './file-trace.js'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { recoverHost } from '../../src/host/recovery.js'
import { SessionRepository } from '../../src/session/repository.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { scanHostInventory } from '../../src/host/inventory.js'
import { prohibitedRecoveryWrites as prohibited, recoveryReferences } from './recovery-fixture.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'

const clock = { now: () => Date.parse('2026-09-26T00:00:00.000Z') }
let trace: FileTraceEntry[], traceRoot: string
beforeAll(async () => {
  traceRoot = await mkdtemp(join(tmpdir(), 'workflow-recovery-trace-'))
  trace = await captureWorkflowTrace(async () => {
    const spec = runnableWorkflowHost(traceRoot)
    await initializeHost(spec, { clock })
    const host = await openHost(spec, { clock })
    try { await host.workflow('research').resume({ requestKey: 'start' }); await host.run(); expect(host.workflow('research').report().closed).toBe(true) }
    finally { await host.shutdown({ mode: 'drain' }) }
  })
}, 30000)
afterAll(async () => { await rm(traceRoot, { recursive: true, force: true }) })

const options = { predecessorStopped: true as const, maxRecoveryWrites: 64, maxJournalConflicts: 4, clock }
const references = (root: string) => recoveryReferences(runnableWorkflowHost(root))

it.each(['workflow/control-requested', 'workflow/assignment-committed', 'workflow/protocol-recorded', 'communication/outbox-accepted',
  'communication/inbox-accepted', 'work/assignment-accepted', 'agent/turn-started', 'model/invocation-prepared', 'model/invocation-started',
  'model/invocation-settled', 'agent/turn-settled', 'work/execution-released', 'artifact/published', 'work/proposal-recorded',
  'workflow/proposal-received', 'workflow/decision-committed'])(
  'recovers the real %s causal prefix with one shared budget and no new execution', async point => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-recovery-cut-'))
    try {
      const position = trace.findIndex(item => item.kind === 'event' && item.event.type === point)
      expect(position).toBeGreaterThan(-1)
      const prefix = trace.slice(0, position + 1)
      await seedWorkflowTrace(root, prefix)
      const spec = runnableWorkflowHost(root)
      let result: Awaited<ReturnType<typeof recoverHost>> = []
      const added = await captureWorkflowTrace(async () => { result = await recoverHost(spec, options) })
      const writes = added.filter(item => item.kind === 'event')
      expect(result.every(item => 'totalWrites' in item.result && item.result.totalWrites === writes.length && item.result.pending.length === 0)).toBe(true)
      expect(writes.every(item => !prohibited.has(item.event.type))).toBe(true)
      // Each recovery acknowledgement can be lost independently; repeat from every real committed prefix.
      for (let index = 1; index <= added.length; index++) {
        const interrupted = await mkdtemp(join(tmpdir(), 'workflow-recovery-again-'))
        try {
          await seedWorkflowTrace(interrupted, [...prefix, ...added.slice(0, index)])
          const refs = await references(interrupted)
          if (Object.values(refs).some(value => value !== null)) await expect(recoverHost(runnableWorkflowHost(interrupted), options)).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
          const resumed = await recoverHost(runnableWorkflowHost(interrupted), { ...options, domainSupersedes: refs })
          expect(resumed.every(item => 'pending' in item.result && item.result.pending.length === 0)).toBe(true)
        } finally { await rm(interrupted, { recursive: true, force: true }) }
      }
      const repeated = await captureWorkflowTrace(async () => { await recoverHost(spec, options) })
      expect(repeated).toEqual([])
      const host = await openHost(spec, { clock })
      try {
        const before = host.report().members.map(member => member.agent.roots.reduce((sum, root) => sum + root.budget.models, 0))
        await host.run()
        expect(host.report().members.map(member => member.agent.roots.reduce((sum, root) => sum + root.budget.models, 0))).toEqual(before)
        await host.workflow('research').resume({ requestKey: 'recover-resume' }); await host.run()
        expect(host.workflow('research').report().closed).toBe(true)
      } finally { await host.shutdown({ mode: 'drain' }) }
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 60000)

it('rejects receiver evidence ahead of sender emission and reports budget exhaustion before execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-invalid-cut-'))
  try {
    const position = trace.findIndex(item => item.kind === 'event' && item.event.type === 'communication/inbox-accepted')
    const prefix = trace.slice(0, position + 1)
    const outgoing = prefix.find(item => item.kind === 'event' && item.event.type === 'communication/outbox-accepted')!
    if (outgoing.kind !== 'event') throw new Error('outbox fixture')
    await seedWorkflowTrace(root, prefix.filter(item => item.kind === 'header' || item.event.sessionId !== outgoing.event.sessionId || item.event.sequence < outgoing.event.sequence))
    await expect(recoverHost(runnableWorkflowHost(root), options)).rejects.toMatchObject({ code: 'WORKFLOW_HISTORY_INVALID', message: 'workflow-inbox-without-emission' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('spends no writes with zero budget and exposes exact unfinished domains', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-recovery-budget-'))
  try {
    const position = trace.findIndex(item => item.kind === 'event' && item.event.type === 'workflow/control-requested')
    await seedWorkflowTrace(root, trace.slice(0, position + 1))
    const result = await recoverHost(runnableWorkflowHost(root), { ...options, maxRecoveryWrites: 0 })
    expect(result.every(item => 'totalWrites' in item.result && item.result.totalWrites === 0 && item.result.pending.some(key => key.startsWith('workflow:')))).toBe(true)
    const repository = new SessionRepository({ backend: new FileSessionBackend(runnableWorkflowHost(root).storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const all = await scanHostInventory(runnableWorkflowHost(root), repository)
      const coordinator = all.find(item => item.history.at(-1)!.events.some(event => event.stored.type === 'workflow/definition-recorded'))!
      expect(projectWorkflowSession(coordinator).controls[0]!.settled).toBeNull()
    } finally { await repository.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reports the unfinished Agent when a small shared budget only settles the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-recovery-partial-'))
  try {
    const position = trace.findIndex(item => item.kind === 'event' && item.event.type === 'model/invocation-started')
    await seedWorkflowTrace(root, trace.slice(0, position + 1))
    const result = await recoverHost(runnableWorkflowHost(root), { ...options, maxRecoveryWrites: 3 })
    expect(result.every(item => 'totalWrites' in item.result && item.result.totalWrites === 3
      && item.result.kind === 'delegation-recovery-pending' && item.result.pending.some(key => key.startsWith('agent:')))).toBe(true)
    const resumed = await recoverHost(runnableWorkflowHost(root), { ...options, domainSupersedes: await references(root) })
    expect(resumed.every(item => 'pending' in item.result && item.result.pending.length === 0)).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
