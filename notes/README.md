# 自主 Agent Harness 笔记索引

## 用途

`notes/` 保存自主 Agent Harness 在设计和开发期间形成的阶段计划、设计判断、研究理解、实验记录和问题调查。这里的笔记服务于后续实现和复盘，不替代源码中的公开类型、测试中的可执行行为或根 README 中的稳定架构说明。

## 笔记类型

| 类型 | 内容 | 命名方式 |
|---|---|---|
| 阶段计划 | 某个开发 Step 的目标、任务、边界和验收 | `stepN.md` |
| 设计决策 | 一个需要长期保留的架构选择和取舍 | `decision-<主题>.md` |
| 研究笔记 | 论文、框架或方法的理解及其对本项目的影响 | `research-<主题>.md` |
| 实验记录 | 数据集、配置、运行环境、结果和结论 | `experiment-<主题>.md` |
| 调查记录 | 尚未形成结论的问题、证据和下一步 | `investigation-<主题>.md` |

## 状态约定

每份阶段、决策或实验笔记在开头记录状态。可用状态为 `planned`、`active`、`complete`、`superseded` 和 `blocked`。状态只描述该笔记对应工作的实际阶段；新笔记不能用 `complete` 表示尚未验证的设计。

稳定结论进入根 [README](../README.md) 或将来的正式架构文档。源码接口和测试分别负责表达当前实现与可执行行为。笔记引用这些事实，不复制一份可能漂移的完整定义。

## 当前索引

### 阶段计划

- [Step 1：Revertible Effect 生命周期内核计划](step1.md) - Effect 所有权、LIFO 恢复、异步收敛、失败回滚与验收矩阵。
- [Step 0：独立工程与基础契约计划](step0.md) - 已完成的工程基线、基础契约和执行证据。
- [Step 0 修订提案](step0-revised.md) - 提前公开论文形式化类型的备选方案，保留为设计输入。

### 设计文档

- [设计原则：基于时空可组合性的 Agent Harness](design-principles.md) - 区分论文结论、项目要求和待验证假设。
- [Agent 提交队列](commit-queue.md) - 记录 Codex、DeepSeek、Claude 和人工贡献的分支、状态与交接。

### 审查报告

- [Step 0 审查报告](step0-review.md) - 对原计划和修订提案的外部审查记录。

### 研究笔记

- 论文阅读：*A Programming Paradigm for Spatiotemporal Composability* (arXiv 2608.25512) - 已完成阅读，核心思想已提炼到 [design-principles.md](design-principles.md)

## 维护规则

- 每个 Step 开始前创建或更新对应计划。
- 执行过程中只记录影响设计、验收或后续工作的事实。
- 每个完成声明必须列出实际执行的命令和结果。
- 被新决定替代的笔记保留原文并标记 `superseded`，同时链接新的决定。
- 临时命令输出和大型生成物不进入 `notes/`。
