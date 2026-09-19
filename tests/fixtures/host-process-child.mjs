import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { decodeHostConfig, openHost, resolveHostConfig } from '../../dist/index.js'

const configPath = process.argv[2]
if (configPath === undefined || typeof process.send !== 'function') throw new Error('IPC and config path are required')
const config = decodeHostConfig(JSON.parse(await readFile(configPath, 'utf8')), dirname(configPath))
const host = await openHost(resolveHostConfig(config))
process.send({ kind: 'ready' })

process.on('message', message => {
  void (async () => {
    if (message.kind === 'send') {
      await host.sendMessage(message.agentKey, message.command)
      process.send({ kind: 'result', requestId: message.requestId, value: await host.run() })
      return
    }
    if (message.kind === 'run') {
      process.send({ kind: 'result', requestId: message.requestId, value: await host.run() })
      return
    }
    if (message.kind === 'shutdown') {
      await host.shutdown({ mode: 'drain' })
      process.send({ kind: 'result', requestId: message.requestId, value: 'stopped' })
      process.disconnect()
    }
  })().catch(error => {
    process.send?.({ kind: 'failure', requestId: message.requestId,
      code: typeof error?.code === 'string' ? error.code : 'HOST_PROCESS_FAILURE' })
  })
})
