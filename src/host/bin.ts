#!/usr/bin/env node
import { runHostCli } from './cli.js'
import { HarnessError } from '../foundation/error.js'
import { hostDiagnostic } from './diagnostic.js'

try {
  process.exitCode = await runHostCli(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })
} catch (error) {
  const diagnostic = hostDiagnostic(error)
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`)
  process.exitCode = error instanceof HarnessError && ['HOST_CONFIG_INVALID', 'HOST_PROTOCOL_INVALID'].includes(error.code) ? 2 : 1
}
