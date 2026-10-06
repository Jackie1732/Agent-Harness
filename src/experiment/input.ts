import type { ExperimentBinding, FrozenExperimentCase } from './definition-types.js'

/** Render only declared research materials; expected answers stay in the control root. */
export function renderExperimentTask(item: FrozenExperimentCase, binding: ExperimentBinding): string {
  if (item.materials.length === 0) return item.task
  const materialText = item.materials.map(material => binding.inputMode === 'inline'
    ? `Material: ${material.logicalPath}\n${material.text}`
    : `Material: ${material.logicalPath} -> ${binding.materials.find(entry => entry.logicalPath === material.logicalPath)!.relativePath}`)
  return `${item.task}\n\n${materialText.join('\n\n')}`
}
