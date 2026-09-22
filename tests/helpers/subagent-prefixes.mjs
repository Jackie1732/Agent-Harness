import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as h from '../../dist/index.js'
import { encodeFrame } from '../../dist/session/frame.js'
import { encodeSessionHeader, encodeStoredSessionEvent } from '../../dist/session/codec.js'
import { effectiveResourceRelease } from '../../dist/subagent/resource-evidence.js'

/** Capture commit order below Session publication, including child creation, without changing append outcomes. */
export async function captureFileCommits(operation) {
  const frames = []
  const create = h.FileSessionBackend.prototype.create
  const open = h.FileSessionBackend.prototype.openWriter
  h.FileSessionBackend.prototype.create = async function (header) {
    await create.call(this, header)
    frames.push({ kind: 'header', header })
  }
  h.FileSessionBackend.prototype.openWriter = async function (id) {
    const writer = await open.call(this, id)
    return { header: writer.header, readCommitted: () => writer.readCommitted(), dispose: () => writer.dispose(),
      append: async (position, event) => {
        const next = await writer.append(position, event)
        frames.push({ kind: 'event', event })
        return next
      } }
  }
  try { await operation(); return frames }
  finally { h.FileSessionBackend.prototype.create = create; h.FileSessionBackend.prototype.openWriter = open }
}

function histories(frames) {
  const sessions = new Map()
  for (const frame of frames) {
    if (frame.kind === 'header') sessions.set(frame.header.sessionId, { header: frame.header, events: [] })
    else sessions.get(frame.event.sessionId).events.push(frame.event)
  }
  return sessions
}

async function seed(root, frames) {
  for (const [id, session] of histories(frames)) {
    const directory = join(root, 'sessions', id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'header.frame'), encodeFrame(encodeSessionHeader(session.header), 65536))
    await writeFile(join(directory, 'events.log'), Buffer.concat(session.events.map(event => encodeFrame(encodeStoredSessionEvent(event), 1048576))))
  }
}

async function read(root, config, ids) {
  const repository = new h.SessionRepository({ backend: new h.FileSessionBackend({ root, maxRecordBytes: config.storage.maxRecordBytes }),
    catalog: h.hostRuntimeEventCatalog, maxLineageDepth: config.storage.maxLineageDepth })
  try { return await Promise.all([...ids].map(id => repository.read(id))) }
  finally { await repository.dispose() }
}

function unreconciled(snapshot) {
  const state = h.projectAgentSession(snapshot)
  return state.openRun !== null || state.openTurn !== null || state.openRecovery !== null
    || state.subagents.recoveries.some(item => item.settled === null && item.supersededBy === null)
    || state.subagents.resources.some(item => effectiveResourceRelease(item, state.subagents.recoveries)?.outcome !== 'released')
    || h.projectModelSession(snapshot).pendingInvocationId !== null || h.projectToolSession(snapshot).pendingInvocationId !== null
}

function recoveryReferences(snapshots) {
  const result = {}
  for (const snapshot of snapshots) {
    const state = h.projectAgentSession(snapshot)
    if (state.openRecovery !== null) result[snapshot.header.sessionId + ':agent'] = state.openRecovery
    for (const item of state.subagents.recoveries) if (item.settled === null && item.supersededBy === null) {
      result[snapshot.header.sessionId + ':subagent:' + item.requested.payload.delegation] = item.requested.stored.eventId
    }
  }
  return result
}

function externalIds(snapshot) {
  return snapshot.history.at(-1).events.filter(({ stored: event }) =>
    ['model/invocation-requested', 'model/invocation-prepared', 'model/invocation-started',
      'tool/invocation-requested', 'tool/authorization-decided', 'tool/invocation-started',
      'communication/outbox-accepted', 'communication/inbox-accepted', 'subagent/delegation-requested'].includes(event.type))
    .map(item => item.stored.eventId)
}

async function reconcile(root, config, frames, clock) {
  const spec = h.resolveHostConfig(h.decodeHostConfig({ ...config, storage: { ...config.storage, root } }, root))
  const ids = histories(frames).keys()
  const before = await read(root, config, ids)
  let snapshots = before
  const added = await captureFileCommits(async () => {
    for (let attempt = 0; attempt < 16; attempt++) {
      const report = await h.recoverHost(spec, { predecessorStopped: true, maxRecoveryWrites: 20, maxJournalConflicts: 4,
        clock, domainSupersedes: recoveryReferences(snapshots) })
      assert.ok(report.every(item => item.result.totalWrites <= 20))
      snapshots = await read(root, config, before.map(item => item.header.sessionId))
      if (!snapshots.some(unreconciled)) break
    }
    assert.equal(snapshots.some(unreconciled), false)
  })
  assert.ok(added.every(frame => frame.kind === 'event'), 'recovery cannot create a child')
  for (const original of before) {
    const current = snapshots.find(item => item.header.sessionId === original.header.sessionId)
    assert.deepEqual(externalIds(current), externalIds(original), 'recovery emitted new work')
    const previous = h.projectAgentSession(original); const state = h.projectAgentSession(current)
    for (const old of previous.roots) assert.deepEqual(state.roots.find(item => item.id === old.id).budget, old.budget, 'recovery changed a grant or budget')
    assert.deepEqual(state.subagents.delegations, previous.subagents.delegations)
  }
  return added
}

/** Every chronological cut after CP-D, then every new recovery-write cut, uses fresh real File repositories. */
export async function verifySubagentPrefixes(label, config, frames, clock, startType = 'subagent/delegation-requested') {
  const root = await mkdtemp(join(tmpdir(), 'subagent-prefixes-'))
  const start = frames.findIndex(frame => frame.kind === 'event' && frame.event.type === startType) + 1
  assert.ok(start > 0)
  let recoveryPrefixes = 0
  try {
    for (let cut = start; cut <= frames.length; cut++) {
      const prefix = frames.slice(0, cut)
      const directory = join(root, 'business-' + cut)
      await seed(directory, prefix)
      let added
      try { added = await reconcile(directory, config, prefix, clock) }
      catch (cause) { throw new Error(label + ' business cut ' + cut + ': ' + JSON.stringify(frames[cut - 1]), { cause }) }
      for (let interrupted = 1; interrupted < added.length; interrupted++) {
        const recovered = [...prefix, ...added.slice(0, interrupted)]
        const again = join(root, 'recovery-' + cut + '-' + interrupted)
        await seed(again, recovered)
        try { await reconcile(again, config, recovered, clock) }
        catch (cause) { throw new Error(label + ' recovery cut ' + cut + '/' + interrupted, { cause }) }
        recoveryPrefixes++
      }
      if ((cut - start) % 30 === 0) process.stdout.write(JSON.stringify({ trace: label, checkedThrough: cut, total: frames.length }) + '\n')
    }
    process.stdout.write(JSON.stringify({ trace: label, filePrefixes: frames.length - start + 1, recoveryPrefixes }) + '\n')
  } finally { await rm(root, { recursive: true, force: true }) }
}
