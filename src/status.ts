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

/**
 * 停滞读数：自指引擎「还在动吗」。
 *
 * 存在理由（2026-10-15 实测）：假设库 `active 0 / finding 0`、最新一条 confirmed 停在 25 天前，
 * 而**没有任何面报出这件事**——`rewrite_status` 只报静态计数，不报「多久没动」。
 * 论文 SpecForge（arXiv:2610.15708v1）的教训是「改进必须**累积**而非震荡」，
 * 而本引擎当时的病**不是震荡是停滞**：五环的采证环整条停了，且不可见。
 *
 * ⚠ 空要分型（§5.9）：库空 / 从未布线 / 有布线三种情形**必须长得不一样**，
 * 且天数一律为 `null` 而不是 0（0 天 = 今天刚动过，与「算不出来」是两回事）。
 */
export interface Staleness {
  /** 最新一条 `confirmed` 假设的 `updatedAt`（近似「最后布线时刻」）；无 confirmed ⇒ `null` */
  readonly lastWiredAt: string | null
  /** 全部证据里最新的 `ts`（最后采证时刻）；无证据 ⇒ `null` */
  readonly lastEvidenceAt: string | null
  /** 距今天数（向下取整）；无对应时刻 ⇒ `null`（**不是 0**） */
  readonly daysSinceWired: number | null
  readonly daysSinceEvidence: number | null
  /** 在采证的假设数（`active`）——**0 条 = 采证链断**，这是停滞的根因，比天数更该看 */
  readonly collecting: number
}

const DAY_MS = 86_400_000

/** ISO 时刻 → 距 `now` 的整天数（向下取整）；解析不出 ⇒ `null` */
function daysSince(iso: unknown, now: Date): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.floor((now.getTime() - t) / DAY_MS)
}

export function stalenessOf(hypotheses: readonly Hypothesis[], now: Date): Staleness {
  let lastWired: string | null = null
  let lastEvidence: string | null = null
  let collecting = 0
  for (const h of hypotheses) {
    if (h.status === 'active') collecting += 1
    if (h.status === 'confirmed' && typeof h.updatedAt === 'string' && h.updatedAt.length > 0) {
      if (lastWired === null || Date.parse(h.updatedAt) > Date.parse(lastWired)) lastWired = h.updatedAt
    }
    for (const ev of h.evidence ?? []) {
      const ts = (ev as { ts?: unknown }).ts
      if (typeof ts === 'string' && ts.length > 0 && !Number.isNaN(Date.parse(ts))) {
        if (lastEvidence === null || Date.parse(ts) > Date.parse(lastEvidence)) lastEvidence = ts
      }
    }
  }
  return {
    lastWiredAt: lastWired,
    lastEvidenceAt: lastEvidence,
    daysSinceWired: daysSince(lastWired, now),
    daysSinceEvidence: daysSince(lastEvidence, now),
    collecting,
  }
}

/** 推进队列的一行：一条在采证的假设及其**归一化剩余缺口** */
export interface AdvanceRow {
  readonly id: string
  readonly statement: string
  readonly evidence: number
  readonly threshold: number
  /** `max(0, 阈值 − 证据) / max(阈值, 1)`；0 = 已达阈值（却仍是 active ⇒ 该看为什么没转 finding） */
  readonly gapRatio: number
}

/**
 * 推进队列：在采证的假设按**归一化剩余缺口升序** —— 最接近阈值的排最前。
 *
 * 判据来源：论文 SpecForge §3.2 的 discounted-UCB 奖励 `r̂ = Δφ / (1 − φ)`——
 * 它**除以剩余缺口**，把「本质可修性」与「缺口大所以随便动动就涨」的平凡效应分开。
 * 本函数只取其排序含义：**奖励接近完成的，而不是绝对进展最大的**。
 *
 * ⚠ 三条刻意的边界：
 * - **不设阈值、不替主体选**——只排序 + 如实给缺口比，推进哪条由主体裁（§2.1 判断不可代填）；
 * - 分母用 `max(阈值, 1)` 防除零，且比率型阈值（< 1）不会被算成负缺口；
 * - 同缺口比时**证据多者在前**（更接近可裁决）。
 */
export function advanceQueue(hypotheses: readonly Hypothesis[]): readonly AdvanceRow[] {
  return hypotheses
    .filter((h) => h.status === 'active')
    .map((h) => {
      const threshold = typeof h.threshold === 'number' && Number.isFinite(h.threshold) ? h.threshold : 0
      const evidence = (h.evidence ?? []).length
      return {
        id: h.id,
        statement: h.statement,
        evidence,
        threshold,
        gapRatio: Math.max(0, threshold - evidence) / Math.max(threshold, 1),
      }
    })
    .sort((a, b) => (a.gapRatio === b.gapRatio ? b.evidence - a.evidence : a.gapRatio - b.gapRatio))
}

/** 推进面的渲染（纯文本层；不可用时不渲染——那是 `notes` 的职责，不许两处都说同一件事） */
function advanceLine(stale: Staleness, queue: readonly AdvanceRow[]): string {
  if (stale.lastWiredAt === null && stale.lastEvidenceAt === null && stale.collecting === 0 && queue.length === 0) {
    return '推进面：无假设——五环的「猜想」环当前无内容'
  }
  const wired = stale.lastWiredAt === null
    ? '从未布线'
    : `最后布线 ${String(stale.daysSinceWired ?? '?')} 天前（${stale.lastWiredAt.slice(0, 10)}）`
  const evidence = stale.lastEvidenceAt === null
    ? '从未采证'
    : `最后采证 ${String(stale.daysSinceEvidence ?? '?')} 天前`
  const collecting = stale.collecting === 0
    ? '在采证 0 条（**采证链停**：没有 active 假设，探针不会积累证据）'
    : `在采证 ${String(stale.collecting)} 条`
  const head = `推进面：${wired} · ${evidence} · ${collecting}`
  if (queue.length === 0) return head
  const top = queue.slice(0, 3).map((r) => `${r.id} ${String(r.evidence)}/${String(r.threshold)}`)
  return head + `\n  最接近阈值（归一化缺口升序）：${top.join(' · ')}`
}

export function buildStatus(input: StatusInput, now: Date = new Date()): StatusReport {
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
  if (input.selfTest.ok) {
    // ⚠ 守卫是刻意的：库**读不到**时 `hypotheses` 也是空数组，直接渲染会把「读不到」印成
    // 「无假设」（两种情形必须长得不一样——本模块头部那条纪律）。不可用时交给 notes 说。
    lines.push(advanceLine(stalenessOf(hypotheses, now), advanceQueue(hypotheses)))
  }
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
