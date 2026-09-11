# Step 0：独立工程与基础契约计划

| 字段 | 值 |
|---|---|
| 状态 | `complete` |
| 目标目录 | `Experimental/` |
| 计划范围 | 独立工程、通用基础类型、设计原则和质量入口 |
| 理论参考 | *A Programming Paradigm for Spatiotemporal Composability*（arXiv:2608.25512） |
| 下一阶段 | Step 1：Revertible Effect 生命周期内核 |

## 目标

Step 0 建立自主 Agent Harness 的独立 TypeScript 工程，并实现所有后续模块共同依赖、但不预设 Harness 架构的基础契约。完成后的工程可以独立安装、编译、测试、检查和加载构建产物；它不依赖 DSH 内部包，也不包含 Plugin、Service、LLM、Tool、Session 或 Agent 运行时。

本阶段同时建立一份设计原则文档，将论文的理论结论、我们采纳的工程要求和仍待验证的假设分开。论文指导设计，但不直接决定公开 TypeScript API。

## 本次修订采用的内容

`step0-revised.md` 提出了在工程初始化时加入类型基础和论文设计原则。新版计划采纳这个方向，但缩小为跨阶段稳定的基础类型，不提前冻结 Effect、Coeffect、Unified Context 或 Component Lifecycle 的具体表示。

以下内容纳入 Step 0：

- 品牌类型工具，但不提前声明所有领域 ID；
- 通用 `Result` 和结构化错误基类；
- JSON 可序列化值定义和运行时断言；
- 可替换 Clock 与 Logger 接口；
- 版本导出和构建产物 Smoke Test；
- 论文设计原则文档；
- 严格 TypeScript、Lint、Test 和 Build 入口。

以下内容留到对应运行时阶段：

- `EffectFunction`、Effect Iterator 和恢复累积器进入 Step 1；
- Coeffect、Service Key、依赖解析和响应式激活进入 Step 2；
- Scope、事件和 Middleware 进入 Step 3；
- Component 生命周期状态由 Step 1 和 Step 2 的实际行为共同确定。

## 为什么不直接采用修订稿中的形式化类型

论文中的数学结构用于说明和证明动态组合性质，不等于适合直接公开的 TypeScript 数据结构。Step 0 不把下面这些表达直接复制为运行时接口：

```text
EffectFunction<Γ>
EffectContext<Γ>
WitnessedEffect<Γ>
CoeffectContext<K, T>
UnifiedContext<State, Key, Value>
ObservationalEquivalence<...>
```

原因如下：

1. TypeScript 函数签名只能要求 Effect 返回一个逆操作，不能证明该逆操作满足 `g(f(γ)) ≃ γ`。
2. 一个返回 `boolean` 的 `witness` 不是数学证明，也不能保证对所有状态成立。
3. 论文中的 Context 表示整个系统可观察状态；把它简化成普通 `{ state, accumulator, coeffects }` 对象会掩盖外部 I/O、异步资源和所有权。
4. Observational Equivalence 由每项能力公开的操作决定，不能在 Step 0 定义一个通用二元谓词后宣称已经获得该性质。
5. Component Lifecycle 必须包含等待依赖、启动失败、异步卸载和最终释放等真实状态；在运行时出现之前先冻结枚举会反向限制设计。
6. 使用 `Date.now()` 和 `Math.random()` 构造领域 ID 会降低测试确定性，也不提供可靠唯一性；ID 策略应在对应领域出现时设计。

Step 0 的设计原则文档会保留这些理论结构及其工程含义。后续运行时通过属性测试、状态机测试和资源观察验证我们实际实现的保证。

## 已确定的工程选择

| 主题 | Step 0 选择 | 说明 |
|---|---|---|
| 语言 | TypeScript | 支持类型化协议，并便于实现后续 SDK 和工具 Schema |
| 模块系统 | ESM | 自主工程只维护一种模块语义 |
| 当前 Node 基线 | `>=22.14.0` | 与当前工作机已验证的 `v22.14.0` 对齐；发布前重新评估支持范围 |
| 包管理器 | pnpm `11.19.0` | 与当前工作机已验证版本对齐 |
| 编译器 | TypeScript `^6.0.3` | 与当前源码环境一致，并启用严格检查 |
| 测试框架 | Vitest `^4.1.8` | 支持异步、类型辅助和后续 Mock Runtime |
| Lint | Oxlint `1.76.0` | 提供快速且独立的源码静态检查 |
| 构建方式 | `tsc` | Step 0 只生成标准 ESM 和声明文件，不引入 Bundler |
| 包状态 | `private: true` | 项目名称、许可证和发布边界尚未决定 |
| Lockfile | 纳入源码 | 保持依赖解析可复现；不得加入 `.gitignore` |
| DSH 依赖 | 禁止 | DSH 和 Cordis 只作为参考，不进入自主 Harness 依赖闭包 |

版本字段记录计划采用的初始值。只有完成安装并实际执行检查后，才能将对应验收项标记为完成。

## 计划目录

```text
Experimental/
├─ README.md
├─ .gitignore
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ tsconfig.json
├─ tsconfig.build.json
├─ vitest.config.ts
├─ src/
│  ├─ index.ts
│  ├─ version.ts
│  └─ foundation/
│     ├─ index.ts
│     ├─ brand.ts
│     ├─ result.ts
│     ├─ error.ts
│     ├─ json.ts
│     ├─ clock.ts
│     └─ logger.ts
├─ tests/
│  ├─ smoke.spec.ts
│  ├─ built-smoke.mjs
│  └─ foundation/
│     ├─ brand.type-test.ts
│     ├─ result.spec.ts
│     └─ json.spec.ts
└─ notes/
   ├─ README.md
   ├─ step0.md
   ├─ step0-revised.md
   └─ design-principles.md
```

本阶段不预建 `runtime/`、`model/`、`tools/`、`session/` 或 `agent/`。每个目录在其第一项真实实现出现时创建。

## 基础契约范围

基础契约必须能被所有后续模块使用，同时不能依赖尚未设计的 Component 或 Agent。

### Brand

提供一种零运行时开销的品牌类型：

```ts
export type Brand<T, Name extends string> = T & {
  readonly __brand: Name
}
```

Step 0 只导出通用 `Brand` 和受控构造辅助函数。`ComponentId`、`EffectId`、`ServiceKey` 和 `SessionId` 在其所有者出现时定义，避免提前决定身份格式和生成策略。

### Result

异步失败仍使用异常表达基础设施或程序错误。`Result<T, E>` 用于调用方需要显式分支的预期领域结果：

```ts
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }
```

Step 0 提供构造和窄化辅助函数，并测试判别联合。它不规定后续所有 API 必须使用 `Result`。

### HarnessError

提供带稳定 `code`、可读 `message`、可选 `cause` 和 JSON 安全 `details` 的错误基类。每个子系统以后扩展自己的错误代码，不在基础层维护一个包含全项目错误的中心枚举。

错误序列化必须保留稳定字段，同时不得假设任意 `cause` 可以直接 JSON 序列化。

### JsonValue

定义 JSON 原始值、数组和对象，并提供运行时断言：

```text
null | boolean | number | string | JsonValue[] | { [key]: JsonValue }
```

断言拒绝 `undefined`、`bigint`、函数、Symbol、循环引用、非有限数字和非普通对象。具体的大小、深度和字段数量限制由后续持久化或协议边界负责。

### Clock

定义最小 Clock 接口，使时间相关逻辑可以使用真实时钟或测试时钟。Step 0 不加入 Scheduler、Timer 所有权或虚拟时间系统。

### Logger

定义结构化 Logger 接口和无操作实现。日志字段只接受 JSON 安全值。日志传输、格式化、文件输出和遥测进入后续 Host 或 Observability 阶段。

## 计划任务

### 0.1 创建独立工作区

创建 `package.json` 和 `pnpm-workspace.yaml`。包清单包含包名、版本、ESM、Engine、Package Manager、公开导出、发布文件范围、检查脚本和最小开发依赖。

`pnpm-workspace.yaml` 只包含当前目录：

```yaml
packages:
  - '.'
```

自主工程不得声明 `workspace:`、`link:` 或指向 DSH 目录的 `file:` 依赖。

### 0.2 建立严格 TypeScript 配置

`tsconfig.json` 服务编辑器、测试和只读类型检查，至少启用：

- `strict`；
- `noImplicitOverride`；
- `noUncheckedIndexedAccess`；
- `exactOptionalPropertyTypes`；
- `useUnknownInCatchVariables`；
- `noFallthroughCasesInSwitch`；
- `noEmit`；
- Node ESM 对应的 `NodeNext` 模块与解析方式。

`tsconfig.build.json` 只包含 `src/`，输出到 `dist/`，生成 JavaScript、声明文件、Declaration Map 和 Source Map。测试和笔记不进入构建产物。

### 0.3 创建基础类型

按以下顺序实现并导出：

1. `Brand`；
2. `Result`；
3. `JsonValue` 及断言；
4. `HarnessError`；
5. `Clock` 与系统实现；
6. `Logger` 与无操作实现。

这些模块之间保持单向依赖。`brand.ts` 和 `result.ts` 不导入其他基础模块；错误详情和日志字段依赖 `JsonValue`。

### 0.4 创建版本和公共入口

`version.ts` 导出当前内部版本。`index.ts` 只重导出 Step 0 已实现的公共成员，不创建尚未设计的占位接口。

版本只在一个源码位置维护。Step 0 不声称构建系统已经自动同步 `package.json`，除非执行阶段实现并验证该机制。

### 0.5 创建测试

测试分为三类：

| 测试 | 验证内容 |
|---|---|
| `smoke.spec.ts` | 源码公共入口可被 Vitest 以 ESM 方式加载 |
| `foundation/*.spec.ts` | Result 分支和 JSON 断言的真实运行行为 |
| `brand.type-test.ts` | 不同品牌值不能在类型检查中互换 |
| `built-smoke.mjs` | 普通 Node 可以导入 `dist/index.js` |

类型测试不使用运行时断言证明类型性质。负面类型案例使用 `@ts-expect-error` 或专门的编译 Fixture，并由 `pnpm run typecheck` 验证。

Step 0 不测试数学见证、Effect 组合或 Coeffect 激活，因为这些运行时尚未实现。

### 0.6 建立设计原则文档

创建 `notes/design-principles.md`，至少区分以下三类陈述：

| 类别 | 含义 |
|---|---|
| 论文结论 | 论文在其形式化前提下证明的性质 |
| 项目要求 | 我们决定让自主 Harness 满足的工程行为 |
| 待验证假设 | 尚未通过实现或实验确认的方案 |

文档覆盖：

- Temporal Composability 与 Revertible Effects；
- Spatial Composability 与 Reactive Coeffects；
- Context Mediation；
- Effect Independence 和能力操作交换性；
- Acquisition 与 Emission 的系统边界；
- 异步 Inertia、失败隔离和依赖有序卸载；
- 这些原则对原子 Agent 与多 Agent 运行时的约束。

### 0.7 建立生成物边界

`.gitignore` 忽略：

- `node_modules/`；
- `dist/`；
- `coverage/`；
- `*.tsbuildinfo`；
- 临时文件、日志和编辑器缓存。

`.gitignore` 不忽略 `pnpm-lock.yaml`、源码、测试、配置和笔记。

### 0.8 安装并执行检查

在 `Experimental/` 目录按顺序执行：

```text
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run test:built
pnpm run check
```

`check` 是只读验证入口，不运行格式化、代码生成或依赖安装。它依次执行 Lint、类型检查、测试、构建和构建产物 Smoke Test。

### 0.9 审计独立性

安装完成后检查：

- `Experimental/pnpm-lock.yaml` 存在；
- 所有直接依赖都由 `Experimental/package.json` 声明；
- Lockfile 没有 DSH Workspace Link；
- `src/` 和 `tests/` 没有导入 DSH、Cordis 或父目录源码；
- 构建产物只包含 `src/` 的 JavaScript、声明和 Source Map；
- 普通 Node 不依赖 TypeScript Loader 即可导入产物。

## 实际执行顺序

```text
package.json + pnpm-workspace.yaml
              ↓
tsconfig.json + tsconfig.build.json + .gitignore
              ↓
foundation types and implementations
              ↓
version.ts + public index.ts
              ↓
source, type and built-output tests
              ↓
design-principles.md
              ↓
pnpm install
              ↓
lint → typecheck → test → build → built smoke
              ↓
dependency and artifact audit
              ↓
record executed evidence and mark complete
```

依赖安装放在清单和源码骨架完成之后，避免反复生成 Lockfile。设计原则在运行检查前完成，使本阶段的源码和测试可以接受同一次原则审查。

## 验收清单

下列项目已根据本页“执行证据”中的实际结果逐项验收。

### 工程

- [x] `Experimental/` 拥有独立 `package.json`、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml`。
- [x] 当前 Node 版本满足 Engine 并能执行全部脚本。
- [x] `pnpm run lint` 通过。
- [x] `pnpm run typecheck` 通过。
- [x] `pnpm run test` 通过。
- [x] `pnpm run build` 生成预期 JavaScript、声明和 Source Map。
- [x] `pnpm run test:built` 使用普通 Node 成功导入构建产物。
- [x] `pnpm run check` 通过且不修改源码。

### 基础契约

- [x] Brand 的负面类型案例由类型检查验证。
- [x] Result 的成功和失败分支可以正确窄化。
- [x] JSON 断言接受所有合法类别并拒绝非法、循环和非有限数值。
- [x] HarnessError 的稳定字段可以转成 JSON 安全诊断。
- [x] Clock 可以替换为确定性测试实现。
- [x] Logger 接受结构化字段，无操作实现不产生副作用。

### 独立性和文档

- [x] 源码和测试没有 DSH、Cordis 或父目录导入。
- [x] Lockfile 没有父工作区链接。
- [x] `.gitignore` 保留 Lockfile，并排除生成物。
- [x] `design-principles.md` 区分论文结论、项目要求和待验证假设。
- [x] README、笔记索引和 Step 0 计划之间的链接有效。
- [x] 本节记录所有实际执行命令和结果。

## 失败处理

| 情况 | 处理 |
|---|---|
| pnpm 把自主工程并入父工作区 | 修正 `Experimental/pnpm-workspace.yaml` 和执行目录，不修改 DSH 工作区清单 |
| 当前 Node 不满足 Engine | 停止安装，记录实际版本，再决定升级环境或修改支持范围 |
| TypeScript 或测试版本与当前 Node 不兼容 | 选择同时满足当前环境和后续需求的版本，并在本计划记录原因 |
| 测试通过但普通 Node 无法导入产物 | 修正 ESM 导出和编译配置，不使用 tsx 等 Loader 掩盖发布问题 |
| 依赖从父目录偶然解析成功 | 补充自主工程直接依赖或修复工作区隔离，并在隔离环境重新验证 |
| JSON 断言需要策略限制 | 保持 Step 0 只判断 JSON 合法性，把大小和深度限制交给具体协议所有者 |
| 论文术语无法直接映射为代码类型 | 保留为设计原则或待验证假设，不创建名义上对应但语义不完整的 API |

## Step 0 不实现

- Effect 跟踪、逆操作组合和恢复。
- Coeffect 存储、依赖满足和变化分类。
- Component、Fiber、Plugin 或生命周期状态机。
- Service Registry、Scope、Event Bus 或 Middleware。
- LLM、Tool、Session、Agent 或 Subagent。
- YAML Loader、CLI、SDK、UI 或 HMR。
- 正式的 Observational Equivalence 判定器。
- 论文定理的形式化证明器。
- 多包 Monorepo。

## 执行证据

执行环境为 Windows、Node.js `v22.14.0` 和 pnpm `11.19.0`。

| 命令或检查 | 结果 |
|---|---|
| `pnpm install` | 成功；创建独立 Lockfile，安装 49 个依赖包 |
| 首次 `pnpm run check` | TypeScript 拒绝 `HarnessErrorJson` 的不安全断言；改为直接构造类型化结果 |
| 第二次 `pnpm run check` | Vitest 继承父仓库配置并找不到本项目测试；新增本地 `vitest.config.ts` |
| 最终 `pnpm run check` | 成功；Lint、类型检查、6 个测试文件中的 19 个测试、构建和普通 Node Smoke 全部通过 |
| `pnpm install --frozen-lockfile` | 成功，Lockfile 无需更新 |
| `pnpm list --depth 0` | 只有 4 个直接开发依赖，无生产依赖 |
| Lockfile 链接检查 | 未发现 `workspace:`、`link:` 或 `file:` 依赖项 |
| 源码依赖检查 | `src/` 和 `tests/` 未发现 DSH 或 Cordis 导入 |
| TypeScript 文件清单 | 确认 `brand.type-test.ts` 由类型检查包含 |
| Git Ignore 检查 | `dist/` 和 `node_modules/` 被忽略，`pnpm-lock.yaml` 未被忽略 |

最终安装解析的直接开发依赖为 `@types/node@22.20.2`、`oxlint@1.76.0`、`typescript@6.0.3` 和 `vitest@4.1.11`。包清单保留兼容版本范围，Lockfile固定本次解析结果。

## 完成后的下一步

Step 1 实现 Revertible Effect 生命周期内核，包括 Effect 获取、逆操作记录、LIFO 恢复、异步 Inertia、失败回滚、幂等 Dispose 和属性测试。Step 2 再把服务提供和依赖声明建模为 Reactive Coeffects，使组件根据依赖变化激活和停用。
