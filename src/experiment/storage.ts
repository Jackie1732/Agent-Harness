import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { EffectOwner } from '../effect/owner.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import { acquireHostStorageLock, unlockHostStorage } from '../host/storage-lock.js'
import { FileSessionBackend } from '../session/file-backend.js'
import { SessionRepository } from '../session/repository.js'
import { parseSessionId } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import type { ExperimentFileRef, ExperimentLocation, ExperimentPlan } from './definition-types.js'
import type { ExperimentJournalSnapshot } from './journal-types.js'
import { ExperimentError } from './errors.js'
import { ExperimentJournal } from './journal.js'
import { experimentEventCatalog, preflightExperimentRecordBudget } from './journal-events.js'
import { projectExperimentJournal } from './journal-projection.js'
import { experimentBytesDigest, experimentDigest, experimentInteger, experimentKeys, experimentObject, experimentRelativePath, experimentText } from './parsing.js'
import { parseBoundedJson } from '../schema/bounded-json.js'
import { canonicalExperimentPath } from './materials.js'

/** Locked write ownership for the Journal and its experiment-controlled files. */
export interface ExperimentStorage {
  readonly location: ExperimentLocation
  readonly journal: ExperimentJournal
  readonly lockToken: string
  dispose(): Promise<void>
}
export type ExperimentStorageRead = { readonly kind: 'uninitialized'; readonly location: ExperimentLocation | null; readonly snapshot: null; readonly state: null }
  | { readonly kind: 'initialized'; readonly location: ExperimentLocation; readonly snapshot: SessionSnapshot; readonly state: ExperimentJournalSnapshot }

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause }
}
/** Read a fixed file without creating its parent or following an unexpected symlink. */
export async function readExperimentFile(path: string, maximum: number): Promise<Uint8Array> {
  const information = await lstat(path)
  if (!information.isFile() || information.isSymbolicLink()) throw new ExperimentError('EXPERIMENT_EVIDENCE_INCOMPLETE', 'experiment-file-not-regular')
  if (information.size > maximum) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'experiment-file-bytes-limit')
  const handle = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(information.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    if (offset > information.size) throw new ExperimentError('EXPERIMENT_CONFLICT', 'experiment-file-changed-during-read')
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}

/** Atomically publish immutable bytes; an existing complete equal file is adopted, never overwritten. */
export async function publishExperimentFile(rootInput: string, relativePath: string, bytes: Uint8Array, maximum: number): Promise<ExperimentFileRef> {
  const path = experimentRelativePath(relativePath, 'publish-path')
  if (bytes.byteLength > maximum) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'published-file-bytes-limit')
  const root = await realpath(rootInput)
  const destination = join(root, path)
  const plannedParent = await canonicalExperimentPath(dirname(destination))
  const parentPart = relative(root, plannedParent)
  if (isAbsolute(parentPart) || parentPart === '..' || parentPart.startsWith(`..${sep}`)) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'published-directory-escapes-root')
  await mkdir(plannedParent, { recursive: true })
  const parent = await realpath(dirname(destination))
  const part = relative(root, parent)
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'published-directory-escapes-root')
  const sha256 = experimentBytesDigest(bytes)
  const temporary = join(parent, `.publish-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  try {
    try { await link(temporary, destination) }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      const prior = await readExperimentFile(destination, maximum)
      if (prior.byteLength !== bytes.byteLength || experimentBytesDigest(prior) !== sha256) throw new ExperimentError('EXPERIMENT_CONFLICT', 'published-file-content-changed')
    }
  } finally { await unlink(temporary) }
  return Object.freeze({ path, sha256, byteLength: bytes.byteLength })
}

function locationFor(plan: ExperimentPlan): ExperimentLocation {
  return Object.freeze({ version: 1, controlRoot: plan.storage.controlRoot, journalSessionId: plan.journalSessionId,
    maxRecordBytes: plan.storage.maxRecordBytes, planDigest: plan.planDigest })
}
/** Read the bootstrap; a missing file denotes uninitialized storage and never creates a directory. */
export async function readExperimentBootstrap(controlRoot: string): Promise<ExperimentLocation | null> {
  const root = resolve(controlRoot)
  const bootstrap = join(root, 'experiment.json')
  if (!await exists(bootstrap)) return null
  const bytes = await readExperimentFile(bootstrap, 16384)
  const data = experimentObject(parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { maxBytes: 16384, maxDepth: 2, maxNodes: 32 }), 'bootstrap')
  experimentKeys(data, ['version', 'controlRoot', 'journalSessionId', 'maxRecordBytes', 'planDigest'], 'bootstrap')
  if (data.version !== 1 || resolve(experimentText(data.controlRoot, 'bootstrap-root')) !== root) throw new ExperimentError('EXPERIMENT_CONFLICT', 'bootstrap-location-mismatch')
  return Object.freeze({ version: 1, controlRoot: root, journalSessionId: parseSessionId(experimentText(data.journalSessionId, 'bootstrap-sessionId', 36)),
    maxRecordBytes: experimentInteger(data.maxRecordBytes, 'bootstrap-maxRecordBytes', 4096), planDigest: experimentDigest(data.planDigest, 'bootstrap-planDigest') })
}

/** Read the Journal while an existing controller may own its lock; no Writer or root marker is acquired. */
export async function readExperimentStorage(input: string | ExperimentLocation): Promise<ExperimentStorageRead> {
  const location = await readExperimentBootstrap(typeof input === 'string' ? input : input.controlRoot)
  if (location === null) return { kind: 'uninitialized', location: null, snapshot: null, state: null }
  const journalRoot = join(location.controlRoot, 'journal-store')
  const sessionRoot = join(journalRoot, 'sessions', location.journalSessionId)
  if (!await exists(join(sessionRoot, 'header.frame')) || !await exists(join(sessionRoot, 'events.log'))) return { kind: 'uninitialized', location, snapshot: null, state: null }
  const repository = new SessionRepository({ backend: new FileSessionBackend({ root: journalRoot, maxRecordBytes: location.maxRecordBytes }), catalog: experimentEventCatalog, maxLineageDepth: 0 })
  try {
    const snapshot = await repository.read(location.journalSessionId)
    const state = projectExperimentJournal(snapshot)
    if (state.plan === null) return { kind: 'uninitialized', location, snapshot: null, state: null }
    if (state.plan.planDigest !== location.planDigest) throw new ExperimentError('EXPERIMENT_CONFLICT', 'bootstrap-plan-digest-mismatch')
    return { kind: 'initialized', location, snapshot, state }
  } finally { await repository.dispose() }
}

/** Create a bootstrap and frozen inputs under one control-root lock, then durably admit the plan. */
export async function createExperimentStorage(plan: ExperimentPlan): Promise<ExperimentStorage> {
  preflightExperimentRecordBudget(plan)
  const owner = new EffectOwner('Experiment storage')
  const lease = await owner.run('Create experiment', async context => {
    const lock = await context.apply('Control-root ownership', () => acquireHostStorageLock(plan.storage.controlRoot, `experiment:${plan.experimentKey}`), value => value.dispose())
    if (lock.root !== plan.storage.controlRoot) throw new ExperimentError('EXPERIMENT_CONFLICT', 'planned-control-root-changed')
    const location = locationFor(plan)
    await publishExperimentFile(lock.root, 'experiment.json', canonicalJsonBytes(location as unknown as JsonValue), 16384)
    for (const item of plan.dataset.cases) for (const material of item.materials) {
      await publishExperimentFile(lock.root, `inputs/${item.caseKey}/${material.logicalPath}`, Buffer.from(material.text), plan.evidenceLimits.maxInputBytes)
    }
    const repository = await context.apply('Journal Repository', () => new SessionRepository({ backend: new FileSessionBackend({ root: join(lock.root, 'journal-store'), maxRecordBytes: location.maxRecordBytes }), catalog: experimentEventCatalog, maxLineageDepth: 0 }), value => value.dispose())
    const headerPath = join(lock.root, 'journal-store', 'sessions', plan.journalSessionId, 'header.frame')
    const handle = await exists(headerPath) ? await repository.open(plan.journalSessionId) : await repository.create({ sessionId: plan.journalSessionId })
    const journal = await context.apply('Journal admission', () => new ExperimentJournal(handle), value => value.dispose())
    await journal.recordPlan(plan)
    return { location, journal, lockToken: lock.record.token }
  })
  return Object.freeze({ ...lease.value, dispose: () => owner.dispose() })
}

/** Open existing metadata for a deliberate write operation, optionally removing one confirmed residual marker. */
export async function openExperimentStorage(input: string | ExperimentLocation,
  options: { readonly predecessorStopped?: true; readonly expectedToken?: string } = {}): Promise<ExperimentStorage> {
  const location = await readExperimentBootstrap(typeof input === 'string' ? input : input.controlRoot)
  if (location === null) throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'experiment-uninitialized')
  if (options.expectedToken !== undefined) {
    if (options.predecessorStopped !== true) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'predecessor-stop-confirmation-required')
    await unlockHostStorage(location.controlRoot, { predecessorStopped: true, expectedToken: options.expectedToken })
  }
  const owner = new EffectOwner('Experiment storage')
  const lease = await owner.run('Open experiment', async context => {
    const lock = await context.apply('Control-root ownership', () => acquireHostStorageLock(location.controlRoot, 'experiment'), value => value.dispose())
    const headerPath = join(location.controlRoot, 'journal-store', 'sessions', location.journalSessionId, 'header.frame')
    if (!await exists(headerPath)) throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'journal-uninitialized')
    const repository = await context.apply('Journal Repository', () => new SessionRepository({ backend: new FileSessionBackend({ root: join(lock.root, 'journal-store'), maxRecordBytes: location.maxRecordBytes }), catalog: experimentEventCatalog, maxLineageDepth: 0 }), value => value.dispose())
    const journal = await context.apply('Journal admission', async () => new ExperimentJournal(await repository.open(location.journalSessionId)), value => value.dispose())
    if (journal.snapshot().plan?.planDigest !== location.planDigest) throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'journal-plan-not-admitted')
    return { location, journal, lockToken: lock.record.token }
  })
  return Object.freeze({ ...lease.value, dispose: () => owner.dispose() })
}
