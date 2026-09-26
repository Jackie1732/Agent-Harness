import { describe, expect, it } from 'vitest'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { resolveWorkflowNode } from '../../src/workflow/graph.js'
import { workflowFixture } from './fixtures.js'

describe('fixed workflow definition', () => {
  it('uses accepted direct predecessor data to decide a ready input', () => {
    const definition = decodeWorkflowDefinition(workflowFixture())
    const ready = resolveWorkflowNode(definition.nodes[0]!, new Map(), definition)
    expect(ready).toEqual({ kind: 'ready', inputs: {} })
    const writer = definition.nodes[1]!
    expect(resolveWorkflowNode(writer, new Map(), definition)).toMatchObject({ kind: 'blocked' })
    expect(resolveWorkflowNode(writer, new Map([['read', { kind: 'accepted', value: { text: 'evidence' } }]]), definition))
      .toEqual({ kind: 'ready', inputs: { text: 'evidence' } })
  })

  it('rejects a dependency cycle and unrelated input source before any resource use', () => {
    const original = workflowFixture()
    const read = original.nodes[0]!
    const cycle = { ...original, nodes: [{ ...read, dependencies: [{ nodeKey: 'write', mode: 'required' }] }, original.nodes[1]] }
    expect(() => decodeWorkflowDefinition(cycle)).toThrow('dependency-cycle')
    const missing = { ...original, nodes: [{ ...read, inputs: [{ name: 'leak', source: { kind: 'accepted', nodeKey: 'write', path: ['text'] } }] }, original.nodes[1]] }
    expect(() => decodeWorkflowDefinition(missing)).toThrow('input-dependency')
  })

  it('distinguishes false guards, missing guard fields, and required skipped work', () => {
    const base = workflowFixture()
    const changed = { ...base, nodes: [base.nodes[0], { ...base.nodes[1], guard: {
      kind: 'equals', nodeKey: 'read', path: ['ok'], value: true,
    } }] }
    const definition = decodeWorkflowDefinition(changed)
    const node = definition.nodes[1]!
    expect(resolveWorkflowNode(node, new Map([['read', { kind: 'accepted', value: { text: 'x', ok: false } }]]), definition))
      .toMatchObject({ kind: 'skipped', reason: 'guard-false' })
    expect(resolveWorkflowNode(node, new Map([['read', { kind: 'accepted', value: { text: 'x' } }]]), definition))
      .toMatchObject({ kind: 'failed', reason: 'guard-value' })
    expect(resolveWorkflowNode(node, new Map([['read', { kind: 'skipped' }]]), definition))
      .toMatchObject({ kind: 'skipped', reason: 'required-dependency-skipped' })
  })

  it('rejects an unsupported Schema keyword and an excessive graph', () => {
    const base = workflowFixture()
    const badSchema = { ...base, nodes: [{ ...base.nodes[0], inputSchema: { ...base.nodes[0]!.inputSchema, maxProperties: 1 } }, base.nodes[1]] }
    expect(() => decodeWorkflowDefinition(badSchema)).toThrow()
    const limits = { ...base.limits, maxEdges: 1 }
    const extraEdge = { ...base, limits, nodes: [base.nodes[0], { ...base.nodes[1], dependencies: [
      { nodeKey: 'read', mode: 'required' }, { nodeKey: 'read', mode: 'optional' },
    ] }] }
    expect(() => decodeWorkflowDefinition(extraEdge)).toThrow()
  })

  it('requires explicit disclosure to downstream peers and fixed member grants', () => {
    const base = workflowFixture()
    const hidden = { ...base, communication: { ...base.communication, disclosures: [
      { nodeKey: 'read', recipients: ['coordinator'] }, base.communication.disclosures[1],
    ] } }
    expect(() => decodeWorkflowDefinition(hidden)).toThrow('downstream-disclosure')
    const underfunded = { ...base, roster: [{ ...base.roster[0], budgetCeiling: {
      ...base.roster[0]!.budgetCeiling, models: 1,
    } }, base.roster[1]] }
    expect(() => decodeWorkflowDefinition(underfunded)).toThrow('member-budget')
  })

  it('distinguishes an optional skip from failed work and validates the mapped result', () => {
    const base = workflowFixture()
    const writer = { ...base.nodes[1], dependencies: [{ nodeKey: 'read', mode: 'optional' }],
      inputs: [{ name: 'text', source: { kind: 'accepted', nodeKey: 'read', path: ['text'], fallback: 'none' } }] }
    const definition = decodeWorkflowDefinition({ ...base, nodes: [base.nodes[0], writer] })
    expect(resolveWorkflowNode(definition.nodes[1]!, new Map([['read', { kind: 'skipped' }]]), definition))
      .toEqual({ kind: 'ready', inputs: { text: 'none' } })
    expect(resolveWorkflowNode(definition.nodes[1]!, new Map([['read', { kind: 'failed' }]]), definition))
      .toMatchObject({ kind: 'failed', reason: 'dependency-failed' })
    const badFallback = { ...writer, inputs: [{ ...writer.inputs[0], source: { ...writer.inputs[0]!.source, fallback: 1 } }] }
    const checked = decodeWorkflowDefinition({ ...base, nodes: [base.nodes[0], badFallback] })
    expect(resolveWorkflowNode(checked.nodes[1]!, new Map([['read', { kind: 'skipped' }]]), checked))
      .toMatchObject({ kind: 'failed', reason: 'input-schema' })
  })

  it('rejects an oversized mapped value without changing the definition', () => {
    const base = workflowFixture()
    const definition = decodeWorkflowDefinition({ ...base, limits: { ...base.limits, maxValueBytes: 64 } })
    expect(resolveWorkflowNode(definition.nodes[1]!, new Map([[
      'read', { kind: 'accepted', value: { text: 'x'.repeat(128) } },
    ]]), definition)).toMatchObject({ kind: 'failed', reason: 'input-limit' })
  })

  it('keeps protocol and artifact limits in the recorded definition', () => {
    const base = workflowFixture()
    const limits = { ...base.limits, maxQuestions: 0, maxGroups: 0, maxProgress: 0,
      maxArtifactsPerAttempt: 1 }
    expect(decodeWorkflowDefinition({ ...base, limits }).limits).toEqual(limits)
    const read = base.nodes[0]!
    const artifacts = [{ name: 'first', source: { kind: 'json-text', path: ['text'] } },
      { name: 'second', source: { kind: 'json-text', path: ['text'] } }]
    expect(() => decodeWorkflowDefinition({ ...base, limits, nodes: [
      { ...read, output: { ...read.output, artifacts } }, base.nodes[1],
    ] })).toThrow('artifacts-array')
  })

  it('rejects a definition whose finite protocol allowance cannot close all attempts', () => {
    const base = workflowFixture()
    expect(() => decodeWorkflowDefinition({ ...base, limits: { ...base.limits, maxProtocolMessages: 11,
      maxQuestions: 0, maxIncomingQuestions: 0, maxGroups: 0, maxGroupRecipients: 0,
      maxIncomingGroupMessages: 0, maxProgress: 0 } })).toThrow('protocol-message-limit')
  })
})
