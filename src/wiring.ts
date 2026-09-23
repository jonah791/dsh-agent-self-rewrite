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
      readonly action: UpsertAction
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

/**
 * **唯一写入口**：一次调用完成「登记校验 → 标记完整性校验 → upsert → 预算裁决」。
 *
 * 返回 `ok: true` 才允许落盘；任何拒绝路径都**不改动入参内容**（返回值里没有新内容）。
 * 四类拒绝都是**响亮**的（带闭集 reason 与可诊断 detail），不静默降级。
 */
export function applyRuleUpsert(full: string, req: UpsertRequest): WriteOutcome {
  const block = findBlock(req.blockId)
  if (block === undefined) {
    const known = MANAGED_BLOCKS.map((b) => b.id).join(' / ')
    return reject(full, req.maxBytes, 'unknown-block', `未登记的标记段 id：${req.blockId}（已登记：${known}）`)
  }
  if (normalizeRule(req.draft) === '') {
    return reject(full, req.maxBytes, 'empty-draft', '空草稿：拒绝写入（调用方的规则串构造有误）')
  }
  const start = full.indexOf(block.start)
  const end = full.indexOf(block.end)
  if ((start === -1) !== (end === -1)) {
    return reject(
      full,
      req.maxBytes,
      'corrupt-markers',
      `标记段 ${block.id} 起止标记只出现一个（start=${start} end=${end}）——拒绝追加，以免产生第二个块`,
    )
  }
  if (start !== -1 && end < start) {
    return reject(
      full,
      req.maxBytes,
      'corrupt-markers',
      `标记段 ${block.id} 起止顺序颠倒（start=${start} > end=${end}）——追加会产出读不回来的块，拒绝`,
    )
  }
  const existing = extractBlockInner(full, block) ?? ''
  const merged = upsertRuleBlock(existing, req.draft)
  if (merged.action === 'exists') {
    const verdict = checkBudget(full, req.maxBytes)
    return { ok: true, action: 'exists', content: full, bytes: verdict.bytes, headroom: verdict.headroom }
  }
  const next = spliceBlock(full, merged.inner, block)
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
