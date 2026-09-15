import assert from 'node:assert/strict'
import * as h from '../dist/index.js'
import { contextProfile, contextSelection, modelLimits, scriptedTextProvider, sessionRepository } from './context-fixture.mjs'
import { demonstrateInvalidToolHistory } from './context-invalid-tool-history.mjs'

const repository = sessionRepository(new h.MemorySessionBackend({ maxRecordBytes: 2 * 1024 * 1024 }))
const provider = scriptedTextProvider('short model summary')
try {
  const session = await repository.create()
  const context = new h.SessionContext({ session, messageCatalog: h.createMessageCatalog() })
  const generation = await context.recordProfile(contextProfile())
  const input = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'example', text: 'long source '.repeat(1200) })
  const rule = await context.compact({
    profileEventId: generation.stored.eventId,
    history: { mode: 'local-suffix', representation: 'raw' },
    units: [{ eventId: input.stored.eventId, selector: 'user-input' }], protectedRefs: [], maxExcerptBytes: 24,
  })
  assert.equal(rule.kind, 'committed')
  const ruleAssembly = await context.assemble(contextSelection(generation.stored.eventId, provider.descriptor, {
    compactions: [rule.committed.stored.eventId],
  }))
  assert.equal(ruleAssembly.kind, 'ready')

  const summaryProfile = await context.recordProfile(contextProfile('compaction'))
  const summaryInput = await context.prepareCompactionInput(contextSelection(summaryProfile.stored.eventId, provider.descriptor, {
    compactionSource: { units: [{ eventId: input.stored.eventId, selector: 'user-input' }], protectedRefs: [] },
  }))
  assert.equal(summaryInput.kind, 'ready')
  const runner = new h.SessionModelRunner({ session, provider, limits: modelLimits })
  const settlement = await runner.invoke(summaryInput.request, { inputPrecondition: summaryInput.inputPrecondition })
  const adopted = await context.adoptModelCompaction(settlement.payload.invocationId, [])
  assert.equal(adopted.kind, 'committed')
  const modelAssembly = await context.assemble(contextSelection(generation.stored.eventId, provider.descriptor, {
    compactions: [adopted.committed.stored.eventId],
  }))
  assert.equal(modelAssembly.kind, 'ready')
  assert.equal(h.rebuildAssembly(session.snapshot(), ruleAssembly.committed.stored.eventId).kind, 'rebuilt')
  assert.equal(h.rebuildAssembly(session.snapshot(), modelAssembly.committed.stored.eventId).kind, 'rebuilt')
  const invalidToolHistory = await demonstrateInvalidToolHistory()
  process.stdout.write(`${JSON.stringify({
    example: 'compaction',
    rule: { before: rule.committed.payload.originalRenderedBytes, after: rule.committed.payload.compactedRenderedBytes, losses: rule.committed.payload.losses },
    model: { before: adopted.committed.payload.originalRenderedBytes, after: adopted.committed.payload.compactedRenderedBytes, losses: adopted.committed.payload.losses },
    invalidToolHistory,
  })}\n`)
  await runner.dispose()
  await context.dispose()
} finally {
  await provider.dispose()
  await repository.dispose()
}
