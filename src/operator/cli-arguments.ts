import { OperatorError } from './errors.js'

const common = ['--profile', '--json']
const configWrite = ['--yes', '--expected-revision']
const definitions: Readonly<Record<string, readonly string[]>> = {
  tui: [], setup: ['--mode', '--params-stdin', '--yes'],
  'config.create': ['--kind', '--output', '--params-stdin', '--replace', ...configWrite],
  'config.link': ['--kind', '--file', ...configWrite],
  'config.show': ['--kind', '--redacted'], 'config.check': ['--kind', '--all'], 'config.readiness': ['--kind'],
  'config.set': ['--kind', '--pointer', '--value-stdin', ...configWrite],
  'config.apply': ['--kind', '--ops-stdin', ...configWrite], 'config.edit': ['--kind'],
  'config.import': ['--kind', '--source', '--source-stdin', ...configWrite],
  'config.export': ['--kind', '--output', '--redacted', '--replace', ...configWrite],
  'config.diff': ['--kind', '--candidate'], 'config.plan': ['--kind', ...configWrite],
  'config.clone': ['--kind', '--new-storage', '--output', '--host-key', '--replace', ...configWrite],
  'config.workflow-bindings': ['--kind', '--ops-stdin', ...configWrite],
  'connection.probe': [], status: [],
  'task.submit': ['--agent', '--text', '--text-stdin', '--key', '--drive', '--acknowledge-intent'],
  'task.answer': ['--params-stdin', '--drive', '--acknowledge-intent'],
  'task.get': ['--agent', '--key', '--input-event'], 'run-once': ['--acknowledge-intent'],
  'agent.pause': ['--agent'], 'agent.resume': ['--agent'], 'host.stop': ['--mode'],
  'intent.get': ['--id'], 'intent.resume': ['--id'],
  'journal.inspect': ['--id'], 'journal.unlock': ['--predecessor-stopped', '--expected-token'],
  ...Object.fromEntries(['root.get', 'root.wait', 'root.cancel', 'message.send', 'message.reply', 'message.get', 'message.wait',
    'child.spawn', 'child.get', 'child.wait', 'child.cancel', 'workflow.get', 'workflow.wait', 'workflow.pause', 'workflow.resume',
    'workflow.cancel', 'workflow.retry', 'workflow.output', 'workflow.artifact'].map(command => [command, ['--params-stdin']])),
  events: ['--params-stdin', '--follow'],
}
const boolean = new Set(['--json', '--params-stdin', '--yes', '--replace', '--redacted', '--all', '--value-stdin', '--ops-stdin',
  '--source-stdin', '--text-stdin', '--follow', '--predecessor-stopped'])
export interface OperatorArguments { readonly command: string; readonly words: readonly string[]; readonly options: ReadonlyMap<string, string | true> }

/** Parse one closed command grammar before reading input, allocating identities, or opening a Host. */
export function parseOperatorArguments(args: readonly string[]): OperatorArguments {
  const words: string[] = [], options = new Map<string, string | true>()
  let flags = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith('--')) {
      if (flags || words.length === 2) throw new OperatorError('OPERATOR_USAGE_COMMAND', 2)
      words.push(arg); continue
    }
    flags = true
    if (options.has(arg)) throw new OperatorError('OPERATOR_USAGE_DUPLICATE', 2)
    if (boolean.has(arg)) options.set(arg, true)
    else {
      const value = args[++index]
      if (value === undefined || value.startsWith('--')) throw new OperatorError('OPERATOR_USAGE_VALUE', 2)
      options.set(arg, value)
    }
  }
  const command = words.join('.'), allowed = definitions[command]
  if (allowed === undefined || [...options.keys()].some(key => !common.includes(key) && !allowed.includes(key))) throw new OperatorError('OPERATOR_USAGE_OPTION', 2)
  requiredOption(options, '--profile')
  const sources = ['--params-stdin', '--text-stdin', '--value-stdin', '--ops-stdin', '--source-stdin'].filter(flag => options.has(flag))
  if (sources.length > 1) throw new OperatorError('OPERATOR_USAGE_STDIN', 2)
  if (command.startsWith('config.') && command !== 'config.check' || command === 'config.check' && !options.has('--all')) requiredOption(options, '--kind')
  if (options.has('--all') && options.has('--kind')) throw new OperatorError('OPERATOR_USAGE_EXCLUSIVE', 2)
  if (command === 'setup' && !['local', 'remote'].includes(requiredOption(options, '--mode'))) throw new OperatorError('OPERATOR_USAGE_MODE', 2)
  if (command === 'host.stop' && !['drain', 'cancel'].includes(requiredOption(options, '--mode'))) throw new OperatorError('OPERATOR_USAGE_MODE', 2)
  if (command.startsWith('task.') && command !== 'task.answer' || command.startsWith('agent.')) requiredOption(options, '--agent')
  if (command === 'task.submit') exactlyOne(options, '--text', '--text-stdin')
  if (command === 'task.get') exactlyOne(options, '--key', '--input-event')
  if (command === 'config.import') exactlyOne(options, '--source', '--source-stdin')
  if (command === 'config.export' && options.has('--json')) throw new OperatorError('OPERATOR_USAGE_EXPORT_JSON', 2)
  if (command === 'task.answer' || command === 'events' || allowed.includes('--params-stdin') && !['setup', 'config.create'].includes(command)) {
    if (!options.has('--params-stdin')) throw new OperatorError('OPERATOR_USAGE_PARAMS', 2)
  }
  if (options.has('--drive') && requiredOption(options, '--drive') !== 'once'
    || command !== 'run-once' && options.has('--acknowledge-intent') && !options.has('--drive')) throw new OperatorError('OPERATOR_USAGE_DRIVE', 2)
  if (['config.plan', 'config.clone', 'config.workflow-bindings'].includes(command) && options.get('--kind') !== 'host') throw new OperatorError('OPERATOR_USAGE_HOST_KIND', 2)
  for (const name of command === 'config.create' ? ['--output'] : command === 'config.link' ? ['--file']
    : command === 'config.clone' ? ['--new-storage', '--output', '--host-key'] : command === 'config.diff' ? ['--candidate']
    : command.startsWith('intent.') ? ['--id'] : command === 'config.set' ? ['--pointer'] : command === 'journal.unlock' ? ['--expected-token'] : []) requiredOption(options, name)
  if (command === 'config.set' && !options.has('--value-stdin') || command === 'config.apply' && !options.has('--ops-stdin')
    || command === 'journal.unlock' && !options.has('--predecessor-stopped')) throw new OperatorError('OPERATOR_USAGE_SOURCE_OR_CONFIRMATION', 2)
  return { command, words, options }
}
function exactlyOne(options: ReadonlyMap<string, string | true>, a: string, b: string): void {
  if (Number(options.has(a)) + Number(options.has(b)) !== 1) throw new OperatorError('OPERATOR_USAGE_EXCLUSIVE', 2)
}
export function requiredOption(options: ReadonlyMap<string, string | true>, name: string): string {
  const value = options.get(name)
  if (typeof value !== 'string') throw new OperatorError('OPERATOR_USAGE_REQUIRED', 2)
  return value
}
export function configWrites(command: string, options: ReadonlyMap<string, string | true>): boolean {
  return command === 'setup' || ['create', 'link', 'set', 'apply', 'import', 'plan', 'clone', 'workflow-bindings'].some(name => command === `config.${name}`)
    || command === 'config.export' && options.has('--output')
}
