import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileSessionBackend, SessionContext, rebuildAssembly } from '../../src/index.js'
import type { ContextBudgetLimits, SessionBackend } from '../../src/index.js'
import { digest } from '../../src/context/validation.js'
import { AgentJournal } from '../../src/agent/journal.js'
import { agentSessionEventDefinitions, agentSpecRecordedEvent } from '../../src/agent/session-events.js'
import { agentSpec, openStep, clock } from './fixtures.js'
import { repository, profile, emptyMessageCatalog, scriptedModel } from '../context/fixtures.js'

async function memoryFixture(budget: Partial<ContextBudgetLimits>, optional = false, backend?: SessionBackend) {
  const repo = repository(backend, agentSessionEventDefinitions), session = await repo.create()
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog }), provider = scriptedModel()
  const p = profile('generation', { rendererVersion: 'context-neutral/v2' })
  const recorded = await context.recordProfile({ ...p, budget: { ...p.budget, ...budget } })
  const required = await context.recordMemory({ key: 'required', previousEventId: null, text: 'required explicit memory', tags: [], origin: { kind: 'host-authored', originLabel: 'test', relatedTo: [] } })
  const extra = optional ? await context.recordMemory({ key: 'optional', previousEventId: null, text: 'optional memory', tags: [], origin: { kind: 'host-authored', originLabel: 'test', relatedTo: [] } }) : null
  const spec = agentSpec(recorded.stored.eventId, provider, { context: { history: { mode: 'none', maxRoots: 0 }, memory: {
    required: [{ eventId: required.stored.eventId, selector: 'memory' }], query: { requiredTags: [], queryTags: [], topK: optional ? 1 : 0 },
  }, compactions: [] } })
  const journal = new AgentJournal(session, 4, clock), installed = await journal.append(agentSpecRecordedEvent, () => spec)
  const close = async () => { await context.dispose(); await provider.dispose(); await repo.dispose() }
  const opened = await openStep({ repo, session, context, provider, spec, journal, installed, close })
  return { repo, session, context, provider, required, extra, opened, close }
}

it('keeps explicit required Memory when optional Memory allowance is zero', async () => {
  const f = await memoryFixture({ maxMemoryEstimatedTokens: 0 })
  try {
    const built = await f.context.assembleAgent(f.opened.consumer)
    expect(built.kind).toBe('ready')
    if (built.kind !== 'ready') throw new Error('expected ready assembly')
    expect(JSON.stringify(built.request)).toContain('required explicit memory')
    expect(built.committed.payload.budget.memoryEstimatedTokens).toBe(88)
    expect(rebuildAssembly(f.session.snapshot(), built.committed.stored.eventId)).toMatchObject({ kind: 'rebuilt', request: built.request })
  } finally { await f.close() }
})

it('keeps the total request byte limit for explicit required Memory', async () => {
  const f = await memoryFixture({ maxMemoryEstimatedTokens: 0, maxRequestBytes: 512 })
  try {
    const position = f.session.snapshot().localPosition
    expect(await f.context.assembleAgent(f.opened.consumer)).toMatchObject({ kind: 'budget-exceeded', limit: 'request-bytes', available: 512 })
    expect(f.session.snapshot().localPosition).toBe(position)
  } finally { await f.close() }
})

it('keeps the total input-token limit for explicit required Memory', async () => {
  const f = await memoryFixture({ maxMemoryEstimatedTokens: 0, contextWindowTokens: 4400 })
  try {
    const position = f.session.snapshot().localPosition
    expect(await f.context.assembleAgent(f.opened.consumer)).toMatchObject({ kind: 'budget-exceeded', limit: 'input-tokens', available: 48 })
    expect(f.session.snapshot().localPosition).toBe(position)
  } finally { await f.close() }
})

it('preserves optional Memory exclusion while keeping the required pin', async () => {
  const f = await memoryFixture({ maxMemoryEstimatedTokens: 0 }, true)
  try {
    const built = await f.context.assembleAgent(f.opened.consumer)
    if (built.kind !== 'ready') throw new Error('expected ready assembly')
    expect(JSON.stringify(built.request)).toContain('required explicit memory')
    expect(JSON.stringify(built.request)).not.toContain('optional memory')
    expect(built.committed.payload.omitted).toContainEqual({ reference: { eventId: f.extra!.stored.eventId, selector: 'memory' }, reason: 'memory-budget' })
    expect(built.committed.payload.selected.filter(unit => unit.reference.selector === 'memory').map(unit => unit.reference.eventId)).toEqual([f.required.stored.eventId])
    expect(rebuildAssembly(f.session.snapshot(), built.committed.stored.eventId).kind).toBe('rebuilt')
  } finally { await f.close() }
})

it('preserves the archived ready Memory Assembly and rebuilds a persisted cut in an independent process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-agent-context-memory-'))
  const f = await memoryFixture({}, false, new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }))
  let reopened: ReturnType<typeof repository> | undefined
  try {
    const built = await f.context.assembleAgent(f.opened.consumer)
    if (built.kind !== 'ready') throw new Error('expected ready assembly')
    expect(built.committed.payload.requestDigest).toBe('289909cf3b1031b8eb5e0dc897c7187a7b8165b31902cfb1f66b1fe56ea5eb91')
    expect(digest(built.committed.payload)).toBe('9c7beaefb3f5701ba7ca9e8ebf3bd29c1fd34ea030f85712e48674ff3375ada6')
    const id = f.session.header.sessionId, assemblyEventId = built.committed.stored.eventId
    await f.close()
    reopened = repository(new FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }), agentSessionEventDefinitions)
    const snapshot = await reopened.read(id)
    expect(rebuildAssembly(snapshot, assemblyEventId)).toMatchObject({ kind: 'rebuilt', request: built.request })
    const path = join(root, 'snapshot.json')
    await writeFile(path, JSON.stringify({ snapshot, assemblyEventId, requestDigest: built.committed.payload.requestDigest }))
    const child = spawnSync(process.execPath, ['tests/context-replay-child.mjs', path], { cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH } })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toContain('context-replay-child: ok')
  } finally { await reopened?.dispose(); await f.close(); await rm(root, { recursive: true, force: true }) }
})
