import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { workflowConfig, resolveWorkflowConfig } from './workflow-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'workflow-readers-'))
let host
try {
  const raw = await workflowConfig(root)
  raw.workflows.maxBusinessConcurrency = 2
  const spec = resolveWorkflowConfig(raw)
  await h.initializeHost(spec); host = await h.openHost(spec)
  await host.workflow('research').resume({ requestKey: 'start-readers' })
  const run = await host.run(), report = host.workflow('research').report()
  assert.equal(run.businessRuns, 2); assert.equal(report.closed, true); assert.equal(report.counts.accepted, 2)
  assert.ok(host.report().members.every(member => member.agent.roots.length === 1 && member.agent.roots[0].budget.models === 1))
  console.log(JSON.stringify({ example: 'workflow-parallel', maxBusinessConcurrency: 2, report }))
} finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
