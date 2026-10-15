/** 跨代自评估进化插件 —— 共享类型。 */
export type ResourceId = 'agent-rules' | 'candidate-prompt' | 'composition'

/**
 * 全部合法资源 id（**运行时真源**，与 `ResourceId` 联合类型同处声明——加资源只改这里）。
 *
 * 存在理由：工具层收到的是 `string`，校验它需要运行时可枚举的值；`ResourceId` 是类型，
 * 编译后不存在。两份声明放同一处，是为了让「加了类型却忘了运行时」在**同一屏**可见。
 */
export const RESOURCE_IDS: readonly ResourceId[] = ['agent-rules', 'candidate-prompt', 'composition']

/**
 * 落点模式：
 * - `block` —— 写进受管文件的**标记段**（走 `applyBlockSet`，有预算裁决）
 * - `file` —— **整文件覆盖**（无预算裁决：它不是注入面）
 */
export type SinkMode = 'block' | 'file'

/**
 * 一个资源的落点（「它写到哪里去」的声明）。
 *
 * 判别联合是刻意的：`block` 必有 `blockId` 与**数值**上限，`file` 必**无上限**——
 * 「无上限」用 `null` 而不是 `0`（`0` 是「上限为零字节」，两者不是一回事）。
 */
export type ResourceSink =
  | {
    readonly id: ResourceId
    /** 绝对路径 */
    readonly path: string
    readonly mode: 'block'
    /** 标记段 id（`MANAGED_BLOCKS` 里的登记名） */
    readonly blockId: string
    readonly maxBytes: number
    /** 要写进段内的文本 */
    readonly content: string
  }
  | {
    readonly id: ResourceId
    readonly path: string
    readonly mode: 'file'
    /** **无上限**（`null` ≠ `0`） */
    readonly maxBytes: null
    /** 要整文件写入的文本 */
    readonly content: string
  }

export interface ResourceVersion {
  /** 版本号（v0.0 起） */
  version: string
  /** 内容全文 */
  content: string
  /** 编辑说明 */
  note: string
  /** 创建时间（ISO） */
  at: string
  /** diff 摘要（编辑产生） */
  diff?: { added: number; removed: number; firstChangedLine?: number; newLength: number }
}

export interface Resource {
  id: ResourceId
  versions: ResourceVersion[]
  /** 锚点版本号（已验证，按序）——**主干**的线性链，语义不因分支而变 */
  anchors: string[]
}

/**
 * 并存的分支（RSI topology = Tree 的落地形态 · 域图 P2）。
 *
 * 存在的理由：旧形态只有一条链——`anchors` 是**线性数组**、`active` 是**单值**，
 * 于是「两条竞争性改动」在账本里**结构上装不下**（只能串行，或整体回滚）。
 * 分支把「从哪个版本分叉、分叉后走到哪」记成**独立记录**，主干一字不动 ⇒ 两者并存。
 *
 * ⚠ `Ledger.branches` 是**可选**字段：无分支时行为与旧版逐字节一致（零迁移成本）。
 */
export interface Branch {
  /** 分支 id（`b<n>`，账本内唯一；由 `openBranch` 按现有分支数分配） */
  id: string
  resource: ResourceId
  /** 分叉点：必须是该资源**已有**的版本号（不许凭空造祖先） */
  from: string
  /** 该分支当前版本号（开分支时 = 新产出的版本） */
  head: string
  note: string
  at: string
  /** `open` 并存中 · `merged` 已合入主干 · `abandoned` 已放弃（**保留记录，不删**） */
  state: 'open' | 'merged' | 'abandoned'
  /** 收口说明（merge / abandon 时写） */
  closedNote?: string
  closedAt?: string
}

export interface Generation {
  gen: number
  version: string
  runId: string
  sessionId?: string
  ability: number | null
  ship: number | null
  releaseClass: string | null
  dimensions: Record<string, number | null>
  at: string
  note: string
  /** 父的评估结论 */
  verdict?: string
}

export interface Ledger {
  initialized: boolean
  modeltestDir: string
  mainSessionId: string
  compositionSource: string
  createdAt: string
  resources: Record<ResourceId, Resource>
  /** 当前浮动版本（编辑后未验证） */
  active: Partial<Record<ResourceId, string>>
  generations: Generation[]
  edits: { version: string; resource: ResourceId; note: string; at: string; diff?: ResourceVersion['diff'] }[]
  rollbacks: { at: string; fromVersion: string; toVersion: string; note: string }[]
  /** 并存的分支（缺省不存在 ⇒ 纯线性，与旧版一致） */
  branches?: Branch[]
}

export interface RunState {
  runId: string
  gen: number
  sessionId?: string
  status: 'pending' | 'running' | 'done' | 'failed'
  at: string
  doneAt?: string
  note?: string
  /** 派发它的父会话 id（t-a19d7800 件 2：孤儿要能找回主会话告知，也便于事后归因）。 */
  parentSessionId?: string
  /** 本轮的**期望时长**（ms）——超期判据的基准；缺省用 `orphans.DEFAULT_EXPECTED_MS`。 */
  expectedMs?: number
  /** 被收尸的痕迹（件 3）：收尸不留痕 = 又一次静默失效。 */
  reaped?: { at: string; reason: string }
}
