/** Native/structural contract tests. Full Runner/Ajv integration is tested separately. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink, lstat, realpath, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { boundedJson, parseBoundedJson, JsonBoundaryError } from '../dist/schema/bounded-json.js'
import { validateInlineSchema } from '../dist/schema/inline.js'
import { validationData, validationSchema, validationKey } from '../dist/schema/validation-keys.js'
import { createToolDefinition } from '../dist/tool/definition.js'
import { createPreparedToolPlan, decodePlan } from '../dist/tool/plan.js'
import { createWorkspaceReadTextProvider, createWorkspaceReadTextProviderWithIO, createReadTextDefinition } from '../dist/tool/providers/workspace-read.js'
import { readLimits, readSchemaLimits } from '../dist/tool/validation.js'
import { workspaceRelativePath } from '../dist/tool/workspace-path.js'
import { ScriptedToolProvider, createScriptedToolExecution } from '../dist/tool/providers/scripted.js'

const jsonLimits = { maxBytes: 10000, maxDepth: 16, maxNodes: 1000 }
const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
const limits = { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536,
  maxArgumentsBytes: 4096, maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 65536, maxJournalConflicts: 4 }
const definition = createReadTextDefinition(schemaLimits)
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function fixture(body, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'atomic-tool-native-'))
  try {
    const workspace = join(root, 'workspace'); const storage = join(root, 'storage')
    await mkdir(workspace); await mkdir(storage)
    const options = { rootId: 'research', rootPath: workspace, protectedRoots: [storage],
      maxReadBytes: 4096, maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 65536, schemaLimits, ...overrides }
    await body({ root, workspace, storage, options })
  } finally { await rm(root, { recursive: true, force: true }) }
}
function tracedIO(hooks = {}) {
  const trace = { opens: 0, reads: 0, closes: 0, bytesRequested: 0, active: 0 }
  const io = { lstat: path => lstat(path, { bigint: true }), realpath,
    open: async (path, flags) => {
      if (hooks.beforeOpen) await hooks.beforeOpen(path)
      trace.opens++
      const handle = await open(path, flags); trace.active++
      return {
        stat: opts => handle.stat(opts),
        read: async (...args) => {
          trace.reads++; trace.bytesRequested += args[2]
          if (hooks.beforeRead) await hooks.beforeRead(path)
          const result = await handle.read(...args)
          if (hooks.afterRead) await hooks.afterRead(path)
          return result
        },
        close: async () => {
          trace.closes++
          if (hooks.beforeClose) await hooks.beforeClose(path)
          await handle.close(); trace.active--
          if (hooks.afterClose) await hooks.afterClose(path)
        },
      }
    },
  }
  return { io, trace }
}
async function execute(provider, path, signal = new AbortController().signal) {
  const binding = provider.prepare(definition, { path }, limits)
  const execution = await binding.acquire(binding.plan, signal)
  try { return { plan: binding.plan, result: await execution.start() } }
  finally { await execution.close() }
}

test('T7-04/05 bounded snapshot does not invoke getters or retain mutable aliases', () => {
  const original = { nested: { x: 1 }, list: ['原文'] }
  const snapshot = boundedJson(original, jsonLimits)
  original.nested.x = 99; original.list.push('changed')
  assert.deepEqual(snapshot, { nested: { x: 1 }, list: ['原文'] }); assert(Object.isFrozen(snapshot.nested))
  let calls = 0
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { calls++; return 1 } })
  assert.throws(() => boundedJson(getter, jsonLimits), JsonBoundaryError); assert.equal(calls, 0)
  const proxy = new Proxy({}, { ownKeys() { calls++; return [] } })
  assert.throws(() => boundedJson(proxy, jsonLimits), JsonBoundaryError); assert.equal(calls, 0)
})
for (const [name, value] of [['NaN', NaN], ['Infinity', Infinity], ['undefined', undefined], ['function', () => 1],
  ['bigint', 1n], ['sparse', Array(2)], ['date', new Date()], ['symbol value', Symbol('x')], ['symbol key', { [Symbol('x')]: 1 }]]) {
  test(`T7-05 rejects ${name}`, () => assert.throws(() => boundedJson(value, jsonLimits), JsonBoundaryError))
}
test('T7-05 cycle rejects; shared acyclic and cross-realm plain data remain valid', () => {
  const cycle = {}; cycle.self = cycle
  assert.throws(() => boundedJson(cycle, jsonLimits), JsonBoundaryError)
  const common = { x: 1 }; assert.deepEqual(boundedJson([common, common], jsonLimits), [{ x: 1 }, { x: 1 }])
  assert.deepEqual(boundedJson(runInNewContext('({ x: [1, 2] })'), jsonLimits), { x: [1, 2] })
})
test('T7-06 finite depth/node/raw-text budgets precede recursive helpers', () => {
  let deep = {}; for (let i = 0; i < 10000; i++) deep = { child: deep }
  assert.throws(() => boundedJson(deep, jsonLimits), error => error instanceof JsonBoundaryError && error.reason === 'depth')
  assert.throws(() => boundedJson([1, 2, 3], { ...jsonLimits, maxNodes: 3 }), JsonBoundaryError)
  assert.throws(() => parseBoundedJson('not-json'.repeat(1000), { ...jsonLimits, maxBytes: 8 }), error => error.reason === 'bytes')
  assert.throws(() => boundedJson('\0'.repeat(10), { ...jsonLimits, maxBytes: 20 }), error => error.reason === 'bytes')
})
test('T7-08 structural validation-key transform is injective and does not pollute prototypes', () => {
  const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":7,"p005f":4}')
  const translated = validationData(boundedJson(value, jsonLimits))
  assert.deepEqual(Object.keys(translated).sort(), Object.keys(value).map(validationKey).sort())
  assert.equal(Object.prototype.polluted, undefined)
  assert.equal(Object.hasOwn(value, '__proto__'), true)
  assert.notEqual(validationKey('\ud800'), validationKey('\ufffd'))
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"integer"}},"required":["__proto__"],"additionalProperties":false}')
  const mapped = validationSchema(schema)
  assert.deepEqual(mapped.required, [validationKey('__proto__')])
  assert.equal(mapped.properties[validationKey('__proto__')].type, 'integer')
})
test('T7-09/10 shared inline subset rejects duplicate enums and unsupported keywords', () => {
  assert.throws(() => validateInlineSchema({ type: 'object', enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }))
  for (const field of ['$ref', 'format', 'default', 'pattern', 'oneOf', '$async']) {
    assert.throws(() => validateInlineSchema({ type: 'object', [field]: 'unsupported' }))
  }
  assert.throws(() => validateInlineSchema({ type: 'array' }))
  assert.throws(() => validateInlineSchema({ type: 'object', required: ['undeclared'] }))
  validateInlineSchema({ type: 'array', items: { type: 'integer', enum: [1, 2] } })
})
test('T7-06/07 definition output accepts non-object roots; model input root stays object', () => {
  const selected = createToolDefinition({ ...definition, outputSchema: { type: 'array', items: { type: 'string' } } }, schemaLimits)
  assert.equal(selected.outputSchema.type, 'array')
  assert.throws(() => createToolDefinition({ ...definition, inputSchema: { type: 'string' } }, schemaLimits))
  assert.throws(() => createToolDefinition(definition, { ...schemaLimits, maxSchemaBytes: 32 }))
})
const invalidPaths = ['', '.', '..', '/tmp/file', '../x', 'x/../y', './x', 'x//y', 'x/', 'x\\y', 'x/\\y',
  'C:/x', 'C:x', '\\\\server\\share', '\\\\?\\C:\\x', 'file:stream', 'file\0name', 'CON', 'con.txt', 'LPT1', 'COM9.dat',
  'AUX', 'NUL', 'CONIN$', 'CONOUT$', 'x. ', 'x.', 'x ', 'x/./y', 'a?b', 'a*b', 'a|b', 'a<b', 'a>b', 'a"b']
for (const path of invalidPaths) test(`T7-62 portable path rejects ${JSON.stringify(path)}`, () => {
  assert.throws(() => workspaceRelativePath(path, 1024), error => error.code === 'TOOL_PATH_INVALID')
})
test('T7-62/63 portable path accepts Unicode/space data without normalization or root guessing', () => {
  assert.equal(workspaceRelativePath('研究 资料/原文.txt', 1024), '研究 资料/原文.txt')
  assert.throws(() => workspaceRelativePath('a'.repeat(256), 1024))
})
test('T7-30/61/63 native UTF-8, SHA and byte length; prepare/acquire perform zero target opens', async () => fixture(async ({ workspace, options }) => {
  await mkdir(join(workspace, '研究 资料'))
  const data = Buffer.from('\ufeff中文 🌏\ntext\0', 'utf8')
  await writeFile(join(workspace, '研究 资料/原文.txt'), data)
  const { io, trace } = tracedIO()
  const provider = await createWorkspaceReadTextProviderWithIO(options, io)
  const binding = provider.prepare(definition, { path: '研究 资料/原文.txt' }, limits)
  const execution = await binding.acquire(binding.plan, new AbortController().signal)
  assert.equal(trace.opens, 0); assert(!JSON.stringify(binding.plan).includes(workspace))
  const result = await execution.start()
  assert.equal(trace.active, 1)
  assert.deepEqual(result, { kind: 'success', value: { path: '研究 资料/原文.txt', text: data.toString('utf8'), byteLength: data.length, sha256: createHash('sha256').update(data).digest('hex') } })
  const close = execution.close(); assert.equal(execution.close(), close); await close
  assert.equal(trace.closes, 1); assert.equal(trace.active, 0); await provider.dispose()
}))
test('T7-59 native read probes no more than maxBytes + 1 and never returns truncated success', async () => fixture(async ({ workspace, options }) => {
  await writeFile(join(workspace, 'large.txt'), Buffer.alloc(100, 65))
  const { io, trace } = tracedIO(); const provider = await createWorkspaceReadTextProviderWithIO({ ...options, maxReadBytes: 7 }, io)
  const { result, plan } = await execute(provider, 'large.txt')
  assert.equal(plan.target.maxBytes, 7); assert.equal(result.kind, 'error'); assert.equal(result.code, 'TOOL_RESULT_LIMIT')
  assert.equal(trace.bytesRequested, 8); assert.equal(trace.closes, 1); await provider.dispose()
}))
test('T7-59/64 empty, exact-limit and invalid UTF-8 are distinguished', async () => fixture(async ({ workspace, options }) => {
  await writeFile(join(workspace, 'empty'), Buffer.alloc(0)); await writeFile(join(workspace, 'exact'), 'abcd')
  await writeFile(join(workspace, 'invalid'), Buffer.from([0xc0, 0xaf]))
  const provider = await createWorkspaceReadTextProvider({ ...options, maxReadBytes: 4 })
  assert.equal((await execute(provider, 'empty')).result.value.byteLength, 0)
  assert.equal((await execute(provider, 'exact')).result.value.text, 'abcd')
  assert.deepEqual((await execute(provider, 'invalid')).result, { kind: 'error', code: 'invalid-utf8' })
  await provider.dispose()
}))
test('T7-62 a file symlink never opens as text', async t => fixture(async ({ workspace, storage, options }) => {
  await writeFile(join(storage, 'secret'), 'private')
  try { await symlink(join(storage, 'secret'), join(workspace, 'link')) }
  catch (reason) {
    if (process.platform === 'win32' && reason?.code === 'EPERM') {
      t.skip('Windows file symlinks require Developer Mode or elevated privileges')
      return
    }
    throw reason
  }
  const { io, trace } = tracedIO(); const provider = await createWorkspaceReadTextProviderWithIO(options, io)
  assert.equal((await execute(provider, 'link')).result.kind, 'error')
  assert.equal(trace.opens, 0); await provider.dispose()
}))
test('T7-62 a linked directory component never opens as text', async () => fixture(async ({ workspace, storage, options }) => {
  await writeFile(join(storage, 'secret'), 'private')
  await symlink(storage, join(workspace, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir')
  const { io, trace } = tracedIO(); const provider = await createWorkspaceReadTextProviderWithIO(options, io)
  assert.equal((await execute(provider, 'linked-dir/secret')).result.kind, 'error')
  assert.equal(trace.opens, 0); await provider.dispose()
}))
test('T7-62 a directory never opens as text', async () => fixture(async ({ workspace, options }) => {
  await mkdir(join(workspace, 'ordinary-dir'))
  const { io, trace } = tracedIO(); const provider = await createWorkspaceReadTextProviderWithIO(options, io)
  assert.equal((await execute(provider, 'ordinary-dir')).result.kind, 'error')
  assert.equal(trace.opens, 0); await provider.dispose()
}))
test('T7-64 nonexistent and permission errors contain no absolute path or raw exception', async () => fixture(async ({ workspace, options }) => {
  const normal = await createWorkspaceReadTextProvider(options)
  assert.deepEqual((await execute(normal, 'missing')).result, { kind: 'error', code: 'file-not-found' }); await normal.dispose()
  await writeFile(join(workspace, 'secret'), 'test')
  const { io, trace } = tracedIO({ beforeOpen: () => { throw Object.assign(new Error('secret path and credentials'), { code: 'EACCES' }) } })
  const provider = await createWorkspaceReadTextProviderWithIO(options, io)
  const result = (await execute(provider, 'secret')).result
  assert.deepEqual(result, { kind: 'error', code: 'file-forbidden' }); assert.equal(trace.active, 0); assert.equal(trace.closes, 0)
  await provider.dispose()
}))
test('T7-65 observable file mutation does not become stable success', async () => fixture(async ({ workspace, options }) => {
  await writeFile(join(workspace, 'changed'), 'before')
  let changed = false
  const { io, trace } = tracedIO({ afterRead: async path => { if (!changed) { changed = true; await appendFile(path, ' after') } } })
  const provider = await createWorkspaceReadTextProviderWithIO(options, io)
  const { result } = await execute(provider, 'changed')
  assert.equal(result.kind, 'error'); assert.equal(result.code, 'TOOL_SOURCE_CHANGED'); assert.equal(trace.closes, 1)
  await provider.dispose()
}))
test('T7-38/40 native cancellation and close wait for an already-started read', async () => fixture(async ({ workspace, options }) => {
  await writeFile(join(workspace, 'held'), 'data')
  const entered = deferred(); const release = deferred()
  const { io, trace } = tracedIO({ beforeRead: async () => { entered.resolve(); await release.promise } })
  const provider = await createWorkspaceReadTextProviderWithIO(options, io)
  const controller = new AbortController(); const binding = provider.prepare(definition, { path: 'held' }, limits)
  const execution = await binding.acquire(binding.plan, controller.signal)
  const running = execution.start(); await entered.promise
  controller.abort(); const closing = execution.close()
  assert.equal(trace.closes, 0); assert.equal(trace.active, 1)
  release.resolve(); assert.equal((await running).kind, 'error'); await closing
  assert.equal(trace.closes, 1); assert.equal(trace.active, 0); await provider.dispose()
}))
test('T7-41/42 close failure is sticky and is never retried', async () => fixture(async ({ workspace, options }) => {
  await writeFile(join(workspace, 'file'), 'test')
  const { io, trace } = tracedIO({ afterClose: () => { throw new Error('private close detail') } })
  const provider = await createWorkspaceReadTextProviderWithIO(options, io)
  const binding = provider.prepare(definition, { path: 'file' }, limits)
  const execution = await binding.acquire(binding.plan, new AbortController().signal)
  assert.equal((await execution.start()).kind, 'success')
  const closing = execution.close(); assert.equal(execution.close(), closing)
  await assert.rejects(closing, error => error.code === 'TOOL_CLEANUP_FAILED' && !JSON.stringify(error).includes('private close detail'))
  await assert.rejects(provider.dispose(), error => error.code === 'TOOL_CLEANUP_FAILED')
  assert.equal(trace.closes, 1); assert.equal(trace.active, 0)
}))
test('T7-41 provider cleanup failure closes every admission path and aborts sibling slots', async () => {
  const tool = createToolDefinition({ name: 'cleanup-gate', version: 1, description: '', operationClass: 'pure',
    inputSchema: { type: 'object' }, outputSchema: { type: 'null' } }, schemaLimits)
  const providerDescriptor = { providerId: 'cleanup-gate', adapterVersion: '1', resourceId: 'ledger',
    tools: [{ name: tool.name, version: tool.version }], maxConcurrentExecutions: 2,
    maxArgumentsBytes: 4096, maxResultBytes: 65536 }
  let acquisitions = 0, starts = 0, closes = 0, reentrantError
  const provider = new ScriptedToolProvider({ descriptor: providerDescriptor, acquire: (_plan, signal) => {
    const ordinal = ++acquisitions
    if (ordinal === 2) signal.addEventListener('abort', () => {
      try { provider.prepare(tool, {}, limits) } catch (reason) { reentrantError = reason }
    }, { once: true })
    return createScriptedToolExecution(() => { starts++; return { kind: 'success', value: null } }, () => {
      closes++
      if (ordinal === 1) throw new Error('injected cleanup failure')
    })
  } })
  const firstBinding = provider.prepare(tool, {}, limits)
  const oldBinding = provider.prepare(tool, {}, limits)
  const siblingBinding = provider.prepare(tool, {}, limits)
  const first = await firstBinding.acquire(firstBinding.plan, new AbortController().signal)
  const sibling = await siblingBinding.acquire(siblingBinding.plan, new AbortController().signal)
  const closing = first.close(); assert.equal(first.close(), closing)
  await assert.rejects(closing, { code: 'TOOL_CLEANUP_FAILED' })
  assert.equal(reentrantError?.code, 'TOOL_PROVIDER_INACTIVE')
  assert.throws(() => sibling.start(), { code: 'TOOL_PROVIDER_INACTIVE' })
  await sibling.close()
  await assert.rejects(oldBinding.acquire(oldBinding.plan, new AbortController().signal), { code: 'TOOL_PROVIDER_INACTIVE' })
  assert.throws(() => provider.prepare(tool, {}, limits), { code: 'TOOL_PROVIDER_INACTIVE' })
  assert.equal(acquisitions, 2); assert.equal(starts, 0); assert.equal(closes, 2)
  await assert.rejects(provider.dispose(), { code: 'TOOL_CLEANUP_FAILED' })
})
test('T7-41 acquisition already inside the provider remains owned after cleanup failure', async () => {
  const tool = createToolDefinition({ name: 'late-acquire', version: 1, description: '', operationClass: 'pure',
    inputSchema: { type: 'object' }, outputSchema: { type: 'null' } }, schemaLimits)
  const providerDescriptor = { providerId: 'late-acquire', adapterVersion: '1', resourceId: 'ledger',
    tools: [{ name: tool.name, version: tool.version }], maxConcurrentExecutions: 2,
    maxArgumentsBytes: 4096, maxResultBytes: 65536 }
  const entered = deferred(), release = deferred()
  let acquisitions = 0, starts = 0, closes = 0, lateSignal
  const provider = new ScriptedToolProvider({ descriptor: providerDescriptor, acquire: async (_plan, signal) => {
    const ordinal = ++acquisitions
    if (ordinal === 2) { lateSignal = signal; entered.resolve(); await release.promise }
    return createScriptedToolExecution(() => { starts++; return { kind: 'success', value: null } }, () => {
      closes++
      if (ordinal === 1) throw new Error('injected cleanup failure')
    })
  } })
  let late, pending
  try {
    const firstBinding = provider.prepare(tool, {}, limits)
    const lateBinding = provider.prepare(tool, {}, limits)
    const first = await firstBinding.acquire(firstBinding.plan, new AbortController().signal)
    pending = lateBinding.acquire(lateBinding.plan, new AbortController().signal)
    await entered.promise
    await assert.rejects(first.close(), { code: 'TOOL_CLEANUP_FAILED' })
    assert.equal(lateSignal.aborted, true)
    release.resolve(); late = await pending
    assert.throws(() => late.start(), { code: 'TOOL_PROVIDER_INACTIVE' })
    await late.close(); late = undefined
    assert.equal(acquisitions, 2); assert.equal(starts, 0); assert.equal(closes, 2)
    await assert.rejects(provider.dispose(), { code: 'TOOL_CLEANUP_FAILED' })
  } finally {
    release.resolve()
    if (late === undefined && pending !== undefined) late = await pending.catch(() => undefined)
    await late?.close()
    await provider.dispose().catch(error => {
      if (error?.code !== 'TOOL_CLEANUP_FAILED') throw error
    })
  }
})
test('T7-60 native capacity is one and released capacity is reusable', async () => fixture(async ({ workspace, options }) => {
  await writeFile(join(workspace, 'file'), 'test')
  const provider = await createWorkspaceReadTextProvider(options)
  const a = provider.prepare(definition, { path: 'file' }, limits); const b = provider.prepare(definition, { path: 'file' }, limits)
  const first = await a.acquire(a.plan, new AbortController().signal)
  await assert.rejects(b.acquire(b.plan, new AbortController().signal), error => error.code === 'TOOL_PROVIDER_BUSY')
  await first.close()
  assert.equal((await execute(provider, 'file')).result.kind, 'success'); await provider.dispose()
}))
test('T7-66 protected-root equality/ancestors/descendants reject; path prefixes alone do not overlap', async () => fixture(async ({ root, workspace, options }) => {
  const child = join(workspace, 'child'); await mkdir(child)
  for (const protectedRoots of [[workspace], [root], [child]]) {
    await assert.rejects(createWorkspaceReadTextProvider({ ...options, protectedRoots }), error => error.code === 'TOOL_WORKSPACE_INVALID')
  }
  const sibling = `${workspace}-other`; await mkdir(sibling)
  const provider = await createWorkspaceReadTextProvider({ ...options, protectedRoots: [sibling] }); await provider.dispose()
  await assert.rejects(createWorkspaceReadTextProvider({ ...options, rootPath: '.' }), error => error.code === 'TOOL_WORKSPACE_INVALID')
}))
test('T7-19/30 plan is a complete immutable comparison, not a digest shortcut', async () => fixture(async ({ options }) => {
  const provider = await createWorkspaceReadTextProvider(options)
  const binding = provider.prepare(definition, { path: 'file' }, limits)
  assert.deepEqual(decodePlan(binding.plan), binding.plan)
  assert.throws(() => decodePlan({ ...binding.plan, input: { path: 'different' } }), error => error.code === 'TOOL_BINDING_MISMATCH')
  await assert.rejects(binding.acquire({ ...binding.plan, target: { ...binding.plan.target, path: 'different' } }, new AbortController().signal), error => error.code === 'TOOL_BINDING_MISMATCH')
  await provider.dispose()
}))
test('T7-35/60 Scripted capacity and one-shot start/close do not reverse a ledger', async () => {
  let ledger = 0; let closed = 0
  const tool = createToolDefinition({ ...definition, name: 'ledger', operationClass: 'external', outputSchema: { type: 'integer' } }, schemaLimits)
  const descriptor = { providerId: 'scripted', adapterVersion: '1', resourceId: 'ledger', tools: [{ name: 'ledger', version: 1 }],
    maxConcurrentExecutions: 2, maxArgumentsBytes: 4096, maxResultBytes: 65536 }
  const provider = new ScriptedToolProvider({ descriptor, acquire: () => createScriptedToolExecution(() => ({ kind: 'success', value: ++ledger }), () => { closed++ }) })
  const plan = createPreparedToolPlan({ definition: tool, provider: descriptor, input: { path: 'x' }, limits, target: { kind: 'logical', resourceId: 'ledger' } })
  const binding = provider.prepare(tool, { path: 'x' }, limits); assert.deepEqual(binding.plan, plan)
  const execution = await binding.acquire(binding.plan, new AbortController().signal)
  assert.equal((await execution.start()).value, 1); assert.throws(() => execution.start())
  const closing = execution.close(); assert.equal(closing, execution.close()); await closing
  assert.equal(ledger, 1); assert.equal(closed, 1); await provider.dispose()
})

test('T7-05/30 provider plan accessors do not execute and cannot supply their own live budget', async () => {
  let getters = 0
  const bad = Object.defineProperty({}, 'limits', { enumerable: true, get() { getters++; return limits } })
  assert.throws(() => decodePlan(bad)); assert.equal(getters, 0)
  const scriptedDefinition = createToolDefinition({ name: 'echo', version: 1, description: '', operationClass: 'pure',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true }, outputSchema: { type: 'object' } }, schemaLimits)
  const descriptor = { providerId: 'budget-test', adapterVersion: '1', resourceId: 'ledger', tools: [{ name: 'echo', version: 1 }],
    maxConcurrentExecutions: 1, maxArgumentsBytes: 4096, maxResultBytes: 65536 }
  const plan = createPreparedToolPlan({ definition: scriptedDefinition, provider: descriptor, input: { x: 'a'.repeat(1000) }, limits,
    target: { kind: 'logical', resourceId: 'ledger' } })
  assert.throws(() => decodePlan(plan, { ...limits, maxPlanBytes: 256 }))
})

test('T7-42 close publishes its shared task before a cancellation listener reenters close', async () => {
  const tool = createToolDefinition({ name: 'echo', version: 1, description: '', operationClass: 'pure', inputSchema: { type: 'object' }, outputSchema: { type: 'null' } }, schemaLimits)
  let execution, nested, closes = 0
  const provider = new ScriptedToolProvider({ descriptor: { providerId: 'reentrant-close', adapterVersion: '1', resourceId: 'ledger',
    tools: [{ name: 'echo', version: 1 }], maxConcurrentExecutions: 1, maxArgumentsBytes: 4096, maxResultBytes: 65536 },
    acquire: (_plan, signal) => {
      signal.addEventListener('abort', () => { nested = execution.close() }, { once: true })
      return createScriptedToolExecution(() => ({ kind: 'success', value: null }), () => { closes++ })
    },
  })
  try {
    const binding = provider.prepare(tool, {}, limits)
    execution = await binding.acquire(binding.plan, new AbortController().signal)
    const task = execution.close(); assert.equal(task, nested)
    await task; assert.equal(closes, 1)
    assert.equal(execution.close(), task)
  } finally { await execution?.close(); await provider.dispose() }
})

test('T7-43 provider callback cannot await its own provider; release request still takes effect', async () => {
  const tool = createToolDefinition({ name: 'echo', version: 1, description: '', operationClass: 'pure', inputSchema: { type: 'object' }, outputSchema: { type: 'null' } }, schemaLimits)
  let provider, execution, closes = 0
  provider = new ScriptedToolProvider({ descriptor: { providerId: 'self-provider', adapterVersion: '1', resourceId: 'ledger',
    tools: [{ name: 'echo', version: 1 }], maxConcurrentExecutions: 1, maxArgumentsBytes: 4096, maxResultBytes: 65536 },
    acquire: () => createScriptedToolExecution(async () => {
      await assert.rejects(provider.dispose(), { code: 'TOOL_REENTRANT_WAIT' })
      return { kind: 'success', value: null }
    }, () => { closes++ }),
  })
  try {
    const binding = provider.prepare(tool, {}, limits)
    execution = await binding.acquire(binding.plan, new AbortController().signal)
    await execution.start()
    assert.throws(() => provider.prepare(tool, {}, limits), { code: 'TOOL_PROVIDER_INACTIVE' })
    const first = provider.dispose(); assert.equal(first, provider.dispose())
    await execution.close(); await first; assert.equal(closes, 1)
  } finally { await execution?.close(); await provider.dispose() }
})


test('T7-06 composite record budgets reject safe-integer arithmetic overflow at configuration entry', () => {
  assert.throws(() => readSchemaLimits({ ...schemaLimits, maxSchemaBytes: Number.MAX_SAFE_INTEGER }), { code: 'TOOL_REQUEST_INVALID' })
  assert.throws(() => readSchemaLimits({ ...schemaLimits, maxSchemaNodes: Number.MAX_SAFE_INTEGER }), { code: 'TOOL_REQUEST_INVALID' })
  for (const field of ['maxPlanBytes', 'maxResultBytes', 'maxJsonNodes', 'maxSchemaNodes', 'maxSchemaBytes']) {
    assert.throws(() => readLimits({ ...limits, [field]: Number.MAX_SAFE_INTEGER }), { code: 'TOOL_REQUEST_INVALID' })
  }
  assert.deepEqual(readLimits(limits), limits)
})
