# Atomic Agent Harness

Atomic Agent Harness is an independently developed TypeScript runtime for building small, composable agents. Its design treats lifecycle ownership, capability dependencies, durable sessions, explicit agent communication, model access, tools, and workflow coordination as separate layers with explicit contracts.

The project is informed by the [spatiotemporal composability model](https://arxiv.org/abs/2608.25512) and by engineering experience from DeepSeek Harness. Those projects are references only; this repository does not import their runtime or package structure.

The source includes the foundation, revertible effect ownership, and reactive capability/component lifecycle layers. Components declare required and provided capabilities, activate only when requirements are satisfied, publish bindings atomically, and release in dependency-safe order. Each activation owns its resources through `EffectOwner`; incomplete cleanup is reported and cannot be silently layered under a new activation.

```ts
import { CapabilityRegistry, createCapabilityKey } from '@atomic-harness/core'

const logger = createCapabilityKey<{ write(message: string): void }>('logger')
const registry = new CapabilityRegistry()

registry.mount({
  label: 'console-logger',
  requires: [],
  provides: [logger],
  setup: context => context.provide(logger, { write: console.log }),
})

registry.mount({
  label: 'research-agent',
  requires: [logger],
  provides: [],
  setup: context => context.require(logger).write('ready'),
})

await registry.whenQuiescent()
await registry.dispose()
```

The implementation is provider-neutral and host-neutral. Model providers, tools, sessions, transports, user interfaces, and automation belong in later layers rather than in the lifecycle kernel.

Development notes and phase-specific design evidence are indexed in [notes/README.md](notes/README.md). The package uses strict TypeScript, ESM, Vitest, and build-output smoke tests; run the checks from a Windows Node environment with `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, and `npm run test:built`.
