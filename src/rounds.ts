/**
 * rounds.ts — 进化轮的账本与轮次操作（原 `dsh-agent-evolve` 的核心，迁入本件）。
 *
 * 三处与旧实现的有意差异：
 * 1. **规则写盘不在这里**——`editResource('agent-rules')` 只更新账本版本，落盘由调用方经
 *    `wiring.applyBlockSet` 完成（唯一写原语 + 预算裁决）。旧实现自己拼 `replace(/start[\s\S]*end/)`
 *    且不做预算裁决。
 * 2. **`extractRules` 只认本件登记的标记段**（不再散落第二份 marker 字面量）。
 * 3. 保留全部事故配套判据：派发前校验工作区（`workspaceStatus`）、提交前扫 child 终态
 *    （`scanSessionOutcome`）、跨代残留集合差（`planWorkspaceReset` / `workspaceSetDiff`）。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { EvolveStore } from './ledger-store.js'
import type { Ledger, ResourceId, ResourceSink } from './types.js'
import { renderPreset } from './presets.js'
import { runFullEval } from './evaluator.js'
import {
  DEFAULT_EXPECTED_MS,
  TRUNCATED_CAVEAT,
  describeOrphan,
  findOrphans,
  reapNote,
  scanSessionOutcome,
  workspaceMissingMessage,
  workspaceStatus,
} from './orphans.js'
import {
  looksLikeWorkspace,
  planWorkspaceReset,
  sweptSummary,
  workspaceResetMessage,
  workspaceSetDiff,
} from './workspace-reset.js'
import { MANAGED_BLOCKS } from './wiring.js'

export const RULES_BLOCK_ID = 'evolve'
export const RULES_FILE = 'AGENTS.md'
/** 候选任务说明书的文件名（落点表与 `initLedger` **共用这一个常量**，不各写一份字面量） */
export const CANDIDATE_PROMPT_FILE = 'CANDIDATE_PROMPT.md'

/** 落点解析所需的环境（路径由调用方解析后注入——本模块不读环境变量、不拼 DSH_HOME） */
export interface SinkEnv {
  /** 受管规则文件的**绝对路径**（调用方用 `resolveRulesPath` 解析） */
  readonly rulesPath: string
  /** modeltest 工作目录（候选任务说明书的家） */
  readonly modeltestDir: string
  /** 规则标记段的字节上限 */
  readonly maxBytes: number
}

/**
 * 有落点的资源（**顺序即声明顺序**）。
 *
 * ⚠ `composition` **不在其中**——理由见 `sinkOf` 注释（它是「已声明未实现」，给它落点会造出第二写者）。
 * 本常量是「哪些资源会写盘」的单一真源：落盘分派、状态读数、回滚遍历都读它。
 */
export const SINK_RESOURCE_IDS: readonly ResourceId[] = ['agent-rules', 'candidate-prompt']

/**
 * 落点表（**单一真源**）：每个资源「写到哪里、怎么写、有没有上限」只在这里声明一次。
 *
 * | 资源 | 落点 | 模式 | 上限 |
 * |---|---|---|---|
 * | `agent-rules` | `env.rulesPath` | `block`（标记段 `evolve`，走 `applyBlockSet` 预算裁决） | `env.maxBytes` |
 * | `candidate-prompt` | `<modeltestDir>/CANDIDATE_PROMPT.md` | `file`（整文件覆盖） | `null`（不是注入面，无预算） |
 * | `composition` | **不注册** | — | — |
 *
 * ⚠ `composition` 为何不注册：`ResourceId` 声明了它，但账本里它**连基线版本都没有**
 * （`initLedger` 只注册前两个），且渲染真源是 `ledger.compositionSource`（**另一个字段**）
 * ⇒ 编辑 `resources['composition']` 对实际渲染**零影响**。这是「已声明未实现」，不是
 * 「可写但没落点」——给它一个落点等于造出**第二个写者**（§5.19）。
 *
 * 返回 `null` 的语义 = **无落点**：调用方必须如实告知「账本变了、盘上没变」，不许静默。
 */
export function sinkOf(env: SinkEnv, resource: ResourceId, content: string): ResourceSink | null {
  if (resource === 'agent-rules') {
    return {
      id: resource,
      path: env.rulesPath,
      mode: 'block',
      blockId: RULES_BLOCK_ID,
      maxBytes: env.maxBytes,
      content,
    }
  }
  if (resource === 'candidate-prompt') {
    return {
      id: resource,
      path: join(env.modeltestDir, CANDIDATE_PROMPT_FILE),
      mode: 'file',
      maxBytes: null,
      content,
    }
  }
  return null
}

export interface RoundConfig {
  readonly modeltestDir: string
  readonly workspaceDir: string
  readonly dshHome: string
  readonly pythonBin: string
  readonly evalTimeoutMs: number
}

/** 抽取本件受管标记段的块内文本（marker 字面量取自 `MANAGED_BLOCKS`，不另写一份） */
export function extractRules(full: string): string {
  const block = MANAGED_BLOCKS.find((b) => b.id === RULES_BLOCK_ID)
  if (block === undefined) return ''
  const start = full.indexOf(block.start)
  const end = full.indexOf(block.end)
  if (start === -1 || end === -1 || end < start) return ''
  return full.slice(start + block.start.length, end).trim()
}

/** 子智能体任务文本：任务说明书 + 本体规则段（规则为空则不附该节） */
export function buildTaskPrompt(candidate: string, rules: string): string {
  const ruleSection = rules.trim().length > 0
    ? '\n\n【本体规则（继承自宿主，必须遵守）】\n' + rules + '\n'
    : ''
  return candidate + ruleSection + '\n\n【输出】完成后简要报告：修改了哪些模块、验证结果、未验证风险。'
}

/** 跑外部命令（用于 modeltest 的 `make_broken_project.py`）；超时 → 124，启动失败 → -2 */
export function runCmd(bin: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], { cwd, windowsHide: true })
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill()
    }, timeoutMs)
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({ code: killed ? 124 : (code ?? -1) })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -2 })
    })
  })
}

/** 无 compositionSource 时的兜底组合（与旧实现同文本） */
export const defaultComposition = "# evolve-live default composition (v1: minimal-ish)\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    prefix: |-\n      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.\n- id: tool-pwsh\n  name: '@deepseek-ai/dsh-tool-pwsh'\n  disabled: !!js process.platform !== 'win32'\n- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'\n- id: tool-fs-search\n  name: '@deepseek-ai/dsh-tool-fs-search'\n- id: tool-jobs\n  name: '@deepseek-ai/dsh-tool-jobs'"

export interface InitResult {
  readonly candidatePromptFile: string
  readonly anchors: Record<string, string>
}

/** 初始化：读 AGENTS.md 规则段与 modeltest 任务说明书注册 v0.0 基线并锁锚点（幂等） */
export function initLedger(store: EvolveStore, config: RoundConfig): InitResult {
  const l = store.ensureLedger()
  const rulesPath = join(config.workspaceDir, RULES_FILE)
  const rulesText = existsSync(rulesPath) ? extractRules(readFileSync(rulesPath, 'utf8')) : ''
  store.addVersion(l, 'agent-rules', rulesText, 'v0.0 基线：本体规则段')
  const cpPath = join(config.modeltestDir, CANDIDATE_PROMPT_FILE)
  const cpText = existsSync(cpPath) ? readFileSync(cpPath, 'utf8') : ''
  store.addVersion(l, 'candidate-prompt', cpText, 'v0.0 基线：modeltest 任务说明书')
  for (const id of ['agent-rules', 'candidate-prompt'] as ResourceId[]) {
    const res = l.resources[id]
    const first = res?.versions[0]
    if (res !== undefined && first !== undefined && !res.anchors.includes(first.version)) res.anchors.push(first.version)
  }
  store.writeLedger(l)
  return {
    candidatePromptFile: cpPath,
    anchors: {
      'agent-rules': l.resources['agent-rules']?.anchors.at(-1) ?? 'v0.0',
      'candidate-prompt': l.resources['candidate-prompt']?.anchors.at(-1) ?? 'v0.0',
    },
  }
}

export interface EditResult {
  readonly version: string
  readonly diff: unknown
  /**
   * 落点（`null` = **无落点**：账本版本已产生、盘上不会变）。
   *
   * 旧版这里是 `needsDiskWrite: boolean` + `rulesContent: string`，两个缺陷：
   * ① boolean 表达不了「哪个资源、写到哪、怎么写」——多资源下 `true` 不知道写谁；
   * ② `rulesContent` 恒取 `agent-rules` 的文本（**编辑 candidate-prompt 时也返回它**）
   * ⇒ 即使照着写，写进去的也是**另一个资源的内容**。落点自带 `content`，这两条一起消失。
   */
  readonly sink: ResourceSink | null
}

/** 编辑资源：新版本 + diff 留痕；**不落盘**（落盘归调用方，按返回的 `sink` 走唯一写原语） */
export function editResource(store: EvolveStore, env: SinkEnv, resource: ResourceId, newContent: string, note: string): EditResult {
  const l = store.ensureLedger()
  const version = store.addVersion(l, resource, newContent, note)
  l.active[resource] = version
  store.writeLedger(l)
  const v = l.resources[resource]?.versions.find((x) => x.version === version)
  return {
    version,
    diff: v?.diff ?? { added: 0, removed: 0, newLength: 0 },
    // 落点内容取**本次编辑的文本**（不是 `contentOf`——那取的是账本里「当前生效」的版本，
    // 对 `agent-rules` 恰好相同，对别的资源就是错的）
    sink: sinkOf(env, resource, newContent),
  }
}

export interface CommitResult {
  readonly action: 'commit' | 'rollback'
  readonly anchor: string
  readonly rollbackFrom?: string
  /**
   * 需要重写盘上的落点（版本变了）——**每个资源一个**。
   *
   * 旧版是单个 `needsDiskWrite: boolean`：它只能表达「有东西要写」，表达不了「写哪个」
   * ⇒ 多资源下这个 boolean 是**有损**的（回滚 candidate-prompt 时无从落盘）。
   */
  readonly sinks: readonly ResourceSink[]
}

/**
 * 提交（浮动版本成为锚点）或回滚（回到最近锚点，不产生新版本号）。
 *
 * 回滚**遍历落点表**——旧版硬编码 `agent-rules`：其余资源的浮动版本被删了却没人通知盘上
 * ⇒ 账本与盘上静默漂移（P1 修的正是这条）。
 */
export function commitOrRollback(store: EvolveStore, env: SinkEnv, rollback: boolean, note: string): CommitResult {
  const l = store.ensureLedger()
  if (rollback) {
    const sinks: ResourceSink[] = []
    let anchor = 'v0.0'
    let rollbackFrom: string | undefined
    for (const id of SINK_RESOURCE_IDS) {
      const res = l.resources[id]
      const latestAnchor = res?.anchors.at(-1)
      const active = l.active[id]
      if (res === undefined || latestAnchor === undefined || active === undefined || active === latestAnchor) continue
      l.rollbacks.push({ at: new Date().toISOString(), fromVersion: active, toVersion: latestAnchor, note })
      delete l.active[id]
      const sink = sinkOf(env, id, store.contentOf(l, id))
      if (sink !== null) sinks.push(sink)
      // `anchor` / `rollbackFrom` 报**规则资源**那一份（它是主锚点）；其余资源的版本由
      // 各自的 `sinks[].id` 指认——把两条资源的版本混成一个数就是口径失真。
      if (id === 'agent-rules') {
        anchor = latestAnchor
        rollbackFrom = active
      }
    }
    store.writeLedger(l)
    return { action: 'rollback', anchor, ...(rollbackFrom !== undefined ? { rollbackFrom } : {}), sinks }
  }
  for (const id of SINK_RESOURCE_IDS) {
    const res = l.resources[id]
    if (res === undefined) continue
    const active = l.active[id]
    if (active !== undefined && !res.anchors.includes(active)) {
      res.anchors.push(active)
      delete l.active[id]
    }
  }
  store.writeLedger(l)
  return { action: 'commit', anchor: l.resources['agent-rules']?.anchors.at(-1) ?? 'v0.0', sinks: [] }
}

export interface RoundStartResult {
  readonly workspace: string
  readonly candidatePromptVersion: string
  readonly rulesVersion: string
  readonly swept: string
}

/**
 * 开始一代：清理 `workspace/` 顶层跨代残留（`make_broken_project.py` 只清 `project2_task/` 内部）
 * → 重置坏项目 → **当场断言集合差** → 渲染配置。
 */
export async function startRound(store: EvolveStore, config: RoundConfig): Promise<RoundStartResult> {
  const l = store.ensureLedger()
  const wsRoot = join(config.modeltestDir, 'workspace')
  const before = existsSync(wsRoot) ? readdirSync(wsRoot) : []
  if (before.length > 0 && !looksLikeWorkspace(before)) {
    throw new Error('拒绝重置：' + wsRoot + ' 顶层无脚手架锚（reference/tests/tools）——疑似 modeltestDir 配错，**未做任何删除**。')
  }
  const plan = planWorkspaceReset(before)
  for (const name of plan.remove) rmSync(join(wsRoot, name), { recursive: true, force: true })
  await runCmd(config.pythonBin, [join(config.modeltestDir, 'evaluator', 'make_broken_project.py')], config.modeltestDir, 300000)
  const after = existsSync(wsRoot) ? readdirSync(wsRoot) : []
  const diff = workspaceSetDiff(after)
  if (!diff.ok) throw new Error(workspaceResetMessage(diff))
  const rules = store.contentOf(l, 'agent-rules')
  renderPreset(config.dshHome, l, rules, l.compositionSource || defaultComposition)
  return {
    workspace: join(config.modeltestDir, 'workspace', 'project2_task'),
    candidatePromptVersion: store.versionOf(l, 'candidate-prompt'),
    rulesVersion: store.versionOf(l, 'agent-rules'),
    swept: sweptSummary(plan),
  }
}

/** 派发前的准备工作区校验（真因：归档时把活跃工作区搬走，此后每轮都无从下手却照常派发） */
export function assertWorkspaceReady(config: RoundConfig): void {
  const ws = workspaceStatus(config.modeltestDir, existsSync, join)
  if (ws.missing) throw new Error(workspaceMissingMessage(ws.project, config.modeltestDir))
}

/** 记录一次派发（run 落盘；sessionId 由调用方从 subagents 拿到） */
export function recordRun(store: EvolveStore, args: { runId: string; gen: number; sessionId: string; parentSessionId?: string }): void {
  store.writeRun({
    runId: args.runId,
    gen: args.gen,
    sessionId: args.sessionId,
    status: 'pending',
    at: new Date().toISOString(),
    ...(args.parentSessionId !== undefined ? { parentSessionId: args.parentSessionId } : {}),
    expectedMs: DEFAULT_EXPECTED_MS,
  })
}

export interface SubmitDeps {
  /** child 会话终态扫描器（会话不在场时返回 undefined = 无法判定） */
  readonly scanChild: (sessionId: string) => { truncated: boolean } | undefined
}

export interface SubmitResult {
  readonly ability: number
  readonly ship: number
  readonly releaseClass: string
  readonly dimensions: unknown
  readonly truncated: boolean
}

/** 收尾一轮：扫 child 终态（截断要标记，否则会被误读成能力回归）→ 跑官方评测 → 入账本 */
export async function submitRun(
  store: EvolveStore,
  config: RoundConfig,
  runId: string,
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const run = store.readRun(runId)
  if (run === null) throw new Error('未知 run：' + runId)
  const l = store.ensureLedger()
  let truncated = false
  if (run.sessionId !== undefined && run.sessionId !== '') {
    const scanned = deps.scanChild(run.sessionId)
    if (scanned !== undefined) truncated = scanned.truncated
  }
  if (truncated) {
    run.note = ((run.note ?? '') + ' ' + TRUNCATED_CAVEAT).trim()
    store.writeRun(run)
  }
  const project = join(config.modeltestDir, 'workspace', 'project2_task')
  const score = await runFullEval(config.modeltestDir, config.pythonBin, project, {
    model: 'dsh-rewrite',
    harness: 'rewrite',
    runGroupId: 'rewrite-gen' + run.gen,
  }, config.evalTimeoutMs)
  run.status = 'done'
  run.doneAt = new Date().toISOString()
  store.writeRun(run)
  l.generations.push({
    gen: run.gen,
    version: store.versionOf(l, 'agent-rules'),
    runId: run.runId,
    sessionId: run.sessionId ?? '',
    ability: score.ability,
    ship: score.ship,
    releaseClass: score.releaseClass,
    dimensions: score.dimensions,
    at: new Date().toISOString(),
    note: run.note ?? '',
  })
  store.writeLedger(l)
  return {
    ability: score.ability ?? 0,
    ship: score.ship ?? 0,
    releaseClass: score.releaseClass ?? '',
    dimensions: score.dimensions,
    truncated,
  }
}

export interface ReapResult {
  readonly dryRun: boolean
  readonly reaped: string[]
}

/** 收尸：超期 run 标 failed（带原因与时刻），**不删记录**；缺省只预览 */
export function reapRuns(
  store: EvolveStore,
  args: { reason?: string; runId?: string; dryRun?: boolean; graceFactor?: number },
): ReapResult {
  const reason = args.reason ?? '超期未收尾（孤儿）'
  const dryRun = args.dryRun !== false
  const all = store.listRuns()
  const targets = args.runId !== undefined && args.runId !== ''
    ? all.filter((r) => r.runId === args.runId)
    : findOrphans(all, Date.now(), args.graceFactor ?? 3)
      .map((o) => all.find((r) => r.runId === o.runId))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
  const done: string[] = []
  for (const r of targets) {
    if (r.status === 'done' || r.status === 'failed') continue
    if (!dryRun) {
      const at = new Date().toISOString()
      store.writeRun({
        ...r,
        status: 'failed',
        doneAt: at,
        reaped: { at, reason },
        note: ((r.note ?? '') + ' ' + reapNote(reason)).trim(),
      })
    }
    done.push(r.runId + '（gen' + r.gen + ' · ' + r.status + ' ⇒ failed）')
  }
  return { dryRun, reaped: done }
}

/** 孤儿清单（只读，不收尸） */
export function listOrphans(store: EvolveStore, graceFactor: number): string[] {
  return findOrphans(store.listRuns(), Date.now(), graceFactor).map(describeOrphan)
}

/** 账本瘦身视图（代 / 活跃版本 / 锚点链 / 撤回记录） */
export function ledgerView(store: EvolveStore): unknown {
  const l: Ledger = store.ensureLedger()
  return {
    generations: l.generations,
    active: l.active,
    anchors: Object.fromEntries(Object.entries(l.resources).map(([k, r]) => [k, r.anchors])),
    rollbacks: l.rollbacks,
  }
}

/** child 终态扫描器的默认实现（会话不在场 ⇒ undefined，不假装「完整」也不无中生有扣帽子） */
export function makeChildScanner(getAgent: (sessionId: string) => unknown): (sessionId: string) => { truncated: boolean } | undefined {
  return (sessionId: string) => {
    const child = getAgent(sessionId)
    if (child === undefined || child === null) return undefined
    const session = (child as { session?: { eventAt?: unknown; seq?: unknown } }).session
    if (session === undefined || typeof session.eventAt !== 'function') return undefined
    const read = (session.eventAt as (seq: number) => unknown).bind(session)
    return scanSessionOutcome(read, session.seq as number)
  }
}
