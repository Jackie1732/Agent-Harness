# Atomic Agent Harness

## 项目目标

本目录用于从基础协议和生命周期开始，自主实现一套面向个人学习、科研实验和多 Agent 协作的原子化 Agent Harness。DeepSeek Harness、Cordis 及时空可组合性论文是设计参考，不是运行时依赖或必须复制的架构。

## 当前状态

Step 0 已建立独立 TypeScript 工程和通用基础契约。当前代码提供 Brand、Result、JSON 边界、结构化错误、Clock、Logger、版本导出和独立质量检查，不包含 Effect、Component、LLM、Tool、Session 或 Agent 运行时。

## 开发入口

- [笔记索引](notes/README.md)
- [Agent 提交队列](notes/commit-queue.md)
- [Step 0 实施计划与证据](notes/step0.md)
- [设计原则](notes/design-principles.md)
- [Step 0 修订提案](notes/step0-revised.md)
- [Step 0 外部审查记录](notes/step0-review.md)

## 本地检查

在本目录执行：

```text
pnpm install --frozen-lockfile
pnpm run check
```

`check` 依次执行 Lint、TypeScript 类型检查、Vitest、构建和普通 Node 构建产物 Smoke Test。该命令不修改源码。

## 目录边界

- 自主 Harness 的代码、测试、配置和笔记保存在本目录。
- `src/` 和 `tests/` 不导入父目录中的 DSH 或 Cordis 包。
- `pnpm-lock.yaml` 保存在本目录并用于可复现安装。
- `node_modules/`、`dist/` 和覆盖率结果是本地生成物。
- 仓库只使用 `step<number>` 阶段分支；Codex、DeepSeek 和 Claude 通过提交作者、`Agent:` trailer 和提交队列区分贡献。

## 下一阶段

Step 1 实现 Revertible Effect 生命周期内核，包括 Effect 获取、逆操作记录、LIFO 恢复、异步 Inertia、失败回滚和幂等 Dispose。Service 与 Reactive Coeffect 在 Step 2 实现。
