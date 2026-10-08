import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packNode } from './pack-node.mjs'

// Build artifacts are prerequisites; publication is a separate explicit operation.
const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const pnpm = process.env.npm_execpath
assert.ok(pnpm, 'Use pnpm run release:prepare after the complete release gates')
const out = await mkdtemp(join(root, '.tmp', `release-${manifest.version}-`))
const scratch = await mkdtemp(join(tmpdir(), 'atomic-release-'))
const assets = []
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`)
  return result.stdout.trim()
}
const sources = ['src', 'tests', 'scripts', 'examples', 'deployment', 'python', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.gitignore']
for (const args of [['diff', '--name-only', 'HEAD', '--', ...sources], ['ls-files', '--others', '--exclude-standard', '--', ...sources]]) {
  const pending = run('git', args).split(/\r?\n/).filter(path => path.length !== 0 && !path.endsWith('.md'))
  assert.deepEqual(pending, [], 'Release source must match the recorded commit')
}
async function add(path) {
  const bytes = await readFile(path)
  assets.push({ name: path.slice(out.length + 1), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const pack = join(out, `atomic-harness-core-${manifest.version}.tgz`)
await packNode(root, pack, pnpm); await add(pack)
const installed = join(scratch, 'installed'); await mkdir(installed)
await writeFile(join(installed, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [manifest.name]: `file:${pack}` } }))
run(process.execPath, [pnpm, 'install', '--prod', '--offline', '--ignore-scripts', '--node-linker=hoisted'], installed)
const bundle = join(scratch, 'node'); await mkdir(join(bundle, 'node_modules'), { recursive: true })
for (const entry of await readdir(join(installed, 'node_modules'))) {
  if (entry.startsWith('.')) continue
  await cp(join(installed, 'node_modules', entry), join(bundle, 'node_modules', entry), { recursive: true, dereference: true })
}
await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'atomic-harness-distribution', version: manifest.version, private: true, type: 'module' }) + '\n')
await writeFile(join(bundle, 'start.mjs'), "import './node_modules/@atomic-harness/core/dist/host/bin.js'\n")
assert.equal(run(process.execPath, ['start.mjs', '--version'], bundle), manifest.version)
for (const command of ['ui', 'automate']) assert.match(run(process.execPath, ['start.mjs', command, '--help'], bundle), /atomic-harness/)
const deploy = join(bundle, 'deployment'); await mkdir(deploy)
for (const file of ['host-config.json', 'ui-config.json']) await cp(join(root, 'examples', file), join(deploy, file))
const automationExample = JSON.parse(await readFile(join(root, 'examples', 'automation-config.json'), 'utf8'))
automationExample.hostKey = 'test-host'; automationExample.client.origin = 'https://127.0.0.1:4317'
automationExample.client.tls.certFile = './tls/operator.pem'; automationExample.client.tls.keyFile = './tls/operator-key.pem'
for (const job of automationExample.jobs) job.agentKey = 'writer'
await writeFile(join(deploy, 'automation-config.json'), JSON.stringify(automationExample, null, 2) + '\n')
await cp(join(root, 'deployment', 'api-config.json'), join(deploy, 'api-config.json'))
await cp(join(root, 'deployment', 'START.txt'), join(deploy, 'START.txt'))
await cp(join(root, 'deployment', 'control-client.mjs'), join(deploy, 'control-client.mjs'))
const nodeArchive = join(out, `atomic-harness-node-${manifest.version}.tgz`)
run('tar', ['-czf', nodeArchive, '-C', bundle, 'node_modules', 'start.mjs', 'package.json', 'deployment'])
const inventory = run('tar', ['-tf', nodeArchive]).split(/\r?\n/)
assert.ok(inventory.every(name => !/(^|\/)(notes|\.tmp|tests|codex\.md|AGENTS\.md)(\/|$)|\.(pem|key|log)$|(^|\/)\.env(?:$|\.)/.test(name)), 'Release contains forbidden workspace material')
await add(nodeArchive)
const extracted = join(scratch, 'extracted'); await mkdir(extracted)
run('tar', ['-xzf', nodeArchive, '-C', extracted])
assert.equal(run(process.execPath, ['start.mjs', '--version'], extracted), manifest.version)
for (const command of ['ui', 'automate']) assert.match(run(process.execPath, ['start.mjs', command, '--help'], extracted), /atomic-harness/)
// This verification-only data is copied after packaging; no test key enters an asset.
await cp(join(root, 'tests', 'pack', 'consumer.mjs'), join(extracted, 'consumer.mjs'))
await cp(join(root, 'examples', 'host-config.json'), join(extracted, 'host.json'))
for (const file of ['ca.pem', 'server.pem', 'server-key.pem', 'client.pem', 'client-key.pem']) {
  await cp(join(root, 'tests', 'host', 'certs', file), join(extracted, file))
}
const behavior = run(process.execPath, ['consumer.mjs'], extracted)
const pythonOut = process.argv[2]
assert.ok(pythonOut, 'Provide the verified Python release directory as the argument')
const pythonManifest = JSON.parse(await readFile(join(pythonOut, 'python-release-manifest.json'), 'utf8'))
assert.equal(pythonManifest.version, manifest.version, 'Python and Node release versions must agree')
for (const file of await readdir(pythonOut)) {
  if (!/\.(whl|tar\.gz|zip)$/.test(file) && file !== 'python-release-manifest.json') continue
  const target = join(out, file); await cp(join(pythonOut, file), target); await add(target)
}
assert.ok(assets.some(asset => asset.name.endsWith('.whl')) && assets.some(asset => asset.name.endsWith('.tar.gz')) && assets.some(asset => asset.name.endsWith('.zip')), 'Python wheel, sdist and offline dependency archive are required')
assert.equal(assets.find(asset => asset.name.endsWith('.whl')).sha256, pythonManifest.wheelSha256)
assert.equal(assets.find(asset => asset.name.endsWith('.tar.gz')).sha256, pythonManifest.sdistSha256)
const commit = run('git', ['rev-parse', 'HEAD'])
await writeFile(join(out, 'SHA256SUMS'), assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''))
await writeFile(join(out, 'release-manifest.json'), JSON.stringify({ version: manifest.version, sourceCommit: commit,
  node: process.version, platform: process.platform, architecture: process.arch, cloud: 'not-run', assets }, null, 2) + '\n')
console.log(JSON.stringify({ kind: 'release-prepared', directory: out, commit, assets, nodeOfflineCli: true, extractedConsumer: extracted, behavior }))
