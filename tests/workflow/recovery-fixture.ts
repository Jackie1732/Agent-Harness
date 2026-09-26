import { SessionRepository } from '../../src/session/repository.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { scanHostInventory } from '../../src/host/inventory.js'
import { discoverHostDelegations } from '../../src/host/delegation-discovery.js'
import { workflowRecoveryDomains } from '../../src/host/workflow-recovery.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import type { ResolvedHostSpec } from '../../src/host/config.js'
import type { SessionEventId } from '../../src/session/ids.js'

export const prohibitedRecoveryWrites = new Set(['model/invocation-prepared', 'model/invocation-started', 'tool/invocation-requested', 'tool/invocation-started',
  'communication/outbox-accepted', 'communication/inbox-accepted', 'artifact/published', 'work/proposal-recorded', 'workflow/assignment-committed', 'workflow/decision-committed'])

/** Read exact owners, including shared parent journals and partially installed children. */
export async function recoveryReferences(spec: ResolvedHostSpec): Promise<Record<string, SessionEventId | null>> {
  const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
  try {
    const inventory = await scanHostInventory(spec, repository), relations = (await discoverHostDelegations(spec, repository, inventory)).filter(item => !item.closed)
    const agents = inventory.filter(snapshot => spec.members.some(member => member.kind === 'local' && member.sessionId === snapshot.header.sessionId)
      || relations.some(relation => relation.child?.header.sessionId === snapshot.header.sessionId && snapshot.localPosition > 0))
    const all = [...agents, ...inventory.filter(snapshot => snapshot.history.at(-1)!.events.some(item => item.stored.type === 'workflow/definition-recorded'))]
    const refs = Object.fromEntries(workflowRecoveryDomains(all))
    for (const snapshot of agents) {
      const state = projectAgentSession(snapshot)
      refs['agent:' + snapshot.header.address] = state.openRecovery
      for (const relation of relations.filter(item => item.parent.header.sessionId === snapshot.header.sessionId || item.child?.header.sessionId === snapshot.header.sessionId)) {
        const delegation = relation.requested.stored.eventId
        refs['subagent:' + snapshot.header.address + ':' + delegation] = state.subagents.recoveries.find(item => item.requested.payload.delegation === delegation
          && item.settled === null && item.supersededBy === null)?.requested.stored.eventId ?? null
      }
    }
    return refs
  } finally { await repository.dispose() }
}
