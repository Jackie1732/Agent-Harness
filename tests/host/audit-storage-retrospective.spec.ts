import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import { FileSessionBackend, SessionRepository, adoptEmptyHostMember, decodeHostConfig,
  hostRuntimeEventCatalog, initializeHost, parseSessionId, resolveHostConfig, runHostCli,
  sessionLogPosition } from '../../src/index.js'
import { hostConfig, hostSessionId } from './fixtures.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'host-storage-retrospective-'))
  roots.push(root)
  return root
}

function repository(root: string) {
  return new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: 1048576 }),
    catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
}

function streams() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  stdout.resume(); stderr.resume(); stdin.end()
  return { stdin, stdout, stderr }
}

it('requires an existing Header for empty adoption without creating the missing member', async () => {
  const root = await temporaryRoot(), source = repository(join(root, 'source'))
  let header
  try { header = (await source.create({ sessionId: parseSessionId(hostSessionId) })).header }
  finally { await source.dispose() }
  const target = join(root, 'target'), spec = resolveHostConfig(decodeHostConfig(hostConfig(target), root))
  await expect(adoptEmptyHostMember(spec, 'writer', { predecessorStopped: true, expectedHeader: header }))
    .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  await expect(access(join(target, 'sessions', hostSessionId))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(initializeHost(spec)).resolves.toMatchObject([{ mode: 'initialized' }])
})

it('checks the complete empty Header and preserves the original log on a mismatch', async () => {
  const root = await temporaryRoot(), source = repository(root)
  let header
  try { header = (await source.create({ sessionId: parseSessionId(hostSessionId) })).header }
  finally { await source.dispose() }
  const path = join(root, 'sessions', hostSessionId, 'events.log'), before = await readFile(path)
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(root), root))
  const different = { ...header, createdAt: new Date(Date.parse(header.createdAt) + 1000).toISOString() }
  await expect(adoptEmptyHostMember(spec, 'writer', { predecessorStopped: true, expectedHeader: different }))
    .rejects.toMatchObject({ code: 'HOST_BOOTSTRAP_AMBIGUOUS' })
  expect(await readFile(path)).toEqual(before)
  await expect(adoptEmptyHostMember(spec, 'writer', { predecessorStopped: true, expectedHeader: header }))
    .resolves.toMatchObject({ mode: 'initialized' })
})

it('leaves a planned prefix to explicit init resume instead of treating it as an empty Session', async () => {
  const root = await temporaryRoot(), original = join(root, 'original'), target = join(root, 'target')
  await initializeHost(resolveHostConfig(decodeHostConfig(hostConfig(original), root)))
  const source = repository(original)
  let snapshot
  try { snapshot = await source.read(parseSessionId(hostSessionId)) }
  finally { await source.dispose() }
  const backend = new FileSessionBackend({ root: target, maxRecordBytes: 1048576 })
  try {
    await backend.create(snapshot.header)
    const writer = await backend.openWriter(snapshot.header.sessionId)
    try { await writer.append(sessionLogPosition(0), snapshot.history.at(-1)!.events[0]!.stored) }
    finally { await writer.dispose() }
  } finally { await backend.dispose() }
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(target), root))
  const path = join(target, 'sessions', hostSessionId, 'events.log'), before = await readFile(path)
  await expect(adoptEmptyHostMember(spec, 'writer', { predecessorStopped: true, expectedHeader: snapshot.header }))
    .rejects.toMatchObject({ code: 'HOST_BOOTSTRAP_AMBIGUOUS' })
  expect(await readFile(path)).toEqual(before)
  await expect(initializeHost(spec, { resume: true })).resolves.toMatchObject([{ mode: 'initialized' }])
  await expect(initializeHost(spec)).resolves.toMatchObject([{ mode: 'existing' }])
})

it('rejects repeated CLI empty adoption after setup while ordinary init still returns existing', async () => {
  const root = await temporaryRoot(), target = join(root, 'target'), source = repository(target)
  let header
  try { header = (await source.create({ sessionId: parseSessionId(hostSessionId) })).header }
  finally { await source.dispose() }
  const configPath = join(root, 'host.json')
  await writeFile(configPath, JSON.stringify(hostConfig(target)))
  const args = ['adopt-empty', '--config', configPath, '--agent-key', 'writer',
    '--predecessor-stopped', '--expected-header', JSON.stringify(header)]
  expect(await runHostCli(args, streams())).toBe(0)
  const path = join(target, 'sessions', hostSessionId, 'events.log'), before = await readFile(path)
  await expect(runHostCli(args, streams())).rejects.toMatchObject({ code: 'HOST_BOOTSTRAP_AMBIGUOUS' })
  expect(await readFile(path)).toEqual(before)
  expect(await runHostCli(['init', '--config', configPath], streams())).toBe(0)
  expect(await readFile(path)).toEqual(before)
})

it.each(['init', 'adopt', 'adopt-empty'] as const)('refuses a Fork before %s can append a Host binding', async operation => {
  const root = await temporaryRoot(), source = new SessionRepository({
    backend: new FileSessionBackend({ root, maxRecordBytes: 1048576 }),
    catalog: hostRuntimeEventCatalog, maxLineageDepth: 4,
    identitySource: { nextSessionId: () => parseSessionId(hostSessionId) },
  })
  let header
  try {
    const parent = await source.create({ sessionId: parseSessionId('70000000-0000-4000-8000-000000000199') })
    header = (await source.fork(parent.header.sessionId)).header
  } finally { await source.dispose() }
  const config = hostConfig(root), member = (config.members as readonly Record<string, unknown>[])[0]!
  const spec = resolveHostConfig(decodeHostConfig({ ...config,
    members: [{ ...member, mode: operation === 'adopt' ? 'adopt' : 'create' }] }, root))
  const path = join(root, 'sessions', hostSessionId, 'events.log'), before = await readFile(path)
  const attempt = operation === 'adopt-empty'
    ? adoptEmptyHostMember(spec, 'writer', { predecessorStopped: true, expectedHeader: header })
    : initializeHost(spec, { resume: true })
  await expect(attempt).rejects.toMatchObject({ code: 'HOST_BINDING_CONFLICT', message: 'fork-session-not-supported' })
  expect(await readFile(path)).toEqual(before)
})
