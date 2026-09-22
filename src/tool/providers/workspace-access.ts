/** Current Host authority is checked at prepare and borrowed only by an actual execution. */
export interface WorkspaceAccess {
  assert(path: string, mode: 'read' | 'write'): void
  verifyRead?(path: string, byteLength: number, sha256: string): void
  borrow(path: string, mode: 'read' | 'write'): Promise<{ release(clean: boolean): void }>
}
