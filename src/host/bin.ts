#!/usr/bin/env node
import { runHostCli } from './cli.js'
import { HarnessError } from '../foundation/error.js'

try {
  process.exitCode = await runHostCli(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })
} catch (error) {
  const diagnostic = error instanceof HarnessError
    ? error.toJSON()
    : { name: 'Error', code: 'HOST_INTERNAL_ERROR', message: 'host-command-failed' }
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`)
  process.exitCode = error instanceof HarnessError && ['HOST_CONFIG_INVALID', 'HOST_PROTOCOL_INVALID'].includes(error.code) ? 2 : 1
}
