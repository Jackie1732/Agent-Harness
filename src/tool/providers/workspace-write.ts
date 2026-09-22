import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { JsonValue } from '../../foundation/json.js'
import type { PreparedToolCall, PreparedToolPlan, ToolDefinition, ToolExecution, ToolExecutionResult, ToolInvocationLimits, ToolProvider, ToolSchemaLimits } from '../contract.js'
import { createToolDefinition } from '../definition.js'
import { ToolError } from '../errors.js'
import { createPreparedToolPlan } from '../plan.js'
import { equalJson, exact, integer, jsonBytes, object, readDescriptor, readLimits, readSchemaLimits, safeCode } from '../validation.js'
import { workspaceRelativePath } from '../workspace-path.js'
import { ToolExecutionPool } from './pool.js'
import { nodeWorkspaceIO } from './workspace-io.js'
import type { WorkspaceFileIO } from './workspace-io.js'
import { checkTarget, contains, directory, sameIdentity, sameContentMetadata } from './workspace-target.js'
import type { Root } from './workspace-target.js'
import type { WorkspaceAccess } from './workspace-access.js'

export interface WorkspaceWriteTextOptions {
  readonly rootId: string
  readonly rootPath: string
  readonly protectedRoots: readonly string[]
  readonly maxWriteBytes: number
  readonly maxPathBytes: number
  readonly maxArgumentsBytes: number
  readonly maxResultBytes: number
  readonly schemaLimits: ToolSchemaLimits
  readonly access: WorkspaceAccess
}
type WriteHandle = Pick<FileHandle, 'read' | 'write' | 'sync' | 'stat' | 'close'>
export interface WorkspaceWriteIO extends Omit<WorkspaceFileIO, 'open'> { open(path: string, flags: number): Promise<WriteHandle> }
const nodeWriteIO: WorkspaceWriteIO = { ...nodeWorkspaceIO, open: (path, flags) => open(path, flags) }

/** Create one new UTF-8 file. Existing files and directories are never replaced or created. */
export function createWriteTextDefinition(limits: ToolSchemaLimits): ToolDefinition {
  return createToolDefinition({ name: 'write_text', version: 1, operationClass: 'external',
    description: 'Create one new UTF-8 text file in an authorized output directory. Existing files are rejected. Failure or cancellation may leave a partial file; retry does not overwrite it.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { path: { type: 'string' }, byteLength: { type: 'integer' }, sha256: { type: 'string' } }, required: ['path', 'byteLength', 'sha256'], additionalProperties: false },
  }, limits)
}
export async function createWorkspaceWriteTextProvider(options: WorkspaceWriteTextOptions): Promise<ToolProvider> {
  return createWorkspaceWriteTextProviderWithIO(options, nodeWriteIO)
}
/** Internal I/O seam for short writes and cleanup failures. */
export async function createWorkspaceWriteTextProviderWithIO(options: WorkspaceWriteTextOptions, io: WorkspaceWriteIO): Promise<ToolProvider> {
  const rootId = safeCode(options.rootId)
  const maxWriteBytes = integer(options.maxWriteBytes)
  const maxPathBytes = integer(options.maxPathBytes)
  const definition = createWriteTextDefinition(readSchemaLimits(options.schemaLimits))
  const descriptor = readDescriptor({ providerId: 'workspace-write-text', adapterVersion: '1', resourceId: rootId,
    tools: [{ name: 'write_text', version: 1 }], maxConcurrentExecutions: 1,
    maxArgumentsBytes: integer(options.maxArgumentsBytes), maxResultBytes: integer(options.maxResultBytes, 128) })
  const protectedPaths = [...options.protectedRoots]
  const access = options.access
  const root = await directory(io, options.rootPath)
  for (const path of protectedPaths) {
    const protectedRoot = await directory(io, path)
    if (contains(root.path, protectedRoot.path) || contains(protectedRoot.path, root.path)) throw new ToolError('TOOL_WORKSPACE_INVALID', 'workspace overlaps a protected root')
  }
  const pool = new ToolExecutionPool(1)
  return Object.freeze({ descriptor, prepare(selected: ToolDefinition, input: JsonValue, supplied: ToolInvocationLimits): PreparedToolCall {
    pool.assertAccepting()
    if (!equalJson(selected, definition)) throw new ToolError('TOOL_BINDING_MISMATCH', 'write_text definition mismatch')
    const limits = readLimits(supplied)
    if (limits.maxArgumentsBytes > descriptor.maxArgumentsBytes || limits.maxResultBytes > descriptor.maxResultBytes) throw new ToolError('TOOL_BINDING_MISMATCH', 'write limits exceed provider')
    const args = object(input); exact(args, ['path', 'text'])
    const path = workspaceRelativePath(args.path, maxPathBytes)
    if (typeof args.text !== 'string' || Buffer.from(args.text, 'utf8').toString('utf8') !== args.text) throw new ToolError('TOOL_REQUEST_INVALID', 'write_text requires lossless UTF-8 text')
    if (Buffer.byteLength(args.text) > maxWriteBytes) throw new ToolError('TOOL_REQUEST_INVALID', 'write_text byte limit')
    access.assert(path, 'write')
    if (jsonBytes({ kind: 'success', value: { path, byteLength: Number.MAX_SAFE_INTEGER, sha256: '0'.repeat(64) } }) > limits.maxResultBytes) throw new ToolError('TOOL_RECORD_BUDGET', 'write result does not fit')
    const plan = createPreparedToolPlan({ definition, provider: descriptor, input: { path, text: args.text }, limits,
      target: { kind: 'workspace-file', rootId, path, maxBytes: maxWriteBytes } })
    return pool.prepare(plan, (committed, signal) => writeExecution(io, root, access, committed, signal))
  }, dispose: () => pool.dispose() })
}

function writeExecution(io: WorkspaceWriteIO, root: Root, access: WorkspaceAccess, plan: PreparedToolPlan, signal: AbortSignal): ToolExecution {
  if (plan.target.kind !== 'workspace-file') throw new ToolError('TOOL_BINDING_MISMATCH', 'write target')
  const target = plan.target
  const bytes = Buffer.from(String(object(plan.input).text), 'utf8')
  let handle: WriteHandle | undefined
  let borrow: Awaited<ReturnType<WorkspaceAccess['borrow']>> | undefined
  let work: Promise<ToolExecutionResult> | undefined
  let closing: Promise<void> | undefined
  let stopped = false
  const check = () => { if (stopped || signal.aborted) throw new ToolError('TOOL_CANCELLED', 'write cancelled') }
  const write = async (): Promise<ToolExecutionResult> => {
    try {
      check(); borrow = await access.borrow(target.path, 'write'); check()
      const parent = target.path.split('/').slice(0, -1).join('/')
      await checkTarget(io, root, parent, 'directory'); check()
      handle = await io.open(join(root.path, target.path), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      const created = await handle.stat({ bigint: true })
      if (!created.isFile() || created.size !== 0n) throw new ToolError('TOOL_SOURCE_CHANGED', 'created target is not an empty regular file')
      let offset = 0
      while (offset < bytes.length) {
        check()
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.length - offset) throw new ToolError('TOOL_RESULT_INVALID', 'write made invalid progress')
        offset += bytesWritten
      }
      check(); await handle.sync(); check()
      const actual = await checkTarget(io, root, target.path)
      if (!sameIdentity(created, actual.stat) || actual.stat.size !== BigInt(bytes.length)) throw new ToolError('TOOL_SOURCE_CHANGED', 'written target identity or length changed')
      const hash = createHash('sha256')
      let read = 0
      while (read < bytes.length) {
        check(); const buffer = Buffer.allocUnsafe(Math.min(65536, bytes.length - read))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, read)
        if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > buffer.length) throw new ToolError('TOOL_SOURCE_CHANGED', 'written file readback failed')
        hash.update(buffer.subarray(0, bytesRead)); read += bytesRead
      }
      const sha256 = hash.digest('hex')
      if (sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new ToolError('TOOL_SOURCE_CHANGED', 'written content changed')
      const final = await checkTarget(io, root, target.path)
      if (!sameContentMetadata(actual.stat, final.stat) || !sameContentMetadata(final.stat, await handle.stat({ bigint: true }))) throw new ToolError('TOOL_SOURCE_CHANGED', 'written file changed during readback')
      return { kind: 'success', value: { path: target.path, byteLength: bytes.length, sha256 } }
    } catch (cause) {
      if (cause instanceof ToolError) return { kind: 'error', code: cause.code }
      const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : null
      return { kind: 'error', code: code === 'EEXIST' ? 'already-exists' : code === 'ENOENT' ? 'directory-not-found' : 'file-write-failed' }
    }
  }
  return { start() {
    if (work !== undefined || closing !== undefined) throw new ToolError('TOOL_PROVIDER_INACTIVE', 'write is single-use')
    work = Promise.resolve().then(write); return work
  }, close() {
    stopped = true
    closing ??= Promise.resolve().then(async () => {
      await work
      try { await handle?.close() } catch (cause) { borrow?.release(false); throw cause }
      borrow?.release(true)
    })
    return closing
  } }
}
