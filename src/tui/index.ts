/** Terminal entrypoints are dynamically imported only by explicit interactive routes. */
export { runTui } from './lifecycle.js'
export { runSetupWizard, runConfigCreate, runConfigEditor, runWorkflowBindingsEditor } from './wizards.js'
