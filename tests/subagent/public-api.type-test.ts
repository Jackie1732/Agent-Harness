import type { AtomicHost, DelegationRequest, ParentSubagents, SessionAddress, SessionEventId, MessageId } from '../../src/index.js'

function publicTypes(host: AtomicHost, address: SessionAddress, root: SessionEventId, delegation: SessionEventId, message: MessageId, request: DelegationRequest) {
  const parent: ParentSubagents = host.bindParent(address, root)
  void parent.spawn('request-key', request)
  void parent.cancel(delegation, 'cancel-key')
  void parent.wait(delegation, { until: 'closed' })
  // @ts-expect-error A message is not a delegation identity.
  parent.inspect(message)
  // @ts-expect-error Parent controls do not expose child Agents.
  parent.agent.start()
  // @ts-expect-error Parent controls do not expose Session writers.
  parent.session.append()
  // @ts-expect-error Observing cannot select a model-driving wait mode.
  void parent.wait(delegation, { until: 'drive' })
}
void publicTypes
