import type { Writable } from 'node:stream'
import { createJsonLineWriter } from '../host/cli-io.js'
import { displayValue } from '../tui/text.js'
import type { OperatorProfile } from './profile.js'

/** C1 remains JSON data while its encoded representation cannot execute on a terminal. */
export function operatorJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Output owns only bounded writes on a borrowed stream; it never ends stdout. */
export function operatorOutput(stream: Writable, json: boolean, profile: OperatorProfile | null,
  secrets: readonly string[] = []) {
  return createJsonLineWriter(stream, profile?.output.maxBytes ?? 2 * 1024 * 1024, profile?.output.drainTimeoutMs ?? 30000,
    json ? operatorJson : value => displayValue(value, profile?.display.maxTextBytes ?? 65536, secrets))
}
