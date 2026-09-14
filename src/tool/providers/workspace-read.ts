import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { JsonValue } from '../../foundation/json.js'
import type { PreparedToolCall, PreparedToolPlan, ToolDefinition, ToolExecution, ToolExecutionResult, ToolInvocationLimits, ToolProvider, ToolProviderDescriptor, ToolSchemaLimits } from '../contract.js'
import { createToolDefinition } from '../definition.js'
import { ToolError } from '../errors.js'
import { createPreparedToolPlan } from '../plan.js'
import { equalJson, exact, integer, jsonBytes, object, readDescriptor, readLimits, readSchemaLimits, safeCode, text } from '../validation.js'
import { workspaceRelativePath } from '../workspace-path.js'
import { ToolExecutionPool } from './pool.js'
import { nodeWorkspaceIO } from './workspace-io.js'
import type { WorkspaceFileIO } from './workspace-io.js'

export interface WorkspaceReadTextOptions {
  readonly rootId: string
  /** Explicit trusted workspace; never inferred from cwd, home, or environment variables. */
  readonly rootPath: string
  /** Explicit configured Session/credential roots. Empty means none were supplied, not no secrets exist. */
  readonly protectedRoots: readonly string[]
  readonly maxReadBytes: number
  readonly maxPathBytes: number
  readonly maxArgumentsBytes: number
  readonly maxResultBytes: number
  readonly schemaLimits: ToolSchemaLimits
}

/** The exact advertised schema and description of the implemented native read-only operation. */
export function createReadTextDefinition(limits: ToolSchemaLimits): ToolDefinition {
  return createToolDefinition({ name: 'read_text', version: 1,
    description: 'Read one complete UTF-8 text file from an authorized logical workspace. Input is a portable relative path. Oversized, linked, changed, or non-text files fail; no truncation is returned as success.',
    operationClass: 'read-only',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {
      path: { type: 'string' }, text: { type: 'string' }, byteLength: { type: 'integer' }, sha256: { type: 'string' },
    }, required: ['path', 'text', 'byteLength', 'sha256'], additionalProperties: false },
  }, limits)
}

/**
 * Construct a capacity-one reader for a cooperative trusted workspace. This is not an OS
 * sandbox, transactional snapshot, or protection against hostile concurrent path replacement.
 */
export async function createWorkspaceReadTextProvider(options: WorkspaceReadTextOptions): Promise<ToolProvider> {
  return createWorkspaceReadTextProviderWithIO(options, nodeWorkspaceIO)
}

interface Root { readonly path: string; readonly identity: BigIntStats }
function contains(parent: string, child: string): boolean {
  const offset = relative(parent, child)
  return offset === '' || !isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`)
}
function sameIdentity(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino
}
function sameContentMetadata(first: BigIntStats, second: BigIntStats): boolean {
  return sameIdentity(first, second) && first.size === second.size && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs
}
async function directory(io: WorkspaceFileIO, path: string): Promise<Root> {
  if (!isAbsolute(text(path, 32768))) throw new ToolError('TOOL_WORKSPACE_INVALID', 'workspace configuration requires absolute local roots')
  const initial = await io.lstat(path)
  if (initial.isSymbolicLink() || !initial.isDirectory()) throw new ToolError('TOOL_WORKSPACE_INVALID', 'configured root must be a non-linked directory')
  const canonical = await io.realpath(path)
  const identity = await io.lstat(canonical)
  if (!identity.isDirectory() || identity.isSymbolicLink() || !sameIdentity(initial, identity)) {
    throw new ToolError('TOOL_WORKSPACE_INVALID', 'root identity changed during configuration')
  }
  return { path: canonical, identity }
}

/** Internal entry for deterministic tests. It is deliberately absent from the public root. */
export async function createWorkspaceReadTextProviderWithIO(options: WorkspaceReadTextOptions, io: WorkspaceFileIO): Promise<ToolProvider> {
  let root: Root
  let definition: ToolDefinition
  let descriptor: ToolProviderDescriptor
  let maxPathBytes: number
  let maxReadBytes: number
  try {
    const rootId = safeCode(options.rootId)
    maxPathBytes = integer(options.maxPathBytes)
    maxReadBytes = integer(options.maxReadBytes)
    if (maxPathBytes > 16384 || maxReadBytes === Number.MAX_SAFE_INTEGER) throw new TypeError('unsupported ceiling')
    const rootPath = text(options.rootPath, 32768)
    if (!Array.isArray(options.protectedRoots) || options.protectedRoots.length > 64) throw new TypeError('explicit roots required')
    // Snapshot trusted configuration before the first await.
    const protectedRoots = options.protectedRoots.map(path => text(path, 32768))
    definition = createReadTextDefinition(readSchemaLimits(options.schemaLimits))
    descriptor = readDescriptor({ providerId: 'workspace-read-text', adapterVersion: '1', resourceId: rootId,
      tools: [{ name: definition.name, version: definition.version }], maxConcurrentExecutions: 1,
      maxArgumentsBytes: integer(options.maxArgumentsBytes), maxResultBytes: integer(options.maxResultBytes, 128) })
    root = await directory(io, rootPath)
    for (const path of protectedRoots) {
      const protectedRoot = await directory(io, path)
      if (contains(root.path, protectedRoot.path) || contains(protectedRoot.path, root.path)) {
        throw new ToolError('TOOL_WORKSPACE_INVALID', 'workspace overlaps a configured protected root')
      }
    }
  } catch {
    throw new ToolError('TOOL_WORKSPACE_INVALID', 'workspace configuration is invalid, inaccessible, or overlaps a protected root')
  }
  const pool = new ToolExecutionPool(1)
  return Object.freeze({ descriptor,
    prepare: (selected: ToolDefinition, input: JsonValue, suppliedLimits: ToolInvocationLimits): PreparedToolCall => {
      pool.assertAccepting()
      if (!equalJson(selected, definition)) throw new ToolError('TOOL_BINDING_MISMATCH', 'native provider requires its exact read_text definition')
      const limits = readLimits(suppliedLimits)
      if (limits.maxArgumentsBytes > descriptor.maxArgumentsBytes || limits.maxResultBytes > descriptor.maxResultBytes) {
        throw new ToolError('TOOL_BINDING_MISMATCH', 'native provider cannot exceed its published ceilings')
      }
      const args = object(input); exact(args, ['path'])
      const path = workspaceRelativePath(args.path, maxPathBytes)
      // Worst-case JSON escaping is six bytes per source byte; reserve all metadata too.
      const overhead = jsonBytes({ kind: 'success', value: { path, text: '', byteLength: Number.MAX_SAFE_INTEGER, sha256: '0'.repeat(64) } })
      const maxBytes = Math.min(maxReadBytes, Math.floor((limits.maxResultBytes - overhead) / 6))
      if (maxBytes < 1) throw new ToolError('TOOL_RECORD_BUDGET', 'result ceiling cannot hold a complete read_text result')
      const plan = createPreparedToolPlan({ definition, provider: descriptor, input: { path }, limits,
        target: { kind: 'workspace-file', rootId: descriptor.resourceId, path, maxBytes } })
      return pool.prepare(plan, (committed, signal) => readExecution(io, root, committed, signal))
    },
    dispose: () => pool.dispose(),
  })
}

async function checkTarget(io: WorkspaceFileIO, root: Root, path: string): Promise<{ readonly path: string; readonly stat: BigIntStats }> {
  const rootNow = await io.lstat(root.path)
  if (rootNow.isSymbolicLink() || !rootNow.isDirectory() || !sameIdentity(root.identity, rootNow)
    || await io.realpath(root.path) !== root.path) throw new ToolError('TOOL_PATH_INVALID', 'configured root is no longer the authorized directory')
  const parts = path.split('/')
  let current = root.path
  let last: BigIntStats | undefined
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!)
    if (!contains(root.path, current)) throw new ToolError('TOOL_PATH_INVALID', 'target escapes its authorized root')
    last = await io.lstat(current)
    if (last.isSymbolicLink() || index < parts.length - 1 && !last.isDirectory()
      || index === parts.length - 1 && !last.isFile()) {
      throw new ToolError('TOOL_PATH_INVALID', 'target contains a link or a non-regular component')
    }
  }
  if (last === undefined || await io.realpath(current) !== current) throw new ToolError('TOOL_PATH_INVALID', 'target no longer has its authorized relative path')
  return { path: current, stat: last }
}

function readExecution(io: WorkspaceFileIO, root: Root, plan: PreparedToolPlan, signal: AbortSignal): ToolExecution {
  if (plan.target.kind !== 'workspace-file') throw new ToolError('TOOL_BINDING_MISMATCH', 'read_text requires a workspace-file target')
  const target = plan.target
  let handle: Pick<FileHandle, 'read' | 'stat' | 'close'> | undefined
  let work: Promise<ToolExecutionResult> | undefined
  let closing: Promise<void> | undefined
  let stop = false
  const cancelled = (): void => { if (stop || signal.aborted) throw new ToolError('TOOL_CANCELLED', 'file operation was cancelled') }
  const read = async (): Promise<ToolExecutionResult> => {
    try {
      cancelled()
      const initial = await checkTarget(io, root, target.path)
      cancelled()
      // O_NONBLOCK avoids hanging if a cooperative path check races a FIFO replacement.
      handle = await io.open(initial.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || !sameContentMetadata(initial.stat, before)) throw new ToolError('TOOL_SOURCE_CHANGED', 'file identity or content metadata changed before reading')
      const checked = await checkTarget(io, root, target.path)
      if (!sameIdentity(before, checked.stat)) throw new ToolError('TOOL_SOURCE_CHANGED', 'opened file no longer matches its authorized target')
      const chunks: Buffer[] = []
      let length = 0
      while (length <= target.maxBytes) {
        cancelled()
        const buffer = Buffer.allocUnsafe(Math.min(65536, target.maxBytes + 1 - length))
        const result = await handle.read(buffer, 0, buffer.length, length)
        if (result.bytesRead === 0) break
        if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.length) {
          throw new ToolError('TOOL_RESULT_INVALID', 'file reader returned an invalid byte count')
        }
        length += result.bytesRead
        if (length > target.maxBytes) return { kind: 'error', code: 'TOOL_RESULT_LIMIT' }
        chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)))
      }
      const after = await handle.stat({ bigint: true })
      if (!sameContentMetadata(before, after) || BigInt(length) !== after.size) {
        return { kind: 'error', code: 'TOOL_SOURCE_CHANGED' }
      }
      cancelled()
      const bytes = Buffer.concat(chunks, length)
      let decoded: string
      try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
      catch { return { kind: 'error', code: 'invalid-utf8' } }
      const result: ToolExecutionResult = { kind: 'success', value: { path: target.path, text: decoded,
        byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') } }
      if (jsonBytes(result) > plan.limits.maxResultBytes) return { kind: 'error', code: 'TOOL_RESULT_LIMIT' }
      return result
    } catch (reason) {
      if (reason instanceof ToolError) return { kind: 'error', code: reason.code }
      const code = reason !== null && typeof reason === 'object' && 'code' in reason ? reason.code : undefined
      return { kind: 'error', code: code === 'ENOENT' ? 'file-not-found'
        : code === 'EACCES' || code === 'EPERM' ? 'file-forbidden' : 'file-read-failed' }
    }
  }
  return Object.freeze({
    start: () => {
      if (work !== undefined || closing !== undefined) throw new ToolError('TOOL_PROVIDER_INACTIVE', 'file execution is single-use')
      work = Promise.resolve().then(read)
      void work.catch(() => undefined)
      return work
    },
    close: () => {
      if (closing !== undefined) return closing
      stop = true
      closing = Promise.resolve().then(async () => {
        if (work !== undefined) await work.catch(() => undefined)
        if (handle !== undefined) await handle.close()
      })
      void closing.catch(() => undefined)
      return closing
    },
  })
}
