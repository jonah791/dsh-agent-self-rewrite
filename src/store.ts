/**
 * store.ts — 迁移期**兼容读取层**：按旧两件的落点读状态，**不做数据搬迁**。
 *
 * 落点由 2026-09-23 源码实测确定（见 docs/semantic.md §5.4）：
 * - `dsh-agent-self-test`：`<dataDir|join(dshHome,'agent-self-test')>/self-test.json`（原子写 renameSync）
 * - `dsh-agent-evolve`：`<dataDir|$DSH_HOME/.evolve>/{ledger.json, resources/, runs/, orphans.jsonl}`
 *
 * 两条判据来自实战教训：
 * - **缺失与损坏必须可区分**（「账本坏」与「账本不存在」是两种事实，读法不同）；
 * - **形状先归一**再使用——外部 JSON 不得直接当已知类型用（`.length` / 索引访问会抛）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Polarity, ProbeKind } from './polarity.js'

export interface LegacyPaths {
  readonly selfTestDir: string
  readonly selfTestFile: string
  readonly selfTestBackupsDir: string
  readonly evolveDir: string
  readonly ledgerFile: string
  readonly runsDir: string
  readonly resourcesDir: string
  readonly orphansFile: string
}

export interface PathOptions {
  readonly selfTestDataDir?: string
  readonly evolveDataDir?: string
}

/** 解析旧两件的落点（缺省值与原实现一致；给了 dataDir 则覆盖） */
export function resolveLegacyPaths(dshHome: string, opts: PathOptions = {}): LegacyPaths {
  const selfTestDir = opts.selfTestDataDir ?? join(dshHome, 'agent-self-test')
  const evolveDir = opts.evolveDataDir ?? join(dshHome, '.evolve')
  return {
    selfTestDir,
    selfTestFile: join(selfTestDir, 'self-test.json'),
    selfTestBackupsDir: join(selfTestDir, 'backups'),
    evolveDir,
    ledgerFile: join(evolveDir, 'ledger.json'),
    runsDir: join(evolveDir, 'runs'),
    resourcesDir: join(evolveDir, 'resources'),
    orphansFile: join(evolveDir, 'orphans.jsonl'),
  }
}

/** 读取失败三态（闭集）：**不存在** / **存在但坏** / **存在但读不动** */
export type ReadFailure = 'missing' | 'corrupt' | 'unreadable'

export type ReadOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ReadFailure; readonly detail: string }

/** 严格读 JSON：不存在与损坏**可区分**，且都带可诊断 detail（不静默吞） */
export function readJsonStrict<T>(path: string): ReadOutcome<T> {
  if (!existsSync(path)) return { ok: false, reason: 'missing', detail: `文件不存在：${path}` }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { ok: false, reason: 'unreadable', detail: `读取失败：${path}（${(err as Error).message}）` }
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T }
  } catch (err) {
    return { ok: false, reason: 'corrupt', detail: `JSON 解析失败：${path}（${(err as Error).message}）` }
  }
}

/** 一条证据（探针命中记录） */
export interface Evidence {
  ts: string
  kind: ProbeKind
  detail: Record<string, unknown>
}

/** 假设状态机 */
export type HypothesisStatus = 'active' | 'finding' | 'confirmed' | 'refuted' | 'archived'

/**
 * 探针定义（**住数据里**）。
 *
 * `polarity` 是**物化**字段：登记时按 kind 取默认值写进数据，不靠消费方回退到隐式默认表
 * （2026-09-17 修复的核心——方向判定必须有单一真源）。
 */
export interface Probe {
  kind: ProbeKind
  polarity?: Polarity
  tool?: string
  failureRateAbove?: number
  minSamples?: number
  windowMs?: number
  repeatCount?: number
  minSteps?: number
  burstGapMs?: number
  planWindowMs?: number
  minActions?: number
  probeWindowMs?: number
  claimWindowMs?: number
  minArranged?: number
  claimCheckIntervalMs?: number
}

export interface Hypothesis {
  id: string
  statement: string
  prediction: string
  probe: Probe
  threshold: number
  status: HypothesisStatus
  evidence: Evidence[]
  createdAt: string
  updatedAt: string
  source?: string
  note?: string
  resolution?: string
}

export interface SelfTestState {
  readonly hypotheses: Hypothesis[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 形状校验：顶层对象且 `hypotheses` 是数组（形状不对一律判 corrupt，不猜测） */
export function isSelfTestState(v: unknown): v is SelfTestState {
  return isRecord(v) && Array.isArray(v.hypotheses)
}

/** 读旧件 `self-test.json`：缺失 / 损坏 / 形状不符 三态都响亮回报 */
export function loadSelfTestState(paths: LegacyPaths): ReadOutcome<SelfTestState> {
  const read = readJsonStrict<unknown>(paths.selfTestFile)
  if (!read.ok) return read
  if (!isSelfTestState(read.value)) {
    return { ok: false, reason: 'corrupt', detail: `形状不符：${paths.selfTestFile} 顶层缺少 hypotheses 数组` }
  }
  return { ok: true, value: read.value }
}

export interface Resource {
  readonly id: string
  readonly versions: readonly string[]
  readonly anchors: readonly string[]
}

export interface Ledger {
  readonly resources: Record<string, Resource>
}

/** 形状校验：顶层对象且 `resources` 是对象 */
export function isLedger(v: unknown): v is Ledger {
  return isRecord(v) && isRecord(v.resources)
}

/**
 * 读旧件 `ledger.json`。
 *
 * ⚠ 2026-09-23 实测：盘上**只有 `runs/`，没有 `ledger.json`**（evolve 从未初始化成功）。
 * ⇒ 「账本不存在」是**合法状态**，由调用方决定怎么呈现；本函数**不伪造空账本**
 * （伪造会让「未初始化」与「已初始化但为空」无法区分）。
 */
export function loadLedger(paths: LegacyPaths): ReadOutcome<Ledger> {
  const read = readJsonStrict<unknown>(paths.ledgerFile)
  if (!read.ok) return read
  if (!isLedger(read.value)) {
    return { ok: false, reason: 'corrupt', detail: `形状不符：${paths.ledgerFile} 顶层缺少 resources 对象` }
  }
  return { ok: true, value: read.value }
}

/** 列出未收尾评测轮 id（目录不存在 ⇒ 空表，不是错误） */
export function listRuns(paths: LegacyPaths): readonly string[] {
  if (!existsSync(paths.runsDir)) return []
  try {
    return readdirSync(paths.runsDir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

/** 原子写 JSON：先写临时文件再 rename；失败**响亮抛出**（不静默丢内容） */
export function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw new Error(`原子写失败：${path}（${(err as Error).message}）`)
  }
}
