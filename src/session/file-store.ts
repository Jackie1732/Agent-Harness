import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { decodeSessionHeader, decodeStoredSessionEvent, encodeSessionHeader } from './codec.js'
import { SessionError } from './errors.js'
import { encodeFrame, FrameScanner } from './frame.js'
import { formatSessionEventId, parseSessionId, sessionLogPosition } from './ids.js'
import type { SessionId, SessionLogPosition } from './ids.js'
import { SESSION_HEADER_MAX_BYTES } from './types.js'
import type { IncompleteSessionTail, SessionHeader, StoredSessionEvent } from './types.js'

const HEADER_FILE = 'header.frame'
const EVENTS_FILE = 'events.log'
const READ_CHUNK_BYTES = 64 * 1024

/** Canonical root paths owned by one initialized File Backend. */
export interface PreparedFileRoot {
  readonly root: string
  readonly sessions: string
}

/** Verified physical event-log prefix and its final valid byte. */
export interface ScannedFileEvents {
  readonly events: readonly StoredSessionEvent[]
  readonly position: SessionLogPosition
  readonly committedBytes: number
  readonly incompleteTail?: IncompleteSessionTail
}

/** Recognize one Node filesystem error code without depending on platform subclasses. */
export function isNodeError(cause: unknown, code: string): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === code
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (cause) {
    if (isNodeError(cause, 'ENOENT')) return false
    throw cause
  }
}

async function requirePlainDirectory(path: string, label: string): Promise<void> {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new SessionError('SESSION_LOG_INVALID', `${label} must be a non-symlink directory`)
  }
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  let entry
  try {
    entry = await lstat(path)
  } catch (cause) {
    throw new SessionError('SESSION_LOG_INVALID', `${label} is missing`, { cause })
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new SessionError('SESSION_LOG_INVALID', `${label} must be a non-symlink regular file`)
  }
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

/** Initialize and canonicalize a non-symlink File Session root. */
export async function prepareFileRoot(rootInput: string): Promise<PreparedFileRoot> {
  if (!isAbsolute(rootInput)) throw new TypeError('File Session root must be absolute')
  const requested = resolve(rootInput)
  await mkdir(requested, { recursive: true, mode: 0o700 })
  await requirePlainDirectory(requested, 'File Session root')
  const root = await realpath(requested)
  const sessions = join(root, 'sessions')
  await mkdir(sessions, { recursive: true, mode: 0o700 })
  await requirePlainDirectory(sessions, 'File Session directory')
  return Object.freeze({ root, sessions })
}

/** Return the confined directory of one validated Session identity. */
export function fileSessionDirectory(root: PreparedFileRoot, sessionId: SessionId): string {
  parseSessionId(sessionId)
  return join(root.sessions, sessionId)
}

/** Return the append-only event log path of one validated Session identity. */
export function fileSessionLog(root: PreparedFileRoot, sessionId: SessionId): string {
  return join(fileSessionDirectory(root, sessionId), EVENTS_FILE)
}

/** Open a verified non-symlink event log for explicit-position writes. */
export async function openFileSessionLog(path: string): Promise<FileHandle> {
  await requireRegularFile(path, 'Session event log')
  return await open(path, 'r+')
}

/** Write a complete Buffer at one explicit offset, handling partial writes. */
export async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (result.bytesWritten < 1) throw new Error('file write made no progress')
    offset += result.bytesWritten
  }
}

/** Read and strictly verify one fixed-size Header frame. */
export async function readFileSessionHeader(
  root: PreparedFileRoot,
  sessionId: SessionId,
): Promise<SessionHeader> {
  const directory = fileSessionDirectory(root, sessionId)
  try {
    await requirePlainDirectory(directory, 'Session directory')
  } catch (cause) {
    try {
      await lstat(directory)
    } catch (missing) {
      if (isNodeError(missing, 'ENOENT')) {
        throw new SessionError('SESSION_NOT_FOUND', `Session ${sessionId} does not exist`, {
          details: { sessionId },
          cause: missing,
        })
      }
    }
    throw cause
  }
  const path = join(directory, HEADER_FILE)
  await requireRegularFile(path, 'Session Header file')
  const maxFrameBytes = SESSION_HEADER_MAX_BYTES + 96
  const bytes = await readBoundedFile(path, maxFrameBytes)
  if (bytes.byteLength > maxFrameBytes) {
    throw new SessionError('SESSION_LOG_INVALID', 'Session Header file exceeds its fixed byte budget', {
      details: { sessionId, headerBytes: bytes.byteLength },
    })
  }
  const scanner = new FrameScanner(SESSION_HEADER_MAX_BYTES)
  const frames = scanner.push(bytes)
  scanner.finish(false)
  if (frames.length !== 1) {
    throw new SessionError('SESSION_LOG_INVALID', 'Session Header file must contain exactly one frame', {
      details: { sessionId },
    })
  }
  const frame = frames[0]
  if (frame === undefined) throw new Error('verified Header frame is missing')
  const header = decodeSessionHeader(frame.payload)
  if (header.sessionId !== sessionId) {
    throw new SessionError('SESSION_LOG_INVALID', 'Session Header identity differs from its directory', {
      details: { expectedSessionId: sessionId, actualSessionId: header.sessionId },
    })
  }
  return header
}

/** Stream and verify one local event prefix without reading beyond a requested cut. */
export async function scanFileSessionEvents(
  path: string,
  boundary: number,
  maxRecordBytes: number,
  through?: SessionLogPosition,
): Promise<ScannedFileEvents> {
  await requireRegularFile(path, 'Session event log')
  const handle = await open(path, 'r')
  try {
    const scanner = new FrameScanner(maxRecordBytes)
    const events: StoredSessionEvent[] = []
    let offset = 0
    while (offset < boundary) {
      const desired = through === undefined ? Number.POSITIVE_INFINITY : through - events.length
      if (desired === 0) {
        return Object.freeze({
          events: Object.freeze(events),
          position: sessionLogPosition(events.length),
          committedBytes: scanner.finish(true).byteLength,
        })
      }
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, boundary - offset))
      const result = await handle.read(buffer, 0, buffer.byteLength, offset)
      if (result.bytesRead === 0) {
        throw new SessionError('SESSION_LOG_INVALID', 'Session committed boundary exceeds file length', {
          details: { boundary, byteOffset: offset },
        })
      }
      offset += result.bytesRead
      const frames = scanner.push(buffer.subarray(0, result.bytesRead), desired)
      for (const frame of frames) events.push(decodeStoredSessionEvent(frame.payload))
      if (through !== undefined && events.length === through) {
        return Object.freeze({
          events: Object.freeze(events),
          position: sessionLogPosition(events.length),
          committedBytes: frames.at(-1)?.endOffset ?? 0,
        })
      }
    }
    const end = scanner.finish(true)
    if (through !== undefined && events.length < through) {
      throw new SessionError('SESSION_POSITION_INVALID', 'requested prefix exceeds committed events', {
        details: { through, available: events.length },
      })
    }
    return Object.freeze({
      events: Object.freeze(events),
      position: sessionLogPosition(events.length),
      committedBytes: end.byteLength,
      ...(end.incompleteTail === undefined ? {} : { incompleteTail: end.incompleteTail }),
    })
  } finally {
    await handle.close()
  }
}

/** Verify that decoded events form the canonical local sequence of one Session. */
export function validateFileSessionEvents(
  sessionId: SessionId,
  events: readonly StoredSessionEvent[],
): void {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    const expectedSequence = index + 1
    if (
      event.sessionId !== sessionId
      || event.sequence !== expectedSequence
      || event.eventId !== formatSessionEventId(sessionId, event.sequence)
    ) {
      throw new SessionError('SESSION_LOG_INVALID', 'stored event does not match its local Session position', {
        details: { sessionId, eventId: event.eventId, expectedSequence, actualSequence: event.sequence },
      })
    }
  }
}

/** Return the current physical byte length of one Session event log. */
export async function fileSessionLogSize(path: string, sessionId: SessionId): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (cause) {
    if (isNodeError(cause, 'ENOENT')) {
      throw new SessionError('SESSION_LOG_INVALID', `Session ${sessionId} event log is missing`, {
        details: { sessionId },
        cause,
      })
    }
    throw cause
  }
}

/** Atomically publish one complete empty Session directory. */
export async function createFileSession(root: PreparedFileRoot, headerInput: SessionHeader): Promise<void> {
  const header = decodeSessionHeader(encodeSessionHeader(headerInput))
  const finalDirectory = fileSessionDirectory(root, header.sessionId)
  const temporaryDirectory = join(root.sessions, `.create-${header.sessionId}-${randomUUID()}`)
  let temporaryCreated = false
  let published = false
  try {
    await mkdir(temporaryDirectory, { mode: 0o700 })
    temporaryCreated = true
    const headerHandle = await open(join(temporaryDirectory, HEADER_FILE), 'wx', 0o600)
    try {
      await writeAll(headerHandle, encodeFrame(encodeSessionHeader(header), SESSION_HEADER_MAX_BYTES), 0)
      await headerHandle.sync()
    } finally {
      await headerHandle.close()
    }
    const eventHandle = await open(join(temporaryDirectory, EVENTS_FILE), 'wx', 0o600)
    try {
      await eventHandle.sync()
    } finally {
      await eventHandle.close()
    }
    try {
      await rename(temporaryDirectory, finalDirectory)
    } catch (cause) {
      const destinationConflict = isNodeError(cause, 'EEXIST')
        || isNodeError(cause, 'ENOTEMPTY')
        || isNodeError(cause, 'EPERM') && await pathExists(finalDirectory)
      if (destinationConflict) {
        throw new SessionError('SESSION_ALREADY_EXISTS', `Session ${header.sessionId} already exists`, {
          details: { sessionId: header.sessionId },
          cause,
        })
      }
      throw cause
    }
    published = true
  } finally {
    if (temporaryCreated && !published) {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}
