import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { render } from 'ink'
import { expect, it } from 'vitest'
import type { JsonObject } from '../src/foundation/json.js'
import { decodeHostConfig } from '../src/host/config.js'
import type { HostHttpModelConfig } from '../src/host/config.js'
import { deepSeekModelDescriptor } from '../src/model/providers/deepseek.js'
import { openOperatorSession } from '../src/operator/session.js'
import { modelCredentialReferences } from '../src/tui/credentials.js'
import { runTui } from '../src/tui/lifecycle.js'
import { hostConfig, twoMemberHostConfig } from './host/fixtures.js'
import { subagentHostConfig } from './host/subagent-fixture.js'
import { localFixture } from './step15-operator-fixture.js'
import { tuiStreams } from './step15-tui-streams.js'

function schemaDataConfig(root: string): JsonObject {
  const value = twoMemberHostConfig(root), message = (value.messages as readonly JsonObject[])[0]!
  return { ...value, messages: [{ ...message, schema: { type: 'object', properties: {
    credentialRef: { type: 'string' },
  }, required: ['credentialRef'], additionalProperties: false, enum: [{ credentialRef: 'PAYLOAD_DATA' }] } }] }
}
function httpModel(model: JsonObject, credentialRef: string): JsonObject {
  const { text: _text, ...options } = model
  return { ...options, kind: 'deepseek', endpoint: 'https://example.test/chat', credentialRef }
}

it('ignores legal Message schema enum data when finding Model credential references', () => {
  const config = decodeHostConfig(schemaDataConfig('.tmp/unused-credential-store'), process.cwd())
  expect(modelCredentialReferences(config)).toEqual([])
})

it('does not prompt for the Model credential of a disabled local member', () => {
  const value = hostConfig('.tmp/unused-credential-store'), member = (value.members as readonly JsonObject[])[0]!
  const config = decodeHostConfig({ ...value, members: [{ ...member, enabled: false, model: httpModel(member.model as JsonObject, 'DISABLED_KEY') }] }, process.cwd())
  expect(modelCredentialReferences(config)).toEqual([])
})

it('keeps enabled member and Child Model references and deduplicates the same credential', async () => {
  const value = await subagentHostConfig('.tmp/unused-credential-store'), member = (value.members as readonly JsonObject[])[0]!
  const subagents = value.subagents as JsonObject, template = (subagents.templates as readonly JsonObject[])[0]!
  const memberConfig = { ...member, model: httpModel(member.model as JsonObject, 'PARENT_KEY') }
  const model = httpModel(template.model as JsonObject, 'CHILD_KEY'), spec = template.spec as JsonObject
  const child = { ...template, model, spec: { ...spec, target: { ...(spec.target as JsonObject),
    provider: deepSeekModelDescriptor(model as unknown as HostHttpModelConfig) as unknown as JsonObject } } }
  const candidate = { ...value, members: [memberConfig], subagents: { ...subagents,
    templates: [child] } }
  const distinct = decodeHostConfig(candidate, process.cwd())
  expect(modelCredentialReferences(distinct)).toEqual(['PARENT_KEY', 'CHILD_KEY'])
  const shared = decodeHostConfig({ ...candidate, subagents: { ...candidate.subagents,
    templates: [{ ...child, model: { ...model, credentialRef: 'PARENT_KEY' } }] } }, process.cwd())
  expect(modelCredentialReferences(shared)).toEqual(['PARENT_KEY'])
})

it('opens a real offline TUI Host whose Message schema contains credentialRef business data', async () => {
  const f = await localFixture(schemaDataConfig), io = tuiStreams(), signals = new EventEmitter()
  let opened = 0
  const running = runTui(f.profilePath, io, {}, { signals,
    render: (node, options) => render(node, { ...options, interactive: true, debug: true }),
    openSession: async (path, options) => { const session = await openOperatorSession(path, options); opened++; return session },
  })
  try {
    await expect.poll(() => io.stdout.frames).toContain('test-host')
    expect(opened).toBe(1)
    expect(io.stdout.frames).not.toContain('local 启动缺少环境凭据')
    signals.emit('SIGTERM'); expect(await running).toBe(143)
    expect(io.stdin.raw.at(-1)).toBe(false)
    expect(signals.listenerCount('SIGINT')).toBe(0)
  } finally { signals.emit('SIGTERM'); await running; io.destroy(); await rm(f.directory, { recursive: true, force: true }) }
})
