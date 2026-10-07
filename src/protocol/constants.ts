/** One-request control protocol shared by the HTTPS owner and Node client. */
export const CONTROL_PROTOCOL = 'atomic-harness-control' as const
export const CONTROL_VERSION = 1 as const
export const CONTROL_PATH = '/ah-control/v1/rpc' as const

/** Exact method names; the permission list and both dispatchers use this set. */
export const CONTROL_METHODS = [
  'host.status', 'host.run', 'host.shutdown', 'agent.get', 'agent.pause', 'agent.resume',
  'input.submit', 'input.answer', 'input.get', 'root.get', 'root.wait', 'root.cancel',
  'message.send', 'message.reply', 'message.get', 'message.wait', 'session.events',
  'delegation.spawn', 'delegation.get', 'delegation.wait', 'delegation.cancel',
  'workflow.get', 'workflow.wait', 'workflow.pause', 'workflow.resume', 'workflow.cancel',
  'workflow.retry', 'workflow.output', 'workflow.artifact',
] as const
export type ControlMethod = typeof CONTROL_METHODS[number]

/** Admission ownership is independent of HTTP response writing. */
export type MethodCategory = 'observation' | 'business' | 'input' | 'control' | 'management'
export const METHOD_CATEGORIES = {
  'host.status': 'observation', 'host.run': 'business', 'host.shutdown': 'management',
  'agent.get': 'observation', 'agent.pause': 'control', 'agent.resume': 'control',
  'input.submit': 'input', 'input.answer': 'input', 'input.get': 'observation',
  'root.get': 'observation', 'root.wait': 'observation', 'root.cancel': 'control',
  'message.send': 'business', 'message.reply': 'business', 'message.get': 'observation', 'message.wait': 'observation',
  'session.events': 'observation', 'delegation.spawn': 'control', 'delegation.get': 'observation',
  'delegation.wait': 'observation', 'delegation.cancel': 'control', 'workflow.get': 'observation',
  'workflow.wait': 'observation', 'workflow.pause': 'control', 'workflow.resume': 'control',
  'workflow.cancel': 'control', 'workflow.retry': 'control', 'workflow.output': 'observation', 'workflow.artifact': 'observation',
} as const satisfies Record<ControlMethod, MethodCategory>
