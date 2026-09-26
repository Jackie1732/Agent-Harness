import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import type { SessionHeader, StoredSessionEvent } from '../../src/session/types.js'
import { encodeFrame } from '../../src/session/frame.js'
import { encodeSessionHeader, encodeStoredSessionEvent } from '../../src/session/codec.js'

export type FileTraceEntry = { readonly kind: 'header'; readonly header: SessionHeader } | { readonly kind: 'event'; readonly event: StoredSessionEvent }

/** Record actual commits before their callers can publish dependent cross-Session operations. */
export async function captureWorkflowTrace(operation: () => Promise<void>): Promise<FileTraceEntry[]> {
  const trace: FileTraceEntry[] = []
  const create = FileSessionBackend.prototype.create, open = FileSessionBackend.prototype.openWriter
  FileSessionBackend.prototype.create = async function (header) {
    await create.call(this, header); trace.push({ kind: 'header', header })
  }
  FileSessionBackend.prototype.openWriter = async function (id) {
    const writer = await open.call(this, id)
    return { header: writer.header, readCommitted: () => writer.readCommitted(), dispose: () => writer.dispose(),
      append: async (position, event) => { const next = await writer.append(position, event); trace.push({ kind: 'event', event }); return next } }
  }
  try { await operation(); return trace }
  finally { FileSessionBackend.prototype.create = create; FileSessionBackend.prototype.openWriter = open }
}

/** Seed only complete recorded frames into an isolated file root, preserving each Session's identity and sequence. */
export async function seedWorkflowTrace(root: string, trace: readonly FileTraceEntry[]): Promise<void> {
  for (const frame of trace) {
    if (frame.kind !== 'header') continue
    const path = join(root, 'sessions', frame.header.sessionId)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'header.frame'), encodeFrame(encodeSessionHeader(frame.header), 65536))
    const events = trace.filter((item): item is Extract<FileTraceEntry, { kind: 'event' }> => item.kind === 'event' && item.event.sessionId === frame.header.sessionId)
    await writeFile(join(path, 'events.log'), Buffer.concat(events.map(item => encodeFrame(encodeStoredSessionEvent(item.event), 1048576))))
  }
}
