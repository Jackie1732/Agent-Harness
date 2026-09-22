import type { SessionSnapshot } from '../session/types.js'

/** Defer Host-owned protocol writes between an Agent step reservation and its Model CP0 or decision. */
export function isModelAdmissionPending(snapshot: SessionSnapshot): boolean {
  const events = snapshot.history.at(-1)?.events ?? []
  for (let index = events.length - 1; index >= 0; index--) {
    switch (events[index]!.stored.type) {
      case 'agent/step-opened': return true
      case 'model/invocation-prepared':
      case 'agent/step-decided':
      case 'agent/turn-settled':
      case 'agent/run-settled': return false
    }
  }
  return false
}
