/**
 * status.ts — 状态聚合（`rewrite_status` 的**读侧**）。
 *
 * 分两层，为了可离线证伪：
 * - `buildStatus(input)` **纯函数**：给定已读出的状态，产出一屏报告与结构化计数；
 * - `collectStatus(paths)` 薄 I/O 层：调用 `store` 读，再交给 `buildStatus`。
 *
 * 纪律：**读数必须自带范围标注**（§5.9 规则 6）——「账本不存在」与「账本为空」、
 * 「假设库读不到」与「假设库为空」在报告里必须长得不一样，且不可用时**不谎报 0 为真实值**。
 */

import {
  TERMINAL_RUN_STATUSES,
  listRuns,
  loadLedger,
  loadSelfTestState,
  type Hypothesis,
  type Ledger,
  type LegacyPaths,
  type ReadOutcome,
  type RunRecord,
  type SelfTestState,
} from './store.js'

export interface StatusInput {
  readonly selfTest: ReadOutcome<SelfTestState>
  readonly ledger: ReadOutcome<Ledger>
  /** run **记录**（目录里的全部，不只是未收尾的）—— 含 `status`，供如实分解 */
  readonly runs: readonly RunRecord[]
  /** 受管文件的预算读数：`bytes: null` 表示**文件不存在**（与「0 字节」是两件事） */
  readonly rules?: { readonly path: string; readonly bytes: number | null; readonly maxBytes: number }
}

export interface StatusCounts {
  readonly hypotheses: number
  readonly active: number
  readonly findings: number
  readonly confirmed: number
  readonly refuted: number
  readonly other: number
  /** 账本可读时的锚点数；不可读时为 `null`（**不是 0**） */
  readonly anchors: number | null
  /** runs 目录里的**记录数**——**不是**「未收尾轮次数」（后者是 `unclosed`） */
  readonly runs: number
  /** 真正未收尾的记录数（`status` 不在 `TERMINAL_RUN_STATUSES` 内） */
  readonly unclosed: number
}

export interface StatusReport {
  readonly counts: StatusCounts
  /** 如实呈现的数据可用性与异常（每条一句话） */
  readonly notes: readonly string[]
  readonly text: string
}

/** 假设库里的四种已知终态之外的都归 `other`（不猜、不吞） */
const KNOWN = new Set(['active', 'finding', 'confirmed', 'refuted'])

export function countHypotheses(hypotheses: readonly Hypothesis[]): Omit<StatusCounts, 'anchors' | 'runs' | 'unclosed'> {
  let active = 0
  let findings = 0
  let confirmed = 0
  let refuted = 0
  let other = 0
  for (const h of hypotheses) {
    if (h.status === 'active') active += 1
    else if (h.status === 'finding') findings += 1
    else if (h.status === 'confirmed') confirmed += 1
    else if (h.status === 'refuted') refuted += 1
    else other += 1
  }
  return { hypotheses: hypotheses.length, active, findings, confirmed, refuted, other }
}

/** 账本可读 ⇒ 锚点总数；不可读 ⇒ `null`（区分「没有锚点」与「读不到账本」） */
export function countAnchors(ledger: ReadOutcome<Ledger>): number | null {
  if (!ledger.ok) return null
  let n = 0
  for (const res of Object.values(ledger.value.resources)) {
    if (Array.isArray(res.anchors)) n += res.anchors.length
  }
  return n
}

/**
 * 未收尾记录数：`status` **不在**终态集合内的。
 *
 * ⚠ 未知状态一律计入未收尾（宁可多报不可漏报）——终态是**白名单**，不是黑名单。
 */
export function countUnclosed(runs: readonly RunRecord[]): number {
  const terminal = new Set<string>(TERMINAL_RUN_STATUSES)
  return runs.filter((r) => !terminal.has(r.status)).length
}

/**
 * 状态分布串（如 `done 11 · failed 9`）。
 *
 * **为什么要有它**：2026-10-03 修正前 `rewrite_status` 只报一个数并标成「未收尾评测轮」——
 * 实测该目录 20 条里 `done 11 · failed 9`、未收尾 **0**，那个标签误导了一整圈排查。
 * 把分布摆出来，让人一眼看出这个数由什么构成（§5.9 规则 6：读数自带范围标注）。
 */
export function statusBreakdown(runs: readonly RunRecord[]): string {
  const order: readonly string[] = ['pending', 'running', ...TERMINAL_RUN_STATUSES]
  const tally = new Map<string, number>()
  for (const r of runs) tally.set(r.status, (tally.get(r.status) ?? 0) + 1)
  if (tally.size === 0) return '无记录'
  const known = order.filter((s) => tally.has(s))
  const unknown = [...tally.keys()].filter((s) => !order.includes(s)).sort()
  return [...known, ...unknown].map((s) => `${s} ${tally.get(s)}`).join(' · ')
}

export function buildStatus(input: StatusInput): StatusReport {
  const notes: string[] = []

  const hypotheses = input.selfTest.ok ? input.selfTest.value.hypotheses : []
  const base = countHypotheses(hypotheses)
  if (!input.selfTest.ok) {
    notes.push(`假设库不可用（${input.selfTest.reason}）：${input.selfTest.detail}——下列假设计数为 0，**不代表没有假设**`)
  } else if (base.hypotheses === 0) {
    notes.push('假设库为空：五环的「猜想」环当前无内容')
  }
  if (base.other > 0) notes.push(`有 ${base.other} 条假设的状态不在已知四态内（active/finding/confirmed/refuted）——原样计数，未归类`)

  const anchors = countAnchors(input.ledger)
  if (!input.ledger.ok) {
    notes.push(`锚点链不可用（${input.ledger.reason}）：${input.ledger.detail}——锚点计数为「未知」，不是 0`)
  }
  const unclosed = countUnclosed(input.runs)
  if (input.runs.length === 0) {
    notes.push('runs 目录为空：引擎尚未跑过任何评测轮（「目录为空」与「跑了但都收尾了」是两件事）')
  } else if (unclosed === 0) {
    notes.push(`runs 记录 ${input.runs.length} 条，全部已收尾（${statusBreakdown(input.runs)}）——无挂起轮次`)
  }

  const counts: StatusCounts = { ...base, anchors, runs: input.runs.length, unclosed }

  const anchorText = anchors === null ? '未知（账本不可读）' : String(anchors)
  const lines = ['自改写引擎 · 状态']
  if (input.rules !== undefined) {
    const r = input.rules
    lines.push(
      r.bytes === null
        ? `受管文件：${r.path}（**不存在**——首次写入会追加标记段；此处的「不存在」不等于零字节）`
        : `受管文件：${r.path}（${r.bytes} 字节 / 上限 ${r.maxBytes}，余量 ${r.maxBytes - r.bytes}）`,
    )
  }
  lines.push(
    `假设：${base.hypotheses} 条（active ${base.active} / finding ${base.findings} / confirmed ${base.confirmed} / refuted ${base.refuted}${base.other ? ` / other ${base.other}` : ''}）`,
    `锚点：${anchorText}`,
    `runs 记录：${input.runs.length}（${statusBreakdown(input.runs)}）· 未收尾 ${unclosed}`,
  )
  if (notes.length > 0) lines.push('', '注：', ...notes.map((n) => `- ${n}`))

  return { counts, notes, text: lines.join('\n') }
}

/** 薄 I/O 层：读旧两件落点后聚合（不做任何写入） */
export function collectStatus(paths: LegacyPaths): StatusReport {
  return buildStatus({
    selfTest: loadSelfTestState(paths),
    ledger: loadLedger(paths),
    runs: listRuns(paths),
  })
}
