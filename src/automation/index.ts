/** Independent ingress and scheduling consume the existing control API. */
export { decodeAutomationConfig, parseAutomationConfig, resolveAutomationConfig } from './config.js'
export type { AutomationConfig, AutomationJob, AutomationLimits } from './config-types.js'
export { openHarnessAutomation } from './runtime.js'
export type { HarnessAutomation, AutomationReady } from './runtime.js'
export type { AutomationNotice } from './driver.js'
export type { AutomationObservation } from './events.js'
export { AutomationError } from './validation.js'
