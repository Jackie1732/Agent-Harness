# Atomic Agent Harness

## 项目目标

本目录用于从基础协议和生命周期开始，自主实现一套面向个人学习、科研实验和多 Agent 协作的原子化 Agent Harness。DeepSeek Harness、Cordis 及时空可组合性论文是设计参考，不是运行时依赖或必须复制的架构。

## 当前状态

Step 2 已实现 Reactive Coeffect 与能力生命周期。当前代码提供三部分：

- Step 0 的基础契约：Brand、Result、JSON 边界、结构化错误、Clock、Logger。
- Step 1 的 Effect 内核：`EffectOwner`、`EffectContext`、`EffectLease`。调用方在正向操作旁提供逆操作，Runtime 在把结果交给调用方之前登记该逆操作，并按实际接受顺序的反向串行恢复。
- Step 2 的能力层：`CapabilityRegistry`、`ComponentHandle`、`ComponentContext`。组件声明自己需要什么、提供什么；能力就绪时激活，提供者撤回时先停用依赖者再收回绑定。

不包含事件、Middleware、Session、模型、工具、通信或 Agent 运行时。

```ts
import { CapabilityRegistry, createCapabilityKey } from '@atomic-harness/core'

const datastore = createCapabilityKey<{ open(): string }>('storage.datastore')
const registry = new CapabilityRegistry()

registry.mount({
  label: 'datastore-provider',
  requires: [],
  provides: [datastore],
  setup: context => {
    context.provide(datastore, { open: () => 'ready' })
  },
})

const service = registry.mount({
  label: 'research-service',
  requires: [datastore],
  provides: [],
  setup: context => {
    // Runs only after the datastore is published; never runs while it is missing.
    console.log(context.require(datastore).open())
  },
})

// Wait for the chained activation instead of polling.
await registry.whenQuiescent()

// Release: the consumer tears down before the provider withdraws its binding.
await service.dispose()
await registry.dispose()
```

```ts
import { EffectOwner } from '@atomic-harness/core'

const active = new Set<string>()
const owner = new EffectOwner('example')

const lease = await owner.run('resource', async effect => {
  return await effect.apply(
    'listen',
    () => {
      active.add('listener')
      return 'listener'
    },
    resource => {
      active.delete(resource)
    },
  )
})

await lease.dispose()
await owner.dispose()
// active is empty, and owner.status is 'disposed'.
```

`lease.value` 是 `setup` 的原始返回值，Runtime 不代理也不清空它。对应的 Lease 或 Owner 开始释放后，该值不再表示活动资源。已经成功结算的 `run()` 结果不会被随后的释放改变。

## 开发入口

- [笔记索引](notes/README.md)
- [Agent 提交队列](notes/commit-queue.md)
- [Step 2 实施计划与证据](notes/step2.md)
- [Step 1 实施计划与证据](notes/step1.md)
- [Step 0 实施计划与证据](notes/step0.md)
- [设计原则](notes/design-principles.md)
- [Step 0 修订提案](notes/step0-revised.md)
- [Step 0 外部审查记录](notes/step0-review.md)

## 本地检查

依赖按 Windows 安装，门禁从 Windows Node 逐项执行：

```text
npm install --frozen-lockfile
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:built
```

五条脚本依次等价于 `check` 的内容。`check` 自身调用 `pnpm`，而当前环境只在 Windows 侧提供 Node 与 npm，因此逐项执行。Lint、类型检查、测试和构建都不修改源码。

## 目录边界

- 自主 Harness 的代码、测试、配置和笔记保存在本目录。
- `src/` 和 `tests/` 不导入父目录中的 DSH 或 Cordis 包。
- `pnpm-lock.yaml` 保存在本目录并用于可复现安装。
- `node_modules/`、`dist/` 和覆盖率结果是本地生成物。
- 仓库只使用 `step<number>` 阶段分支；Codex、DeepSeek 和 Claude 通过提交作者、`Agent:` trailer 和提交队列区分贡献。

## 下一阶段

Step 3 在所有权与能力生命周期之上提供扩展平面：Scope、类型化事件与 Middleware。所有注册都服从已有所有权与依赖规则，事件只在当前 Runtime 内通知，跨 Session 通信留给 Session 与通信协议阶段。
