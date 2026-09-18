import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as h from '../../dist/index.js'

const definitions = [...h.agentSessionEventDefinitions, ...h.contextSessionEventDefinitions, ...h.modelSessionEventDefinitions, ...h.toolSessionEventDefinitions, ...h.communicationSessionEventDefinitions]
const clock = { now: () => 1789257600000 }

/** Seed committed bytes through the storage interface, then reopen with fresh Reader and Writer objects. */
async function reopen(root, header, records) {
  const backend = new h.FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 })
  await backend.create(header); const writer = await backend.openWriter(header.sessionId)
  let position = h.sessionLogPosition(0)
  for (const event of records) position = await writer.append(position, event)
  await writer.dispose(); await backend.dispose()
  const repository = new h.SessionRepository({ backend: new h.FileSessionBackend({ root, maxRecordBytes: 2 * 1024 * 1024 }), catalog: h.createDurableEventCatalog(definitions), maxLineageDepth: 8, clock })
  return { repository, session: await repository.open(header.sessionId) }
}
function external(records) {
  return records.filter(event => event.type.startsWith('model/') && event.type !== 'model/invocation-settled'
    || ['tool/invocation-requested', 'tool/authorization-decided', 'tool/invocation-started'].includes(event.type)
    || event.type.startsWith('communication/')).map(event => event.eventId)
}
async function reconcile(session) {
  const before = session.snapshot().history.at(-1).events.map(event => event.stored)
  const state = h.projectAgentSession(session.snapshot())
  const result = await h.recoverAgentSession(session, { predecessorStopped: true, supersedes: state.openRecovery,
    maxRecoveryWrites: 100, maxJournalConflicts: 4, clock })
  assert.ok(['recovered', 'nothing-to-recover', 'already-ended'].includes(result.kind))
  const after = session.snapshot().history.at(-1).events.map(event => event.stored)
  assert.deepEqual(external(after), external(before))
  const current = h.projectAgentSession(session.snapshot())
  assert.equal(current.openRun, null); assert.equal(current.openTurn, null); assert.equal(current.openRecovery, null)
  for (const input of state.inputs) if (input.claimedBy !== null) assert.notEqual(current.inputs.find(item => item.reference.eventId === input.reference.eventId).status, 'queued')
  for (const root of state.roots) for (const [kind, amount] of Object.entries(root.budget)) assert.equal(current.roots.find(item => item.id === root.id).budget[kind], amount)
  const position = session.snapshot().localPosition
  await h.recoverAgentSession(session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 100, maxJournalConflicts: 4, clock })
  assert.equal(session.snapshot().localPosition, position)
  return after
}

/** Every persisted prefix, then every interrupted recovery-write prefix, with no execution dependencies. */
export async function verifyAgentPrefixes(label, snapshot) {
  const root = await mkdtemp(join(tmpdir(), 'agent-prefix-'))
  const records = snapshot.history.at(-1).events.map(event => event.stored)
  let recoveryPrefixes = 0
  try {
    for (let length = 0; length <= records.length; length++) {
      const seeded = await reopen(join(root, 'source-' + length), snapshot.header, records.slice(0, length))
      let recovered
      try { recovered = await reconcile(seeded.session) } finally { await seeded.repository.dispose() }
      for (let cut = length + 1; cut < recovered.length; cut++) {
        const interrupted = await reopen(join(root, 'recovery-' + length + '-' + cut), snapshot.header, recovered.slice(0, cut))
        try { await reconcile(interrupted.session); recoveryPrefixes++ } finally { await interrupted.repository.dispose() }
      }
    }
    process.stdout.write(JSON.stringify({ trace: label, filePrefixes: records.length + 1, recoveryPrefixes }) + '\n')
  } finally { await rm(root, { recursive: true, force: true }) }
}
