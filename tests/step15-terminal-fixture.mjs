import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { buildHostPreset } from '../dist/operator/config-presets.js'
import { buildOperatorProfile } from '../dist/operator/profile.js'
import { setupOperator, planOperatorHost } from '../dist/operator/config-operations.js'
import { runProfileMaintenance } from '../dist/operator/maintenance.js'

// A loopback provider exercises the shipped HTTP/function-calling path without an external model.
const directory = resolve(process.argv[2] ?? '.tmp/step15-terminal'), path = join(directory, 'operator.json')
await mkdir(directory, { recursive: true })
let requests = 0
const inputs = [], finalText = process.argv.includes('--long-final')
  ? '已采用 Markdown，研究笔记完成。\n' + '中文全角ＡＢ 👩‍🔬 é 研究证据。'.repeat(120) + '\n完整结尾：终端科研验收完成。'
  : '已采用 Markdown，研究笔记完成。'
const server = createServer(async (request, response) => {
  if (request.url === '/quit') { response.end('stopped'); server.close(); return }
  const parts = []
  for await (const part of request) parts.push(part)
  inputs.push(JSON.parse(Buffer.concat(parts).toString('utf8')).messages)
  requests++
  const delta = requests === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'human-question', type: 'function',
    function: { name: 'agent_ask_user', arguments: JSON.stringify({ question: '科研笔记使用什么格式？', timeoutMs: 300000 }) } }] }
    : { role: 'assistant', content: finalText }
  const chunk = { id: `terminal-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] }
  await writeFile(join(directory, 'provider-evidence.json'), JSON.stringify({ requests, inputs, finalText }))
  response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}/model`
const profile = buildOperatorProfile({ kind: 'local', hostConfig: 'host.json', shutdownMode: 'drain' })
const host = buildHostPreset('solo-http', { hostKey: 'terminal-harness', storageRoot: join(directory, 'host-store'),
  http: { kind: 'deepseek', endpoint, credentialRef: 'STEP15_DEMO_KEY', model: 'fixture-model' } })
await setupOperator({ profilePath: path, profile, host })
const raw = await import('../dist/operator/config-check.js').then(module => module.readConfigDocument(path, 'host'))
await planOperatorHost(path, { expectedRevision: raw.revision })
await runProfileMaintenance(['init', '--profile', path], { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })
await writeFile(join(directory, 'launch.json'), JSON.stringify({ endpoint, profilePath: path, columns: process.stdout.columns ?? null, node: process.version }))
console.log(JSON.stringify({ kind: 'step15-terminal-fixture', endpoint, profilePath: path, credentialRef: 'STEP15_DEMO_KEY' }))
