import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const python = process.env.ATOMIC_HARNESS_PYTHON
if (python === undefined) throw new Error('Set ATOMIC_HARNESS_PYTHON to a Python >=3.11 environment with build, hatchling and jsonschema')
const logfile = resolve('.tmp/python-sdk-package.log'), records = []
await mkdir('.tmp', { recursive: true }); await writeFile(logfile, '')
const env = { ...process.env, PYTHONUTF8: '1' }; delete env.PYTHONPATH
async function run(command, args, options = {}) {
  const started = new Date().toISOString()
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += String(chunk) })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  const record = { command, args, started, ended: new Date().toISOString(), code }
  records.push(record); await appendFile(logfile, JSON.stringify(record) + '\n' + output + '\n'); assert.equal(code, 0, output)
  return output
}
const artifactScript = resolve('python/scripts/package_artifacts.py')
const { version, ...tools } = JSON.parse(await run(python, [artifactScript, 'metadata']))
const directory = resolve(`.tmp/python-sdk-release-${version}`), cache = resolve(`.tmp/python-sdk-wheelhouse-${version}`)
await mkdir(directory, { recursive: true }); await mkdir(cache, { recursive: true })
await run(process.execPath, ['scripts/generate-python-protocol.mjs', '--check'])
await run(python, ['-m', 'build', '--no-isolation', '--sdist', '--wheel', '--outdir', directory, 'python'])
const wheel = join(directory, `atomic_agent_harness-${version}-py3-none-any.whl`), sdist = join(directory, `atomic_agent_harness-${version}.tar.gz`)
await run(python, [artifactScript, 'inspect', wheel, sdist])
if (process.argv.includes('--prepare-cache')) {
  await run(python, ['-m', 'pip', 'download', '--only-binary=:all:', '--dest', cache, wheel,
    `jsonschema==${tools.packages.jsonschema}`, `build==${tools.packages.build}`, `hatchling==${tools.packages.hatchling}`])
}
await copyFile(wheel, join(cache, basename(wheel)))
const wheels = (await readdir(cache)).filter(name => name.endsWith('.whl')).sort()
assert.ok(wheels.length > 1, 'Dependency cache is missing; rerun with --prepare-cache')
const consumer = await mkdtemp(join(tmpdir(), 'atomic-python-consumer-')), venv = join(consumer, 'venv')
await run(python, ['-m', 'venv', venv])
const consumerPython = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
await run(consumerPython, ['-m', 'pip', 'install', '--no-index', '--find-links', cache,
  `atomic-agent-harness==${version}`, `build==${tools.packages.build}`, `hatchling==${tools.packages.hatchling}`], { cwd: consumer })
await run(consumerPython, ['-m', 'pip', 'check'], { cwd: consumer })
const unpacked = join(consumer, 'sdist')
await run(consumerPython, [artifactScript, 'extract', sdist, unpacked], { cwd: consumer })
await run(consumerPython, ['-m', 'build', '--no-isolation', '--wheel', '--outdir', join(consumer, 'rebuilt'), join(unpacked, `atomic_agent_harness-${version}`)], { cwd: consumer })
await run(consumerPython, ['-c', `import atomic_harness,json,sys,importlib.metadata as m; from atomic_harness.types import SCHEMA_SHA256; assert m.version("atomic-agent-harness")==${JSON.stringify(version)}; assert len(atomic_harness.CONTROL_METHODS)==29; assert "dist" not in atomic_harness.__file__; print(json.dumps({"module":atomic_harness.__file__,"version":m.version("atomic-agent-harness"),"schemaSha256":SCHEMA_SHA256}))`], { cwd: consumer })
const positive = join(consumer, 'typecheck_positive.py'); await copyFile(resolve('python/tests/typecheck_positive.py'), positive)
await run(python, ['-m', 'mypy', '--strict', '--python-executable', consumerPython, positive], { cwd: consumer })
await run(process.execPath, ['--test', 'tests/python-control.built.node.mjs'], { env: { ...env, ATOMIC_HARNESS_PYTHON: consumerPython, ATOMIC_HARNESS_PYTHON_INSTALLED: '1' } })
const hashes = await Promise.all(wheels.map(async name => ({ file: name, sha256: createHash('sha256').update(await readFile(join(cache, name))).digest('hex') })))
const manifest = { version, tested: tools, sdkWheelTag: 'py3-none-any', dependencyWheels: hashes,
  platformScope: 'This dependency cache supports the actual interpreter/platform wheel tags listed above; other platforms are not claimed tested.',
  wheelSha256: createHash('sha256').update(await readFile(wheel)).digest('hex'),
  sdistSha256: createHash('sha256').update(await readFile(sdist)).digest('hex') }
const manifestPath = join(directory, 'python-release-manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
const bundle = join(directory, `atomic-agent-harness-${version}-python-${tools.platform}.zip`)
await run(python, [artifactScript, 'bundle', bundle, cache, wheel, sdist, manifestPath])
await writeFile(resolve('.tmp/python-sdk-package.exit.json'), JSON.stringify({ passed: true, consumer, manifest, bundle, records }, null, 2) + '\n')
console.log(JSON.stringify({ kind: 'python-package-validation', passed: true, consumer, wheel, sdist, bundle,
  wheelSha256: manifest.wheelSha256, sdistSha256: manifest.sdistSha256, wheels: wheels.length, log: logfile }))
