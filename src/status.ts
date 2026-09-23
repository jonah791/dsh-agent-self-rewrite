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
  listRuns,
  loadLedger,
  loadSelfTestState,
  type Hypothesis,
  type Ledger,
  type LegacyPaths,
  type ReadOutcome,
  type SelfTestState,
} from './store.js'

export interface StatusInput {
  readonly selfTest: ReadOutcome<SelfTestState>
  readonly ledger: ReadOutcome<Ledger>
  readonly runIds: readonly string[]
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
  readonly runs: number
}

export interface StatusReport {
  readonly counts: StatusCounts
  /** 如实呈现的数据可用性与异常（每条一句话） */
  readonly notes: readonly string[]
  readonly text: string
}

/** 假设库里的四种已知终态之外的都归 `other`（不猜、不吞） */
const KNOWN = new Set(['active', 'finding', 'confirmed', 'refuted'])

export function countHypotheses(hypotheses: readonly Hypothesis[]): Omit<StatusCounts, 'anchors' | 'runs'> {
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
  if (input.runIds.length === 0) notes.push('无未收尾评测轮')

  const counts: StatusCounts = { ...base, anchors, runs: input.runIds.length }

  const anchorText = anchors === null ? '未知（账本不可读）' : String(anchors)
  const lines = [
    '自改写引擎 · 状态',
    `假设：${base.hypotheses} 条（active ${base.active} / finding ${base.findings} / confirmed ${base.confirmed} / refuted ${base.refuted}${base.other ? ` / other ${base.other}` : ''}）`,
    `锚点：${anchorText}`,
    `未收尾评测轮：${input.runIds.length}`,
  ]
  if (notes.length > 0) lines.push('', '注：', ...notes.map((n) => `- ${n}`))

  return { counts, notes, text: lines.join('\n') }
}

/** 薄 I/O 层：读旧两件落点后聚合（不做任何写入） */
export function collectStatus(paths: LegacyPaths): StatusReport {
  return buildStatus({
    selfTest: loadSelfTestState(paths),
    ledger: loadLedger(paths),
    runIds: listRuns(paths),
  })
}
