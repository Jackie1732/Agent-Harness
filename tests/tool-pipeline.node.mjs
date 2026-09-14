import assert from 'node:assert/strict'
import { test } from 'node:test'
import { h, fixture, deferred, toolLimits, schemaLimits, echoDefinition, descriptor, toolEvents, FaultBackend } from './helpers/tool-fixture.mjs'

// All runtime tests in this file load the actual built public root. No replacement validator.
test('T7-02/04/30/35 direct request uses four facts, a frozen input, one approval and one execution', async () => {
  await fixture(async f => {
    const request = { name: 'echo', input: { n: 7 } }
    const task = f.runner.invoke(request); request.input.n = 99
    const result = await task
    assert.equal(result.payload.outcome, 'succeeded')
    assert.deepEqual(result.payload.result, { kind: 'success', value: { n: 7 } })
    assert.deepEqual(toolEvents(f.session).map(event => event.stored.type), [
      'tool/invocation-requested', 'tool/authorization-decided', 'tool/invocation-started', 'tool/invocation-settled',
    ])
    assert.equal(f.trace.starts, 1); assert.equal(f.trace.closes, 1); assert.equal(f.trace.approvals, 1)
    assert.deepEqual(f.trace.approved[0].plan, f.trace.plans[0])
    assert.deepEqual(f.trace.plans[0].input, { n: 7 }); assert(Object.isFrozen(f.trace.plans[0].input))
    assert.equal(f.runner.snapshot().pendingInvocationId, null)
    const snapshot = f.session.snapshot()
    await f.runner.dispose(); await f.registration.dispose(); await f.provider.dispose()
    assert.deepEqual(h.projectToolSession(snapshot), h.projectToolSession(snapshot))
  })
})

for (const [name, input] of [['string not coerced', { n: '7' }], ['fraction not integer', { n: 1.5 }], ['missing required', {}], ['additional property', { n: 1, extra: true }]]) {
  test(`T7-07/08 schema rejects ${name} before policy and execution`, async () => fixture(async f => {
    const original = structuredClone(input)
    const result = await f.runner.invoke({ name: 'echo', input })
    assert.equal(result.payload.outcome, 'rejected'); assert.equal(result.payload.result.code, 'invalid-arguments')
    assert.equal(f.trace.prepares, 0); assert.equal(f.trace.approvals, 0); assert.equal(f.trace.starts, 0)
    assert.deepEqual(input, original)
  }))
}
for (const [type, value, wrong] of [['string', 'x', 1], ['boolean', true, 'true'], ['number', 1.5, '1.5'], ['integer', 1, 1.5], ['null', null, false],
  ['array', [1, 2], [1, '2']], ['object', { inner: 1 }, []]]) {
  test(`T7-07/09 actual Ajv2020 validates ${type} and does not coerce`, async () => {
    const schema = type === 'array' ? { type, items: { type: 'integer' } } : { type }
    const definition = echoDefinition({ inputSchema: { type: 'object', properties: { value: schema }, required: ['value'], additionalProperties: false }, outputSchema: { type: 'object' } })
    await fixture(async f => {
      const yes = await f.runner.invoke({ name: 'echo', input: { value } }); assert.equal(yes.payload.outcome, 'succeeded')
      const no = await f.runner.invoke({ name: 'echo', input: { value: wrong } }); assert.equal(no.payload.outcome, 'rejected')
      assert.equal(f.trace.starts, 1)
    }, { definition })
  })
}
test('T7-08/09 actual Ajv checks special own keys and structural enum equality', async () => {
  const inputSchema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"object","enum":[{"a":1,"b":2}]},"constructor":{"type":"integer"}},"required":["__proto__","constructor"],"additionalProperties":false}')
  await fixture(async f => {
    const input = JSON.parse('{"__proto__":{"b":2,"a":1},"constructor":4}')
    const yes = await f.runner.invoke({ name: 'echo', input }); assert.equal(yes.payload.outcome, 'succeeded')
    const no = await f.runner.invoke({ name: 'echo', input: JSON.parse('{"__proto__":{"a":2,"b":2},"constructor":4}') })
    assert.equal(no.payload.outcome, 'rejected'); assert.equal(f.trace.starts, 1)
    assert.equal(Object.prototype.a, undefined); assert(Object.hasOwn(input, '__proto__'))
  }, { definition: echoDefinition({ inputSchema, outputSchema: { type: 'object' } }) })
})

test('T7-11 output-schema failure preserves already observed external ledger', async () => fixture(async f => {
  const result = await f.runner.invoke({ name: 'echo', input: { n: 1 } })
  assert.equal(result.payload.outcome, 'failed'); assert.equal(result.payload.result.code, 'TOOL_RESULT_INVALID')
  assert.equal(result.payload.execution, 'execution-observed'); assert.equal(result.payload.emission, 'may-have-occurred')
  assert.equal(f.trace.ledger, 1); assert.equal(f.trace.closes, 1)
}, { execute: () => ({ kind: 'success', value: { n: 'bad' } }) }))

test('T7-27 missing policy fails closed before any request or provider work', async () => fixture(async f => {
  assert.throws(() => new h.SessionToolRunner({ session: f.session, scope: f.scope, registry: f.registry, limits: toolLimits }), { code: 'TOOL_POLICY_INVALID' })
  assert.equal(toolEvents(f.session).length, 0); assert.equal(f.trace.starts, 0)
}, { noRunner: true }))

test('T7-28 deny is a real CP-A followed by rejected CP2 and no acquisition', async () => fixture(async f => {
  const result = await f.runner.invoke({ name: 'echo', input: { n: 1 } })
  assert.equal(result.payload.outcome, 'rejected'); assert.equal(result.payload.result.code, 'policy-denied')
  assert.deepEqual(toolEvents(f.session).map(e => e.stored.type), ['tool/invocation-requested', 'tool/authorization-decided', 'tool/invocation-settled'])
  assert.equal(f.trace.acquisitions, 0); assert.equal(f.trace.starts, 0)
}, { decide: () => ({ kind: 'deny', reasonCode: 'research-denied' }) }))

for (const kind of ['throw', 'malformed', 'extra-field']) {
  test(`T7-29 ${kind} policy result never becomes a fabricated deny audit`, async () => fixture(async f => {
    await assert.rejects(f.runner.invoke({ name: 'echo', input: { n: 1 } }), error => {
      assert.equal(error.code, 'TOOL_POLICY_INVALID'); assert(error.details.settledEventId)
      assert.equal(JSON.stringify(error).includes('SECRET'), false); return true
    })
    assert.equal(toolEvents(f.session).some(e => e.stored.type === 'tool/authorization-decided'), false)
    assert.equal(f.runner.snapshot().invocations[0].settled.payload.outcome, 'failed'); assert.equal(f.trace.starts, 0)
  }, { decide: () => {
    if (kind === 'throw') throw new Error('SECRET internal policy data')
    return kind === 'malformed' ? { allow: true } : { kind: 'allow', reasonCode: 'ok', secret: 'SECRET' }
  } }))
}
for (const stop of ['signal', 'registration', 'runner', 'scope', 'policy']) {
  for (const decision of ['allow', 'deny']) {
    test(`T7-31/32 late ${decision} after ${stop} waits but is not committed`, async () => {
      const entered = deferred(), release = deferred(); const signal = new AbortController()
      await fixture(async f => {
        f.releaseOnCleanup(release)
        const task = f.runner.invoke({ name: 'echo', input: { n: 1 } }, { signal: signal.signal })
        await entered.promise
        let settled = false; void task.then(() => { settled = true }, () => { settled = true })
        let close
        if (stop === 'signal') signal.abort()
        else if (stop === 'registration') close = f.registration.dispose()
        else if (stop === 'runner') close = f.runner.dispose()
        else if (stop === 'scope') close = f.scope.dispose()
        else f.policyLife.abort()
        assert.equal(settled, false); assert.equal(f.trace.starts, 0)
        release.resolve(); const result = await task; await close
        assert.equal(result.payload.outcome, 'cancelled')
        assert.equal(toolEvents(f.session).some(e => e.stored.type === 'tool/authorization-decided'), false)
        assert.equal(f.trace.acquisitions, 0); assert.equal(f.trace.starts, 0)
      }, { decide: async () => { entered.resolve(); await release.promise; return { kind: decision, reasonCode: 'late' } } })
    })
  }
}

test('T7-34 pre-aborted input has no event, borrow, prepare, approval or start', async () => fixture(async f => {
  const signal = new AbortController(); signal.abort()
  assert.throws(() => f.runner.invoke({ name: 'echo', input: { n: 1 } }, { signal: signal.signal }), { code: 'TOOL_CANCELLED' })
  assert.equal(toolEvents(f.session).length, 0); assert.equal(f.registry.snapshot()[0].inFlight, 0)
  assert.equal(f.trace.prepares, 0); assert.equal(f.trace.starts, 0)
}))

test('T7-38/42 dispose stays pending while an abort-ignoring execution is running', async () => {
  const entered = deferred(), release = deferred()
  await fixture(async f => {
    f.releaseOnCleanup(release)
    const task = f.runner.invoke({ name: 'echo', input: { n: 1 } }); await entered.promise
    const disposal = f.runner.dispose(); assert.equal(disposal, f.runner.dispose())
    assert.equal(f.trace.signals[0].aborted, true); assert.equal(f.trace.closes, 0)
    assert.equal(f.runner.snapshot().invocations[0].state, 'started')
    release.resolve(); const result = await task; await disposal
    assert.equal(result.payload.outcome, 'cancelled'); assert.equal(f.trace.closes, 1)
  }, { execute: async plan => { entered.resolve(); await release.promise; return { kind: 'success', value: plan.input } } })
})

test('T7-39 cancel-first still validates a returned invalid result', async () => {
  const entered = deferred(), release = deferred(); const signal = new AbortController()
  await fixture(async f => {
    f.releaseOnCleanup(release)
    const task = f.runner.invoke({ name: 'echo', input: { n: 1 } }, { signal: signal.signal }); await entered.promise
    signal.abort(); release.resolve(); const result = await task
    assert.equal(result.payload.outcome, 'cancelled'); assert.equal(result.payload.failure.code, 'TOOL_RESULT_INVALID')
    assert.equal(f.trace.ledger, 1); assert.equal(f.trace.closes, 1)
  }, { execute: async () => { entered.resolve(); await release.promise; return { kind: 'success', value: { n: 'invalid' } } } })
})

test('T7-39 result-first remains succeeded while later cancellation still reaches cleanup', async () => {
  const closing = deferred(), release = deferred()
  await fixture(async f => {
    f.releaseOnCleanup(release)
    const task = f.runner.invoke({ name: 'echo', input: { n: 1 } }); await closing.promise
    assert.equal(f.trace.signals[0].aborted, true)
    const disposed = f.runner.dispose(); release.resolve()
    const result = await task; await disposed
    assert.equal(result.payload.outcome, 'succeeded'); assert.equal(result.payload.cleanup.status, 'complete')
  }, { close: async () => { closing.resolve(); await release.promise } })
})

test('T7-40 partial acquire failure performs no start and has no unowned operation', async () => {
  let active = 0, partialCloses = 0
  await fixture(async f => {
    await assert.rejects(f.runner.invoke({ name: 'echo', input: { n: 1 } }), { code: 'TOOL_PROVIDER_INVALID' })
    assert.equal(active, 0); assert.equal(partialCloses, 1); assert.equal(f.trace.starts, 0)
    assert.equal(f.runner.snapshot().invocations[0].settled.payload.execution, 'not-started')
  }, { acquire: () => { active++; try { throw new Error('partial construction') } finally { active--; partialCloses++ } } })
})

test('T7-41/42 cleanup failure preserves committed result, sticky errors and one inverse', async () => fixture(async f => {
  await assert.rejects(f.runner.invoke({ name: 'echo', input: { n: 1 } }), error => {
    assert.equal(error.code, 'TOOL_CLEANUP_FAILED'); assert(error.details.settledEventId); return true
  })
  const result = f.runner.snapshot().invocations[0].settled.payload
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.cleanup.status, 'incomplete')
  assert.equal(result.cleanup.failed, 1); assert.equal(f.trace.ledger, 1)
  const disposed = f.runner.dispose(); assert.equal(disposed, f.runner.dispose())
  await assert.rejects(disposed, { code: 'TOOL_CLEANUP_FAILED' })
  await assert.rejects(f.provider.dispose(), { code: 'TOOL_CLEANUP_FAILED' }); assert.equal(f.trace.closes, 1)
}, { close: () => { throw new Error('SECRET cleanup') }, allowCleanupFailure: true }))

test('T7-43 policy cannot await its owning runner disposal, but the stop request remains effective', async () => {
  let owner
  await fixture(async f => {
    owner = f.runner
    const result = await f.runner.invoke({ name: 'echo', input: { n: 1 } })
    assert.equal(result.payload.outcome, 'cancelled'); assert.equal(f.trace.starts, 0)
    await f.runner.dispose()
  }, { decide: async () => {
    await assert.rejects(owner.dispose(), { code: 'TOOL_REENTRANT_WAIT' })
    return { kind: 'allow', reasonCode: 'too-late' }
  } })
})

test('T7-44 same Handle has exactly one pending invocation across two runners', async () => {
  const entered = deferred(), release = deferred()
  await fixture(async f => {
    f.releaseOnCleanup(release)
    const other = f.makeRunner()
    const tasks = [f.runner.invoke({ name: 'echo', input: { n: 1 } }), other.invoke({ name: 'echo', input: { n: 2 } })]
    const outcomes = Promise.allSettled(tasks)
    await entered.promise; release.resolve(); const results = await outcomes
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(results.find(item => item.status === 'rejected').reason.code, 'TOOL_SESSION_BUSY')
    assert.equal(f.trace.starts, 1); assert.equal(toolEvents(f.session).filter(e => e.stored.type === 'tool/invocation-requested').length, 1)
    assert.equal(f.session.status, 'open')
  }, { execute: async plan => { entered.resolve(); await release.promise; return { kind: 'success', value: plan.input } } })
})

test('T7-45 reused identity is a conflict, never a query for the old success', async () => fixture(async f => {
  const id = h.parseToolInvocationId('10000000-0000-0000-0000-000000000007')
  const runner = f.makeRunner({ identity: { nextInvocationId: () => id } })
  await runner.invoke({ name: 'echo', input: { n: 1 } })
  await assert.rejects(runner.invoke({ name: 'echo', input: { n: 2 } }), { code: 'TOOL_ID_CONFLICT' })
  assert.equal(f.trace.starts, 1); assert.equal(f.registry.snapshot()[0].inFlight, 0)
}))

for (const point of ['tool/invocation-requested', 'tool/authorization-decided', 'tool/invocation-started']) {
  test(`T7-36/37 CP guard at ${point} has zero start before commit and cancellation`, async () => {
    const entered = deferred(), release = deferred(); const signal = new AbortController()
    const backend = new FaultBackend(new h.MemorySessionBackend({ maxRecordBytes: 262144 }), async event => {
      if (event.type === point) { entered.resolve(); await release.promise }
    })
    await fixture(async f => {
      f.releaseOnCleanup(release)
      const task = f.runner.invoke({ name: 'echo', input: { n: 1 } }, { signal: signal.signal })
      await entered.promise; assert.equal(f.trace.starts, 0); signal.abort(); release.resolve()
      const result = await task; assert.equal(result.payload.outcome, 'cancelled'); assert.equal(result.payload.execution, 'not-started')
      assert.equal(f.trace.starts, 0)
    }, { backend })
  })
}

test('T7-58 actual Session ceiling rejects before policy/acquisition/execution', async () => fixture(async f => {
  await assert.rejects(f.runner.invoke({ name: 'echo', input: { n: 1 } }), { code: 'TOOL_RECORD_BUDGET' })
  assert.equal(toolEvents(f.session).length, 0); assert.equal(f.trace.starts, 0); assert.equal(f.trace.approvals, 0)
}, { maxRecordBytes: 2048 }))

test('T7-59 escaped result budget failure is durable and does not reverse external effects', async () => fixture(async f => {
  const result = await f.runner.invoke({ name: 'echo', input: { n: 1 } })
  assert.equal(result.payload.result.code, 'TOOL_RESULT_LIMIT'); assert.equal(result.payload.outcome, 'failed')
  assert.equal(f.trace.ledger, 1); assert.equal(f.trace.closes, 1)
}, { definition: echoDefinition({ outputSchema: { type: 'string' } }), limits: { ...toolLimits, maxResultBytes: 256 }, execute: () => ({ kind: 'success', value: '\0'.repeat(100) }) }))
