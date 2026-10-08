/**
 * wiring.ts — AGENTS.md 标记段的**唯一写原语**（纯函数，可离线单测）。
 *
 * 事故背景：`AGENTS.md` 的标记段被**两个插件**各自写入——`dsh-agent-self-test` 的
 * `selftest_review` 自动布线，与 `dsh-agent-evolve` 的 `evolve_edit(agent-rules)`。
 * 前者旧实现是整块替换（`full.replace(/start[\s\S]*end/, block)`），隐含假设「块里只有一条规则」，
 * 而块是**累积**的（每确认一条猜想追加一条）⇒ 第二次 confirm 抹掉第一次的规则，
 * 且只有**字节数反降**才暴露（65,151 → 64,795）。2026-09-16 首次、2026-09-17 重演，
 * 两次各丢一条规则（事故号 `t-d7b9739f`）。
 *
 * 本模块是那次教训的收敛形态：把「写 AGENTS.md 标记段」收敛成**一个纯函数原语**，
 * 由本插件独占（不变量 I1：AGENTS.md 只有一个写者）。
 *
 * 三条语义：
 * - **只增不减**：归一化后既有块已包含草稿 ⇒ `exists`，一字不写；新规则 ⇒ 追加在块尾，
 *   既有条目顺序与内容原样保留。
 * - **超限拒写**：写入后超字节预算 ⇒ `over-budget`，**调用方不得写盘**（宁可拒写，不可截断）。
 * - **标记损坏响亮失败**：起止标记只出现一个 ⇒ `corrupt-markers` 拒绝（绝不追加出第二个块）。
 *
 * 本模块**不碰文件系统**——落盘由调用方（`index.ts`）在拿到 `ok: true` 后执行，
 * 因此全部判定都可离线证伪。
 */

/** 归一化：折叠空白、去首尾——「同一条规则」的判定输入 */
export function normalizeRule(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 文本的 UTF-8 字节数（预算口径的唯一真源） */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** 一个受管理的标记段：起止字面量 + 稳定 id */
export interface BlockSpec {
  readonly id: string
  readonly start: string
  readonly end: string
}

/**
 * 本件管理的标记段登记表——marker 字面量的**唯一真源**（写入与解析共用，避免两处各写一份）。
 *
 * 两个 id 都是**历史遗留段**：它们由被替换的两件写入，迁移期必须能按原 id 继续读写，
 * 否则新件上线当天就会与旧段脱钩（旧段留在文件里、新件往别处写 ⇒ 双份规则）。
 */
export const MANAGED_BLOCKS: readonly BlockSpec[] = [
  { id: 'evolve', start: '<!-- dsh-agent-evolve:start -->', end: '<!-- dsh-agent-evolve:end -->' },
  { id: 'self-test', start: '<!-- dsh-agent-self-test:start -->', end: '<!-- dsh-agent-self-test:end -->' },
]

/** 按 id 取标记段登记项（未登记 ⇒ undefined） */
export function findBlock(id: string): BlockSpec | undefined {
  return MANAGED_BLOCKS.find((b) => b.id === id)
}

export type UpsertAction = 'added' | 'exists'

/** 一次写入的动作（`replaced` 只由版本化替换 `applyBlockSet` 产生） */
export type WriteAction = UpsertAction | 'replaced'

export interface UpsertResult {
  /** 合并后的块内文本（不含 marker 行） */
  readonly inner: string
  readonly action: UpsertAction
}

/**
 * 把 `draft` 合并进既有块内文本（**只增不减**）。
 *
 * 判定：归一化后既有块**已包含** draft ⇒ `exists`（幂等跳过）。
 * 方向性是有意的：同主题的**不同措辞**会被判成 `added` 并追加——宁可「重复表述」，
 * 也不「丢失既有」（丢信息不可逆；重复只是冗余，人读时自会合并）。
 */
export function upsertRuleBlock(existingInner: string, draft: string): UpsertResult {
  const draftNorm = normalizeRule(draft)
  if (draftNorm === '') return { inner: existingInner, action: 'exists' }
  if (normalizeRule(existingInner).includes(draftNorm)) return { inner: existingInner, action: 'exists' }
  const head = existingInner.replace(/\s+$/, '')
  return { inner: head === '' ? draft.trim() : head + '\n' + draft.trim(), action: 'added' }
}

export interface BudgetVerdict {
  readonly allowed: boolean
  readonly bytes: number
  readonly headroom: number
}

/** 字节预算裁决（fail-loud）：`allowed === false` 时调用方**不得写盘** */
export function checkBudget(nextContent: string, maxBytes: number): BudgetVerdict {
  const bytes = byteLength(nextContent)
  return { allowed: bytes <= maxBytes, bytes, headroom: maxBytes - bytes }
}

/** 组装 marker 块 */
export function buildBlock(inner: string, block: BlockSpec): string {
  return block.start + '\n' + inner.replace(/\s+$/, '') + '\n' + block.end
}

/** 抽取块内文本（无块 / 块序颠倒 ⇒ undefined） */
export function extractBlockInner(full: string, block: BlockSpec): string | undefined {
  const start = full.indexOf(block.start)
  const end = full.indexOf(block.end)
  if (start === -1 || end === -1 || end < start) return undefined
  return full.slice(start + block.start.length, end).replace(/^\s*\n/, '').replace(/\s+$/, '')
}

/** 用新的块内文本就地替换旧块；无块则追加到文件尾（返回整文件新内容） */
export function spliceBlock(full: string, inner: string, block: BlockSpec): string {
  const built = buildBlock(inner, block)
  const start = full.indexOf(block.start)
  const end = full.indexOf(block.end)
  if (start !== -1 && end !== -1 && end > start) {
    return full.slice(0, start) + built + full.slice(end + block.end.length)
  }
  return full.replace(/\n?\s*$/, '\n') + '\n' + built + '\n'
}

export interface UpsertRequest {
  readonly blockId: string
  readonly draft: string
  readonly maxBytes: number
}

/** 拒写原因（闭集——调用方据此分派诊断，不得用自由文本代替） */
export type WriteRejectReason = 'unknown-block' | 'empty-draft' | 'corrupt-markers' | 'over-budget'

export type WriteOutcome =
  | {
      readonly ok: true
      readonly action: WriteAction
      /** 应写盘的**整文件新内容**（`exists` 时与入参逐字节相同） */
      readonly content: string
      readonly bytes: number
      readonly headroom: number
    }
  | {
      readonly ok: false
      readonly reason: WriteRejectReason
      readonly detail: string
      /** 拒绝时给出的**当前**字节读数（未写入任何东西） */
      readonly bytes: number
      readonly headroom: number
    }

function reject(full: string, maxBytes: number, reason: WriteRejectReason, detail: string): WriteOutcome {
  const verdict = checkBudget(full, maxBytes)
  return { ok: false, reason, detail, bytes: verdict.bytes, headroom: verdict.headroom }
}

/** 多行草稿折叠为单行——段是**规则清单**（一条一行），回收按行切分才有意义 */
export function flattenDraft(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

/** 前置守卫结果：通过 ⇒ 给出段登记项；否则给出**已构造好的**拒绝结果 */
type GuardResult = { readonly ok: true; readonly block: BlockSpec } | { readonly ok: false; readonly outcome: WriteOutcome }

/**
 * 前置守卫（登记 → 空草稿 → 标记完整性）。两条写路径**共用**它——
 * 复制一份守卫就是复制一处会漂移的真理（I3 的落地形态）。
 */
function guard(full: string, req: { readonly blockId: string; readonly draft: string; readonly maxBytes: number }): GuardResult {
  const block = findBlock(req.blockId)
  if (block === undefined) {
    const known = MANAGED_BLOCKS.map((b) => b.id).join(' / ')
    return { ok: false, outcome: reject(full, req.maxBytes, 'unknown-block', `未登记的标记段 id：${req.blockId}（已登记：${known}）`) }
  }
  if (flattenDraft(req.draft) === '') {
    return { ok: false, outcome: reject(full, req.maxBytes, 'empty-draft', '空草稿：拒绝写入（调用方的规则串构造有误）') }
  }
  const start = full.indexOf(block.start)
  const end = full.indexOf(block.end)
  if ((start === -1) !== (end === -1)) {
    return {
      ok: false,
      outcome: reject(
        full,
        req.maxBytes,
        'corrupt-markers',
        `标记段 ${block.id} 起止标记只出现一个（start=${start} end=${end}）——拒绝追加，以免产生第二个块`,
      ),
    }
  }
  if (start !== -1 && end < start) {
    return {
      ok: false,
      outcome: reject(
        full,
        req.maxBytes,
        'corrupt-markers',
        `标记段 ${block.id} 起止顺序颠倒（start=${start} > end=${end}）——追加会产出读不回来的块，拒绝`,
      ),
    }
  }
  return { ok: true, block }
}

/**
 * **唯一写入口**（累积路径）：一次调用完成「登记校验 → 标记完整性校验 → upsert → 预算裁决」。
 *
 * 返回 `ok: true` 才允许落盘；任何拒绝路径都**不改动入参内容**（返回值里没有新内容）。
 * 四类拒绝都是**响亮**的（带闭集 reason 与可诊断 detail），不静默降级。
 *
 * 撞预算时本函数**拒写**（不做回收）——要回收请用 `applyRuleUpsertWithRecycle`。
 * 两者的分工是**调用方的策略选择**，不是安全等级（守卫与预算裁决完全共用）。
 */
export function applyRuleUpsert(full: string, req: UpsertRequest): WriteOutcome {
  const g = guard(full, req)
  if (!g.ok) return g.outcome
  const existing = extractBlockInner(full, g.block) ?? ''
  const merged = upsertRuleBlock(existing, flattenDraft(req.draft))
  if (merged.action === 'exists') {
    const verdict = checkBudget(full, req.maxBytes)
    return { ok: true, action: 'exists', content: full, bytes: verdict.bytes, headroom: verdict.headroom }
  }
  const next = spliceBlock(full, merged.inner, g.block)
  const verdict = checkBudget(next, req.maxBytes)
  if (!verdict.allowed) {
    return reject(
      full,
      req.maxBytes,
      'over-budget',
      `写入后 ${verdict.bytes} 字节 > 上限 ${req.maxBytes}（超 ${-verdict.headroom} 字节）——拒绝写盘`,
    )
  }
  return { ok: true, action: 'added', content: next, bytes: verdict.bytes, headroom: verdict.headroom }
}

export interface SetRequest {
  readonly blockId: string
  /** 新的块内全文（取代旧内容） */
  readonly inner: string
  readonly maxBytes: number
}

/**
 * **版本化替换**：把标记段内容整体换成 `inner`（用于 `agent-rules` 这类**版本化资源**）。
 *
 * 与 `applyRuleUpsert` 的分工是语义而非安全等级：upsert 表达「累积一条规则」（只增不减、幂等），
 * 本函数表达「设置该资源的当前版本」（旧内容被新版本取代）。
 *
 * 两者**共用同一套标记完整性守卫与字节预算裁决**——这一点是刻意的：被替换的
 * `dsh-agent-evolve` 用 `full.replace(/start[\s\S]*end/, wrapped)` 做整块替换且**完全不做预算裁决**，
 * 而 `AGENTS.md` 的注入有硬上限（超限从尾部静默截断）⇒ 那条路径可以在无人察觉时把我的规则段截掉。
 * 本件不允许任何一条写路径绕过预算。
 */
export function applyBlockSet(full: string, req: SetRequest): WriteOutcome {
  const block = findBlock(req.blockId)
  if (block === undefined) {
    const known = MANAGED_BLOCKS.map((b) => b.id).join(' / ')
    return reject(full, req.maxBytes, 'unknown-block', `未登记的标记段 id：${req.blockId}（已登记：${known}）`)
  }
  const start = full.indexOf(block.start)
  const end = full.indexOf(block.end)
  if ((start === -1) !== (end === -1)) {
    return reject(
      full,
      req.maxBytes,
      'corrupt-markers',
      `标记段 ${block.id} 起止标记只出现一个（start=${start} end=${end}）——拒绝替换`,
    )
  }
  if (start !== -1 && end < start) {
    return reject(
      full,
      req.maxBytes,
      'corrupt-markers',
      `标记段 ${block.id} 起止顺序颠倒（start=${start} > end=${end}）——拒绝替换`,
    )
  }
  const next = spliceBlock(full, req.inner, block)
  const verdict = checkBudget(next, req.maxBytes)
  if (!verdict.allowed) {
    return reject(
      full,
      req.maxBytes,
      'over-budget',
      `写入后 ${verdict.bytes} 字节 > 上限 ${req.maxBytes}（超 ${-verdict.headroom} 字节）——拒绝写盘`,
    )
  }
  return { ok: true, action: 'replaced', content: next, bytes: verdict.bytes, headroom: verdict.headroom }
}

// ---------- 回收（v0.6.0 · 2026-10-08）：撞线时迁最旧条，不再人肉腾空间 ----------
//
// 触发背景：累积段 `self-test` 实测 4,666 B / 11 条且**只增不减**，全文件余量 1,245 B
// ÷ 条目中位 382 B ⇒ 再约 3 条规则就撞线；而此前唯一的腾空间手段是**降级一条正本规则的
// 表达力**（单调消耗，不可持续）。第三版能力「回收」补上「变旧」这一维：
// v0.5.0 管不丢（upsert）→ v0.5.1 管不超（预算守卫）→ 本版管**变旧**。

/** 段内条目切分：**非空行即一条**（trim 后丢弃空行——段是规则清单，不是格式敏感文档） */
export function splitEntries(inner: string): string[] {
  return inner
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** 条目拼回段内文本（`splitEntries` 的逆；往返**幂等**而非逐字，见语义文档 §7） */
export function joinEntries(entries: readonly string[]): string {
  return entries.join('\n')
}

/** 回收指针行前缀——**单一真源**（写入与识别共用：靠它把旧指针从条目里剥掉，避免叠加） */
export const RECYCLE_POINTER_PREFIX = '> ⤵'

export interface RecycleResult {
  /** 回收后的段内文本 */
  readonly inner: string
  /** 迁出的条目（旧 → 新） */
  readonly recycled: readonly string[]
  readonly stopped: 'fits' | 'exhausted'
}

/**
 * 回收：从**最旧**一端逐条移出，直到 `fits` 为真或只剩 `keep` 条。
 *
 * `fits` 是**注入的谓词**（候选段内文本 → 是否可接受）⇒ 本函数不碰文件系统，可离线证伪。
 * 方向是刻意的：只迁最旧（新规则还在被引用），且**绝不迁空**（空段 = 该段机制失效）。
 */
export function recycleOldest(inner: string, fits: (candidateInner: string) => boolean, keep = 1): RecycleResult {
  const head = joinEntries(splitEntries(inner))
  if (fits(head)) return { inner: head, recycled: [], stopped: 'fits' }
  const recycled: string[] = []
  let rest = splitEntries(inner)
  const floor = Math.max(1, Math.floor(keep))
  while (rest.length > floor) {
    recycled.push(rest[0] as string)
    rest = rest.slice(1)
    if (fits(joinEntries(rest))) return { inner: joinEntries(rest), recycled, stopped: 'fits' }
  }
  return { inner: joinEntries(rest), recycled, stopped: 'exhausted' }
}

/** 拼出「条目 + 指针行」；`pointerFor` 缺省时沿用 `stalePointer`（不让既有条目的可达性丢失） */
function withPointer(
  entries: readonly string[],
  count: number,
  pointerFor: ((n: number) => string) | undefined,
  stalePointer: string | undefined,
): string {
  const body = joinEntries(entries)
  const line = count > 0 && pointerFor !== undefined ? pointerFor(count).trim() : (stalePointer ?? '')
  return line === '' ? body : body + '\n' + line
}

export interface RecycleWriteRequest extends UpsertRequest {
  /** 段尾指针行构造器（纯函数；返回 '' ⇒ 不留指针）。缺省 ⇒ 沿用既有指针行 */
  readonly pointerFor?: (recycledCount: number) => string
  /** 至少保留几条规则（缺省 1） */
  readonly keep?: number
  /**
   * 回收的**目标余量**（字节，缺省 1,024）。
   *
   * 只迁到「刚好放下」是不够的——那样下一次写入立刻又撞线（实测：迁到 allowed 时余量只剩 490 B）。
   * 本参数让回收以「回到安全区」为目标；迁到只剩 `keep` 条仍达不到时**尽力而为**（放得下就放行，
   * 但 `stopped` 报 `tight`，不谎报「已回安全区」）。
   */
  readonly reserveBytes?: number
}

/** `not-needed` = 没撞线；`fits` = 迁到目标余量；`tight` = 放得下但没到目标余量；`exhausted` = 迁不动仍放不下 */
export type RecycleStop = 'not-needed' | 'fits' | 'tight' | 'exhausted'

export interface RecycleWriteOutcome {
  readonly outcome: WriteOutcome
  /** 实际迁出的条目（旧 → 新）。**仅在 `outcome.ok === true` 时非空**——拒写时没有任何东西被迁走 */
  readonly recycled: readonly string[]
  readonly stopped: RecycleStop
}

/**
 * **累积路径 + 回收**：撞预算时先迁最旧条，迁够就放行，迁不动才照旧拒写。
 *
 * 与 `applyRuleUpsert` 的分工是**调用方的策略选择**，不是安全等级——两者共用同一套守卫与
 * 预算裁决（I3），本函数只是多了一个「超限时的下一步」。
 *
 * 四条刻意的不变量：
 * - `ok: false` ⇒ `recycled` 恒为空（调用方**不可能**误把没收到的迁移写进归档）；
 * - 只迁**最旧**、且保留 ≥ `keep` 条（I10）；
 * - 迁了几条 / 停止原因**一律回传**（I11：回收不许静默）；
 * - 目标是 `reserveBytes` 安全区；达不到时尽力而为并如实报 `tight`，**不谎报达标**。
 */
export function applyRuleUpsertWithRecycle(full: string, req: RecycleWriteRequest): RecycleWriteOutcome {
  const request: UpsertRequest = { blockId: req.blockId, draft: req.draft, maxBytes: req.maxBytes }
  const direct = applyRuleUpsert(full, request)
  if (direct.ok) return { outcome: direct, recycled: [], stopped: 'not-needed' }
  if (direct.reason !== 'over-budget') return { outcome: direct, recycled: [], stopped: 'not-needed' }

  const block = findBlock(req.blockId)
  if (block === undefined) return { outcome: direct, recycled: [], stopped: 'not-needed' }
  const existing = extractBlockInner(full, block) ?? ''
  const merged = upsertRuleBlock(existing, flattenDraft(req.draft))
  if (merged.action === 'exists') return { outcome: direct, recycled: [], stopped: 'not-needed' }

  const budgetOf = (candidateInner: string): BudgetVerdict =>
    checkBudget(spliceBlock(full, candidateInner, block), req.maxBytes)

  // 指针是**状态**不是条目：先把它从条目里剥掉（重复回收替换它，不叠加），留作兜底
  const all = splitEntries(merged.inner)
  const stalePointer = all.find((line) => line.startsWith(RECYCLE_POINTER_PREFIX))
  const entries = all.filter((line) => !line.startsWith(RECYCLE_POINTER_PREFIX))

  const keep = Math.max(1, Math.floor(req.keep ?? 1))
  const reserve = Math.max(0, Math.floor(req.reserveBytes ?? 1024))
  const recycled: string[] = []
  let rest = entries
  let chosen: string | null = null
  let fallback: { inner: string; count: number } | null = null
  let stopped: RecycleStop = 'exhausted'
  while (rest.length > keep) {
    recycled.push(rest[0] as string)
    rest = rest.slice(1)
    const candidate = withPointer(rest, recycled.length, req.pointerFor, stalePointer)
    const verdict = budgetOf(candidate)
    if (verdict.allowed && fallback === null) {
      fallback = { inner: candidate, count: recycled.length } // 放得下的**最少**迁移量
    }
    if (verdict.headroom >= reserve) {
      chosen = candidate
      stopped = 'fits'
      break
    }
  }
  if (chosen === null && fallback !== null) {
    chosen = fallback.inner
    recycled.splice(fallback.count) // 回到「最少迁移量」——不为没达到的目标白迁条目
    stopped = 'tight'
  }
  if (chosen === null) return { outcome: direct, recycled: [], stopped }

  const next = spliceBlock(full, chosen, block)
  const verdict = checkBudget(next, req.maxBytes)
  if (!verdict.allowed) return { outcome: direct, recycled: [], stopped } // 双保险：放行前再裁一次
  return {
    outcome: { ok: true, action: 'added', content: next, bytes: verdict.bytes, headroom: verdict.headroom },
    recycled,
    stopped,
  }
}
