import { basename, dirname, resolve } from 'node:path'
import type { HostCliIo } from '../host/cli.js'
import { createJsonLineWriter } from '../host/cli-io.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { parseBoundedJson } from '../schema/bounded-json.js'
import { parseSessionId } from '../session/ids.js'
import { parseModelInvocationId } from '../model/ids.js'
import { planExperiment } from './definition.js'
import type { ExperimentPlan } from './definition-types.js'
import { decodeExperimentPlan } from './plan-codec.js'
import { runExperiment } from './runner.js'
import { compareExperiments, evaluateExperiment, exportExperimentFixture, inspectExperiment, registerDerivedEvidence, verifyExperiment } from './analysis.js'
import { reportExperiment } from './report.js'
import { closeInterruptedExperiment } from './administration.js'
import { publishExperimentFile, readExperimentFile, readExperimentStorage } from './storage.js'
import { experimentArray, experimentChoice, experimentObject, experimentText } from './parsing.js'
import { ExperimentError } from './errors.js'
import { HarnessError } from '../foundation/error.js'
import type { ExperimentJournalSnapshot } from './journal-types.js'
import type { ExperimentComparison } from './comparison-types.js'

const commands = {
  plan: { values: ['--definition', '--output'], flags: [] },
  run: { values: ['--plan', '--root', '--mode', '--expected-token'], flags: ['--continue-unstarted', '--predecessor-stopped'] },
  inspect: { values: ['--root'], flags: [] },
  verify: { values: ['--root'], flags: [] },
  evaluate: { values: ['--root', '--unit', '--evaluator'], flags: [] },
  compare: { values: ['--root', '--comparison', '--other-root', '--variant-a', '--variant-b'], flags: [] },
  report: { values: ['--root', '--report-key', '--kind'], flags: ['--finalize'] },
  'export-fixture': { values: ['--root', '--unit', '--session', '--invocations', '--output'], flags: [] },
  close: { values: ['--root', '--expected-token', '--report-key'], flags: ['--predecessor-stopped'] },
  'register-evidence': { values: ['--root', '--unit', '--evidence-key', '--evidence', '--source'], flags: [] },
} as const
type Command = keyof typeof commands

const help = `atomic-harness experiment <command> [options]

Commands:
  plan --definition <JSON> [--output <frozen-plan.json>]
  run (--plan <JSON> | --root <control-root>) --mode fixture|live
      [--continue-unstarted --predecessor-stopped --expected-token <token>]
  inspect --root <control-root>
  verify --root <control-root>
  evaluate --root <control-root> --unit <key> [--evaluator <key>]
  compare --root <control-root> --comparison <key>
      [--other-root <root> --variant-a <key> --variant-b <key>]
  report --root <control-root> --report-key <key> --kind primary|posthoc [--finalize]
  export-fixture --root <control-root> --unit <key> --session <id> --output <file>
      [--invocations <JSON-array>]
  close --root <control-root> --predecessor-stopped [--expected-token <token> --report-key <key>]
  register-evidence --root <control-root> --unit <key> --evidence-key <key>
      --evidence <JSON> --source <JSON>

Fixture execution accepts builtin bindings. Live credentials are resolved from
the exact environment keys named by the frozen recipes.
`

function invalid(reason: string): never { throw new ExperimentError('EXPERIMENT_INPUT_INVALID', reason) }

function parseArguments(args: readonly string[]) {
  const command = args[0]
  if (command === undefined || !Object.hasOwn(commands, command)) invalid('cli-command-invalid')
  const spec = commands[command as Command]
  const values = new Map<string, string>(), flags = new Set<string>(), seen = new Set<string>()
  for (let index = 1; index < args.length; index++) {
    const key = args[index]!
    if (seen.has(key)) invalid('cli-option-duplicate')
    seen.add(key)
    if ((spec.flags as readonly string[]).includes(key)) flags.add(key)
    else if ((spec.values as readonly string[]).includes(key)) {
      const value = args[++index]
      if (value === undefined || value.length === 0 || value.startsWith('--')) invalid('cli-option-value-required')
      values.set(key, value)
    } else invalid('cli-option-unknown')
  }
  const required = (key: string): string => { const value = values.get(key); if (value === undefined) invalid(`cli-${key.slice(2)}-required`); return value }
  return { command: command as Command, values, flags, required }
}

async function readJson(path: string, maximum: number): Promise<JsonValue> {
  const bytes = await readExperimentFile(resolve(path), maximum)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { invalid('cli-file-utf8') }
  return parseBoundedJson(text, { maxBytes: maximum, maxDepth: 64, maxNodes: 1_000_000 })
}

async function requirePlan(root: string): Promise<ExperimentPlan> {
  const read = await readExperimentStorage(root)
  if (read.kind !== 'initialized') throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'experiment-uninitialized')
  return read.state.plan!
}

async function writeJson(io: HostCliIo, value: unknown, maximum: number): Promise<void> {
  const writer = createJsonLineWriter(io.stdout, maximum)
  try { await writer(value) } finally { await writer.dispose() }
}

async function publishJson(path: string, value: unknown, maximum: number) {
  const absolute = resolve(path)
  const reference = await publishExperimentFile(dirname(absolute), basename(absolute), canonicalJsonBytes(value as JsonValue), maximum)
  return { ...reference, path: absolute }
}

function businessExitCode(state: Pick<ExperimentJournalSnapshot, 'units'>): number {
  let failed = false
  for (const unit of state.units) {
    if (unit.sealed === null || ['result-unknown', 'cancelled', 'timed-out', 'interrupted'].includes(unit.sealed.payload.outcome)) return 2
    if (unit.sealed.payload.outcome === 'failed') failed = true
  }
  return failed ? 1 : 0
}

function evaluationExitCode(state: ExperimentJournalSnapshot, selections: readonly JsonObject[]): number {
  let failed = false
  for (const selection of selections) {
    if (selection.evaluationEvent === null) return 2
    const eventId = (selection.evaluationEvent as JsonObject).eventId
    const overall = state.evaluations.find(event => event.stored.eventId === eventId)!.payload.result.overall
    if (overall === 'unavailable') return 2
    if (overall === 'error') failed = true
  }
  return failed ? 1 : 0
}

function stateExitCode(state: ExperimentJournalSnapshot): number {
  if (state.finalized === null) return 2
  const report = state.reports.find(event => event.payload.reportKey === state.finalized!.payload.reportKey)!
  return Math.max(businessExitCode(state), evaluationExitCode(state, report.payload.selections))
}

function comparisonExitCode(result: ExperimentComparison): number {
  let failed = false
  for (const row of result.rows) for (const observation of [row.a, row.b]) {
    if (observation.disposition !== 'sealed' || ['result-unknown', 'cancelled', 'timed-out', 'interrupted'].includes(observation.business)
      || ['unavailable', 'not-evaluated'].includes(observation.evaluation.status)) return 2
    if (observation.business === 'failed' || observation.evaluation.status === 'error') failed = true
  }
  return failed ? 1 : 0
}

function credentialsFor(plan: ExperimentPlan, environment: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const references = new Set<string>()
  for (const unit of plan.units) {
    for (const member of unit.recipe.members) if (member.kind === 'local' && member.model.kind !== 'scripted-fixed') references.add(member.model.credentialRef)
    if (unit.recipe.schemaVersion !== 1 && unit.recipe.subagents.kind === 'enabled') {
      for (const template of unit.recipe.subagents.templates) if (template.model.kind !== 'scripted-fixed') references.add(template.model.credentialRef)
    }
  }
  return Object.fromEntries([...references].flatMap(reference => {
    const credential = environment[reference]
    return credential === undefined ? [] : [[reference, credential]]
  }))
}

/**
 * Stable experiment reasons omit exception causes, credential values, input bodies, and filesystem paths.
 * @param error - Failure caught by the executable command adapter.
 * @returns Public diagnostic fields without private exception details.
 */
export function experimentCliDiagnostic(error: unknown) {
  return Object.freeze({ code: error instanceof HarnessError ? error.code : 'EXPERIMENT_INTERNAL_ERROR',
    message: error instanceof ExperimentError ? error.message : 'experiment-operation-failed' })
}

/**
 * Classify incomplete evidence and unknown Journal commits independently of input and execution failures.
 * @param error - Failure caught by the executable command adapter.
 * @returns Exit code 2 for incomplete or unknown outcomes, otherwise 1.
 */
export function experimentCliErrorExitCode(error: unknown): 1 | 2 {
  return error instanceof ExperimentError && ['EXPERIMENT_EVIDENCE_INCOMPLETE', 'EXPERIMENT_COMMIT_UNKNOWN'].includes(error.code) ? 2 : 1
}

/**
 * Strict finite CLI adapter; Reader commands acquire no Writer, Host, or environment credentials.
 * @param args - Arguments following the executable's experiment command.
 * @param io - Command streams; structured output does not close the caller's stdout.
 * @param environment - Live credential values keyed by exact frozen recipe references.
 * @returns Exit code 0 for a complete operation, 1 for execution errors, or 2 for incomplete outcomes.
 */
export async function runExperimentCli(args: readonly string[], io: HostCliIo,
  environment: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  if (args.length === 0 || args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)
    || args.length === 2 && Object.hasOwn(commands, args[0]!) && ['--help', '-h'].includes(args[1]!)) {
    io.stdout.write(help); return 0
  }
  const { command, values, flags, required } = parseArguments(args)
  if (command === 'plan') {
    const path = resolve(required('--definition'))
    const plan = await planExperiment(await readJson(path, 16 * 1024 * 1024), { baseDirectory: dirname(path) })
    if (plan.runPolicy.mode === 'fixture' && plan.variants.some(variant => variant.fixture.kind !== 'builtin')) invalid('cli-fixture-binding-unsupported')
    const output = values.get('--output')
    await writeJson(io, output === undefined ? plan : { kind: 'planned', planDigest: plan.planDigest,
      output: await publishJson(output, plan, plan.evidenceLimits.maxPlanBytes) }, plan.evidenceLimits.maxPlanBytes + 1)
    return 0
  }
  if (command === 'run') {
    const root = values.get('--root'), path = values.get('--plan')
    if ((root === undefined) === (path === undefined)) invalid('cli-run-input-exclusive')
    const mode = experimentChoice(required('--mode'), ['fixture', 'live'], 'cli-mode')
    if (flags.has('--predecessor-stopped') && !flags.has('--continue-unstarted') || values.has('--expected-token')
      && (!flags.has('--continue-unstarted') || !flags.has('--predecessor-stopped'))) invalid('cli-continuation-confirmation')
    const plan = path === undefined ? await requirePlan(resolve(root!)) : decodeExperimentPlan(await readJson(path, 64 * 1024 * 1024))
    if (plan.runPolicy.mode !== mode) invalid('cli-mode-differs-from-plan')
    const result = await runExperiment(path === undefined ? resolve(root!) : plan, { mode,
      credentials: mode === 'live' ? credentialsFor(plan, environment) : {}, continueUnstarted: flags.has('--continue-unstarted'),
      ...(flags.has('--predecessor-stopped') ? { predecessorStopped: true } : {}),
      ...(values.has('--expected-token') ? { expectedToken: required('--expected-token') } : {}) })
    await writeJson(io, result, plan.evidenceLimits.maxReportBytes)
    return stateExitCode((await readExperimentStorage(result.location)).state!)
  }
  const root = resolve(required('--root'))
  if (command === 'inspect') {
    const result = await inspectExperiment(root)
    await writeJson(io, result, result.state?.plan?.evidenceLimits.maxReportBytes ?? 16384)
    return result.kind === 'uninitialized' ? 2 : stateExitCode(result.state)
  }
  if (command === 'verify') {
    const read = await readExperimentStorage(root)
    const result = await verifyExperiment(root)
    await writeJson(io, result, read.state?.plan?.evidenceLimits.maxReportBytes ?? 16384)
    return !result.complete || read.kind === 'uninitialized' ? 2 : stateExitCode(read.state)
  }
  if (command === 'close' && !flags.has('--predecessor-stopped')) invalid('cli-predecessor-stop-required')
  const plan = await requirePlan(root), maximum = plan.evidenceLimits.maxReportBytes
  switch (command) {
    case 'evaluate': {
      const result = await evaluateExperiment(root, { unitKey: required('--unit'), ...(values.has('--evaluator') ? { evaluatorKey: required('--evaluator') } : {}) })
      await writeJson(io, result, maximum)
      return result.overall === 'unavailable' ? 2 : result.overall === 'error' ? 1 : 0
    }
    case 'compare': {
      const otherRoot = values.get('--other-root')
      if (otherRoot === undefined && (values.has('--variant-a') || values.has('--variant-b'))) invalid('cli-cross-comparison-root-required')
      const result = await compareExperiments(root, { comparisonKey: required('--comparison'), numericMetrics: [],
        ...(otherRoot === undefined ? {} : { otherRoot: resolve(otherRoot), variantA: required('--variant-a'), variantB: required('--variant-b') }) })
      await writeJson(io, result, maximum)
      return comparisonExitCode(result)
    }
    case 'report': {
      const kind = experimentChoice(required('--kind'), ['primary', 'posthoc'], 'cli-report-kind')
      if (kind === 'posthoc' && flags.has('--finalize')) invalid('cli-posthoc-cannot-finalize')
      const result = await reportExperiment(root, { reportKey: required('--report-key'), kind, finalize: flags.has('--finalize') })
      await writeJson(io, result, maximum)
      return result.complete ? Math.max(businessExitCode(result.state), evaluationExitCode(result.state, result.selections)) : 2
    }
    case 'export-fixture': {
      const output = required('--output')
      const raw = values.get('--invocations')
      const invocationIds = raw === undefined ? undefined : experimentArray(parseBoundedJson(raw,
        { maxBytes: plan.evidenceLimits.maxFixtureBytes, maxDepth: 2, maxNodes: plan.evidenceLimits.maxFixtureEntries + 1 }), 'cli-invocations', plan.evidenceLimits.maxFixtureEntries)
        .map(value => parseModelInvocationId(experimentText(value, 'cli-invocation', 36)))
      const result = await exportExperimentFixture(root, { unitKey: required('--unit'), sessionId: parseSessionId(required('--session')),
        ...(invocationIds === undefined ? {} : { invocationIds }) })
      await writeJson(io, result.status === 'unsupported' ? result : { status: 'supported', output: await publishJson(output, result.fixture, plan.evidenceLimits.maxFixtureBytes) }, maximum)
      return result.status === 'supported' ? 0 : 2
    }
    case 'close': {
      const result = await closeInterruptedExperiment(root, { predecessorStopped: true,
        ...(values.has('--expected-token') ? { expectedToken: required('--expected-token') } : {}),
        ...(values.has('--report-key') ? { reportKey: required('--report-key') } : {}) })
      await writeJson(io, result, maximum)
      return stateExitCode(result.state)
    }
    case 'register-evidence': {
      const evidence = await readJson(required('--evidence'), plan.evidenceLimits.maxEvidenceBytes)
      const derivedFrom = experimentObject(await readJson(required('--source'), maximum), 'cli-derived-source') as JsonObject
      const result = await registerDerivedEvidence(root, { unitKey: required('--unit'), evidenceKey: required('--evidence-key'), evidence, derivedFrom })
      await writeJson(io, result, maximum)
      return stateExitCode((await readExperimentStorage(root)).state!)
    }
  }
}
