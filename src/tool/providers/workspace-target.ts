import type { BigIntStats } from 'node:fs'
import { isAbsolute, join, relative, sep, parse, resolve } from 'node:path'
import type { WorkspaceFileIO } from './workspace-io.js'
import { ToolError } from '../errors.js'
import { text } from '../validation.js'

export interface Root { readonly path: string; readonly identity: BigIntStats }
export function contains(parent: string, child: string): boolean {
  const offset = relative(parent, child)
  return offset === '' || !isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`)
}
export function sameIdentity(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino
}
export function sameContentMetadata(first: BigIntStats, second: BigIntStats): boolean {
  return sameIdentity(first, second) && first.size === second.size && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs
}
export async function directory(io: WorkspaceFileIO, path: string): Promise<Root> {
  if (!isAbsolute(text(path, 32768))) throw new ToolError('TOOL_WORKSPACE_INVALID', 'workspace configuration requires absolute local roots')
  const absolute = resolve(path)
  let component = parse(absolute).root
  for (const part of relative(component, absolute).split(sep).filter(Boolean)) {
    component = join(component, part)
    const entry = await io.lstat(component)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ToolError('TOOL_WORKSPACE_INVALID', 'configured path contains a linked component')
  }
  const initial = await io.lstat(path)
  if (initial.isSymbolicLink() || !initial.isDirectory()) throw new ToolError('TOOL_WORKSPACE_INVALID', 'configured root must be a non-linked directory')
  const canonical = await io.realpath(path)
  const identity = await io.lstat(canonical)
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.ino === 0n || !sameIdentity(initial, identity)) {
    throw new ToolError('TOOL_WORKSPACE_INVALID', 'root identity changed during configuration')
  }
  return { path: canonical, identity }
}

export async function checkTarget(io: WorkspaceFileIO, root: Root, path: string, kind: 'file' | 'directory' = 'file'): Promise<{ readonly path: string; readonly stat: BigIntStats }> {
  const rootNow = await io.lstat(root.path)
  if (rootNow.isSymbolicLink() || !rootNow.isDirectory() || !sameIdentity(root.identity, rootNow)
    || await io.realpath(root.path) !== root.path) throw new ToolError('TOOL_PATH_INVALID', 'configured root is no longer the authorized directory')
  if (path === '' && kind === 'directory') return { path: root.path, stat: rootNow }
  const parts = path.split('/')
  let current = root.path
  let last: BigIntStats | undefined
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!)
    if (!contains(root.path, current)) throw new ToolError('TOOL_PATH_INVALID', 'target escapes its authorized root')
    last = await io.lstat(current)
    if (last.isSymbolicLink() || index < parts.length - 1 && !last.isDirectory()
      || index === parts.length - 1 && !(kind === 'file' ? last.isFile() : last.isDirectory())) {
      throw new ToolError('TOOL_PATH_INVALID', 'target contains a link or a non-regular component')
    }
  }
  if (last === undefined || await io.realpath(current) !== current) throw new ToolError('TOOL_PATH_INVALID', 'target no longer has its authorized relative path')
  return { path: current, stat: last }
}
