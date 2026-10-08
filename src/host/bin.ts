#!/usr/bin/env node
import { runHostCli } from './cli.js'
import { HarnessError } from '../foundation/error.js'
import { hostDiagnostic } from './diagnostic.js'
import { runExperimentCli, experimentCliDiagnostic, experimentCliErrorExitCode } from '../experiment/cli.js'
import { runApiCli } from '../api/cli.js'
import { runUiCli } from '../ui/cli.js'
import { runAutomationCli } from '../automation/cli.js'
import { AutomationError } from '../automation/validation.js'

try {
  const args = process.argv.slice(2)
  const io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }
  process.exitCode = args[0] === 'api' ? await runApiCli(args.slice(1), io)
    : args[0] === 'ui' ? await runUiCli(args.slice(1), io)
    : args[0] === 'automate' ? await runAutomationCli(args.slice(1), io)
    : args[0] === 'experiment' ? await runExperimentCli(args.slice(1), io) : await runHostCli(args, io)
  if (args.length === 0 || ['help', '--help', '-h'].includes(args[0]!)) process.stdout.write('  api        serve explicit finite control RPC: --config <host.json> --api-config <api.json>\n  ui         open local browser gateway: --config <ui.json>\n  automate   serve webhooks and UTC triggers: --config <automation.json>\n')
} catch (error) {
  const diagnostic = process.argv[2] === 'experiment' ? experimentCliDiagnostic(error)
    : error instanceof AutomationError ? { code: error.code, message: 'automation-operation-failed' } : hostDiagnostic(error)
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`)
  process.exitCode = process.argv[2] === 'experiment' ? experimentCliErrorExitCode(error)
    : error instanceof AutomationError && error.code === 'AUTOMATION_CONFIG_INVALID'
      || error instanceof HarnessError && ['HOST_CONFIG_INVALID', 'HOST_PROTOCOL_INVALID'].includes(error.code) ? 2 : 1
}
