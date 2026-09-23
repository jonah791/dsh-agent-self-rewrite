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
  type DirectionReport,
  type Polarity,
  type ProbeKind,
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
}

export interface AddHypothesisResult {
  readonly hypothesis: Hypothesis
  /** 同族已成堆时的收敛提示（建前算，不含刚建的这条） */
  readonly clusterNote: string
}

/** 登记一条假设（极性**物化进数据**：显式声明优先，否则取该探针的默认值并写入） */
export function addHypothesis(state: SelfTestState, input: AddHypothesisInput, now: Date = new Date()): AddHypothesisResult {
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
    status: 'active',
    evidence: [],
    createdAt: iso,
    updatedAt: iso,
    source: input.source ?? 'alice',
  }
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
  h.updatedAt = now.toISOString()
  if (input.polarity !== undefined) h.probe.polarity = input.polarity
  const note = (base: string): string => (polarityWarning === null ? base : base + ' ｜ ' + polarityWarning)

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
  return { hypothesis: h, direction, polarityWarning, needsWiring }
}

export interface EnrichedHypothesis extends Hypothesis {
  readonly direction: DirectionReport
  /** 状态说「成立」而证据方向非纯支持（且非「倾向支持」）⇒ 待复核指纹 */
  readonly polaritySuspect: boolean
}

/** 给假设附上方向判定与极性体检（列表与 finding 共用同一真源） */
export function enrich(state: SelfTestState, status?: string): EnrichedHypothesis[] {
  const picked = status === undefined ? state.hypotheses : state.hypotheses.filter((h) => h.status === status)
  return picked.map((h) => {
    const direction = computeDirection(h.evidence, h.probe)
    const polaritySuspect = h.status === 'confirmed' && direction.direction !== 'support' && direction.lean !== 'lean-support'
    return { ...h, direction, polaritySuspect }
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
