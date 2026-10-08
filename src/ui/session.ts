import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { HostError } from '../host/errors.js'

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
/** One operator session; login replaces the previous token and never extends its absolute deadline. */
export class UiSession {
  readonly #password: Buffer
  readonly #timeoutMs: number
  #token: string | undefined
  #expiresAt = 0
  constructor(password: string, timeoutMs: number) {
    if (password.length === 0 || Buffer.byteLength(password) > 4096) throw new HostError('HOST_CONFIG_INVALID', 'ui-password-required')
    this.#password = digest(password); this.#timeoutMs = timeoutMs
  }
  login(password: string): string | undefined {
    if (!timingSafeEqual(digest(password), this.#password)) return undefined
    this.#token = randomBytes(32).toString('hex'); this.#expiresAt = Date.now() + this.#timeoutMs
    return `ah_ui=${this.#token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(this.#timeoutMs / 1000)}`
  }
  accepts(cookie: string | undefined): boolean {
    if (this.#token === undefined || Date.now() >= this.#expiresAt) return false
    const matches = cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith('ah_ui=')) ?? []
    return matches.length === 1 && matches[0] === `ah_ui=${this.#token}`
  }
  logout(): string {
    this.#token = undefined; this.#expiresAt = 0
    return 'ah_ui=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
  }
}
