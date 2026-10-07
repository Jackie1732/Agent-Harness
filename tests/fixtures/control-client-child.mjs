import { readFile } from 'node:fs/promises'
import { request } from 'node:https'
import { randomUUID } from 'node:crypto'
import { createHarnessClient } from '../../dist/client/index.js'
import { CONTROL_PATH, CONTROL_PROTOCOL, CONTROL_VERSION } from '../../dist/protocol/index.js'

const options = JSON.parse(await readFile(process.argv[2], 'utf8'))
for (const name of ['ca', 'cert', 'key']) options.tls[name] = await readFile(options.tls[name])
const client = createHarnessClient(options)
process.on('message', async command => {
  try {
    let result
    if (command.kind === 'close') { await client.dispose(); process.send({ id: command.id, result: 'closed' }); process.disconnect(); return }
    if (command.kind === 'events') {
      result = []; for await (const page of client.events(command.params)) result.push(page)
    } else if (command.kind === 'lost-input') {
      const body = Buffer.from(JSON.stringify({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: randomUUID(), method: 'input.submit', params: command.params }))
      await new Promise((resolve, reject) => {
        const outgoing = request(new URL(CONTROL_PATH, options.origin), { method: 'POST', ...options.tls, servername: options.serverName,
          headers: { 'content-type': 'application/json', 'content-length': body.byteLength } }, response => {
          response.destroy(); outgoing.destroy(); resolve()
        })
        outgoing.once('error', reject); outgoing.end(body)
      })
      result = 'receipt-not-consumed'
    } else result = await client.request(command.method, command.params)
    process.send({ id: command.id, result })
  } catch (error) { process.send({ id: command.id, error: { name: error.name, code: error.code, acceptance: error.acceptance } }) }
})
process.send({ kind: 'client-ready', pid: process.pid })
