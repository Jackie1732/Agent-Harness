# 自主 Agent Harness 设计原则

| 字段 | 值 |
|---|---|
| 状态 | `active` |
| 参考论文 | [A Programming Paradigm for Spatiotemporal Composability](https://arxiv.org/abs/2608.25512) |
| 适用范围 | 自主 Agent Harness 的运行时与能力设计 |

## 目的

本文把时空可组合性论文转换为自主 Agent Harness 的设计检查方法。论文结论只在其形式化前提下成立；项目要求是我们主动选择并准备通过代码验证的行为；尚未获得实现或实验支持的方案保持为待验证假设。

## 陈述分类

| 类别 | 含义 | 使用规则 |
|---|---|---|
| 论文结论 | 论文在形式化 Context、Effect、Coeffect 和 Component Calculus 下证明的性质 | 引用时保留前提，不能宣称当前代码已经满足 |
| 项目要求 | 我们决定让自主 Harness 满足的工程行为 | 必须有明确所有者、失败方式和验收证据 |
| 待验证假设 | 可能适合本项目但尚未证明的设计 | 不进入稳定公共接口，不作为完成声明 |

## Temporal Composability

### 论文结论

Revertible Effect 把一次 Context 变换与在当前应用点成立的左逆配对。Runtime 按应用顺序记录逆操作，并以 LIFO 顺序恢复。多个 Component 的操作满足独立性条件时，一个 Component 的恢复可以移除自身贡献，同时保留其他 Component 的贡献。

### 项目要求

- 每项由 Runtime 管理的资源获取必须在同一局部位置提供释放操作。
- Runtime 必须记录释放操作，调用方不能依赖独立的全局 Shutdown 清单。
- 部分启动失败必须恢复此前已接受的 Effect。
- Dispose 必须幂等，并等待异步清理完成。
- 清理失败必须保留为可诊断错误，同时继续尝试剩余清理。

以上五条已由 Step 1 的 `EffectOwner` 实现，并由 `tests/effect/` 的可执行用例验证：逆操作在结果交给调用方前登记，局部与全局清理按实际接受顺序反向执行，`dispose()` 共享单次认领的清理任务，清理失败逐项聚合后仍继续执行剩余逆操作。执行证据见 [Step 1 计划](step1.md)。

### 待验证假设

- 第一版使用严格 LIFO 串行清理可能比并行清理更容易证明正确。
- 属性测试可以覆盖 Effect 组合的工程不变量，但不能替代论文的形式化证明。

## Spatial Composability

### 论文结论

Reactive Coeffect 把 Component 对环境的需求声明为 Specification。Context 中依赖的提供状态发生变化时，Runtime 将变化分类为 activating、deactivating 或 neutral，并据此驱动 Component 生命周期。Provider 在 Consumer 完成停用后才能撤回 Consumer 清理仍需使用的绑定。

### 项目要求

- Component 必须声明必需能力。
- 必需能力不完整时，Component 不得开始执行主体逻辑。
- Provider 身份变化必须被检测，即使新旧 Provider 暴露相等值。
- Provider 离开时，依赖者必须先完成停用。
- 不满足依赖与 Component 启动失败必须是不同状态。

### 待验证假设

- `ServiceKey<T>` 使用 Symbol、对象身份或名称空间字符串，留到能力层决定。
- 可选依赖是否属于响应式依赖图，根据首个真实用例决定。

## Context Mediation

### 论文结论

Context Paradigm 将 Effect Context 与 Coeffect Context 统一，并要求 Component 对环境的相关操作经由 Context。该中介使 Runtime 能把操作归因到 Component，跟踪恢复动作，并根据依赖变化管理生命周期。

### 项目要求

- Runtime 管理的能力只能通过当前执行 Context 获得。
- 使用哪个 Context 注册资源，就由哪个生命周期所有者负责释放。
- Context 不暴露允许调用方绕过所有权和依赖检查的可变内部表。
- Context 的诊断快照与执行权限分离。

### 待验证假设

- TypeScript 实现是否使用 Proxy 透明拦截访问尚未决定。
- 第一版可能采用显式方法，以换取更清晰的调用和更小的 Runtime。

## Independence 与 Observational Equivalence

### 论文结论

两个 Effect 的前向变换和逆变换都可交换，并且不会改变对方产生的逆操作和继续路径时，二者独立。不同能力键上的局部操作天然更容易独立；同一键上的操作需要由该能力的公开操作证明交换性。状态恢复比较的是公开操作无法区分的观测等价，而不是物理字节完全相同。

### 项目要求

- 每项能力定义自己的可观察结果和并发语义。
- 只有明确声明并验证为可交换的操作才能并行重排。
- Runtime 不把对象地址、生成顺序或内部缓存差异误当作业务状态差异。
- 一项能力不能通过未声明的全局位置影响其他 Component。

### 待验证假设

- Tool Runtime 可以复用相同的交换性声明指导并行 Tool Call。
- 测试需要为关键能力定义可观察状态投影，而不是比较全部内部对象。

## Acquisition 与 Emission

### 论文结论

系统边界区分可恢复的资源获取与越过边界的输出。打开文件、获取连接或创建子进程可以记录并释放；已经发送的网络消息、已经被外部读取的文件内容或已经发生的支付不能依靠本地逆操作自动撤销。外部输出需要延迟提交或业务补偿。

### 项目要求

- 每项操作必须说明它是资源获取、内部状态变换还是外部输出。
- Runtime 只承诺恢复其控制范围内的状态。
- 外部输出不得被描述成普通 Dispose 可以完全撤销。
- 需要原子结果的工作流必须设计 Commit Point、幂等键或补偿动作。

### 待验证假设

- Session 日志可以成为部分外部输出的提交协调者，具体事务边界留到持久化阶段。

## 异步、失败与依赖卸载

### 论文结论

异步 Host 具有 Inertia：已经开始的异步迭代通常不能瞬间撤销。目标依赖在执行中变化时，当前迭代先结算并交出逆操作，然后 Component 转入卸载。Component 失败时只恢复失败前已记录的 Effect，并保持兄弟 Component 运行。无环依赖、有限 Component 和有限 Effect Iterator 是系统最终静止的重要前提。

### 项目要求

- 每次异步启动和卸载都有可等待的单一任务身份。
- 生命周期目标变化不会启动两个并发的加载或卸载任务。
- 失败 Component 完成回滚后再公开失败状态。
- 依赖循环必须在配置或诊断中明确报告。
- Runtime Shutdown 必须等待所有已接受工作收敛。

第一条和第五条已由 Step 1 实现：`EffectOwner.dispose()` 与 `EffectLease.dispose()` 各自返回同一个 Promise，并在 Runtime 跟踪的 `setup`、已开始的 operation 和逆操作全部结算后才完成。第二条属于 Step 2 的依赖目标视图。第三、四条尚未实现。

### 待验证假设

- 第一版采用串行状态机，后续才优化互不依赖 Component 的并行激活。
- Effect Iterator 是否成为公开 API，取决于异步启动需要多少可中断边界。

## 对原子 Agent 的约束

原子 Agent 是一个职责、输入、输出、能力、状态、预算和终止条件明确的执行单元。时空可组合性约束它运行所依赖的 Harness，不规定 Agent 的推理方法。

- Agent 获得模型、工具、Session 和记忆的方式属于 Coeffect。
- Agent 创建的监听器、任务、Worker 和临时资源属于 Effect。
- Agent 对外发送内容属于 Emission，需要明确提交语义。
- 子 Agent 是独立生命周期所有者，父子取消和资源释放必须有明确顺序。
- 多 Agent 并行只能建立在能力操作的交换性和工作区隔离之上。

## 当前实施顺序

```text
Step 0: independent project and neutral foundation
Step 1: revertible effects and lifecycle ownership
Step 2: reactive capabilities and dependency ordering
Step 3: scopes, events and middleware
Later: model, tools, session, agent and multi-agent layers
```

每个 Step 只在执行证据支持其行为后更新本文的项目要求。新的理论对应关系先作为待验证假设，不能直接升级为稳定接口。
