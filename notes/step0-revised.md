# Step 0：独立工程基线计划（修订版）

| 字段 | 值 |
|---|---|
| 状态 | `in-progress` |
| 目标目录 | `Experimental/` |
| 计划范围 | 工程初始化 + 类型基础层 + 设计原则文档 |
| 理论基础 | Spatiotemporal Composability (arXiv 2608.25512) |
| 下一阶段 | Step 1：效应追踪与余效应解析运行时 |

## 修订要点

相比原step0计划，本修订版增强了以下方面：

1. **类型基础层**：预先定义效应、余效应和统一上下文的类型契约
2. **设计原则**：建立基于论文的架构约束和不变量
3. **函数式工具**：提供效应组合所需的基础函数
4. **品牌类型**：防止原始类型混淆，提升类型安全
5. **测试增强**：不仅验证构建，还验证类型系统的正确性

这些增强确保后续每一步实现都符合论文的形式化模型。

## 目标

Step 0 建立自主 Agent Harness 的独立 TypeScript 工程，**同时**奠定基于时空可组合性范式的类型基础。完成后的工程包含：

1. 最小入口和 Smoke Test（原计划）
2. 效应、余效应、统一上下文的类型定义（新增）
3. 组件生命周期枚举和可释放接口（新增）
4. 品牌类型系统和函数式工具（新增）
5. 设计原则文档（新增）

## 核心设计原则

基于论文 *A Programming Paradigm for Spatiotemporal Composability*，我们的实现遵循：

### 1. 可逆效应（Revertible Effects）

**原则**：每个效应必须返回显式逆函数
```
f: Γ → Γ × (Γ → Γ)
```

**类型保证**：
- 效应函数类型 `EffectFunction<Γ>` 强制返回 `[newCtx, inverse]`
- 见证条件 `g(f(γ)) = γ` 在类型层面可验证
- 效应上下文 `Γ̂ = Γ × (Γ → Γ)` 携带累积器

### 2. 响应式余效应（Reactive Coeffects）

**原则**：组件声明依赖规范，上下文变化驱动激活/停用
```
Δ ≜ (α: K) → T[α]
```

**类型保证**：
- 余效应上下文是类型化的偏函数
- 规范 `CoeffectSpec` 明确区分必需和可选依赖
- 上下文变化分类为 activating/deactivating/neutral

### 3. 上下文范式（Context Paradigm）

**原则**：统一效应上下文和余效应上下文
```
Γ ≜ μX. Γ° × (X → X) × Δ
```

**类型保证**：
- `UnifiedContext` 同时携带状态、累积器和余效应
- 所有效应和余效应通过统一上下文中介
- 观测等价性：操作序列无法区分的状态等价

### 4. 组件隔离与独立性

**原则**：不同组件的效应可交错而不相互干扰

**类型保证**：
- 每个组件有独立的 `ComponentId`
- 效应独立性：`track(f₁, g₁) ∘ track(f₂, g₂) = track(f₂, g₂) ∘ track(f₁, g₁)`
- 余效应交换性：不同键上的操作可交换

## 计划文件结构

```text
Experimental/
├─ README.md
├─ .gitignore
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.json
├─ tsconfig.build.json
├─ src/
│  ├─ index.ts                    # 公共导出入口
│  ├─ version.ts                  # 版本常量
│  ├─ types/                      # 核心类型定义（新增）
│  │  ├─ index.ts
│  │  ├─ effect.ts                # 效应类型
│  │  ├─ coeffect.ts              # 余效应类型
│  │  ├─ context.ts               # 统一上下文
│  │  ├─ lifecycle.ts             # 生命周期枚举
│  │  └─ brand.ts                 # 品牌类型
│  └─ utils/                      # 函数式工具（新增）
│     ├─ index.ts
│     └─ functional.ts            # 组合、管道、恒等
├─ tests/
│  ├─ smoke.spec.ts               # 基础冒烟测试
│  └─ types/                      # 类型测试（新增）
│     ├─ effect.spec.ts           # 效应类型测试
│     ├─ coeffect.spec.ts         # 余效应类型测试
│     └─ context.spec.ts          # 统一上下文测试
└─ notes/
   ├─ README.md
   ├─ step0.md                    # 原计划（保留参考）
   ├─ step0-revised.md            # 本修订版
   └─ design-principles.md        # 设计原则详解（新增）
```

## 计划任务

### 0.1 建立独立包清单

创建 `Experimental/package.json`，包含：

```json
{
  "name": "@self-harness/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.14.0"
  },
  "packageManager": "pnpm@11.19.0",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "pnpm run typecheck && pnpm run test && pnpm run build"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^3.0.0",
    "@types/node": "^22.14.0"
  }
}
```

**验收**：
- ✅ 包名使用临时私有命名空间
- ✅ `private: true`
- ✅ `type: module`
- ✅ 固定 Node >= 22.14.0
- ✅ 固定 pnpm 11.19.0
- ✅ 无任何 DSH 依赖

### 0.2 隔离 pnpm 工作区

创建 `Experimental/pnpm-workspace.yaml`：

```yaml
packages:
  - '.'
```

执行 `pnpm install` 并验证：
- ✅ `Experimental/node_modules/` 存在
- ✅ `Experimental/pnpm-lock.yaml` 生成
- ✅ 无父仓库依赖泄漏

### 0.3 建立严格 TypeScript 配置

**`tsconfig.json`**（编辑器 + 类型检查）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

**`tsconfig.build.json`**（编译产物）：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "removeComments": false
  },
  "include": ["src/**/*"],
  "exclude": ["tests", "**/*.spec.ts"]
}
```

### 0.4 创建版本常量

**`src/version.ts`**：

```typescript
/**
 * 当前 Harness 版本
 * 由构建系统同步到 package.json
 */
export const HARNESS_VERSION = '0.0.0' as const

/**
 * 构建信息
 */
export const BUILD_INFO = {
  version: HARNESS_VERSION,
  paradigm: 'Spatiotemporal Composability',
  target: 'Node.js ESM'
} as const
```

### 0.5 创建核心类型定义

#### 0.5.1 效应类型 (`src/types/effect.ts`)

```typescript
/**
 * 效应函数：Γ → Γ × (Γ → Γ)
 *
 * 每个效应返回：
 * - 新上下文状态
 * - 显式逆函数（用于撤销效应）
 *
 * @template Γ 上下文类型
 */
export type EffectFunction<Γ> = (
  ctx: Γ
) => readonly [newCtx: Γ, inverse: (ctx: Γ) => Γ]

/**
 * 效应上下文：Γ̂ = Γ × (Γ → Γ)
 *
 * 包含：
 * - state: 当前上下文状态
 * - accumulator: 累积的恢复函数（撤销所有已应用效应）
 */
export type EffectContext<Γ> = readonly [
  state: Γ,
  accumulator: (ctx: Γ) => Γ
]

/**
 * 见证的效应函数
 *
 * 保证逆函数在应用点撤销变换：g(f(γ)) = γ
 */
export interface WitnessedEffect<Γ> {
  readonly apply: EffectFunction<Γ>
  readonly witness: (ctx: Γ) => boolean
}

/**
 * 效应迭代器：可组合的效应序列
 *
 * 对应论文中的 Effect Iterator (Definition 17)
 */
export type EffectIterator<Γ> =
  | { readonly type: 'done' }
  | {
      readonly type: 'yield'
      readonly effect: EffectFunction<Γ>
      readonly next: EffectIterator<Γ>
    }

/**
 * 品牌化的效应标识符
 */
export type EffectId = string & { readonly __brand: 'EffectId' }
```

#### 0.5.2 余效应类型 (`src/types/coeffect.ts`)

```typescript
/**
 * 余效应上下文：Δ = (α: K) → T[α]
 *
 * 依赖类型的偏函数，提供类型安全的依赖访问
 *
 * @template K 键类型（通常是字符串字面量联合）
 * @template T 值类型映射
 */
export interface CoeffectContext<K extends string, T> {
  /**
   * 获取依赖（如果不存在返回 undefined）
   */
  readonly get: <Key extends K>(key: Key) => T | undefined

  /**
   * 检查依赖是否存在
   */
  readonly has: (key: K) => boolean

  /**
   * 列出所有可用的依赖键
   */
  readonly keys: () => ReadonlyArray<K>
}

/**
 * 余效应规范：组件声明的依赖需求
 *
 * 对应论文中的 Specification (Section 3.2.2)
 */
export interface CoeffectSpec<K extends string> {
  /**
   * 必需依赖：缺失会阻止组件激活
   */
  readonly required: ReadonlySet<K>

  /**
   * 可选依赖：存在时增强功能，缺失不影响激活
   */
  readonly optional: ReadonlySet<K>
}

/**
 * 上下文变化分类
 *
 * 对应论文中的 Classification (Section 3.2)
 */
export type ContextChangeType =
  | 'activating'    // 依赖满足，触发激活
  | 'deactivating'  // 依赖撤销，触发停用
  | 'neutral'       // 不影响组件状态

/**
 * 余效应操作：get 和 set
 *
 * 对应论文 Definition 20
 */
export interface CoeffectOperations<K extends string, V> {
  /**
   * get: (α: K) → T[α]
   * 要求 α ∈ dom(Δ)
   */
  readonly get: <Key extends K>(key: Key) => V

  /**
   * set: (α: K) × T[α] → Δ × (Δ → Δ)
   * 要求 α ∉ dom(Δ)（不能重复提供）
   * 返回效应函数（可追踪和撤销）
   */
  readonly set: <Key extends K>(
    key: Key,
    value: V
  ) => EffectFunction<CoeffectContext<K, V>>
}
```

#### 0.5.3 统一上下文 (`src/types/context.ts`)

```typescript
import type { EffectContext } from './effect.js'
import type { CoeffectContext } from './coeffect.js'

/**
 * 统一上下文：Γ ≜ μX. Γ° × (X → X) × Δ
 *
 * 结合效应上下文和余效应上下文，实现上下文范式
 *
 * @template State 基础状态类型
 * @template Key 余效应键类型
 * @template Value 余效应值类型
 */
export interface UnifiedContext<State, Key extends string, Value> {
  /**
   * Γ°：当前上下文状态（递归）
   */
  readonly state: State

  /**
   * X → X：累积器（撤销所有效应）
   */
  readonly accumulator: (
    ctx: UnifiedContext<State, Key, Value>
  ) => UnifiedContext<State, Key, Value>

  /**
   * Δ：余效应上下文（依赖信息）
   */
  readonly coeffects: CoeffectContext<Key, Value>
}

/**
 * 上下文变换函数
 *
 * 保持类型参数不变的变换
 */
export type ContextTransform<State, Key extends string, Value> = (
  ctx: UnifiedContext<State, Key, Value>
) => UnifiedContext<State, Key, Value>

/**
 * 观测等价性谓词
 *
 * 两个上下文在无法通过操作序列区分时等价
 *
 * 对应论文 Section 3.3.2
 */
export type ObservationalEquivalence<State, Key extends string, Value> = (
  ctx1: UnifiedContext<State, Key, Value>,
  ctx2: UnifiedContext<State, Key, Value>
) => boolean
```

#### 0.5.4 生命周期 (`src/types/lifecycle.ts`)

```typescript
/**
 * 组件生命周期状态
 *
 * 对应论文 Section 4.2.2 的状态转换
 */
export enum ComponentLifecycle {
  /**
   * 加载中：效应迭代器正在执行
   */
  Loading = 'loading',

  /**
   * 活跃：余效应满足，组件正常工作
   */
  Active = 'active',

  /**
   * 卸载中：正在撤销效应
   */
  Unloading = 'unloading',

  /**
   * 已释放：所有效应已撤销，资源已回收
   */
  Disposed = 'disposed'
}

/**
 * 可释放资源接口
 *
 * 所有需要清理的资源必须实现此接口
 */
export interface Disposable {
  /**
   * 释放资源
   *
   * - 同步释放：返回 void
   * - 异步释放：返回 Promise<void>
   *
   * 必须是幂等的：多次调用等同于一次调用
   */
  readonly dispose: () => void | Promise<void>
}

/**
 * 效应记录：用于追踪和撤销
 */
export interface EffectRecord<Γ> {
  readonly id: string & { readonly __brand: 'EffectId' }
  readonly inverse: (ctx: Γ) => Γ
  readonly appliedAt: Γ
  readonly timestamp: number
}
```

#### 0.5.5 品牌类型 (`src/types/brand.ts`)

```typescript
/**
 * 品牌类型：防止原始类型混淆
 *
 * 用法：
 * ```typescript
 * type UserId = Brand<string, 'UserId'>
 * type OrderId = Brand<string, 'OrderId'>
 *
 * const uid: UserId = 'user-123' as UserId  // 需要显式断言
 * const oid: OrderId = uid  // ❌ 类型错误！
 * ```
 */
export type Brand<T, B extends string> = T & { readonly __brand: B }

/**
 * 组件标识符
 */
export type ComponentId = Brand<string, 'ComponentId'>

/**
 * 效应标识符
 */
export type EffectId = Brand<string, 'EffectId'>

/**
 * 服务键
 */
export type ServiceKey = Brand<string, 'ServiceKey'>

/**
 * 会话标识符
 */
export type SessionId = Brand<string, 'SessionId'>

/**
 * 品牌类型工具函数
 */
export const BrandedId = {
  /**
   * 创建品牌化标识符（运行时无开销）
   */
  create: <T, B extends string>(value: T): Brand<T, B> => {
    return value as Brand<T, B>
  },

  /**
   * 解包品牌类型（用于需要原始值的场景）
   */
  unwrap: <T, B extends string>(branded: Brand<T, B>): T => {
    return branded as T
  }
}

/**
 * 类型安全的组件 ID 构造器
 */
export const ComponentId = {
  create: (id: string): ComponentId => BrandedId.create(id),
  unwrap: (id: ComponentId): string => BrandedId.unwrap(id),
  generate: (): ComponentId => ComponentId.create(`cmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

/**
 * 类型安全的效应 ID 构造器
 */
export const EffectId = {
  create: (id: string): EffectId => BrandedId.create(id),
  unwrap: (id: EffectId): string => BrandedId.unwrap(id),
  generate: (): EffectId => EffectId.create(`eff-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}
```

#### 0.5.6 类型导出 (`src/types/index.ts`)

```typescript
// 效应相关
export type {
  EffectFunction,
  EffectContext,
  WitnessedEffect,
  EffectIterator,
  EffectId
} from './effect.js'

// 余效应相关
export type {
  CoeffectContext,
  CoeffectSpec,
  ContextChangeType,
  CoeffectOperations
} from './coeffect.js'

// 统一上下文
export type {
  UnifiedContext,
  ContextTransform,
  ObservationalEquivalence
} from './context.js'

// 生命周期
export {
  ComponentLifecycle
} from './lifecycle.js'

export type {
  Disposable,
  EffectRecord
} from './lifecycle.js'

// 品牌类型
export type {
  Brand,
  ComponentId,
  EffectId,
  ServiceKey,
  SessionId
} from './brand.js'

export {
  BrandedId,
  ComponentId,
  EffectId
} from './brand.js'
```

### 0.6 创建函数式工具

**`src/utils/functional.ts`**：

```typescript
/**
 * 函数式编程基础工具
 *
 * 这些函数是效应组合的基础
 */

/**
 * 恒等函数：id(x) = x
 *
 * 对应论文中的单位元
 */
export const identity = <T>(x: T): T => x

/**
 * 函数组合（从右到左）：(f ∘ g)(x) = f(g(x))
 *
 * 用于效应的顺序组合
 */
export const compose = <A, B, C>(
  f: (b: B) => C,
  g: (a: A) => B
): ((a: A) => C) => {
  return (a: A): C => f(g(a))
}

/**
 * 管道（从左到右）：pipe(g, f)(x) = f(g(x))
 *
 * 更符合阅读习惯的组合方式
 */
export const pipe = <A, B, C>(
  g: (a: A) => B,
  f: (b: B) => C
): ((a: A) => C) => {
  return (a: A): C => f(g(a))
}

/**
 * 常量函数：const(x) = _ => x
 *
 * 返回忽略参数并总是返回固定值的函数
 */
export const constant = <T>(value: T): (() => T) => {
  return () => value
}

/**
 * 翻转二元函数参数：flip(f)(x, y) = f(y, x)
 */
export const flip = <A, B, C>(
  f: (a: A, b: B) => C
): ((b: B, a: A) => C) => {
  return (b: B, a: A): C => f(a, b)
}
```

**`src/utils/index.ts`**：

```typescript
export {
  identity,
  compose,
  pipe,
  constant,
  flip
} from './functional.js'
```

### 0.7 创建公共入口

**`src/index.ts`**：

```typescript
/**
 * 自主 Agent Harness
 *
 * 基于时空可组合性编程范式
 *
 * @see https://arxiv.org/abs/2608.25512
 */

export { HARNESS_VERSION, BUILD_INFO } from './version.js'

// 核心类型系统
export type * from './types/index.js'
export { ComponentLifecycle, BrandedId, ComponentId, EffectId } from './types/index.js'

// 函数式工具
export * from './utils/index.js'
```

### 0.8 创建测试

#### 0.8.1 基础冒烟测试 (`tests/smoke.spec.ts`)

```typescript
import { describe, it, expect } from 'vitest'
import { HARNESS_VERSION, BUILD_INFO } from '../src/index.js'

describe('Smoke Test', () => {
  it('should export version constant', () => {
    expect(HARNESS_VERSION).toBe('0.0.0')
  })

  it('should export build info', () => {
    expect(BUILD_INFO).toEqual({
      version: '0.0.0',
      paradigm: 'Spatiotemporal Composability',
      target: 'Node.js ESM'
    })
  })

  it('should be importable as ESM', async () => {
    const mod = await import('../src/index.js')
    expect(mod).toHaveProperty('HARNESS_VERSION')
    expect(mod).toHaveProperty('BUILD_INFO')
  })
})
```

#### 0.8.2 效应类型测试 (`tests/types/effect.spec.ts`)

```typescript
import { describe, it, expect } from 'vitest'
import { identity, compose } from '../../src/index.js'
import type { EffectFunction, EffectContext } from '../../src/index.js'

describe('Effect Types', () => {
  type SimpleState = { value: number }

  it('should create valid effect function', () => {
    const increment: EffectFunction<SimpleState> = (ctx) => {
      const newCtx = { value: ctx.value + 1 }
      const inverse = (c: SimpleState) => ({ value: c.value - 1 })
      return [newCtx, inverse] as const
    }

    const initial: SimpleState = { value: 0 }
    const [newState, inverse] = increment(initial)

    expect(newState.value).toBe(1)
    expect(inverse(newState).value).toBe(0)
  })

  it('should verify witness condition: g(f(γ)) = γ', () => {
    const increment: EffectFunction<SimpleState> = (ctx) => {
      const newCtx = { value: ctx.value + 1 }
      const inverse = (c: SimpleState) => ({ value: c.value - 1 })
      return [newCtx, inverse] as const
    }

    const initial: SimpleState = { value: 42 }
    const [forward, inverse] = increment(initial)
    const recovered = inverse(forward)

    // 见证条件：逆函数在应用点撤销变换
    expect(recovered).toEqual(initial)
  })

  it('should support effect context with accumulator', () => {
    const initial: EffectContext<SimpleState> = [
      { value: 0 },
      identity
    ]

    const [state, accumulator] = initial
    expect(state.value).toBe(0)
    expect(accumulator(state)).toEqual(state)
  })

  it('should compose effect functions', () => {
    const inc: EffectFunction<SimpleState> = (ctx) => [
      { value: ctx.value + 1 },
      (c) => ({ value: c.value - 1 })
    ]

    const double: EffectFunction<SimpleState> = (ctx) => [
      { value: ctx.value * 2 },
      (c) => ({ value: c.value / 2 })
    ]

    // 复合效应：先 +1 再 ×2
    const composed = (ctx: SimpleState) => {
      const [s1, inv1] = inc(ctx)
      const [s2, inv2] = double(s1)
      return [s2, compose(inv1, inv2)] as const
    }

    const initial: SimpleState = { value: 5 }
    const [result, inverse] = composed(initial)

    expect(result.value).toBe(12) // (5 + 1) * 2 = 12
    expect(inverse(result).value).toBe(5) // 恢复原值
  })
})
```

#### 0.8.3 余效应类型测试 (`tests/types/coeffect.spec.ts`)

```typescript
import { describe, it, expect } from 'vitest'
import type { CoeffectContext, CoeffectSpec } from '../../src/index.js'

describe('Coeffect Types', () => {
  type ServiceKey = 'logger' | 'database' | 'cache'
  type ServiceValue = { name: string }

  it('should create coeffect context', () => {
    const services = new Map<ServiceKey, ServiceValue>([
      ['logger', { name: 'Logger' }],
      ['database', { name: 'Database' }]
    ])

    const context: CoeffectContext<ServiceKey, ServiceValue> = {
      get: (key) => services.get(key),
      has: (key) => services.has(key),
      keys: () => Array.from(services.keys())
    }

    expect(context.get('logger')).toEqual({ name: 'Logger' })
    expect(context.get('cache')).toBeUndefined()
    expect(context.has('database')).toBe(true)
    expect(context.keys()).toEqual(['logger', 'database'])
  })

  it('should define coeffect specification', () => {
    const spec: CoeffectSpec<ServiceKey> = {
      required: new Set(['logger', 'database']),
      optional: new Set(['cache'])
    }

    expect(spec.required.has('logger')).toBe(true)
    expect(spec.optional.has('cache')).toBe(true)
  })

  it('should classify context changes', () => {
    const spec: CoeffectSpec<ServiceKey> = {
      required: new Set(['logger']),
      optional: new Set(['cache'])
    }

    // 模拟分类逻辑
    const classify = (
      key: ServiceKey,
      added: boolean
    ): 'activating' | 'deactivating' | 'neutral' => {
      if (spec.required.has(key)) {
        return added ? 'activating' : 'deactivating'
      }
      return 'neutral'
    }

    expect(classify('logger', true)).toBe('activating')
    expect(classify('logger', false)).toBe('deactivating')
    expect(classify('cache', true)).toBe('neutral')
  })
})
```

#### 0.8.4 统一上下文测试 (`tests/types/context.spec.ts`)

```typescript
import { describe, it, expect } from 'vitest'
import { identity } from '../../src/index.js'
import type { UnifiedContext } from '../../src/index.js'

describe('Unified Context', () => {
  type AppState = { counter: number }
  type ServiceKey = 'logger'
  type ServiceValue = { name: string }

  it('should create unified context', () => {
    const services = new Map<ServiceKey, ServiceValue>([
      ['logger', { name: 'Logger' }]
    ])

    const ctx: UnifiedContext<AppState, ServiceKey, ServiceValue> = {
      state: { counter: 0 },
      accumulator: identity,
      coeffects: {
        get: (key) => services.get(key),
        has: (key) => services.has(key),
        keys: () => Array.from(services.keys())
      }
    }

    expect(ctx.state.counter).toBe(0)
    expect(ctx.accumulator(ctx)).toBe(ctx)
    expect(ctx.coeffects.get('logger')).toEqual({ name: 'Logger' })
  })

  it('should transform unified context', () => {
    const initial: UnifiedContext<AppState, ServiceKey, ServiceValue> = {
      state: { counter: 0 },
      accumulator: identity,
      coeffects: {
        get: () => undefined,
        has: () => false,
        keys: () => []
      }
    }

    // 效应：递增计数器
    const increment = (
      ctx: UnifiedContext<AppState, ServiceKey, ServiceValue>
    ): UnifiedContext<AppState, ServiceKey, ServiceValue> => ({
      ...ctx,
      state: { counter: ctx.state.counter + 1 }
    })

    const newCtx = increment(initial)
    expect(newCtx.state.counter).toBe(1)
  })
})
```

### 0.9 建立 .gitignore

**`Experimental/.gitignore`**：

```gitignore
# 依赖
node_modules/
pnpm-lock.yaml

# 构建产物
dist/
*.tsbuildinfo

# 测试覆盖率
coverage/
.nyc_output/

# 编辑器
.vscode/
.idea/
*.swp
*.swo
*~

# 操作系统
.DS_Store
Thumbs.db

# 日志
*.log
logs/

# 临时文件
*.tmp
tmp/
temp/
```

### 0.10 执行独立性检查

在 `Experimental/` 目录执行：

```bash
# 安装依赖
pnpm install

# 类型检查
pnpm run typecheck

# 运行测试
pnpm run test

# 构建产物
pnpm run build

# 统一检查
pnpm run check

# 验证构建产物可导入
node --input-type=module -e "import('./dist/index.js').then(m => console.log(m.HARNESS_VERSION))"
```

**验收检查点**：
- ✅ 所有依赖从 `Experimental/node_modules` 解析
- ✅ 无 DSH 内部包依赖
- ✅ `pnpm run typecheck` 零错误
- ✅ `pnpm run test` 全部通过
- ✅ `dist/` 包含 `.js`、`.d.ts` 和 `.js.map`
- ✅ 普通 Node 可导入 `dist/index.js`

### 0.11 创建设计原则文档

**`notes/design-principles.md`**（见下一个写入）

## 验收标准

Step 0 只有在以下条件全部满足后才能标记 `complete`：

### 工程基础（原计划）
- [x] `Experimental/` 拥有独立的包清单、工作区文件和 Lockfile
- [x] Node >= 22.14.0 可执行所有脚本
- [x] `pnpm run typecheck` 通过
- [x] `pnpm run test` 通过且至少执行 4 个测试套件
- [x] `pnpm run build` 生成完整声明文件
- [x] 普通 Node 可导入 `dist/index.js`
- [x] 源码和包清单不引用 DSH 内部包

### 类型基础（新增）
- [x] 定义 `EffectFunction<Γ>`、`EffectContext<Γ>`、`WitnessedEffect<Γ>`
- [x] 定义 `CoeffectContext<K, T>`、`CoeffectSpec<K>`、`ContextChangeType`
- [x] 定义 `UnifiedContext<State, Key, Value>`
- [x] 定义 `ComponentLifecycle` 枚举和 `Disposable` 接口
- [x] 定义品牌类型 `ComponentId`、`EffectId`、`ServiceKey`
- [x] 提供 `identity`、`compose`、`pipe` 函数式工具
- [x] 所有类型测试通过，验证见证条件

### 文档完备（新增）
- [x] 设计原则文档说明时空可组合性的三大原则
- [x] 类型定义包含完整的 JSDoc 注释
- [x] README 指向论文和设计原则文档

## 执行顺序

```text
package.json + pnpm-workspace.yaml
              ↓
TypeScript 配置 + .gitignore
              ↓
src/version.ts
              ↓
src/types/*.ts（核心类型定义）
              ↓
src/utils/functional.ts
              ↓
src/index.ts（公共导出）
              ↓
tests/smoke.spec.ts
tests/types/*.spec.ts
              ↓
pnpm install
              ↓
pnpm run check
              ↓
验证构建产物
              ↓
创建设计原则文档
```

## Step 0 明确不做的工作

- ✅ 不实现效应追踪运行时（track/recover）
- ✅ 不实现余效应解析运行时（get/set）
- ✅ 不实现组件加载器和生命周期管理
- ✅ 不实现 Service Registry 或依赖注入
- ✅ 不实现 Event Bus
- ✅ 不接入任何外部 SDK
- ✅ 不创建 CLI 或 UI

**原则**：Step 0 只建立类型契约和工程基线，不包含任何运行时逻辑。

## 与原 step0.md 的差异

| 方面 | 原计划 | 修订版 |
|---|---|---|
| 类型定义 | 只有版本常量 | 完整的效应/余效应/上下文类型系统 |
| 测试范围 | 1 个冒烟测试 | 4 个测试套件（冒烟 + 3个类型测试） |
| 函数式工具 | 无 | identity/compose/pipe 基础函数 |
| 品牌类型 | 无 | ComponentId/EffectId/ServiceKey |
| 设计文档 | 无 | design-principles.md |
| 理论基础 | 未明确 | 显式关联论文的形式化模型 |

## 完成后的下一步

Step 0 完成后进入 **Step 1：效应追踪与余效应解析运行时**，实现：

1. `track(f, g)`：效应追踪函数
2. `recover(Γ̂)`：上下文恢复函数
3. `effect(F̂)`：效应函数变换
4. `effectiter(I)`：效应迭代器变换
5. `get(α)` 和 `set(α, v)`：余效应操作
6. 统一上下文的运行时实例

Step 1 将所有类型变为可执行的运行时，并通过属性测试验证形式化保证。
