import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { authorizeControl, localControlCaller, assertControlActivity, ControlAdmission, dispatchControl } from '../src/control/index.js'
import type { AnyControlOperation } from '../src/control/index.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import { initializeHost } from '../src/host/initialization.js'
import { openHost } from '../src/host/runtime.js'
import { ScriptedModelProvider } from '../src/model/providers/scripted.js'
import { hostConfig } from './host/fixtures.js'

it('admits input, observation and cancellation while a local business run owns its category', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-control-concurrency-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(join(directory, 'store')), directory))
  await initializeHost(spec)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const host = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    script: async function* (_submission, signal) {
      yield { kind: 'message-start', responseId: 'held-run', reportedModel: member.spec.target.model }
      entered()
      signal.addEventListener('abort', release, { once: true })
      try { await held }
      finally { signal.removeEventListener('abort', release) }
      if (signal.aborted) return
      yield { kind: 'block-start', index: 0, block: 'text' }
      yield { kind: 'text-delta', index: 0, text: 'Completed' }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
    } }) } })
  const caller = localControlCaller(spec, '15000000-0000-4000-8000-000000000001')
  const admission = new ControlAdmission({ maxPendingInputs: 1, maxPendingControls: 1, maxObservers: 1, maxPendingShutdowns: 1 })
  const invoke = async (operation: AnyControlOperation) => {
    await authorizeControl(host, spec, caller, operation)
    assertControlActivity(host, operation.method)
    return admission.run(operation.method, () => dispatchControl(host, spec, caller, operation,
      { maxWaitMs: 1000, observerScanIntervalMs: 5, maxPageEvents: 100, pageBytes: 1048576 },
      new AbortController().signal, mode => host.shutdown({ mode }), { domainReturned: false }))
  }
  let running: Promise<unknown> | undefined
  try {
    await invoke({ method: 'input.submit', params: { agentKey: 'writer', submissionKey: 'running', text: 'Run this task' } })
    running = invoke({ method: 'host.run', params: { expectedInstanceId: host.instanceId } })
    await started
    await expect(invoke({ method: 'host.run', params: { expectedInstanceId: host.instanceId } }))
      .rejects.toMatchObject({ code: 'API_BUSY', acceptance: 'not-accepted' })
    await expect(invoke({ method: 'input.submit', params: { agentKey: 'writer', submissionKey: 'during-run', text: 'Queued independently' } }))
      .resolves.toMatchObject({ reused: false })
    await expect(invoke({ method: 'agent.pause', params: { agentKey: 'writer', expectedInstanceId: host.instanceId } }))
      .resolves.toMatchObject({ paused: true })
    await expect(invoke({ method: 'host.status', params: {} })).resolves.toMatchObject({ activity: 'run' })
    const rootId = host.read().agent('writer').report.roots[0]!.id
    await expect(invoke({ method: 'root.cancel', params: { agentKey: 'writer', rootId, reason: 'Operator stop' } }))
      .resolves.toMatchObject({ stopControl: expect.any(String) })
    await running
    expect(host.read().root('writer', rootId).outcome).toBe('cancelled')
    await expect(invoke({ method: 'host.run', params: { expectedInstanceId: host.instanceId } }))
      .resolves.toMatchObject({ instanceId: host.instanceId })
  } finally {
    release(); await Promise.allSettled(running === undefined ? [] : [running])
    await host.shutdown({ mode: 'cancel' }); await rm(directory, { recursive: true, force: true })
  }
}, 30000)
