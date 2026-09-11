# Atomic Agent Harness

## 项目目标

本目录用于从基础协议和生命周期开始，自主实现一套面向个人学习、科研实验和多 Agent 协作的原子化 Agent Harness。DeepSeek Harness、Cordis 及时空可组合性论文是设计参考，不是运行时依赖或必须复制的架构。

## 当前状态

Step 1 已实现 Revertible Effect 生命周期内核。当前代码提供 Step 0 的基础契约，以及 `EffectOwner`、`EffectContext`、`EffectLease`：调用方在正向操作旁提供逆操作，Runtime 在把结果交给调用方之前登记该逆操作，并按实际接受顺序的反向串行恢复。不包含 Component、Service、LLM、Tool、Session 或 Agent 运行时。

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
- 持久分支分两类：阶段分支 `step<number>` 与集成分支 `main`。阶段分支从 `main` 顶端开始，阶段结束后保留在远端；`main` 汇总每个阶段的归档提交；`step0` 冻结在基线，不再接收工作。Codex、DeepSeek 和 Claude 通过提交作者、`Agent:` trailer 和提交队列区分贡献。

## 下一阶段

Step 2 在已经验证的所有权与释放行为之上实现 Reactive Coeffect：能力键、Provider 身份、Consumer 需求、依赖变化分类，以及 Consumer 先于 Provider 的有序停用。
