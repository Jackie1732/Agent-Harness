export type HostBusinessMode = 'readonly' | 'exclusive'
export interface HostBusinessCursor { exclusiveKey?: string }

/** Admission owns the bounded business occupancy and the exclusive candidate waiting for readers. */
export class HostBusinessLane {
  readonly #active = new Map<string, HostBusinessMode>()
  constructor(readonly capacity: 1 | 2, readonly cursor: HostBusinessCursor) {}

  retainExclusive(eligible: (key: string) => boolean): void {
    if (this.cursor.exclusiveKey !== undefined && !eligible(this.cursor.exclusiveKey)) delete this.cursor.exclusiveKey
  }

  admit(key: string, mode: HostBusinessMode): boolean {
    if (this.#active.has(key) || [...this.#active.values()].includes('exclusive')) return false
    if (this.cursor.exclusiveKey !== undefined && this.cursor.exclusiveKey !== key) return false
    if (mode === 'exclusive') {
      this.cursor.exclusiveKey = key
      if (this.#active.size > 0) return false
      delete this.cursor.exclusiveKey
    } else if (this.#active.size >= this.capacity) return false
    this.#active.set(key, mode)
    return true
  }

  release(key: string): void { this.#active.delete(key) }
}
