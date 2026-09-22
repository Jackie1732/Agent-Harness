import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { HostWorkspaceResource } from '../host/subagent-config.js'
import type { DelegationWorkspace } from './contract.js'
import type { WorkspaceAccess } from '../tool/providers/workspace-access.js'
import { nodeWorkspaceIO } from '../tool/providers/workspace-io.js'
import { checkTarget, contains, directory, sameContentMetadata, sameIdentity } from '../tool/providers/workspace-target.js'
import type { Root } from '../tool/providers/workspace-target.js'
import { SubagentError } from './errors.js'
import { constants } from 'node:fs'

export type WorkspaceBaseline = { readonly kind: 'checked-files'; readonly resourceId: string;
  readonly rootIdentity: { readonly device: string; readonly inode: string }; readonly observedAt: string;
  readonly entries: readonly { readonly path: string; readonly byteLength: number; readonly sha256: string }[] }
type Range = { readonly path: string; readonly mode: 'read' | 'write' }
type Resource = { readonly config: HostWorkspaceResource; readonly root: Root }

/** One Host owns all overlapping managed reads and writes, including static parent tool borrows. */
export class WorkspaceAuthority {
  readonly #held = new Set<WorkspaceLease>()
  readonly #resources = new Map<string, Resource>()
  readonly #staticRoots = new Map<string, Root>()
  #closing = false
  static async create(resources: readonly HostWorkspaceResource[], staticPaths: readonly string[], protectedRoots: readonly string[], clock: Clock): Promise<WorkspaceAuthority> {
    const authority = new WorkspaceAuthority(clock)
    const protectedDirectories = await Promise.all(protectedRoots.map(path => directory(nodeWorkspaceIO, path)))
    for (const config of resources) {
      const root = await directory(nodeWorkspaceIO, config.rootPath)
      const protectedAll = [...protectedDirectories, ...await Promise.all(config.protectedRoots.map(path => directory(nodeWorkspaceIO, path)))]
      if (protectedAll.some(item => contains(root.path, item.path) || contains(item.path, root.path))) invalid('protected-workspace')
      authority.#resources.set(config.resourceId, { config, root })
    }
    for (const path of staticPaths) authority.#staticRoots.set(path, await directory(nodeWorkspaceIO, path))
    return authority
  }
  private constructor(readonly clock: Clock) {}
  reserve(request: Exclude<DelegationWorkspace, { kind: 'none' }>, maxFiles: number, maxBytes: number): WorkspaceLease {
    const resource = this.#resources.get(request.resourceId)
    if (resource === undefined || request.kind === 'exclusive-write' && resource.config.mode !== 'exclusive-write') invalid('workspace-resource-authority')
    const permitted = (path: string, prefixes: readonly string[]) => prefixes.some(prefix => path === prefix || path.startsWith(prefix + '/'))
    if (request.readFiles.some(path => !permitted(path, resource.config.readPrefixes)) || request.writePrefixes.some(path => !permitted(path, resource.config.writePrefixes))) invalid('workspace-range-authority')
    if (request.readFiles.length > Math.min(maxFiles, resource.config.maxBaselineFiles)) invalid('workspace-baseline-files')
    const ranges: Range[] = [...request.readFiles.map(path => ({ path: join(resource.root.path, path), mode: 'read' as const })),
      ...request.writePrefixes.map(path => ({ path: join(resource.root.path, path), mode: 'write' as const }))]
    return this.#reserve(resource.root, request, ranges, Math.min(maxBytes, resource.config.maxBaselineBytes))
  }
  /** A static Provider obtains a short read reservation only when its execution starts. */
  staticAccess(rootPath: string): WorkspaceAccess {
    const root = this.#staticRoots.get(rootPath)
    if (root === undefined) invalid('static-workspace-not-configured')
    const assert = (_path: string, mode: 'read' | 'write') => { if (this.#closing || mode !== 'read') invalid('static-read-inactive') }
    return { assert, borrow: async (path, mode) => {
      assert(path, mode)
      const lease = this.#reserve(root, { kind: 'shared-read', resourceId: 'static', readFiles: [path], writePrefixes: [] }, [{ path: join(root.path, path), mode: 'read' }], 0)
      const borrowed = await lease.borrow(path, 'read')
      return { release: clean => { borrowed.release(clean); void lease.dispose().catch(() => undefined) } }
    } }
  }
  #reserve(root: Root, request: Exclude<DelegationWorkspace, { kind: 'none' }>, ranges: readonly Range[], maximum: number): WorkspaceLease {
    if (this.#closing) invalid('workspace-authority-closed')
    if ([...this.#held].some(lease => lease.ranges.some(held => ranges.some(next => (held.mode === 'write' || next.mode === 'write')
      && (contains(held.path, next.path) || contains(next.path, held.path)))))) invalid('workspace-busy')
    const lease = new WorkspaceLease(root, request, ranges, maximum, this.clock, value => this.#held.delete(value))
    this.#held.add(lease); return lease
  }
  async dispose(): Promise<void> {
    this.#closing = true
    const results = await Promise.allSettled([...this.#held].map(lease => lease.dispose()))
    const failures = results.filter(item => item.status === 'rejected').map(item => item.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'workspace cleanup incomplete')
  }
}

/** A lease keeps its conflict reservation until every accepted file handle closes successfully. */
export class WorkspaceLease implements WorkspaceAccess {
  readonly #borrows = new Set<{ readonly done: Promise<void> }>()
  #closing = false
  #failed = false
  #close: Promise<void> | undefined
  #baseline: WorkspaceBaseline | undefined
  constructor(readonly root: Root, readonly request: Exclude<DelegationWorkspace, { kind: 'none' }>, readonly ranges: readonly Range[],
    readonly maximum: number, readonly clock: Clock, readonly releaseReservation: (lease: WorkspaceLease) => void) {}
  assert(path: string, mode: 'read' | 'write'): void {
    if (this.#closing || this.#failed) invalid('workspace-lease-inactive')
    const allowed = mode === 'read' ? this.request.readFiles.includes(path) : this.request.kind === 'exclusive-write'
      && this.request.writePrefixes.some(prefix => path.startsWith(prefix + '/'))
    if (!allowed) invalid('workspace-path-not-authorized')
  }
  async borrow(path: string, mode: 'read' | 'write') {
    this.assert(path, mode)
    let settle!: () => void
    const ticket = { done: new Promise<void>(resolve => { settle = resolve }) }
    this.#borrows.add(ticket)
    let released = false
    return { release: (clean: boolean) => {
      if (released) return
      released = true; this.#failed ||= !clean; this.#borrows.delete(ticket); settle()
    } }
  }
  verifyRead(path: string, byteLength: number, sha256: string): void {
    const entry = this.#baseline?.entries.find(item => item.path === path)
    if (entry === undefined || entry.byteLength !== byteLength || entry.sha256 !== sha256) invalid('workspace-baseline-changed')
  }
  async baseline(): Promise<WorkspaceBaseline> {
    if (this.#baseline !== undefined) return this.#baseline
    const entries: WorkspaceBaseline['entries'][number][] = []
    let total = 0
    for (const path of this.request.readFiles) {
      const borrow = await this.borrow(path, 'read')
      let handle: Awaited<ReturnType<typeof nodeWorkspaceIO.open>> | undefined
      try {
        const checked = await checkTarget(nodeWorkspaceIO, this.root, path)
        if (checked.stat.size > BigInt(this.maximum - total)) invalid('workspace-baseline-bytes')
        handle = await nodeWorkspaceIO.open(checked.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        const before = await handle.stat({ bigint: true })
        if (!before.isFile() || !sameContentMetadata(before, checked.stat)) invalid('workspace-baseline-changed')
        const hash = createHash('sha256'); let length = 0
        while (length <= Number(before.size)) {
          const buffer = Buffer.allocUnsafe(Math.min(65536, Number(before.size) + 1 - length))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, length)
          if (bytesRead === 0) break
          length += bytesRead
          if (length > Number(before.size)) invalid('workspace-baseline-changed')
          hash.update(buffer.subarray(0, bytesRead))
        }
        const after = await handle.stat({ bigint: true })
        if (!sameContentMetadata(before, after) || BigInt(length) !== before.size || !sameIdentity(after, (await checkTarget(nodeWorkspaceIO, this.root, path)).stat)) invalid('workspace-baseline-changed')
        entries.push({ path, byteLength: length, sha256: hash.digest('hex') }); total += length
      } finally {
        try { await handle?.close() } catch (cause) { borrow.release(false); throw cause }
        borrow.release(true)
      }
    }
    await checkTarget(nodeWorkspaceIO, this.root, '', 'directory')
    this.#baseline = { kind: 'checked-files', resourceId: this.request.resourceId, rootIdentity: { device: String(this.root.identity.dev), inode: String(this.root.identity.ino) }, observedAt: clockTimestamp(this.clock), entries }
    return this.#baseline
  }
  dispose(): Promise<void> {
    this.#closing = true
    this.#close ??= Promise.all([...this.#borrows].map(item => item.done)).then(() => {
      if (this.#failed) invalid('workspace-cleanup-incomplete')
      this.releaseReservation(this)
    })
    return this.#close
  }
}
function invalid(reason: string): never { throw new SubagentError('SUBAGENT_STATE_INVALID', reason) }
