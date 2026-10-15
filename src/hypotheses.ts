/**
 * hypotheses.ts — 假设库的状态与裁决逻辑（原 `dsh-agent-self-test` 的核心，迁入本件）。
 *
 * 与旧实现的差异（有意的三处）：
 * 1. **原子写**：走 `store.writeJsonAtomic`（tmp + rename），不再裸 `writeFileSync`；
 * 2. **状态损坏可分辨**：读侧走 `store.readJsonStrict`，损坏与不存在是两种事实；
 * 3. **裁决与布线解耦**：本模块只改状态；写 AGENTS.md 由调用方经 `wiring.applyRuleUpsert` 完成
 *    （唯一写原语，不在本模块里另开一条写路径）。
 */

import { dirname, join } from 'node:path'
import {
  isSelfTestState,
  readJsonStrict,
  writeJsonAtomic,
  type Evidence,
  type Hypothesis,
  type LegacyPaths,
  type Probe,
  type ReadOutcome,
  type SelfTestState,
} from './store.js'
import {
  computeDirection,
  contradictsDirection,
  resolvePolarity,
  stabilityOf,
  type DirectionReport,
  type Polarity,
  type ProbeKind,
  type StabilityReport,
} from './polarity.js'
import { detectCluster } from './cluster.js'

export type HypothesisStatus = Hypothesis['status']

/** 假设库的读取结果（缺失 / 损坏 / 形状不符三态可分辨） */
export function loadHypotheses(paths: LegacyPaths): ReadOutcome<SelfTestState> {
  const read = readJsonStrict<unknown>(paths.selfTestFile)
  if (!read.ok) return read
  if (!isSelfTestState(read.value)) {
    return { ok: false, reason: 'corrupt', detail: `形状不符：${paths.selfTestFile} 顶层缺少 hypotheses 数组` }
  }
  return { ok: true, value: read.value }
}

/**
 * 读假设库；**读不到时响亮抛错**（不静默当成空库）。
 *
 * 旧实现 `loadState` 把「文件不存在」与「JSON 损坏」都吞成空库 ⇒ 一次损坏会让整库看起来「从未有过」，
 * 而写入方随后会把空库写回盘（**静默清空**）。本件不复制这个行为。
 */
export function requireHypotheses(paths: LegacyPaths): SelfTestState {
  const read = loadHypotheses(paths)
  if (read.ok) return read.value
  if (read.reason === 'missing') return { hypotheses: [] }
  throw new Error(`假设库不可读（${read.reason}）：${read.detail}`)
}

export function saveHypotheses(paths: LegacyPaths, state: SelfTestState): void {
  writeJsonAtomic(paths.selfTestFile, state)
}

/** 证据备份目录（与旧实现同位置：`<dataDir>/backups`） */
export function backupsDir(paths: LegacyPaths): string {
  return join(dirname(paths.selfTestFile), 'backups')
}

let idCounter = 0

/** 假设 id（旧格式保持：`h-<base36 时间戳>-<序号>`） */
export function nextHypothesisId(now: Date = new Date()): string {
  idCounter += 1
  return `h-${now.getTime().toString(36)}-${idCounter}`
}

export interface AddHypothesisInput {
  readonly statement: string
  readonly prediction: string
  readonly kind: ProbeKind
  readonly polarity?: Polarity
  readonly threshold: number
  readonly source?: string
  /** 探针参数（未给的键不写入——保持与旧数据的形状一致） */
  readonly probeParams?: Partial<Probe>
  /**
   * 使能型声明：给了它就走 `pending`（待兑现）路径，**不进 `active`**。
   *
   * 用途见 `store.ts` 的 `Hypothesis.enabling`（论文 §3.6 的维度失配）。
   * `deps` 必填且非空——它是这条声明**唯一的可证伪判据**：空 deps 会让它变成永真声明。
   */
  readonly enabling?: { readonly deps: readonly string[] }
}

export interface AddHypothesisResult {
  readonly hypothesis: Hypothesis
  /** 同族已成堆时的收敛提示（建前算，不含刚建的这条） */
  readonly clusterNote: string
}

/** 登记一条假设（极性**物化进数据**：显式声明优先，否则取该探针的默认值并写入） */
export function addHypothesis(state: SelfTestState, input: AddHypothesisInput, now: Date = new Date()): AddHypothesisResult {
  // 使能型声明的护栏：`deps` 必填且非空——空 deps 会让它变成**永真声明**（没有可证伪判据）。
  // 宁可拒绝登记，不可产出无法被证伪的声明（与 id 唯一性护栏同一条纪律）。
  if (input.enabling !== undefined) {
    const deps = input.enabling.deps
    const bad = !Array.isArray(deps) || deps.length === 0
      || deps.some((d) => typeof d !== 'string' || d.trim().length === 0)
    if (bad) {
      throw new Error('使能型声明必须指认依赖路径（enabling.deps = 非空字符串数组）——空 deps 会让它成为永真声明')
    }
  }
  const probe: Probe = { kind: input.kind, polarity: input.polarity ?? resolvePolarity({ kind: input.kind }) }
  const p = input.probeParams ?? {}
  if (p.tool !== undefined) probe.tool = p.tool
  if (p.failureRateAbove !== undefined) probe.failureRateAbove = p.failureRateAbove
  if (p.minSamples !== undefined) probe.minSamples = p.minSamples
  if (p.windowMs !== undefined) probe.windowMs = p.windowMs
  if (p.repeatCount !== undefined) probe.repeatCount = p.repeatCount
  if (p.minSteps !== undefined) probe.minSteps = p.minSteps
  if (p.burstGapMs !== undefined) probe.burstGapMs = p.burstGapMs
  if (p.planWindowMs !== undefined) probe.planWindowMs = p.planWindowMs
  if (p.minActions !== undefined) probe.minActions = p.minActions
  if (p.probeWindowMs !== undefined) probe.probeWindowMs = p.probeWindowMs
  if (p.claimWindowMs !== undefined) probe.claimWindowMs = p.claimWindowMs
  if (p.minArranged !== undefined) probe.minArranged = p.minArranged
  if (p.claimCheckIntervalMs !== undefined) probe.claimCheckIntervalMs = p.claimCheckIntervalMs
  // ⚠ 必须在 push 之前算簇：否则会把刚建的这条也算进去
  const clusterNote = detectCluster(state.hypotheses, input.kind).text
  const iso = now.toISOString()
  const hypothesis: Hypothesis = {
    id: nextHypothesisId(now),
    statement: input.statement,
    prediction: input.prediction,
    probe,
    threshold: input.threshold,
    // 使能型声明停在 `pending`（待兑现）：**不进 active** ⇒ 探针不采它、不污染采证链读数
    status: input.enabling !== undefined ? 'pending' : 'active',
    evidence: [],
    createdAt: iso,
    updatedAt: iso,
    source: input.source ?? 'alice',
  }
  if (input.enabling !== undefined) hypothesis.enabling = { deps: [...input.enabling.deps] }
  state.hypotheses.push(hypothesis)
  return { hypothesis, clusterNote }
}

export type Verdict = 'confirm' | 'refute' | 'refine'

export interface VerdictInput {
  readonly id: string
  readonly verdict: Verdict
  readonly ruleDraft?: string
  readonly newStatement?: string
  readonly newThreshold?: number
  readonly polarity?: Polarity
  readonly resolution?: string
}

export interface VerdictOutcome {
  readonly hypothesis: Hypothesis
  readonly direction: DirectionReport
  /** 裁决动作与证据方向相悖时的护栏提示（**只提示不阻断**，决策权归主体） */
  readonly polarityWarning: string | null
  /**
   * `refute` 但**零证据**时的护栏提示（**只提示不阻断**）。
   *
   * `refuted` 的语义是「**被证伪**」，要求反对证据 ≥1 条；零证据的淘汰（重复项 / 探针不可证伪 /
   * 无独立价值）正确落点是 `archived`（`rewrite_hypothesis action=archive`）。
   * 判据来源（2026-10-15 · t-29233235）：全库核对 6 条「零证据 + refuted」的 resolution，
   * **逐条都是淘汰语义**，没有一条是「被证伪」⇒ 两者同貌会让信号面说谎。
   */
  readonly emptyRefuteWarning: string | null
  /** confirm 且给了 ruleDraft 时为 true——由调用方执行布线（本模块不写 AGENTS.md） */
  readonly needsWiring: boolean
}

/** 裁决一条假设。**只改状态**；布线由调用方用返回的 `needsWiring` 决定。 */
export function applyVerdict(state: SelfTestState, input: VerdictInput, now: Date = new Date()): VerdictOutcome {
  const h = state.hypotheses.find((x) => x.id === input.id)
  if (h === undefined) throw new Error(`假设不存在：${input.id}`)
  if (h.status !== 'finding' && input.verdict === 'confirm') {
    throw new Error(`只有 finding 可以 confirm（当前状态：${h.status}）`)
  }
  const direction = computeDirection(h.evidence, h.probe)
  let polarityWarning: string | null = null
  if (input.verdict !== 'refine' && contradictsDirection(input.verdict, direction.direction, direction.lean)) {
    polarityWarning = `⚠ 护栏提示：${direction.text} —— 而你选择了 ${input.verdict}。`
      + (direction.direction === 'refute'
        ? '若主张本就该被证伪（「我不会 X」型），正确动作通常是 refute 或 refine（改写断言后重新采证）。'
        : '若已确认要逆方向裁定，请在 resolution 写明理由（本次已照办）。')
  }
  // 零证据 refute 护栏（t-29233235）：refuted = 「被证伪」需要反对证据；零证据的淘汰该走 archived。
  // **不阻断**——「零证据也要记成被证伪」可能是刻意的，护栏只要求它在 resolution 里说清证据来源。
  const emptyRefuteWarning: string | null =
    input.verdict === 'refute' && h.evidence.length === 0
      ? '⚠ 护栏提示：本条**零证据**，而 `refuted` 的语义是「被证伪」（要求反对证据 ≥1 条）。'
        + '零证据的淘汰（重复项 / 探针不可证伪 / 无独立价值）正确落点是 `archived`——'
        + '用 `rewrite_hypothesis action=archive`。若确实要记成被证伪，请在 resolution 写明证据来源。'
      : null
  h.updatedAt = now.toISOString()
  if (input.polarity !== undefined) h.probe.polarity = input.polarity
  const note = (base: string): string => {
    const parts = [base]
    if (polarityWarning !== null) parts.push(polarityWarning)
    if (emptyRefuteWarning !== null) parts.push(emptyRefuteWarning)
    return parts.join(' ｜ ')
  }

  let needsWiring = false
  if (input.verdict === 'confirm') {
    h.status = 'confirmed'
    h.resolution = note(input.resolution ?? 'confirmed by evidence')
    if (input.ruleDraft !== undefined) h.note = input.ruleDraft
    needsWiring = input.ruleDraft !== undefined && input.ruleDraft.trim().length > 0
  } else if (input.verdict === 'refute') {
    h.status = 'refuted'
    h.resolution = note(input.resolution ?? 'refuted by evidence')
  } else {
    h.status = 'active'
    if (input.newStatement !== undefined) h.statement = input.newStatement
    if (input.newThreshold !== undefined) h.threshold = input.newThreshold
    h.evidence = [] // 重新采证
    h.resolution = input.resolution ?? 'refined, re-collecting evidence'
  }
  return { hypothesis: h, direction, polarityWarning, emptyRefuteWarning, needsWiring }
}

export interface FulfillInput {
  readonly id: string
  /** 兑现的证据指针（`path:line` / 提交号 / 工具名）——兑现是**事实**，要能指认 */
  readonly refs?: readonly string[]
  readonly note?: string
}

/**
 * 兑现一条使能型声明：`pending` → `confirmed`，并记下兑现时刻与指针。
 *
 * **只改状态**（与 `applyVerdict` 同一条纪律：布线由调用方决定）。
 *
 * ⚠ 三条守卫，都是刻意的：
 * - 非使能型声明 ⇒ 抛错（普通假设走 `applyVerdict`，两条路不混）；
 * - 非 `pending` ⇒ 抛错（`active`/`finding` 不是待兑现态，重复兑现要响亮失败而非静默覆盖）；
 * - 兑现是**记事实**不是**做判断**（§2.4：判断不可代填）——本函数只记录，不判定「这条算不算兑现」。
 */
export function fulfillHypothesis(state: SelfTestState, input: FulfillInput, now: Date = new Date()): Hypothesis {
  const h = state.hypotheses.find((x) => x.id === input.id)
  if (h === undefined) throw new Error(`假设不存在：${input.id}`)
  if (h.enabling === undefined) throw new Error(`不是使能型声明，不能兑现：${input.id}（普通假设用 rewrite_verdict 裁决）`)
  if (h.status !== 'pending') throw new Error(`只有 pending 的使能型声明可以兑现（当前状态：${h.status}）`)
  const iso = now.toISOString()
  h.enabling = {
    deps: h.enabling.deps,
    fulfilledAt: iso,
    ...(input.refs !== undefined && input.refs.length > 0 ? { fulfilledRefs: [...input.refs] } : {}),
  }
  h.status = 'confirmed'
  h.updatedAt = iso
  h.resolution = input.note ?? 'enabling fulfilled'
  return h
}

export interface EnrichedHypothesis extends Hypothesis {
  readonly direction: DirectionReport
  /** 状态说「成立」而证据方向非纯支持（且非「倾向支持」）⇒ 待复核指纹 */
  readonly polaritySuspect: boolean
  /** 判定稳定性（分半复核）——论文 TEB 噪声带的本地化；`unstable` ⇒ 该判定**在带内** */
  readonly stability: StabilityReport
}

/** 给假设附上方向判定、极性体检与稳定性（列表与 finding 共用同一真源） */
export function enrich(state: SelfTestState, status?: string): EnrichedHypothesis[] {
  const picked = status === undefined ? state.hypotheses : state.hypotheses.filter((h) => h.status === status)
  return picked.map((h) => {
    const direction = computeDirection(h.evidence, h.probe)
    const polaritySuspect = h.status === 'confirmed' && direction.direction !== 'support' && direction.lean !== 'lean-support'
    return { ...h, direction, polaritySuspect, stability: stabilityOf(h.evidence, h.probe) }
  })
}

/** 证据达阈值的 active 假设转 finding；返回是否**刚**转（供通知） */
export function recordEvidence(h: Hypothesis, ev: Evidence, now: Date = new Date()): boolean {
  h.evidence.push(ev)
  h.updatedAt = now.toISOString()
  if (h.status === 'active' && h.evidence.length >= h.threshold) {
    h.status = 'finding'
    return true
  }
  return false
}
