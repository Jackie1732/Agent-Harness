import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packNode } from './pack-node.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const pnpm = process.env.npm_execpath
assert.ok(pnpm, 'Run this gate with pnpm run test:pack')
const out = resolve(root, '.tmp', 'step15-package.tgz')
await mkdir(dirname(out), { recursive: true })

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`)
  return result.stdout
}
await packNode(root, out, pnpm)
const entries = run('tar', ['-tf', out], root).trim().split(/\r?\n/)
assert.ok(entries.includes('package/dist/client/index.js'))
assert.ok(entries.includes('package/dist/api/index.js'))
assert.ok(entries.includes('package/dist/protocol/index.d.ts'))
assert.ok(entries.includes('package/dist/ui/index.js') && entries.includes('package/dist/web/app.mjs'))
assert.ok(entries.includes('package/dist/automation/index.js'))
for (const path of ['operator/cli.js', 'operator/session.js', 'operator/intents.js', 'operator/profile.d.ts',
  'control/dispatch.js', 'tui/index.js', 'tui/lifecycle.js', 'tui/wizards.js', 'tui/app.js']) {
  assert.ok(entries.includes(`package/dist/${path}`), `Pack missing terminal implementation: ${path}`)
}
assert.ok(entries.every(entry => !entry.endsWith('.md')), 'Local Markdown must not enter the core package')
assert.ok(entries.every(entry => !/^package\/(notes|tests|src|\.tmp|node_modules)\//.test(entry) && !/\.(pem|key|log)$|\/\.env(?:$|\.)/.test(entry)), 'Pack contains only published code and package metadata')

const base = await mkdtemp(join(tmpdir(), 'atomic-pack-consumer-'))
assert.ok(!resolve(base).startsWith(resolve(root)), 'Consumer must be outside the repository')
const manifest = { private: true, type: 'module', dependencies: { '@atomic-harness/core': `file:${out}` },
  devDependencies: { typescript: '6.0.3', '@types/node': '22.20.2' } }
if (process.argv.includes('--prepare-cache')) {
  const warm = join(base, 'cache-preparation'); await mkdir(warm)
  await writeFile(join(warm, 'package.json'), JSON.stringify(manifest))
  run(process.execPath, [pnpm, 'install', '--ignore-scripts'], warm)
  console.log(JSON.stringify({ kind: 'pack-cache-prepared', network: 'allowed', typescript: '6.0.3', nodeTypes: '22.20.2' }))
}
const consumer = join(base, 'offline-consumer'); await mkdir(consumer)
await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest))
const installed = run(process.execPath, [pnpm, 'install', '--offline', '--ignore-scripts'], consumer)
assert.match(installed, /Done in/)
await copyFile(join(root, 'tests', 'pack', 'consumer.mjs'), join(consumer, 'consumer.mjs'))
await copyFile(join(root, 'tests', 'pack', 'consumer.ts.fixture'), join(consumer, 'consumer.ts'))
for (const file of ['operator-consumer.mjs', 'terminal-consumer.mjs', 'inert-preload.mjs']) {
  await copyFile(join(root, 'tests', 'pack', file), join(consumer, file))
}
await copyFile(join(root, 'examples', 'host-config.json'), join(consumer, 'host.json'))
for (const file of ['ca.pem', 'server.pem', 'server-key.pem', 'client.pem', 'client-key.pem']) await copyFile(join(root, 'tests', 'host', 'certs', file), join(consumer, file))
await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
  strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true, types: ['node'] }, include: ['consumer.ts'] }))
run(process.execPath, [join(consumer, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], consumer)
const library = join(consumer, 'node_modules', '@atomic-harness', 'core')
const seen = new Set()
async function visit(file) {
  if (seen.has(file)) return
  seen.add(file)
  assert.ok(!/[/\\](host|api)[/\\]|file-backend|repository|session-handle/.test(file), `Client imports server runtime: ${file}`)
  const text = await readFile(file, 'utf8')
  for (const match of text.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) await visit(resolve(dirname(file), match[1]))
}
await visit(join(library, 'dist', 'client', 'index.js'))
await visit(join(library, 'dist', 'protocol', 'index.js'))
const preload = pathToFileURL(join(consumer, 'inert-preload.mjs')).href
run(process.execPath, ['--import', preload, '--input-type=module', '--eval',
  "await import('@atomic-harness/core'); await import('@atomic-harness/core/client'); await import('@atomic-harness/core/protocol')"], consumer)
assert.match(run(process.execPath, ['--import', preload, join(library, 'dist', 'host', 'bin.js'), '--help'], consumer), /Human commands/)
run(process.execPath, ['--import', preload, join(library, 'dist', 'host', 'bin.js'), '--version'], consumer)
const behavior = run(process.execPath, ['consumer.mjs'], consumer)
const operatorDirectory = join(consumer, 'operator-empty'); await mkdir(operatorDirectory)
const operatorBehavior = JSON.parse(run(process.execPath, ['operator-consumer.mjs', library, operatorDirectory], consumer))
const terminalBehavior = JSON.parse(run(process.execPath, ['terminal-consumer.mjs', library], consumer))
console.log(JSON.stringify({ kind: 'pack-verified', tarball: out, consumer, offlineInstall: true, strictNodeNext: true,
  runtimeModules: seen.size, node: process.version, behavior: behavior.trim(), operator: operatorBehavior,
  terminal: terminalBehavior, inertCoreClientProtocolHelpVersion: true }))
