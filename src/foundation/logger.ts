import type { JsonObject } from './json.js'

/** Severity of one structured log record. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Minimal structured logging capability shared by runtime modules. */
export interface Logger {
  /**
   * Write one log record with optional JSON-safe fields.
   * @param level - Record severity.
   * @param message - Human-readable event description.
   * @param fields - Optional structured diagnostic fields.
   */
  write(level: LogLevel, message: string, fields?: JsonObject): void
}

/** Logger for tests and embeddings that deliberately discard diagnostics. */
export const noopLogger: Logger = Object.freeze({
  write: () => {},
})
