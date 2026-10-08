import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseAutomationConfig, resolveAutomationConfig, openHarnessAutomation } from '../../dist/automation/index.js'

try {
  const path = process.argv[2]
  const config = resolveAutomationConfig(parseAutomationConfig(await readFile(path, 'utf8')), dirname(path))
  const service = await openHarnessAutomation({ config, bearerToken: process.env.AUTOMATION_TEST_TOKEN,
    onNotice: notice => { process.send({ kind: 'notice', notice }) } })
  process.on('message', message => {
    if (message.kind === 'status') process.send({ id: message.id, status: service.status() })
    else if (message.kind === 'dispose') void service.dispose().then(() => process.disconnect(), error => { process.send({ kind: 'error', code: error.code ?? 'INTERNAL_ERROR' }); process.disconnect(); process.exitCode = 1 })
  })
  process.send({ kind: 'ready', ready: service.ready })
  void service.closed.catch(error => { process.send({ kind: 'error', code: error.code ?? 'INTERNAL_ERROR' }); process.disconnect(); process.exitCode = 1 })
} catch (error) { process.send({ kind: 'error', code: error.code ?? 'INTERNAL_ERROR' }); process.disconnect(); process.exitCode = 1 }
