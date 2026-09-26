import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { workflowConfig, resolveWorkflowConfig } from './workflow-fixture.mjs'

if (process.argv[2] === '--interrupt') {
  const spec = resolveWorkflowConfig(await workflowConfig(process.argv[3]))
  await h.initializeHost(spec)
  const host = await h.openHost(spec, { bindings: { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
    script: async function* () { process.exit(77) } }) } })
  await host.workflow('research').resume({ requestKey: 'start' }); await host.run()
} else {
  const root = await mkdtemp(join(tmpdir(), 'workflow-loss-'))
  let host
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--interrupt', root], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] })
    const [code] = await once(child, 'exit'); assert.equal(code, 77)
    const record = JSON.parse(await readFile(join(root, '.atomic-harness.lock'), 'utf8'))
    await h.unlockHostStorage(root, { predecessorStopped: true, expectedToken: record.token })
    const spec = resolveWorkflowConfig(await workflowConfig(root))
    const recovered = await h.recoverHost(spec, { predecessorStopped: true, maxRecoveryWrites: 64, maxJournalConflicts: 4 })
    assert.ok(recovered.every(item => item.result.pending.length === 0))
    host = await h.openHost(spec)
    const first = host.report().members.find(member => member.agent.roots.length > 0)
    assert.equal(first.agent.roots[0].outcome, 'result-unknown')
    await host.workflow('research').resume({ requestKey: 'acknowledge-recovery' }); await host.run()
    assert.equal(host.report().members.find(member => member.agentKey === first.agentKey).agent.roots[0].budget.models, 1)
    console.log(JSON.stringify({ example: 'workflow-recovery', outcome: 'result-unknown', repeatedModelCalls: 0, report: host.workflow('research').report() }))
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
}
