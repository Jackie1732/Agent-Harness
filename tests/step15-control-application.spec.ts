import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { authorizeControl, localControlCaller, ControlAdmission, dispatchControl } from '../src/control/index.js'
import type { AnyControlOperation, ControlCaller, ControlLimits, ControlRequest } from '../src/control/index.js'
import type { ControlMethod } from '../src/protocol/index.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import type { ResolvedHostSpec } from '../src/host/config.js'
import { initializeHost } from '../src/host/initialization.js'
import { openHost } from '../src/host/runtime.js'
import type { AtomicHost } from '../src/host/runtime.js'
import { hostConfig } from './host/fixtures.js'
import { runnableWorkflowConfig } from './workflow/host-fixture.js'

const profileKey = '15000000-0000-4000-8000-000000000001'
const limits: ControlLimits = { maxWaitMs: 1000, observerScanIntervalMs: 5, maxPageEvents: 100, pageBytes: 1048576 }

async function invoke<M extends ControlMethod>(host: AtomicHost, spec: ResolvedHostSpec, caller: ControlCaller,
  request: ControlRequest<M>, budgets = limits) {
  await authorizeControl(host, spec, caller, request as AnyControlOperation)
  return dispatchControl(host, spec, caller, request, budgets, new AbortController().signal,
    mode => host.shutdown({ mode }), { domainReturned: false })
}

it('retains local keyed identities across instances while isolating API callers and stale run controls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-control-identity-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(join(directory, 'store')), directory))
  await initializeHost(spec)
  let host = await openHost(spec)
  const caller = localControlCaller(spec, profileKey)
  try {
    const submission = { method: 'input.submit', params: { agentKey: 'writer', submissionKey: 'k'.repeat(64), text: 'Local task' } } as const
    const first = await invoke(host, spec, caller, submission)
    const apiReceipt = await invoke(host, spec, { ...caller, namespace: 'api:researcher' },
      { ...submission, params: { ...submission.params, text: 'Remote task' } })
    expect(first.inputEventId).not.toBe(apiReceipt.inputEventId)
    expect(host.read().input('writer', { inputEventId: first.inputEventId })).toMatchObject({
      submission: { namespace: `local:${profileKey}`, key: submission.params.submissionKey }, rootId: null })
    const previousInstance = host.instanceId
    const closed = await invoke(host, spec, caller, { method: 'host.shutdown', params: { expectedInstanceId: previousInstance, mode: 'drain' } })
    expect(closed).toEqual({ instanceId: previousInstance, mode: 'drain', hostStatus: 'stopped' })
    host = await openHost(spec)
    expect(host.instanceId).not.toBe(previousInstance)
    expect(await invoke(host, spec, localControlCaller(spec, profileKey), submission)).toEqual({ ...first, reused: true })
    await expect(invoke(host, spec, caller, { method: 'host.run', params: { expectedInstanceId: previousInstance } }))
      .rejects.toMatchObject({ code: 'API_INSTANCE_MISMATCH', acceptance: 'not-accepted' })
    expect(host.read().input('writer', { inputEventId: first.inputEventId }).rootId).toBeNull()
    await expect(invoke(host, spec, caller, { ...submission, params: { ...submission.params, text: 'Changed task' } }))
      .rejects.toMatchObject({ code: 'AGENT_KEY_CONFLICT' })
  } finally { await host.shutdown({ mode: 'cancel' }); await rm(directory, { recursive: true, force: true }) }
})

it('uses consumer page bytes and carries the original cut through later local input acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-control-pages-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(join(directory, 'store')), directory))
  await initializeHost(spec)
  const host = await openHost(spec), caller = localControlCaller(spec, profileKey)
  try {
    const target = { kind: 'member', agentKey: 'writer' } as const
    await invoke(host, spec, caller, { method: 'input.submit', params: { agentKey: 'writer', submissionKey: 'before-cut', text: 'Before cut' } })
    const first = await invoke(host, spec, caller, { method: 'session.events', params: { target, maxEvents: 1 } })
    const pageBytes = Buffer.byteLength(JSON.stringify(first))
    const bounded = await invoke(host, spec, caller, { method: 'session.events', params: { target, maxEvents: 100 } }, { ...limits, pageBytes })
    expect(bounded).toEqual(first)
    expect(bounded.hasMore).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(pageBytes)
    const later = await invoke(host, spec, caller, { method: 'input.submit', params: { agentKey: 'writer', submissionKey: 'after-cut', text: 'After cut' } })
    const next = await invoke(host, spec, caller, { method: 'session.events', params: { target, maxEvents: 100, cursor: bounded.nextCursor! } })
    expect(next.through).toBe(first.through)
    expect(next.events.map(event => event.eventId)).not.toContain(later.inputEventId)
    await expect(invoke(host, spec, caller, { method: 'session.events', params: { target, maxEvents: 101 } }))
      .rejects.toMatchObject({ code: 'API_LIMIT_EXCEEDED', acceptance: 'not-applicable' })
  } finally { await host.shutdown({ mode: 'cancel' }); await rm(directory, { recursive: true, force: true }) }
})

it('derives Workflow control grants and preserves the caller namespace on durable controls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-control-workflow-'))
  const spec = resolveHostConfig(decodeHostConfig(runnableWorkflowConfig(join(directory, 'store')), directory))
  await initializeHost(spec)
  const host = await openHost(spec), caller = localControlCaller(spec, profileKey)
  try {
    expect(caller.agentKeys).toEqual(['writer', 'reviewer'])
    expect(caller.workflowKeys).toEqual(['research'])
    await expect(invoke(host, spec, { ...caller, workflowKeys: [] }, { method: 'workflow.get', params: { workflowKey: 'research' } }))
      .rejects.toMatchObject({ code: 'API_FORBIDDEN' })
    const requestKey = 'p'.repeat(64)
    await invoke(host, spec, caller, { method: 'workflow.pause', params: { workflowKey: 'research', requestKey, reason: 'Explicit pause' } })
    const page = await invoke(host, spec, caller, { method: 'session.events', params: { target: { kind: 'workflow', workflowKey: 'research' }, maxEvents: 100 } })
    expect(page.events).toContainEqual(expect.objectContaining({ type: 'workflow/control-requested',
      payload: expect.objectContaining({ requestKey: `local:${profileKey}:${requestKey}` }) }))
  } finally { await host.shutdown({ mode: 'cancel' }); await rm(directory, { recursive: true, force: true }) }
})

it('releases an observation quota after rejection without occupying input or control categories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-control-observers-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(join(directory, 'store')), directory))
  await initializeHost(spec)
  const host = await openHost(spec), caller = localControlCaller(spec, profileKey)
  const admission = new ControlAdmission({ maxPendingInputs: 1, maxPendingControls: 1, maxObservers: 1, maxPendingShutdowns: 1 })
  try {
    await expect(admission.run('session.events', () => invoke(host, spec, caller,
      { method: 'session.events', params: { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 1 } }, { ...limits, pageBytes: 1 })))
      .rejects.toMatchObject({ code: 'HOST_LIMIT_EXCEEDED' })
    await expect(admission.run('host.status', () => invoke(host, spec, caller, { method: 'host.status', params: {} })))
      .resolves.toMatchObject({ activity: 'idle' })
    await expect(admission.run('input.submit', () => invoke(host, spec, caller,
      { method: 'input.submit', params: { agentKey: 'writer', submissionKey: 'after-rejection', text: 'Accepted independently' } })))
      .resolves.toMatchObject({ reused: false })
  } finally { await host.shutdown({ mode: 'cancel' }); await rm(directory, { recursive: true, force: true }) }
})
