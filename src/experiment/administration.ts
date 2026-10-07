import type { ExperimentFileRef, ExperimentLocation } from './definition-types.js'
import type { ExperimentJournalSnapshot } from './journal-types.js'
import { ExperimentError } from './errors.js'
import { recordExperimentReport } from './report.js'
import { openExperimentStorage, readExperimentStorage } from './storage.js'
import { experimentKey } from './parsing.js'
import { unlockHostStorage } from '../host/storage-lock.js'

/** Committed metadata status; an active unit does not establish that its old controller is alive. */
export type ExperimentStatus = { readonly kind: 'uninitialized'; readonly location: ExperimentLocation | null } | {
  readonly kind: 'initialized'
  readonly location: ExperimentLocation
  readonly cut: number
  readonly finalized: boolean
  readonly activeUnit: string | null
  readonly primaryReportKey: string | null
  readonly counts: { readonly planned: number; readonly started: number; readonly sealed: number; readonly unresolved: number; readonly unstarted: number }
}

/** Inspect committed metadata without acquiring a Writer, removing markers, or creating a missing root. */
export async function statusExperiment(input: string | ExperimentLocation): Promise<ExperimentStatus> {
  const read = await readExperimentStorage(input)
  if (read.kind === 'uninitialized') return { kind: read.kind, location: read.location }
  const state = read.state
  return Object.freeze({ kind: 'initialized', location: read.location, cut: state.position, finalized: state.finalized !== null,
    activeUnit: state.activeUnit, primaryReportKey: state.reports.find(report => report.payload.kind === 'primary')?.payload.reportKey ?? null,
    counts: Object.freeze({ planned: state.units.length, started: state.units.filter(unit => unit.started !== null).length,
      sealed: state.units.filter(unit => unit.sealed !== null).length, unresolved: state.units.filter(unit => unit.unresolved !== null).length,
      unstarted: state.units.filter(unit => unit.started === null).length }) })
}

export interface ClosedInterruptedExperiment {
  readonly location: ExperimentLocation
  readonly state: ExperimentJournalSnapshot
  readonly report: ExperimentFileRef
}

function reportKeyFor(state: ExperimentJournalSnapshot, requested: string | undefined): string {
  const primary = state.reports.find(report => report.payload.kind === 'primary')?.payload.reportKey
  if (primary !== undefined && requested !== undefined && primary !== requested) throw new ExperimentError('EXPERIMENT_CONFLICT', 'primary-report-key-changed')
  return primary ?? requested ?? 'interrupted'
}

/** Close metadata after an explicitly stopped predecessor; never initializes, opens, or recovers the assessed Host. */
export async function closeInterruptedExperiment(input: string | ExperimentLocation,
  options: { readonly predecessorStopped: true; readonly expectedToken?: string; readonly reportKey?: string }): Promise<ClosedInterruptedExperiment> {
  if (options.predecessorStopped !== true) throw new ExperimentError('EXPERIMENT_INPUT_INVALID', 'predecessor-stop-confirmation-required')
  const requestedReportKey = options.reportKey === undefined ? undefined : experimentKey(options.reportKey, 'report-key')
  const read = await readExperimentStorage(input)
  if (read.kind === 'uninitialized') throw new ExperimentError('EXPERIMENT_STATE_INVALID', 'experiment-uninitialized')
  if (read.state.finalized !== null) {
    reportKeyFor(read.state, requestedReportKey)
    if (options.expectedToken !== undefined) {
      try { await unlockHostStorage(read.location.controlRoot, { predecessorStopped: true, expectedToken: options.expectedToken }) }
      catch (cause) {
        // An already released marker makes a repeated finalized close a read-only result.
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
    }
    const report = read.state.reports.find(report => report.payload.reportKey === read.state.finalized!.payload.reportKey)!
    return { location: read.location, state: read.state, report: report.payload.report }
  }
  const storage = await openExperimentStorage(read.location, options)
  try {
    const current = storage.journal.snapshot()
    const reportKey = reportKeyFor(current, requestedReportKey)
    if (current.activeUnit !== null) await storage.journal.unresolveUnit({ unitKey: current.activeUnit, outcome: 'interrupted',
      reason: 'controller-interrupted', closure: 'unknown', evidence: null })
    const report = await recordExperimentReport(storage, { reportKey, kind: 'primary', finalize: true,
      unstartedReason: 'not-run-after-interruption' })
    return { location: storage.location, state: storage.journal.snapshot(), report: report.reference }
  } finally { await storage.dispose() }
}
