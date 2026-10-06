import type { JsonObject } from '../../src/foundation/json.js'
import { hostConfig } from '../host/fixtures.js'

export function experimentDefinition(root: string): JsonObject {
  const caseKey = 'question'
  return {
    version: 1, experimentKey: 'research',
    dataset: { datasetKey: 'sample', version: '1', cases: [{ caseKey, task: 'What is the answer?',
      materials: [{ logicalPath: 'notes.txt', mediaType: 'text/plain', source: { kind: 'inline', text: 'The answer is 42.\r\n' }, expectedSha256: null }],
      output: { outputKey: 'answer', mediaType: 'text/plain' }, primaryEvaluatorKey: 'exact' }] },
    variants: ['a', 'b'].map(variantKey => ({ variantKey, recipe: hostConfig(`${root}/template`), factors: { prompt: variantKey }, fixture: { kind: 'builtin' },
      bindings: [{ caseKey, kind: 'agent', inputMode: 'inline', agentKey: 'writer', materials: [], output: { kind: 'root-final' } }] })),
    comparisons: [{ comparisonKey: 'a-versus-b', variantA: 'a', variantB: 'b' }], repetitions: 2, order: 'alternating-pairs',
    evaluators: [{ evaluatorKey: 'exact', version: '1', implementationVersion: 'rules/v1', rules: [{ ruleKey: 'answer', kind: 'text-exact', normalize: [], expected: '42' }] }],
    runPolicy: { mode: 'fixture', maxDriveCalls: 16, maxWallTimeMs: 60000, onCaseFailure: 'continue' },
    storage: { controlRoot: `${root}/control`, workspaceRoot: `${root}/work`, maxRecordBytes: 2 * 1024 * 1024 },
    evidenceLimits: { maxCases: 10, maxVariants: 4, maxUnits: 40, maxInputBytes: 1024 * 1024, maxPlanBytes: 2 * 1024 * 1024,
      maxRecipeBytes: 1024 * 1024, maxSessionCount: 100, maxEvents: 10000, maxEvidenceBytes: 8 * 1024 * 1024, maxMetricSamples: 10000,
      maxReportBytes: 2 * 1024 * 1024, maxFixtureEntries: 100, maxFixtureBytes: 2 * 1024 * 1024 }, provenance: { verification: 'unverified' },
  }
}
