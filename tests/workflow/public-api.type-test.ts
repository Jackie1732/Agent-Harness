import type { AtomicHost, WorkflowReport, WorkflowReportSummary, HostInspectionV3 } from '../../src/index.js'

declare const host: AtomicHost
const control = host.workflow('research')
const report: WorkflowReport = control.report()
const summary: WorkflowReportSummary = host.workflowReport()
declare const inspection: HostInspectionV3
void summary; void inspection.recovery.domainSupersedes

// @ts-expect-error Operator controls do not expose coordinator journals.
void control.journal
// @ts-expect-error Reports do not expose peer Session handles.
void report.session
// @ts-expect-error Recovery observations do not expose Writers.
void inspection.recovery.writer
// @ts-expect-error Runtime resources remain private to the Host.
void host.slots
// @ts-expect-error Internal admission maps are not public API.
void control.assignments
