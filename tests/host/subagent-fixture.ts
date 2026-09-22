import type { JsonObject } from '../../src/foundation/json.js'
import { hostConfig } from './fixtures.js'
import { delegationFixture } from '../subagent/fixtures.js'

/** A parent and a private child use independent Providers and one shared business scheduler. */
export async function subagentHostConfig(root: string): Promise<JsonObject> {
  const f = await delegationFixture()
  const template = f.template
  await f.close()
  const base = hostConfig(root)
  const member = (base.members as JsonObject[])[0]!
  const spec = member.spec as JsonObject
  return { ...base, schemaVersion: 2,
    members: [{ ...member, profile: { ...(member.profile as JsonObject), rendererVersion: 'context-neutral/v3' },
      spec: { ...spec, protocolVersion: 2, nativeActions: ['agent_spawn_subagent', 'agent_await_subagent', 'agent_answer_subagent'],
        budget: { models: 12, steps: 12, tools: 2, messages: 20, waits: 8, outputTokens: 4096 } },
      model: { ...(member.model as JsonObject), runnerLimits: { ...((member.model as JsonObject).runnerLimits as JsonObject), maxToolCalls: 4 } } }],
    communication: { ...(base.communication as JsonObject), maxMessageBytes: 32768 },
    scheduling: { ...(base.scheduling as JsonObject), maxBatchesPerRun: 256 },
    subagents: { kind: 'enabled', templates: [template as unknown as JsonObject],
      parents: [{ agentKey: 'writer', templates: [{ templateKey: 'research', templateVersion: 1 }], capabilities: template.capabilities,
        maxDelegations: 3, maxGrant: template.spec.budget }], workspaceResources: [], limits: template.limits } }
}
