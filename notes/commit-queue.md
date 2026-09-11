# Agent 提交队列

## 用途

本队列协调 Codex、DeepSeek、Claude 和人工贡献，记录每项工作的分支、基线、范围、状态和验证。Git 提交保存代码历史，本队列保存跨 Agent 的工作所有权和交接状态。

## 分支与提交身份

- 持久分支分两类：阶段分支 `step<number>`，以及唯一的集成分支 `main`。
- 每个开发阶段对应一条阶段分支。Codex、DeepSeek 和 Claude 在该阶段分支上顺序提交，通过 Git Author、Committer 和 `Agent:` trailer 区分。
- **阶段分支之间不互相合并**：一条阶段分支的全部提交留在它自己身上，阶段结束后分支保留在远端，读者从该分支看到这一阶段的完整开发过程，而不只是它的结果。
- **`main` 汇总每个阶段的归档提交**，是跨阶段连续的历史线；它同时是远端默认分支，因此新克隆能看到所有已完成阶段。
- **`step0` 冻结**在 Step 0 基线，不再接收任何工作，也不接收任何合并；它保留下来是为了让读者看到项目的起点。
- 阶段分支从 `main` 的顶端开始，也就是上一阶段的归档状态；阶段结束时把归档提交同时记录到该阶段分支与 `main`，下一阶段再从那里开始。
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
| C-0003 | Codex | `step1` | `ce54eb2` | `landed` | Step 1 Revertible Effect 生命周期内核完整规划与文档入口 | `pnpm run check`; Markdown 链接检查; `git diff --check` | 规划固定可观察行为、竞争决策和验收矩阵；随 `origin/step1` 首次推送一并发布 |
| C-0004 | Codex | `step1` | `e253063` | `landed` | 审查并整合 Claude 对 Step 1 规划的审计意见 | `pnpm run check`; Markdown 围栏与链接检查; `git diff --check` | 采纳登记临界区、任务发布顺序和可复现竞争测试；删除错误示例与无依据的性能、调试和兼容性扩展；随 `origin/step1` 发布 |
| C-0005 | Codex | `step1` | `c4f657e` | `landed` | 审查并整合 DeepSeek 对 Step 1 规划的审计意见 | Windows Node 下分别运行 `lint`、`typecheck`、`test`、`build`、`test:built`; Markdown 围栏与链接检查; `git diff --check` | 补全 Signal、启动检查点、Lease value、静止范围和标签语义；Provider 延后到 Step 2；修正重入检测范围；随 `origin/step1` 发布 |
| D-0006 | DeepSeek | `step1` | `dbf92b4` | `landed` | 按 Step 1 计划实现 Revertible Effect 生命周期内核：`src/effect/` 的类型、错误、EffectOwner 与 Cleanup record，`tests/effect/` 的行为、回滚、竞争、错误与模型测试 | Windows Node v22.14.0 下分别运行 `npm run lint`、`npm run typecheck`、`npm run test`、`npm run build`、`npm run test:built`，11 个测试文件 74 项测试通过；README 最小示例用构建产物单独执行 | 修正三处认领与等待顺序缺陷和一处审计结论；偏离计划两处已记录在 `step1.md` 的执行证据；四次提交 `5853fca`、`efe3c64`、`50d9f5c`、`fcfb27e` 已推送并校验远端等于本地 HEAD；实现经 Codex 与 Claude 复核后由 D-0008 收尾 |
| CL-0007 | Claude | `step1` | `fcfb27e` | `landed` | 补充 `types.ts`、`errors.ts` 与 `owner.ts` 的 JSDoc，调整非活动错误文案，并收敛公共类型示例 | 提交说明只记录预期命令；DeepSeek 与 Codex 各自实测，在 `14b764f` 上观察到 74 项中 1 项失败（`reports EFFECT_OWNER_INACTIVE`），因为错误文案改动未同步测试断言 | 提交 `14b764f` 保留有用的 API 说明；测试断言与部分过强承诺在其后收敛。“74”为实测值，此前记录的“79 项中 1 项失败”不准确 |
| C-0008 | Codex | `step1` | `14b764f` | `landed` | 审查 DeepSeek 实现与 Claude 修订，修复异步串行 LIFO、已开始 operation 的接纳时序、嵌套释放等待环和错误消息测试回归 | Windows Node 下分别运行 `npm run lint`、`npm run typecheck`、`npm run test`、`npm run build`、`npm run test:built`；11 个测试文件 79 项测试通过；`git diff --cached --check` | 清理任务先整体发布再严格串行执行；`run()` 等待 setup 已启动的 operation 完成登记；释放入口拒绝加入当前异步继承链正在执行的清理任务；替换了一处假阳性竞争测试并补充四类等待环用例 |
| D-0009 | DeepSeek | `step1` | `9a960ee` | `landed` | 审查合并后的实现并加固清理串行链 | Windows Node v22.14.0 下 `npm run lint`、`npm run typecheck`、`npm run test`（11 文件 79 项）、`npm run build`、`npm run test:built` | 串行链的下一步 link 缺 `onRejected`，任务一旦拒绝会中断链并静默跳过更早的逆操作；已加固并记录该分支在现有守卫下不可达（插桩全量测试命中 0 次）。另完成计划逐条核对：补入五条缺失语义的测试，修正 `attempted` 计数语义与 `wait` 阶段说明，测试数 79 → 86 |
| GL-0010 | GAiLO | `step1` | `34dbd28` | `landed` | 在共享工作区直接提交：`publishRecords` 改为索引反向迭代，并补两个 Owner 释放边界测试 | 提交正文记录全量测试通过（79 → 81 项）；随后由 D-0011 修正其非空断言并复核 | 未在队列注册身份，提交无 `Agent:` trailer；声称的性能收益经实测仅 15-40 ns/次释放，且正文引用了本项目不存在的 duplication 门禁；随 PR #1 一并并入 `step0` |
| D-0011 | DeepSeek | `step1` | `7aeb5f7` | `landed` | 逐条核对计划与实现，补入五条缺失语义的测试，修正 `attempted` 计数与 `wait` 阶段说明，并把 GAiLO 的非空断言改为收窄守卫 | Windows Node v22.14.0 下 `lint`、`typecheck`、`test`（11 文件 86 项）、`build`、`test:built`；守卫版本与断言版本实测等价 | 测试数 79 → 86；`EffectStartInterruptedError.attempted` 改为只计本作用域真正执行的逆操作数；随 PR #1 并入 `step0` |
| D-0012 | DeepSeek | `step2` | `d8d162a` | `landed` | 按 `notes/step2.md` 规划并实现 Step 2：能力词汇与身份、纯依赖求值器与声明图、原子绑定发布、串行协调者与屏障、Component 生命周期与有序停用 | Windows Node v22.14.0 下 `npm run lint`、`npm run typecheck`、`npm run test`、`npm run build`、`npm run test:built`；交付前自审补入 10 项边缘用例 | 五个提交：`2d08fa1` 词汇与身份、`71b4030` 求值器、`9454c99` 注册表与原子发布、`098b980` 自审修正三个真实缺陷、`a254447` 失败提交清理与 retry 覆盖、`b2a92c7` 去非空断言；自审记录的七个问题见 `notes/step2.md` 执行证据 |
| C-0013 | Codex | `step2` | `b2a92c7` | `landed` | 审查 Step 2 实现并加固协调生命周期 | Windows Node v22.14.0 下 `npm run lint`、`npm run typecheck`、`npm run test`（15 文件 162 项）、`npm run build`、`npm run test:built`、`git diff --cached --check` | 每次激活分配新的提供者实例身份（原实现按尺寸派生会碰撞）、按提交与在飞的依赖视图传播退役以中断传递性漂移、失败上下文关闭、失败原因按序列保留、release/retry/dispose 共享任务、拒绝生命周期等待环、快照对特殊键名与环安全；新增 25 项回归测试；同时把 README 回退到 Step 1 基线，理由见 D-0014 |
| D-0014 | DeepSeek | `step2` | `d5da72a` | `landed` | 审查并合并 Codex 的加固修订，校准确认 README 与计划的一致性 | 复核门禁：15 文件 162 项测试通过，连跑两遍稳定；README 示例用构建产物实测 | 保留 Codex 全部加固（已逐条核对并确认我的四项修正仍在）；恢复 README 的当前状态与最小示例——计划 §2.7 要求 README 与实现一致，回退会让根文档落后于代码；登记 D-0012 与 C-0013 两行；整个 Step 2 已随 PR #3 以 rebase 方式并入 `step0`（`05c07c5`） |
| C-0015 | Codex | `step2` | `81195f8` | `landed` | 补两处审计遗留：自环在 `mount()` 处拒绝，收敛守卫改用稳定错误码 | Windows Node v22.14.0 下 `lint`、`typecheck`、`test`（15 文件 164 项）、`build`、`test:built`；`git diff --check` 通过；构建产物探针确认自环挂载被拒绝 | 自环原先只在快照里报告而组件永远 `unsatisfied`，与计划「拒绝」的要求不符；收敛守卫原抛裸 `Error`，改为 `REGISTRY_NOT_CONVERGED` 并携带步数预算与各组件状态投影；同时开 PR #3 |
| CL-0016 | Claude | `step2` | `81195f8` | `landed` | Step 2 归档后审查：`src/capability/types.ts` 的 JSDoc 增强（CapabilityKey/ComponentDefinition/ComponentContext 示例与语义说明） | Claude 侧记录 15 文件 164 项测试通过；docs-only 变更 | 提交身份为 GAiLO + Co-Authored-By Claude，缺 `Agent:` trailer，且未登记队列行（本行由 Codex 补记）；`require()` 文档误用「committed view」、示例绕过 `createCapabilityKey()` 工厂，由 C-0017 修正 |
| C-0017 | Codex | `step2` | `1aab5e8` | `landed` | 审查 CL-0016 并修正两处文档错误：`require()` 的 committed view 误称改回 attempt view；CapabilityKey 示例改用工厂函数 | Windows Node v22.14.0 下 `lint`、`typecheck`、`test`（15 文件 164 项）、`build`、`test:built`；`git diff --check` 通过 | 同时把 D-0012/C-0013/D-0014/C-0015 四行同步为 step0 上的 landed 版本，消除 step2 与基线的队列漂移 |
| D-0018 | DeepSeek | `main` | `9dfeb38` | `landed` | 分支模型重构：阶段分支互不合并、`main` 为集成分支并设为远端默认、`step0` 冻结在基线；同步 AGENTS.md 与队列规则 | `git diff --check` | 提交 `d4cbc30`；step0 指针回退到 `d8d162a`（Step 2 分叉前的基线），重构提交本身未登记队列行，本行由 Codex 补记 |

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
