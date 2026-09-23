/**
 * probes.ts — 探针引擎（被动采证）：订阅 `tools/result`，按活跃假设的探针采集证据。
 *
 * 从 `dsh-agent-self-test` 迁入，**保留全部五种探针语义**（它们各自带着事故编号）：
 * - `tool-failure-rate`：双证据（违规即记 **或** 跨检查点仍未违规 ⇒ 记「经受住检验」）
 * - `read-repeat`：窗口内重复读同一文件
 * - `plan-before-action`：实施突发前是否先 `todo_write`
 * - `probe-before-action`：实施突发前是否先做一次最小探测（§5.9 传感器）
 * - `claim-vs-evidence`：机制自述 vs 落盘实证（§5.17 传感器，按 `claimCheckIntervalMs` 节流）
 *
 * ⚠ 与宿主**同进程**：本模块的回调由调用方包 `guarded()`；内部任何异常都不得逃逸
 * （§5.24：逃逸异常直接杀死 web，且常崩在第一次落盘之前）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BURST_DEFAULTS, createBurstTracker, type BurstEvidence } from './burst.js'
import { PROBEFIRST_DEFAULTS, createProbeFirstTracker, type ProbeFirstEvidence } from './probe.js'
import { decideFailureRateEvidence } from './failure-rate.js'
import { CLAIM_DEFAULTS, countLifeCycleClaims, decideClaimEvidence } from './claim-evidence.js'
import { computeDirection } from './polarity.js'
import { recordEvidence, requireHypotheses, saveHypotheses } from './hypotheses.js'
import type { Evidence, Hypothesis, LegacyPaths } from './store.js'

/** claim-vs-evidence 默认检查间隔：机制层观测不必每次工具调用都读 life-log */
export const CLAIM_CHECK_INTERVAL_DEFAULT_MS = 5 * 60 * 1000

/** life-core 的存在时间线路径（与 `dsh-life-core` 的 dshHome 约定一致） */
export function resolveLifeLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(dshHome, 'life-core', 'life-log.jsonl')
}

/** 读 life-log 全量行；失败返回 `null`——观测器失明不得影响任何主流程 */
export function readLifeLogLines(env: NodeJS.ProcessEnv = process.env): string[] | null {
  try {
    const path = resolveLifeLogPath(env)
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8').split('\n')
  } catch {
    return null
  }
}

/** 取窗口内自述样本（只留少量，供裁决时复核——避免证据膨胀） */
export function claimSamples(lines: readonly string[], windowStartMs: number, nowMs: number): string[] {
  const out: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.includes('自我安排')) continue
    try {
      const at = Date.parse((JSON.parse(trimmed) as { at?: string }).at ?? '')
      if (Number.isNaN(at) || at < windowStartMs || at > nowMs) continue
    } catch {
      continue
    }
    out.push(trimmed.slice(0, 200))
    if (out.length >= 3) break
  }
  return out
}

export interface ProbeEngineDeps {
  readonly paths: LegacyPaths
  readonly enabled: boolean
  readonly mainSessionOnly: boolean
  readonly notifyOnFinding: boolean
  /** 主会话判定（delegationDepth 0 = 主会话） */
  readonly isMainAgent: (agent: unknown) => boolean
  /** finding 投递（由调用方实现——投递方式属宿主耦合，不属探针语义） */
  readonly notifyFinding: (agent: unknown, text: string) => void
  readonly readLifeLog: () => string[] | null
  /** 诊断留痕（观测绝不反噬主流程） */
  readonly trace: (line: string) => void
}

export interface ProbeEngine {
  /** `tools/result` 的处理体（调用方负责包 guarded 与订阅） */
  handle(exec: unknown, result: unknown): void
}

/** 从 `exec` 里取被读文件路径（两种形状：`arguments.file_path` / `input.file_path`） */
function readPathOf(exec: unknown): string | undefined {
  const e = exec as { arguments?: { file_path?: unknown }; input?: { file_path?: unknown } } | undefined
  const p = e?.arguments?.file_path ?? e?.input?.file_path
  return typeof p === 'string' ? p : undefined
}

/** 工具名是否命中探针目标（未指定 = 全部） */
function toolMatches(probe: Hypothesis['probe'], name: string): boolean {
  return probe.tool === undefined || name === probe.tool
}

export function createProbeEngine(deps: ProbeEngineDeps): ProbeEngine {
  const toolStats = new Map<string, { calls: number; failures: number }>()
  const readTimes = new Map<string, number[]>()
  const burstTracker = createBurstTracker()
  const probeFirstTracker = createProbeFirstTracker()
  let lastClaimCheckMs = 0

  function notify(agent: unknown, h: Hypothesis): void {
    if (!deps.notifyOnFinding) return
    if (agent === undefined) {
      deps.trace(`finding 通知跳过：agent 未找到 ${new Date().toISOString()}`)
      return
    }
    // 方向判定统一走 polarity.ts（单一真源）——旧实现在此处只读 `detail.verdict`，
    // 而三族探针当时根本不写该字段 ⇒ 把「违规证据已足」误说成「经受住检验」，
    // 4 条「我会先做 X」型假设就是这么被误确认的（2026-09-17 修复）。
    const dir = computeDirection(h.evidence, h.probe)
    const headline = dir.direction === 'support' ? '✓ 证据支持该假设'
      : dir.direction === 'refute' ? '✗ 证据指向该假设不成立'
        : dir.direction === 'mixed' ? '⚠ 证据方向混杂'
          : '⚠ finding 浮现（方向未知）'
    const text = '[self-rewrite] ' + headline + '：' + h.statement
      + `（证据 ${h.evidence.length}/${h.threshold} 条；${dir.text}）`
      + '——该裁决了：rewrite_verdict（confirm 布线 / refute 淘汰 / refine 细化）。'
    deps.notifyFinding(agent, text)
  }

  function handle(exec: unknown, result: unknown): void {
    if (!deps.enabled) return
    const agent = (exec as { agent?: unknown } | undefined)?.agent
    if (deps.mainSessionOnly && !deps.isMainAgent(agent)) return
    const name = (exec as { name?: unknown } | undefined)?.name
    if (typeof name !== 'string') return
    const state = requireHypotheses(deps.paths)

    const isError = (result as { isError?: unknown } | undefined)?.isError === true
    const now = Date.now()

    const stat = toolStats.get(name) ?? { calls: 0, failures: 0 }
    stat.calls += 1
    if (isError) stat.failures += 1
    toolStats.set(name, stat)

    if (name === 'read' || name === 'read_image') {
      const path = readPathOf(exec)
      if (path !== undefined) {
        const arr = readTimes.get(path) ?? []
        arr.push(now)
        readTimes.set(path, arr.slice(-20))
      }
    }

    let changed = false
    const justFinding: Hypothesis[] = []
    const activeOf = (kind: string): Hypothesis['probe'] | undefined =>
      state.hypotheses.find((h) => h.status === 'active' && h.probe.kind === kind)?.probe

    // 每工具调用只推进一次（防多假设 double-count），产出后广播给所有同类活跃假设
    let burstEvidence: BurstEvidence | null = null
    const planProbe = activeOf('plan-before-action')
    if (planProbe !== undefined) {
      burstEvidence = burstTracker.feed(name, isError, now, {
        burstGapMs: planProbe.burstGapMs ?? BURST_DEFAULTS.burstGapMs,
        minSteps: planProbe.minSteps ?? BURST_DEFAULTS.minSteps,
        planWindowMs: planProbe.planWindowMs ?? BURST_DEFAULTS.planWindowMs,
      })
    }
    let probeFirstEvidence: ProbeFirstEvidence | null = null
    const pfProbe = activeOf('probe-before-action')
    if (pfProbe !== undefined) {
      probeFirstEvidence = probeFirstTracker.feed(name, isError, (exec as { arguments?: Record<string, unknown> } | undefined)?.arguments, now, {
        burstGapMs: pfProbe.burstGapMs ?? PROBEFIRST_DEFAULTS.burstGapMs,
        minActions: pfProbe.minActions ?? PROBEFIRST_DEFAULTS.minActions,
        probeWindowMs: pfProbe.probeWindowMs ?? PROBEFIRST_DEFAULTS.probeWindowMs,
      })
    }

    for (const h of state.hypotheses) {
      if (h.status !== 'active') continue
      const probe = h.probe
      const push = (detail: Record<string, unknown>): void => {
        if (recordEvidence(h, { ts: new Date().toISOString(), kind: probe.kind, detail } as Evidence)) justFinding.push(h)
        changed = true
      }

      if (probe.kind === 'tool-failure-rate') {
        if (!toolMatches(probe, name)) continue
        const s = toolStats.get(name) ?? { calls: 0, failures: 0 }
        const ev = decideFailureRateEvidence(name, s, isError, { threshold: probe.failureRateAbove, minSamples: probe.minSamples })
        if (ev !== null) push({ ...ev })
      } else if (probe.kind === 'read-repeat') {
        if (name !== 'read' && name !== 'read_image') continue
        const path = readPathOf(exec)
        if (path === undefined) continue
        const arr = readTimes.get(path) ?? []
        const windowMs = probe.windowMs ?? 10 * 60 * 1000
        const repeatCount = probe.repeatCount ?? 2
        const inWindow = arr.filter((t) => now - t <= windowMs).length
        if (inWindow >= repeatCount) {
          // verdict 是**事件属性**（命中即「又不该地重复读了」）；它对这条假设是支持还是反对
          // 由 probe.polarity 决定（自省缺陷型主张默认 violation-supports）。
          push({ path, readsInWindow: inWindow, windowMs, verdict: 'violated' })
        }
      } else if (probe.kind === 'plan-before-action') {
        if (burstEvidence !== null) push({ ...burstEvidence })
      } else if (probe.kind === 'probe-before-action') {
        if (probeFirstEvidence !== null) push({ ...probeFirstEvidence })
      } else if (probe.kind === 'claim-vs-evidence') {
        const interval = probe.claimCheckIntervalMs ?? CLAIM_CHECK_INTERVAL_DEFAULT_MS
        if (now - lastClaimCheckMs < interval) continue
        lastClaimCheckMs = now
        const windowMs = probe.claimWindowMs ?? CLAIM_DEFAULTS.windowMs
        const entries = deps.readLifeLog()
        if (entries === null) continue
        const counts = countLifeCycleClaims(entries, now - windowMs, now)
        const ev = decideClaimEvidence(counts, { minArranged: probe.minArranged }, claimSamples(entries, now - windowMs, now))
        if (ev !== null) push({ ...ev })
      }
    }

    if (changed) saveHypotheses(deps.paths, state)
    for (const h of justFinding) notify(agent, h)
  }

  return { handle }
}
