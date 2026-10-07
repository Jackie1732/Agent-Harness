#!/usr/bin/env node
import { runHostCli } from './cli.js'
import { HarnessError } from '../foundation/error.js'
import { hostDiagnostic } from './diagnostic.js'
import { runExperimentCli, experimentCliDiagnostic, experimentCliErrorExitCode } from '../experiment/cli.js'
import { runApiCli } from '../api/cli.js'

try {
  const args = process.argv.slice(2)
  const io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }
  process.exitCode = args[0] === 'api' ? await runApiCli(args.slice(1), io)
    : args[0] === 'experiment' ? await runExperimentCli(args.slice(1), io) : await runHostCli(args, io)
  if (args.length === 0 || ['help', '--help', '-h'].includes(args[0]!)) process.stdout.write('  api        serve explicit finite control RPC: --config <host.json> --api-config <api.json>\n')
} catch (error) {
  const diagnostic = process.argv[2] === 'experiment' ? experimentCliDiagnostic(error) : hostDiagnostic(error)
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`)
  process.exitCode = process.argv[2] === 'experiment' ? experimentCliErrorExitCode(error)
    : error instanceof HarnessError && ['HOST_CONFIG_INVALID', 'HOST_PROTOCOL_INVALID'].includes(error.code) ? 2 : 1
}
