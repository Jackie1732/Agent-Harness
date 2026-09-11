# Agent 提交队列

## 用途

本队列协调 Codex、DeepSeek、Claude 和人工贡献，记录每项工作的分支、基线、范围、状态和验证。Git 提交保存代码历史，本队列保存跨 Agent 的工作所有权和交接状态。

## 分支与提交身份

- 远端和本地持久分支只使用 `step<number>`，每个开发阶段对应一个共享分支。
- Codex、DeepSeek 和 Claude 在该阶段分支上顺序提交，通过 Git Author、Committer 和 `Agent:` trailer 区分。
- 自动化 Agent 不修改仓库级 `user.name` 或 `user.email`，每次提交显式提供自己的身份。
- 人工提交保留用户自己的 Git 身份，并可使用 `Agent: Human` trailer。

| Agent | Git 身份 | Trailer |
|---|---|---|
| Codex | `Codex <codex@agent.local>` | `Agent: Codex` |
| DeepSeek | `DeepSeek <deepseek@agent.local>` | `Agent: DeepSeek` |
| Claude | `Claude <claude@agent.local>` | `Agent: Claude` |

## 状态

| 状态 | 含义 |
|---|---|
| `planned` | 已登记，尚未修改代码 |
| `active` | Agent 正在修改或验证 |
| `committed-local` | 已形成经过验证的本地提交，尚未推送 |
| `pushed` | 远端分支已验证为本地提交 |
| `landed` | 已进入共享基线 |
| `superseded` | 被后续队列项替代，保留历史 |
| `blocked` | 缺少外部条件，原因记录在备注 |

## 当前队列

| 顺序 | Agent | 分支 | 基线 | 状态 | 范围 | 验证 | 说明 |
|---:|---|---|---|---|---|---|---|
| C-0001 | Codex | `step0` | 初始仓库 | `pushed` | Step 0 独立工程、基础契约、测试和设计文档 | `pnpm install --frozen-lockfile`; `pnpm run check`; Markdown 链接检查 | Codex 提交以 `Agent: Codex` 标记；后续 Agent 从 `origin/step0` 取得基线 |
| CL-0002 | Claude | `step0` | `origin/step0` | `landed` | 拆分 JSON 校验器、保留嵌套错误原因、补充公共 JSDoc 和错误边界测试 | `pnpm run check`; `git diff --check`; Markdown 链接检查 | Codex 审查修复了类型错误，为 Error cause 增加循环与深度限制，并移除重复的提交说明文件 |
| C-0003 | Codex | `step1` | `ce54eb2` | `committed-local` | Step 1 Revertible Effect 生命周期内核完整规划与文档入口 | `pnpm run check`; Markdown 链接检查; `git diff --check` | 规划固定可观察行为、竞争决策和验收矩阵；纯 Markdown 贡献保留在本地，不单独推送 |

## 工作规则

1. Agent 开始任务前读取本队列，并检出当前开发阶段的 `step<number>` 分支。
2. 同一时刻一个文件只归一个 `active` 队列项修改；需要交接时先更新原项状态和备注。
3. 每个队列项形成一个或一组职责一致的提交。提交正文记录行为、设计选择和实际验证。
4. 推送后比较对应远端 Step 分支与本地 `HEAD`；一致后才能把状态改为 `pushed`。
5. 合并或接受为新基线后，将状态改为 `landed`，并让后续队列项记录该提交或分支为基线。
6. 队列不保存密钥、访问令牌、完整命令输出或模型私有上下文。

## 交接内容

Agent 交接时至少记录：

- 已完成行为；
- 未完成工作和原因；
- 修改文件；
- 实际执行的验证；
- 已知限制；
- 建议的下一项工作及基线。
