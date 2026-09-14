import { lstat, open, realpath } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

/** Internal fault-injection seam. Public provider options never accept an I/O replacement. */
export interface WorkspaceFileIO {
  lstat(path: string): Promise<BigIntStats>
  realpath(path: string): Promise<string>
  open(path: string, flags: number): Promise<Pick<FileHandle, 'read' | 'stat' | 'close'>>
}
export const nodeWorkspaceIO: WorkspaceFileIO = Object.freeze({
  lstat: (path: string) => lstat(path, { bigint: true }), realpath,
  open: (path: string, flags: number) => open(path, flags),
})
