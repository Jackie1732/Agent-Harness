import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { decodeAutomationConfig, parseAutomationConfig, resolveAutomationConfig, automationConfigDigest } from '../../src/automation/config.js'
import { config } from './fixtures.js'

describe('fixed automation configuration', () => {
  it('resolves existing sample and stable configuration digest without opening resources', async () => {
    const sample = parseAutomationConfig(await readFile(new URL('../../examples/automation-config.json', import.meta.url), 'utf8'))
    const resolved = resolveAutomationConfig(sample, 'C:/local-deployment')
    expect(resolved.journal.root).toMatch(/automation-store$/)
    expect(automationConfigDigest(resolved)).toBe(automationConfigDigest(resolved))
    expect(automationConfigDigest({ ...resolved, hostKey: 'changed' })).not.toBe(automationConfigDigest(resolved))
  })
  it.each([
    { extra: true }, { schemaVersion: 2 }, { automationKey: 'unsafe/key' }, { jobs: [] },
    { client: { ...config('C:/tests', 1).client, origin: 'http://localhost' } },
    { limits: { ...config('C:/tests', 1).limits, observeIntervalMs: 0 } },
    { journal: { ...config('C:/tests', 1).journal, maxRecordBytes: 1 } },
    { jobs: [{ jobKey: 'review', agentKey: 'writer', trigger: { kind: 'interval', anchor: '2026-10-08', intervalMs: 10, text: 'review' } }] },
    { jobs: [config('C:/tests', 1).jobs[0], config('C:/tests', 1).jobs[0]] },
  ])('rejects incomplete or incompatible configuration before acquisition: %j', patch => {
    expect(() => decodeAutomationConfig({ ...config('C:/tests', 1), ...patch })).toThrow()
  })
})
