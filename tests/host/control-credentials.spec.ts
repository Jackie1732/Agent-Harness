import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subagentHostConfig } from './subagent-fixture.js'
import type { JsonObject } from '../../src/foundation/json.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { openHost } from '../../src/host/runtime.js'
import { initializeHost } from '../../src/host/initialization.js'
import { deepSeekModelDescriptor } from '../../src/model/providers/deepseek.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { HostHttpModelConfig } from '../../src/host/config.js'

it('requires configured Child credentials before acquiring Host storage and honors an explicit custom Provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-credentials-'))
  try {
    const raw = await subagentHostConfig(directory), subagents = raw.subagents as JsonObject
    const template = (subagents.templates as JsonObject[])[0]!, specTemplate = template.spec as JsonObject
    const scripted = template.model as JsonObject
    const { text: _text, ...common } = scripted
    const model = { ...common, kind: 'deepseek', endpoint: 'https://provider.invalid/v1/chat/completions', credentialRef: 'RESEARCH_CHILD_KEY' } as unknown as HostHttpModelConfig
    const configured = { ...raw, subagents: { ...subagents, templates: [{ ...template, model: model as unknown as JsonObject,
      spec: { ...specTemplate, target: { ...(specTemplate.target as JsonObject), provider: deepSeekModelDescriptor(model) } } }] } }
    const spec = resolveHostConfig(decodeHostConfig(configured, directory))
    await initializeHost(spec)
    const writer = vi.spyOn(FileSessionBackend.prototype, 'openWriter')
    try {
      await expect(openHost(spec)).rejects.toMatchObject({ code: 'HOST_CONFIG_INVALID', message: 'child-model-credential-missing' })
      expect(writer).not.toHaveBeenCalled()
      await expect(access(join(directory, '.atomic-harness.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { writer.mockRestore() }
    const host = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model, script: async function* () {} }) } })
    await host.shutdown()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
