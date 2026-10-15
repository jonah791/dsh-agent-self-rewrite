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
  /** 正常归档态（`archived`）——独立一档：它是**正常状态**，不是「未知取值」（混进 `other` 会让读数口径失真） */
  readonly archived: number
  readonly other: number
  /** 使能型声明的**待兑现**数（`pending`）——独立一档，**不并入 active**（并入会掩盖「采证链停」） */
  readonly pending: number
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

/**
 * 假设库的状态分类。
 *
 * `other` 的口径 = **`HypothesisStatus` 六态之外的取值**（数据损坏 / 旧版本写入 / 手改）——
 * 正常状态一律独立成档，**不许混进 `other`**。`archived` 曾落在这里，让「读数口径不准」
 * 与「数据真的坏了」长得一样（2026-10-15 修 · t-2a164936）。
 *
 * ⚠ 不要恢复「用一个 KNOWN 集合 + else 兜底」的写法：那种写法把**新状态默认归入未知**，
 * 加一档就要记得改两处（集合与 if 链），而漏改的那一处**静默生效**——本次事故的形状。
 */
export function countHypotheses(hypotheses: readonly Hypothesis[]): Omit<StatusCounts, 'anchors' | 'runs' | 'unclosed'> {
  let active = 0
  let findings = 0
  let confirmed = 0
  let refuted = 0
  let archived = 0
  let pending = 0
  let other = 0
  for (const h of hypotheses) {
    if (h.status === 'active') active += 1
    else if (h.status === 'finding') findings += 1
    else if (h.status === 'confirmed') confirmed += 1
    else if (h.status === 'refuted') refuted += 1
    else if (h.status === 'archived') archived += 1
    else if (h.status === 'pending') pending += 1
    else other += 1
  }
  return { hypotheses: hypotheses.length, active, findings, confirmed, refuted, archived, pending, other }
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
    // ⚠ 只数**普通** confirmed：使能型声明兑现后也是 confirmed，但它不是「布线」——
    // 计入会让「最后布线」看起来比实际新（假活读数，而这一面存在的理由正是抓假活）。
    if (h.status === 'confirmed' && h.enabling === undefined && typeof h.updatedAt === 'string' && h.updatedAt.length > 0) {
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

/** 承诺面的一行：一条待兑现的使能型声明 */
export interface PromiseRow {
  readonly id: string
  readonly statement: string
  /** 它支撑的后续动作（登记时必填——该声明唯一的可证伪判据） */
  readonly deps: readonly string[]
  /** 登记至今的天数（向下取整）；解析不出 ⇒ `null` */
  readonly ageDays: number | null
}

/**
 * 承诺面：**待兑现的使能型声明**。
 *
 * 判据来源：论文 `arXiv:2610.14625v1` §3.6——改日志、修判据一类改动**不改变即时读数**，
 * 用即时分数验收会把它们判成「无收益」而丢弃，从而失去它们支撑的后续修复
 * （论文的例子：改日志让下一轮能看出日期格式问题，但该改动本身不加分）。
 * 本面的职责是让**未兑现**的声明浮出来（兑现记录在 `Hypothesis.enabling.fulfilledAt`）。
 *
 * ⚠ 三条刻意的边界：
 * - **不设到期日**——「登记时填时效」的形态已被 `reviewAfter` 的零填写实测证伪
 *   （全库 0/1975）；只报**年龄**，兑现还是放弃由主体裁（§2.4 判断不可代填）；
 * - **只列 `pending`**：已兑现与已放弃的不占版面（它们各有自己的读数）；
 * - 年龄算不出 ⇒ `null`（「不知道」不是「今天刚登记」）。
 */
export function promisesOf(hypotheses: readonly Hypothesis[], now: Date): readonly PromiseRow[] {
  return hypotheses
    .filter((h) => h.status === 'pending' && h.enabling !== undefined)
    .map((h) => ({
      id: h.id,
      statement: h.statement,
      deps: h.enabling?.deps ?? [],
      ageDays: daysSince(h.createdAt, now),
    }))
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1))
}

/** 某一类探针的采证落点统计 */
export interface ProbeStarvation {
  readonly kind: string
  /** 用该探针的假设总数 */
  readonly total: number
  /** 其中证据恒 0 的条数 */
  readonly zeroEvidence: number
  /** 零证据者里最老的年龄（天）；算不出 ⇒ `null` */
  readonly maxAgeDays: number | null
}

/** 零证据清单的一行 */
export interface StarvationRow {
  readonly id: string
  readonly probeKind: string
  readonly status: string
  /** 请求的证据量（登记时设的阈值） */
  readonly threshold: number
  /** 登记至今的天数（向下取整）；解析不出 ⇒ `null` */
  readonly ageDays: number | null
  readonly resolution: string | null
}

/**
 * 信号饥饿面：**请求的证据量 vs 落点的证据量**。
 *
 * 判据来源：论文 TESEARCH（arXiv:2610.15964v1）§4 的 landing kernel——LLM 是 noisy actuator，
 * 「请求生成 N 个」与「实际落 M 个」之间存在系统性偏差，论文**建模该偏差并在请求时补偿**。
 * 本引擎的对应物：假设登记时设 `threshold = N`（请求 N 条证据），探针实际落 `evidence.length` 条。
 * **而系统从不比较这两者**——2026-10-15 实测：32 条假设里 12 条证据恒 0，其中 8 条已裁 `refuted`
 * ⇒ 「**从未被检验**」被记成了「**被证伪**」，采证链因此静默停摆 24 天而无人知。
 *
 * ⚠ 三条刻意的边界：
 * - **不设饥饿阈值**（§2.4 判断不可代填）：报出**年龄**，饿不饿由主体看——新登记的假设零证据是正常的；
 * - **不分状态过滤**：`active` / `refuted` / `confirmed` 的零证据都算，因为它们指向三种不同的病；
 * - **按探针分档**（论文 size-niche 的对应物）：饥饿若集中在某一类探针上，那是**探针的系统性缺陷**
 *   而非某条假设的问题——混成一个总数就把这个信号抹平了。
 */
export interface Starvation {
  /** 零证据假设数（全状态合计） */
  readonly zeroEvidence: number
  /** ⚠ 本面最值钱的一条：**已裁 `refuted` 却零证据** ⇒ 「未被检验」被记成了「被证伪」 */
  readonly refutedWithoutEvidence: number
  /** 已裁 `confirmed` 却零证据——状态机**不该**产出这种组合，出现即如实报（不吞） */
  readonly confirmedWithoutEvidence: number
  /** 零证据者里最老的年龄（天）；无零证据 ⇒ `null` */
  readonly oldestZeroAgeDays: number | null
  /** 按探针分档，只含**有零证据**的档（全采到的档不占版面） */
  readonly byProbe: readonly ProbeStarvation[]
  /** 零证据清单（最老在前）——**不设阈值**，让年龄自己说话 */
  readonly rows: readonly StarvationRow[]
}

export function starvationOf(hypotheses: readonly Hypothesis[], now: Date): Starvation {
  const rows: StarvationRow[] = []
  const perProbe = new Map<string, { total: number; zero: number; oldest: number | null }>()
  let refutedWithoutEvidence = 0
  let confirmedWithoutEvidence = 0

  for (const h of hypotheses) {
    // ⚠ 使能型声明天然零证据（它不靠证据，靠依赖路径兑现）⇒ 计入会把信号面污染成「恒有饥饿」，
    // 而这一面存在的理由正是分辨「请求了 N 条、落点 0 条」的真饥饿。
    if (h.status === 'pending') continue
    const kind = typeof h.probe?.kind === 'string' && h.probe.kind.length > 0 ? h.probe.kind : '(未标探针)'
    const slot = perProbe.get(kind) ?? { total: 0, zero: 0, oldest: null }
    slot.total += 1
    const evidence = (h.evidence ?? []).length
    if (evidence === 0) {
      slot.zero += 1
      const age = daysSince(h.createdAt, now)
      if (age !== null && (slot.oldest === null || age > slot.oldest)) slot.oldest = age
      if (h.status === 'refuted') refutedWithoutEvidence += 1
      if (h.status === 'confirmed') confirmedWithoutEvidence += 1
      rows.push({
        id: h.id,
        probeKind: kind,
        status: h.status,
        threshold: typeof h.threshold === 'number' && Number.isFinite(h.threshold) ? h.threshold : 0,
        ageDays: age,
        resolution: typeof h.resolution === 'string' ? h.resolution : null,
      })
    }
    perProbe.set(kind, slot)
  }

  // 最老在前；年龄算不出的排最后（`null` 不进比较——它是「不知道」，不是「最年轻」）
  rows.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1))

  const byProbe = [...perProbe.entries()]
    .filter(([, v]) => v.zero > 0)
    .map(([kind, v]) => ({ kind, total: v.total, zeroEvidence: v.zero, maxAgeDays: v.oldest }))
    .sort((a, b) => (b.maxAgeDays ?? -1) - (a.maxAgeDays ?? -1))

  const oldest = rows.reduce<number | null>(
    (acc, r) => (r.ageDays === null ? acc : acc === null || r.ageDays > acc ? r.ageDays : acc),
    null,
  )

  return {
    zeroEvidence: rows.length,
    refutedWithoutEvidence,
    confirmedWithoutEvidence,
    oldestZeroAgeDays: oldest,
    byProbe,
    rows,
  }
}

/**
 * 信号面的渲染。
 *
 * ⚠ 三态不许同貌：**无零证据** ⇒ 明说「全部采到」（那是一个**好读数**，不是空）；**有零证据** ⇒
 * 给出条数、最老年龄、以及**已裁 refuted 的条数**（那是「未被检验被记成被证伪」的直接量化）。
 */
function signalLine(s: Starvation): string {
  if (s.zeroEvidence === 0) return '信号面：全部假设都已采到证据（落点 = 请求）'
  const oldest = s.oldestZeroAgeDays === null ? '年龄不可算' : `最老 ${String(s.oldestZeroAgeDays)} 天`
  const head = `信号面：零证据 ${String(s.zeroEvidence)} 条（${oldest}）`
  const refuted = s.refutedWithoutEvidence > 0
    ? ` · ⚠ 其中已裁 refuted ${String(s.refutedWithoutEvidence)} 条——**未被检验 ≠ 被证伪**`
    : ''
  const confirmed = s.confirmedWithoutEvidence > 0
    ? ` · ⚠ 已裁 confirmed ${String(s.confirmedWithoutEvidence)} 条（状态机不该产出此组合，请查）`
    : ''
  const probes = s.byProbe.length === 0
    ? ''
    : '\n  按探针分档（哪类探针系统性采不到）：'
      + s.byProbe.map((p) => `${p.kind} ${String(p.zeroEvidence)}/${String(p.total)}`).join(' · ')
  return head + refuted + confirmed + probes
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

/**
 * 承诺面的渲染。
 *
 * ⚠ 三态不许同貌：**无待兑现** ⇒ 明说「无」（这可能是好读数——都兑现了，或从未登记过）；
 * **有待兑现** ⇒ 给条数、最老年龄与**依赖路径**（一眼看出它在等什么，而不是只有一串 id）。
 */
function promiseLine(rows: readonly PromiseRow[]): string {
  if (rows.length === 0) return '承诺面：无待兑现的使能型声明'
  const oldest = rows.reduce<number | null>(
    (acc, r) => (r.ageDays === null ? acc : acc === null || r.ageDays > acc ? r.ageDays : acc),
    null,
  )
  const head = `承诺面：待兑现 ${String(rows.length)} 条${oldest === null ? '' : `（最老 ${String(oldest)} 天）`}`
  const list = rows.slice(0, 3).map((r) => `${r.id} → ${r.deps.join(' / ')}`)
  return head + `\n  依赖路径：${list.join(' · ')}`
}

/**
 * 感知圈联动的载荷（跨插件服务 `selfRewrite.snapshot()` 的返回）。
 *
 * 存在理由（2026-10-15）：停滞面建好之后，**它仍然要我主动查**——而实测停滞正是
 * 「没人推我」的结果。`evolution-core` 有感知圈联动（life-core 到期拉它），本件没有
 * ⇒ 同一条链上的两个引擎，一个有入口一个没有。本函数把停滞读数做成**可被拉取的载荷**。
 *
 * ⚠ `signal` 的判据刻意收窄（避免噪音）：**库空 ⇒ false**（新装不是停滞；「读不到」与
 * 「空」的分型由调用方另行负责）；**库非空 ⇒ true**（要么采证链停、要么有可推进项，
 * 两者都值得看一眼）。不设「停滞天数阈值」——那是判断，不由程序代填（§2.4）。
 */
export interface SelfRewriteSnapshot {
  readonly at: string
  readonly daysSinceWired: number | null
  readonly daysSinceEvidence: number | null
  readonly collecting: number
  /** 零证据假设数（**信号饥饿**：请求了 N 条证据、落点 0 条） */
  readonly starved: number
  /** 其中**已裁 `refuted`** 的条数——「未被检验」被记成「被证伪」的直接量化 */
  readonly refutedWithoutEvidence: number
  /** 零证据者里最老的年龄（天）；无 ⇒ `null` */
  readonly oldestStarvedDays: number | null
  /** 推进队列首位（归一化缺口最小者）；无在采证假设 ⇒ `null` */
  readonly nextUp: AdvanceRow | null
  /** 感知圈是否该带这段（见上方判据） */
  readonly signal: boolean
  /** 一行摘要 */
  readonly line: string
  /** 需要动作时的一句（无 ⇒ `null`） */
  readonly hint: string | null
}

export function selfRewriteSnapshot(hypotheses: readonly Hypothesis[], now: Date): SelfRewriteSnapshot {
  const stale = stalenessOf(hypotheses, now)
  const queue = advanceQueue(hypotheses)
  const starve = starvationOf(hypotheses, now)
  const next = queue.length > 0 ? (queue[0] as AdvanceRow) : null
  const wired = stale.daysSinceWired === null ? '从未布线' : `最后布线 ${String(stale.daysSinceWired)} 天前`
  const evidence = stale.daysSinceEvidence === null ? '从未采证' : `最后采证 ${String(stale.daysSinceEvidence)} 天前`
  const starved = starve.zeroEvidence === 0 ? '' : ` · 零证据 ${String(starve.zeroEvidence)} 条`
  const line = `${wired} · ${evidence} · 在采证 ${String(stale.collecting)} 条${starved}`
  // hint 优先级：**链停**（最严重——没有 active，探针根本不会积累证据）
  //   → **饥饿**（有 active 却采不到：请求与落点的偏差，先查探针有没有机会采）
  //   → 最接近阈值（正常推进状态）
  const oldest = starve.oldestZeroAgeDays === null ? '' : `（最老 ${String(starve.oldestZeroAgeDays)} 天）`
  const refutedNote = starve.refutedWithoutEvidence > 0
    ? `，其中 ${String(starve.refutedWithoutEvidence)} 条已裁 refuted——**未被检验 ≠ 被证伪**`
    : ''
  const hint = stale.collecting === 0
    ? '⚠ 采证链停：没有 active 假设，探针不会积累证据 ⇒ 要推进五环，先 rewrite_hypothesis(action=add) 登记一条可证伪猜想'
    : (starve.zeroEvidence > 0
      ? `⚠ 信号饥饿：${String(starve.zeroEvidence)} 条假设证据恒 0${oldest}${refutedNote} ⇒ 先查这些探针**有没有机会采到**，再谈推进`
      : (next === null ? null : `最接近阈值：${next.id} ${String(next.evidence)}/${String(next.threshold)}`))
  return {
    at: now.toISOString(),
    daysSinceWired: stale.daysSinceWired,
    daysSinceEvidence: stale.daysSinceEvidence,
    collecting: stale.collecting,
    starved: starve.zeroEvidence,
    refutedWithoutEvidence: starve.refutedWithoutEvidence,
    oldestStarvedDays: starve.oldestZeroAgeDays,
    nextUp: next,
    signal: hypotheses.length > 0,
    line,
    hint,
  }
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
  if (base.other > 0) notes.push(`有 ${base.other} 条假设的状态不在 HypothesisStatus 六态（active/finding/confirmed/refuted/archived/pending）内——原样计数，未归类（这种取值只该来自数据损坏 / 旧版本写入 / 手改）`)

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
    `假设：${base.hypotheses} 条（active ${base.active} / finding ${base.findings} / confirmed ${base.confirmed} / refuted ${base.refuted} / archived ${base.archived} / pending ${base.pending}${base.other ? ` / other ${base.other}` : ''}）`,
    `锚点：${anchorText}`,
    `runs 记录：${input.runs.length}（${statusBreakdown(input.runs)}）· 未收尾 ${unclosed}`,
  )
  if (input.selfTest.ok) {
    // ⚠ 守卫是刻意的：库**读不到**时 `hypotheses` 也是空数组，直接渲染会把「读不到」印成
    // 「无假设」（两种情形必须长得不一样——本模块头部那条纪律）。不可用时交给 notes 说。
    lines.push(advanceLine(stalenessOf(hypotheses, now), advanceQueue(hypotheses)))
    // 信号面与推进面**同守卫**：库读不到时两者一起缺席（「读不到」不许印成「全部采到」）
    lines.push(signalLine(starvationOf(hypotheses, now)))
    // 承诺面（使能型声明）：与上两面同守卫——库读不到时一并缺席
    lines.push(promiseLine(promisesOf(hypotheses, now)))
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
