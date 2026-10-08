import { readFile } from 'node:fs/promises'
import { createSecureContext } from 'node:tls'
import { EffectOwner } from '../effect/owner.js'
import { SerialGate } from '../foundation/serial-gate.js'
import { createHarnessClient } from '../client/client.js'
import type { HarnessClient } from '../client/client.js'
import { decodeParams, CONTROL_PROTOCOL, CONTROL_VERSION, ProtocolError } from '../protocol/index.js'
import { inspectBoundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import { openAutomationJournal, automationTriggerKey } from './journal.js'
import type { AutomationJournal, AutomationTrigger } from './journal.js'
import { AutomationDriver, automationExecutionStatus, runAcceptance } from './driver.js'
import type { AutomationNotice } from './driver.js'
import { startAutomationSchedule } from './scheduler.js'
import { openAutomationWebhook } from './webhook.js'
import type { AutomationConfig, AutomationJob } from './config-types.js'
import { AutomationError } from './validation.js'

/** Receipts and status omit original task text and local material references. */
export function automationTriggerStatus(trigger: AutomationTrigger) {
  return { triggerKey: trigger.triggerKey, jobKey: trigger.jobKey, externalEventId: trigger.externalEventId, acceptedEventId: trigger.acceptedEventId,
    submitIntent: trigger.submitIntent, inputEventId: trigger.inputEventId, runIntent: trigger.runIntent, runAcceptance: runAcceptance(trigger),
    runUnknownAcknowledged: trigger.runUnknownAcknowledged, rejection: trigger.rejection, execution: automationExecutionStatus(trigger.observation),
    observationEventId: trigger.observationEventId, observation: trigger.observation }
}
export interface AutomationReady {
  readonly kind: 'automation-ready'; readonly automationKey: string; readonly journalSessionId: string
  readonly listen: { readonly host: string; readonly port: number }; readonly jobKeys: readonly string[]
}
export interface HarnessAutomation {
  readonly ready: AutomationReady
  /** Settles only after local resources release; rejection preserves work or cleanup failure. */
  readonly closed: Promise<void>
  /** Return the journal's latest certified observations, with their own timestamps and cuts. */
  status(): { readonly lifecycle: 'starting' | 'ready' | 'closing' | 'closed' | 'failed'; readonly driverBlocked: boolean; readonly unknownRuns: readonly string[];
    readonly activeTriggerKey: string | null; readonly queued: number; readonly triggers: readonly ReturnType<typeof automationTriggerStatus>[] }
  /** Durably admit a fixed Job event; a receipt does not establish input submission or Root completion. */
  accept(jobKey: string, eventId: string, text: string): Promise<{ readonly reused: boolean; readonly trigger: ReturnType<typeof automationTriggerStatus> }>
  /** Stop ingress and timers, join active work and leave queued facts for a later explicit service start. */
  dispose(): Promise<void>
}
function drivable(trigger: AutomationTrigger): boolean {
  return trigger.runIntent === null && trigger.rejection === null && (trigger.submitIntent === null || trigger.inputEventId !== null)
    && automationExecutionStatus(trigger.observation) !== 'closed'
}
/** Own local ingress, serial automation work and observation; disposing never shuts down the remote Host. */
export async function openHarnessAutomation(options: { readonly config: AutomationConfig; readonly bearerToken: string;
  readonly onNotice?: (notice: AutomationNotice) => void | Promise<void> }): Promise<HarnessAutomation> {
  const config = options.config
  if (!/^[\x21-\x7e]{32,4096}$/.test(options.bearerToken)) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  const [ca, cert, key, webhookCert, webhookKey] = await Promise.all([config.client.tls.caFile, config.client.tls.certFile, config.client.tls.keyFile,
    config.webhook.tls.certFile, config.webhook.tls.keyFile].map(path => readFile(path)))
  createSecureContext({ ca: ca!, cert: cert!, key: key! }); createSecureContext({ cert: webhookCert!, key: webhookKey! })
  const owner = new EffectOwner('automation'), admissions = new SerialGate()
  let journal!: AutomationJournal, client!: HarnessClient, driver!: AutomationDriver
  let lifecycle: 'starting' | 'ready' | 'closing' | 'closed' | 'failed' = 'starting', activeTriggerKey: string | null = null
  let admissionCount = 0, dirty = false, workTask: Promise<void> | undefined, disposal: Promise<void> | undefined
  let runtimeFailed = false, runtimeFailure: unknown
  let closedResolve!: () => void, closedReject!: (error: unknown) => void
  const closed = new Promise<void>((resolve, reject) => { closedResolve = resolve; closedReject = reject }); void closed.catch(() => undefined)
  const pending = (): readonly AutomationTrigger[] => journal.triggers.filter(drivable)
  const status: HarnessAutomation['status'] = () => ({ lifecycle, driverBlocked: journal.blockedRuns.length > 0, unknownRuns: journal.blockedRuns.map(trigger => trigger.triggerKey),
    activeTriggerKey, queued: pending().length, triggers: journal.triggers.map(automationTriggerStatus) })
  const dispose = (): Promise<void> => {
    if (disposal === undefined) {
      if (lifecycle !== 'failed') lifecycle = 'closing'
      disposal = Promise.resolve().then(async () => {
        try { await owner.dispose() }
        catch (error) { lifecycle = 'failed'; throw runtimeFailed ? runtimeFailure : error }
        if (runtimeFailed) throw runtimeFailure
        lifecycle = 'closed'
      })
      void disposal.then(closedResolve, closedReject)
    }
    return disposal
  }
  const failed = (error: unknown): void => { runtimeFailed = true; runtimeFailure = error; lifecycle = 'failed'; void dispose().catch(() => undefined) }
  const kick = (): void => {
    if (lifecycle !== 'ready') return
    dirty = true
    if (workTask !== undefined) return
    const task = Promise.resolve().then(async () => {
      while (dirty && lifecycle === 'ready') {
        dirty = false
        for (const trigger of journal.triggers) {
          if (lifecycle !== 'ready') break
          activeTriggerKey = trigger.triggerKey
          if (journal.blockedRuns.length === 0 && drivable(trigger)) await driver.drive(trigger.triggerKey)
          else if (trigger.submitIntent !== null && automationExecutionStatus(trigger.observation) !== 'closed') await driver.observe(trigger.triggerKey)
          activeTriggerKey = null
        }
      }
    })
    workTask = task
    void task.then(() => { workTask = undefined; activeTriggerKey = null; if (dirty) kick() }, error => { workTask = undefined; activeTriggerKey = null; failed(error) })
  }
  const accept: HarnessAutomation['accept'] = async (jobKey, eventId, taskText) => {
    if (lifecycle !== 'ready') throw new AutomationError('AUTOMATION_INACTIVE')
    if (admissionCount >= config.limits.maxPendingRequests) throw new AutomationError('AUTOMATION_LIMIT')
    admissionCount++
    try {
      return await admissions.run(async () => {
        if (lifecycle !== 'ready') throw new AutomationError('AUTOMATION_INACTIVE')
        const job = config.jobs.find(job => job.jobKey === jobKey)
        if (job === undefined || eventId.length === 0 || Buffer.byteLength(eventId) > 128) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
        const key = automationTriggerKey(config.automationKey, jobKey, eventId), limits = config.client.limits
        try {
          const params = decodeParams('input.submit', { agentKey: job.agentKey, submissionKey: key, text: taskText }, { maxBytes: limits.maxRequestBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes })
          inspectBoundedJson({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: '0'.repeat(36), method: 'input.submit', params },
            { maxBytes: limits.maxRequestBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes })
        } catch (error) {
          if (!(error instanceof ProtocolError || error instanceof JsonBoundaryError)) throw error
          throw new AutomationError(error instanceof ProtocolError ? error.code === 'API_LIMIT_EXCEEDED' ? 'AUTOMATION_LIMIT' : 'AUTOMATION_CONFIG_INVALID'
            : error.reason === 'invalid' ? 'AUTOMATION_CONFIG_INVALID' : 'AUTOMATION_LIMIT')
        }
        const result = await journal.accept(jobKey, eventId, taskText, pending().length, config.limits.maxQueued)
        if (!result.reused) kick()
        return { reused: result.reused, trigger: automationTriggerStatus(result.trigger) }
      })
    } finally { admissionCount-- }
  }
  try {
    const lease = await owner.run('automation-service', async context => {
      const store = await context.apply('journal', () => openAutomationJournal(config), value => value.dispose()); journal = store.journal
      client = await context.apply('client', () => createHarnessClient({ origin: config.client.origin,
        ...(config.client.serverName === null ? {} : { serverName: config.client.serverName }), tls: { ca: ca!, cert: cert!, key: key! }, limits: config.client.limits }), value => value.close())
      const remote = await client.request('host.status', {})
      if (remote.report.hostKey !== config.hostKey) throw new AutomationError('AUTOMATION_CONFLICT')
      driver = new AutomationDriver({ config, journal, client, now: Date.now, notice: async notice => { await options.onNotice?.(notice) } })
      await context.apply('serial-work', () => undefined, async () => { await admissions.drain(); await workTask })
      await context.apply('observer', () => {
        let timer: ReturnType<typeof setTimeout>
        const arm = (): void => { timer = setTimeout(() => { kick(); if (lifecycle === 'starting' || lifecycle === 'ready') arm() }, config.limits.observeIntervalMs) }; arm()
        return () => clearTimeout(timer)
      }, stop => stop())
      for (const job of config.jobs) if (job.trigger.kind === 'interval') await context.apply(`schedule:${job.jobKey}`,
        () => startAutomationSchedule(job as AutomationJob & { readonly trigger: Extract<AutomationJob['trigger'], { kind: 'interval' }> },
          async (eventId, text) => {
            if (workTask !== undefined || pending().length > 0 || journal.blockedRuns.length > 0) return
            try { await accept(job.jobKey, eventId, text) }
            catch (error) { if (!(error instanceof AutomationError && ['AUTOMATION_LIMIT', 'AUTOMATION_INACTIVE'].includes(error.code))) throw error }
          }, Date.now, failed), value => value.dispose())
      return await context.apply('webhook', () => openAutomationWebhook({ config, cert: webhookCert!, key: webhookKey!, token: options.bearerToken, accept, status }), value => value.dispose())
    })
    lifecycle = 'ready'
    const ready: AutomationReady = { kind: 'automation-ready', automationKey: config.automationKey, journalSessionId: config.journal.sessionId,
      listen: lease.value.listen, jobKeys: config.jobs.map(job => job.jobKey) }
    kick()
    return { ready, closed, status, accept, dispose }
  } catch (error) {
    lifecycle = 'failed'
    try { await owner.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Automation startup failed') }
    throw error
  }
}
