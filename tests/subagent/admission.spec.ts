import { describe, expect, it } from 'vitest'
import { emptyAgentBudget } from '../../src/agent/budget.js'
import { authorizeDelegation } from '../../src/subagent/authority.js'
import { delegationDeadline, reserveDelegationBudget } from '../../src/subagent/budget.js'
import type { DelegationCapabilities, DelegationRequest, SubagentLimits } from '../../src/subagent/contract.js'
import { decodeDelegationRequest, decodeSubagentLimits } from '../../src/subagent/request.js'

const limits: SubagentLimits = {
  maxUnresolvedDelegations: 4, maxActiveChildren: 4, maxChildDurationMs: 60000,
  maxProtocolStepsPerBatch: 8, maxRecoveryWrites: 20, maxRequestBytes: 8192,
  maxMaterialBytes: 1024, maxResultBytes: 4096, maxFileEntries: 8, maxProtocolConflicts: 4, maxDiscoveryEntries: 16,
}
const grant = { models: 2, steps: 2, tools: 1, messages: 4, waits: 2, outputTokens: 200 }
const request: DelegationRequest = { templateKey: 'research', templateVersion: 1, task: '核对材料',
  materials: [{ label: '输入', text: '已授权的材料' }], requestedBudget: grant, workspace: { kind: 'none' } }
const capability: DelegationCapabilities = {
  models: [{ providerId: 'scripted', model: 'fixed' }], tools: ['read_text'],
  workspaces: [{ resourceId: 'research', modes: ['shared-read', 'exclusive-write'], readPrefixes: ['input'], writePrefixes: ['output'] }],
}
const reservation = {
  parentUsed: { ...emptyAgentBudget, models: 1, steps: 1, waits: 1, outputTokens: 100 },
  parentLimit: { models: 4, steps: 4, tools: 2, messages: 8, waits: 4, outputTokens: 400 },
  requested: grant, templateCap: grant, parentGrantCap: grant,
  parentMaxOutputTokens: 100, childMaxOutputTokens: 100, maxQuestions: 2, maxProgress: 1,
}

describe('delegation admission data', () => {
  it('copies complete input and freezes nested materials and grants', () => {
    const original = { ...structuredClone(request) }
    const decoded = decodeDelegationRequest(original, limits)
    expect(decoded).toEqual(request)
    expect(Object.isFrozen(decoded.materials[0])).toBe(true)
    expect(Object.isFrozen(decoded.requestedBudget)).toBe(true)
    original.materials = []
    expect(decoded.materials).toHaveLength(1)
  })

  it.each([
    { ...request, extra: true }, { ...request, templateVersion: -0 },
    { ...request, task: '\ud800' }, { ...request, requestedBudget: { ...grant, models: 1.5 } },
    { ...request, materials: [{ label: 'x', text: '中'.repeat(342) }] },
    { ...request, workspace: { kind: 'none', resourceId: 'secret' } },
    { ...request, workspace: { kind: 'shared-read', resourceId: 'r', readFiles: ['../x'], writePrefixes: [] } },
    { ...request, workspace: { kind: 'shared-read', resourceId: 'r', readFiles: ['A', 'a'], writePrefixes: [] } },
    { ...request, workspace: { kind: 'shared-read', resourceId: 'r', readFiles: [], writePrefixes: ['output'] } },
  ])('rejects malformed or excessive input before reserving anything', value => {
    expect(() => decodeDelegationRequest(value, limits)).toThrow('invalid-request')
  })

  it('does not invoke getters at the request boundary', () => {
    let invoked = false
    const input = { ...request, get task() { invoked = true; return 'secret' } }
    expect(() => decodeDelegationRequest(input, limits)).toThrow('invalid-request')
    expect(invoked).toBe(false)
  })

  it('requires the complete limits and permits explicit zero capacities', () => {
    expect(decodeSubagentLimits({ ...limits, maxActiveChildren: 0 }).maxActiveChildren).toBe(0)
    expect(() => decodeSubagentLimits({ ...limits, inferredDefaults: true })).toThrow('invalid-limits')
    expect(() => decodeSubagentLimits({ ...limits, maxChildDurationMs: Number.MAX_SAFE_INTEGER })).toThrow('invalid-limits')
    expect(() => decodeSubagentLimits({ ...limits, maxProtocolStepsPerBatch: 0 })).toThrow('invalid-limits')
    expect(() => decodeSubagentLimits({ ...limits, maxDiscoveryEntries: 0 })).toThrow('invalid-limits')
  })
})

describe('delegated authority intersection', () => {
  const required = { providerId: 'scripted', model: 'fixed', tools: ['read_text'] }
  it('requires template, parent and current Host grants independently', () => {
    expect(() => authorizeDelegation(required, { kind: 'none' }, [capability, capability, capability])).not.toThrow()
    for (let missing = 0; missing < 3; missing++) {
      const grants: [DelegationCapabilities, DelegationCapabilities, DelegationCapabilities] = [capability, capability, capability]
      grants[missing] = { ...capability, tools: [] }
      expect(() => authorizeDelegation(required, { kind: 'none' }, grants)).toThrow('required-capability')
    }
  })
  it('does not grant a sibling path or broaden a requested prefix', () => {
    const workspace = { kind: 'exclusive-write' as const, resourceId: 'research', readFiles: ['input/a.txt'], writePrefixes: ['output/results'] }
    expect(() => authorizeDelegation(required, workspace, [capability, capability, capability])).not.toThrow()
    for (const prefix of ['out', 'output-other', '']) {
      expect(() => authorizeDelegation(required, { ...workspace, writePrefixes: [prefix] }, [capability, capability, capability])).toThrow('workspace-scope')
    }
  })
})

describe('conservative delegation budgets', () => {
  it('reserves grants and each side of the complete finite message protocol', () => {
    const result = reserveDelegationBudget(reservation)
    expect(result.parentReserved).toEqual({ models: 3, steps: 3, tools: 1, messages: 7, waits: 3, outputTokens: 300 })
    expect(result.childProtocolReserve.messages).toBe(4)
    expect(result.mailboxReserve).toEqual({ parent: { inbox: 4, outbox: 3 }, child: { inbox: 3, outbox: 4 } })
    // Using the previous debit rejects a second request instead of implicitly refunding the first.
    expect(() => reserveDelegationBudget({ ...reservation, parentUsed: result.parentReserved })).toThrow('parent-grant')
  })
  it('retains one full model continuation for the parent', () => {
    expect(() => reserveDelegationBudget({ ...reservation, parentLimit: { ...reservation.parentLimit, outputTokens: 399 } })).toThrow('parent-continuation')
  })
  it('rejects an unusable child grant and message arithmetic overflow', () => {
    expect(() => reserveDelegationBudget({ ...reservation, requested: { ...grant, messages: 3 } })).toThrow('child-minimum')
    expect(() => reserveDelegationBudget({ ...reservation, maxQuestions: Number.MAX_SAFE_INTEGER })).toThrow('message-overflow')
  })
  it('computes an absolute deadline from all three authorities', () => {
    const now = '2026-09-22T10:00:00.000Z'
    expect(delegationDeadline('2026-09-22T10:00:05.000Z', now, 10000, 20000)).toBe('2026-09-22T10:00:05.000Z')
    expect(delegationDeadline('2026-09-22T10:01:00.000Z', now, 10000, 5000)).toBe('2026-09-22T10:00:05.000Z')
    expect(() => delegationDeadline(now, now, 1000, 1000)).toThrow('parent-expired')
    expect(() => delegationDeadline('2026-09-22T10:01:00.000Z', now, Infinity, 1000)).toThrow('deadline-overflow')
  })
})
