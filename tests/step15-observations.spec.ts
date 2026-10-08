import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildOperatorProfile } from '../src/operator/profile.js'
import { openOperatorSession } from '../src/operator/session.js'
import { followOperatorEvents, watchOperatorObservation } from '../src/operator/observations.js'
import { initializeHost } from '../src/host/initialization.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import type { SessionEventPage } from '../src/protocol/index.js'
import { hostConfig } from './host/fixtures.js'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'step15-events-')), profilePath = join(directory, 'operator.json')
  const hostPath = join(directory, 'host.json'), host = hostConfig(join(directory, 'store'))
  await initializeHost(resolveHostConfig(decodeHostConfig(host, directory)))
  await writeFile(hostPath, JSON.stringify(host))
  const profile = buildOperatorProfile({ kind: 'local', hostConfig: hostPath, shutdownMode: 'drain' })
  await writeFile(profilePath, JSON.stringify({ ...profile, observation: { ...profile.observation, pollIntervalMs: 1 } }))
  return { directory, profilePath }
}

it('exhausts a fixed cut, acknowledges only consumed pages and restores the checkpoint after reconnect', async () => {
  const f = await fixture()
  let session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    await session.submit({ agentKey: 'writer', text: 'first', submissionKey: 'first' })
    const abort = new AbortController(), pages: SessionEventPage[] = []
    const summary = await followOperatorEvents(session, { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 1 }, async result => {
      const page = result.result as SessionEventPage; pages.push(page)
      if (pages.length === 1) await session.submit({ agentKey: 'writer', text: 'future', submissionKey: 'future' })
      if (pages.length > 1 && page.through > pages[0]!.through && !page.hasMore) abort.abort()
    }, { signal: abort.signal })
    const firstCut = pages[0]!.through, oldPages = pages.filter(page => page.through === firstCut)
    expect(oldPages.at(-1)?.hasMore).toBe(false)
    expect(oldPages.flatMap(page => page.events).map(event => event.sequence)).toEqual(Array.from({ length: firstCut }, (_, index) => index + 1))
    expect(summary.stoppedBy).toBe('signal')
    expect(session.eventCheckpoint(summary.lastSessionId!)).toBe(pages.at(-1)!.through)
    expect(session.intents().every(intent => intent.method !== 'host.run')).toBe(true)
    await session.close()
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    await session.submit({ agentKey: 'writer', text: 'reconnected', submissionKey: 'reconnected' })
    const nextAbort = new AbortController(), nextPages: SessionEventPage[] = []
    await followOperatorEvents(session, { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 1 }, result => {
      nextPages.push(result.result as SessionEventPage); nextAbort.abort()
    }, { signal: nextAbort.signal })
    expect(nextPages[0]!.events[0]!.sequence).toBe(pages.at(-1)!.through + 1)
  } finally { await session.close(); await rm(f.directory, { recursive: true, force: true }) }
})

it('does not advance a checkpoint when the output consumer fails', async () => {
  const f = await fixture(), session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    const summary = await followOperatorEvents(session, { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 1 }, () => { throw new Error('closed output') })
    expect(summary).toMatchObject({ pages: 0, events: 0, lastSessionId: null, lastSequence: null, stoppedBy: 'output-failure' })
  } finally { await session.close(); await rm(f.directory, { recursive: true, force: true }) }
})

it('serializes observation and consumer settlement, and aborts the owned observer without a Run', async () => {
  const f = await fixture(), session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  let entered!: () => void, release!: () => void
  const seen = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const observer = watchOperatorObservation(session, 'host.status', {}, async () => { calls++; entered(); await gate })
  try {
    await seen
    const closing = observer.dispose(); expect(calls).toBe(1)
    release(); await closing
    expect(calls).toBe(1)
    expect(session.intents()).toHaveLength(0)
  } finally { release(); await observer.dispose(); await session.close(); await rm(f.directory, { recursive: true, force: true }) }
})
