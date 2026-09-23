/**
 * dsh-agent-self-rewrite — 自改写引擎（`AGENTS.md` 标记段的**唯一写者**）。
 *
 * 替换 `dsh-agent-self-test` + `dsh-agent-evolve`：设计见
 * `docs/plans/插件融合设计_自改写与蒸馏_2026-09-23.md`，权威契约见 `docs/semantic.md`。
 *
 * 不变量 I1：`AGENTS.md` 只有一个写者——本件；其他任何插件不得写该文件的标记段。
 *
 * 工具面 14 → 6：
 * - `rewrite_status`     一屏看全（预算 / 假设四态 / findings / 锚点链 / 未收尾轮 / 孤儿）
 * - `rewrite_hypothesis` 登记 / 细化 / 淘汰假设
 * - `rewrite_verdict`    裁决 finding 并**当场布线**（唯一写 AGENTS.md 的入口）
 * - `rewrite_evaluate`   起一代 → 派发 → 收尾 → 收尸（一个入口管完整轮）
 * - `rewrite_commit`     资源版本编辑 / 锚定 / 回滚
 * - `rewrite_history`    履历：版本演进 / 分数 / 撤回记录
 *
 * @module dsh-agent-self-rewrite
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EvolveStore } from './ledger-store.js'
import type { ResourceId } from './types.js'
import { selectParentAgent } from './parent.js'
import { listRuns, loadLedger, loadSelfTestState, resolveLegacyPaths, type LegacyPaths } from './store.js'
import { buildStatus } from './status.js'
import { applyBlockSet, applyRuleUpsert, MANAGED_BLOCKS, type WriteOutcome } from './wiring.js'
import {
  addHypothesis,
  applyVerdict,
  backupsDir,
  enrich,
  requireHypotheses,
  saveHypotheses,
  type Verdict,
} from './hypotheses.js'
import { createProbeEngine, readLifeLogLines } from './probes.js'
import {
  RULES_BLOCK_ID,
  RULES_FILE,
  assertWorkspaceReady,
  buildTaskPrompt,
  commitOrRollback,
  editResource,
  extractRules,
  initLedger,
  ledgerView,
  listOrphans,
  makeChildScanner,
  reapRuns,
  recordRun,
  startRound,
  submitRun,
  type RoundConfig,
} from './rounds.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-agent-self-rewrite': { kind: 'dsh-agent-self-rewrite' }
  }
}

/** 插件名（与 `cordis.patch.yml` 的 id `agent-self-rewrite` 对齐）。 */
export const name = 'agent-self-rewrite'

/** 依赖：工具面、agent 注册表（找父会话）、子智能体（派发评测轮）。 */
export const inject = ['tools', 'agents', 'subagents'] as const

export interface Config {
  enabled: boolean
  /** 工作区根；留空 ⇒ 取 `DSH_HOME` 的父目录 */
  workspaceDir: string
  /** 受管文件名或绝对路径 */
  rulesFile: string
  /** 字节预算上限（缺省留余量于实测注入截断点 ~65,242 之下） */
  maxBytes: number
  /** 规则**累积**写入的标记段（`rewrite_verdict` 用） */
  rulesBlockId: string
  /** 覆盖旧件 `dsh-agent-self-test` 的 dataDir（留空 ⇒ `<DSH_HOME>/agent-self-test`） */
  selfTestDataDir: string
  /** 覆盖旧件 `dsh-agent-evolve` 的 dataDir（留空 ⇒ `<DSH_HOME>/.evolve`） */
  evolveDataDir: string
  /** modeltest 工作目录（评测轮用） */
  modeltestDir: string
  pythonBin: string
  evalTimeoutMs: number
  /** finding 证据阈值（缺省） */
  findingThreshold: number
  /** 只在主会话采证 */
  mainSessionOnly: boolean
  /** finding 浮现时主动投递通知 */
  notifyOnFinding: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  workspaceDir: z.string().default(''),
  rulesFile: z.string().default('AGENTS.md'),
  maxBytes: z.number().default(64800),
  rulesBlockId: z.string().default('self-test'),
  selfTestDataDir: z.string().default(''),
  evolveDataDir: z.string().default(''),
  modeltestDir: z.string().default(''),
  pythonBin: z.string().default('python'),
  evalTimeoutMs: z.number().default(1500000),
  findingThreshold: z.number().default(3),
  mainSessionOnly: z.boolean().default(true),
  notifyOnFinding: z.boolean().default(true),
})

const textOut = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
} as const

const tool = (spec: unknown): never => defineTool(spec as never) as never

/** 解析 `DSH_HOME`：环境变量是运行时真源，硬编码只是最后的回退 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const v = env['DSH_HOME']
  return v !== undefined && v.trim().length > 0 ? v : 'E:/alice/.dsh'
}

/** 受管文件路径：`rulesFile` 含路径分隔符则视为路径本身，否则落到 `<workspaceDir>/<rulesFile>` */
export function resolveRulesPath(config: Config, dshHome: string): string {
  const raw = config.rulesFile.trim()
  const named = raw.length > 0 ? raw : RULES_FILE
  if (named.includes('/') || named.includes('\\')) return named
  const root = config.workspaceDir.trim().length > 0 ? config.workspaceDir.trim() : dirname(dshHome)
  return join(root, named)
}

/** 读受管文件字节数：**不存在 ⇒ `null`**（与「0 字节」严格区分） */
export function readRulesBytes(rulesPath: string): number | null {
  if (!existsSync(rulesPath)) return null
  try {
    return readFileSync(rulesPath).length
  } catch {
    return null
  }
}

/** 主会话判定（delegationDepth 0 / 缺省 = 主会话） */
function isMainAgent(agent: unknown): boolean {
  if (agent === undefined || agent === null) return true
  const depth = (agent as { session?: { header?: { delegationDepth?: number } } }).session?.header?.delegationDepth
  return depth === undefined || depth === 0
}

/** 写盘（备份 + tmp + rename）；**只有 `ok: true` 才允许调用** */
function commitRulesWrite(rulesPath: string, content: string, backupDir: string): void {
  try {
    if (existsSync(rulesPath)) {
      mkdirSync(backupDir, { recursive: true })
      const bak = join(backupDir, 'AGENTS.md.bak-' + new Date().toISOString().replace(/[:.]/g, '-'))
      writeFileSync(bak, readFileSync(rulesPath, 'utf8'), 'utf8')
    }
  } catch {
    /* 备份是 best-effort：checkpoint 是主安全网 */
  }
  const tmp = rulesPath + '.tmp'
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, rulesPath)
}

/** 写入结果的呈现文本（added / exists / replaced / 四类拒绝都当场可见） */
function describeWrite(outcome: WriteOutcome): string {
  if (outcome.ok) {
    if (outcome.action === 'exists') return '该规则已在块内（幂等跳过，一字未写）'
    return (outcome.action === 'replaced' ? '已替换块内容' : '已新增 1 条') + '（余量 ' + String(outcome.headroom) + ' 字节）'
  }
  return '未写入：' + outcome.reason + '——' + outcome.detail
}

export function apply(ctx: Context, config: Config): void {
  const dshHome = resolveDshHome()
  const rulesPath = resolveRulesPath(config, dshHome)
  const paths: LegacyPaths = resolveLegacyPaths(dshHome, {
    selfTestDataDir: config.selfTestDataDir.trim() || undefined,
    evolveDataDir: config.evolveDataDir.trim() || undefined,
  })
  const roundConfig: RoundConfig = {
    modeltestDir: config.modeltestDir,
    workspaceDir: config.workspaceDir.trim().length > 0 ? config.workspaceDir.trim() : dirname(dshHome),
    dshHome,
    pythonBin: config.pythonBin,
    evalTimeoutMs: config.evalTimeoutMs,
  }
  const store = new EvolveStore(paths.evolveDir, config.modeltestDir, '', '')

  const resolveParentAgent = (): Agent => {
    const pinned = ctx.agents.list().length > 0 ? undefined : undefined
    const picked = selectParentAgent('', pinned, ctx.agents.list() as Agent[])
    if ('error' in picked) throw new Error(picked.error)
    return picked.agent
  }

  // ---------- 探针引擎（被动采证；回调包 guarded——逃逸异常会直接杀死宿主） ----------
  const engine = createProbeEngine({
    paths,
    enabled: config.enabled,
    mainSessionOnly: config.mainSessionOnly,
    notifyOnFinding: config.notifyOnFinding,
    isMainAgent,
    notifyFinding: (agent, text) => {
      // reenter 修复：事件回调内同步 send 会触发 session.append reenter ⇒ setImmediate 延迟投递
      setImmediate(() => {
        try {
          const message = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'dsh-agent-self-rewrite' },
          })
          ;(agent as { send?: (m: unknown, s: string, w: boolean) => void }).send?.(message, 'next-step', true)
        } catch (err) {
          ctx.logger('dsh-agent-self-rewrite').warn('finding 通知发送失败：' + String(err))
        }
      })
    },
    readLifeLog: () => readLifeLogLines(),
    trace: (line) => ctx.logger('dsh-agent-self-rewrite').info(line),
  })

  ctx.on('tools/result', (exec, result) => {
    try {
      engine.handle(exec, result)
    } catch (err) {
      // 观测绝不反噬主流程（§5.24）：采证失败只留痕，不抛出
      ctx.logger('dsh-agent-self-rewrite').warn('采证失败：' + String(err))
    }
  })

  // ---------- ① rewrite_status ----------
  ctx.tools.register(tool({
    name: 'rewrite_status',
    description: '自改写引擎状态：受管文件字节预算 / 假设库四态计数 / 待裁决 finding / 锚点链 / 未收尾评测轮 / 孤儿。只读，不写任何东西。'
      + '「读不到」与「为空」在输出里严格区分（账本不可读时锚点报「未知」，不报 0）。',
    parameters: {},
    output: textOut,
    async execute() {
      const report = buildStatus({
        selfTest: loadSelfTestState(paths),
        ledger: loadLedger(paths),
        runIds: listRuns(paths),
        rules: { path: rulesPath, bytes: readRulesBytes(rulesPath), maxBytes: config.maxBytes },
      })
      const lines = [report.text]
      const state = loadSelfTestState(paths)
      if (state.ok) {
        const findings = state.value.hypotheses.filter((h) => h.status === 'finding')
        lines.push('待裁决 finding：' + String(findings.length)
          + (findings.length > 0 ? '\n' + findings.map((h) => '  ⚠ [' + h.id + '] ' + h.statement).join('\n') : ''))
      }
      const orphans = listOrphans(store, 3)
      lines.push('孤儿 run：' + String(orphans.length) + (orphans.length > 0 ? '\n' + orphans.map((o) => '  · ' + o).join('\n') : ''))
      lines.push('受管标记段：' + MANAGED_BLOCKS.map((b) => b.id).join(' / ') + '（累积写入 → ' + config.rulesBlockId + '）')
      return { text: lines.join('\n') }
    },
  }))

  // ---------- ② rewrite_hypothesis ----------
  ctx.tools.register(tool({
    name: 'rewrite_hypothesis',
    description: '自我假设库：action=add 登记一条可证伪假设（插件在真实工具调用中被动采证）/ refine 细化判据后重新采证 / archive 淘汰 / list 列出（含方向判定与极性体检）。',
    parameters: {
      action: { type: 'string', description: 'add（缺省）| refine | archive | list' },
      id: { type: 'string', description: 'refine / archive 时的假设 id' },
      statement: { type: 'string', description: 'add：可证伪陈述' },
      prediction: { type: 'string', description: 'add：可观测预测' },
      kind: { type: 'string', description: 'add：探针类型 tool-failure-rate | read-repeat | plan-before-action | probe-before-action | claim-vs-evidence' },
      threshold: { type: 'number', description: 'add：finding 证据阈值（缺省插件配置）' },
      polarity: { type: 'string', description: 'violation-refutes（主张「我会做 X」）| violation-supports（「我倾向做 X」）；不填按探针取默认并写入数据' },
      status: { type: 'string', description: 'list：状态过滤' },
      newStatement: { type: 'string', description: 'refine：新陈述' },
      newThreshold: { type: 'number', description: 'refine：新阈值' },
      resolution: { type: 'string', description: 'refine / archive：说明' },
    },
    output: textOut,
    async execute(args: { action?: string; id?: string; statement?: string; prediction?: string; kind?: string; threshold?: number; polarity?: string; status?: string; newStatement?: string; newThreshold?: number; resolution?: string }) {
      const action = (args.action ?? 'add').trim()
      const state = requireHypotheses(paths)

      if (action === 'list') {
        const rows = enrich(state, args.status)
        if (rows.length === 0) return { text: '自我假设库为空——先 rewrite_hypothesis(action=add) 登记一条可证伪猜想。' }
        const suspects = rows.filter((r) => r.polaritySuspect).length
        const head = suspects > 0 ? '⚠ 极性存疑 ' + String(suspects) + ' 条（状态标「成立」但证据方向非纯支持）\n' : ''
        return {
          text: head + '自我假设库（' + String(rows.length) + '）\n' + rows.map((h) =>
            (h.status === 'finding' ? '⚠FINDING' : h.status === 'confirmed' ? '✓' : h.status === 'refuted' ? '✗' : '·')
            + ' [' + h.id + '] ' + h.statement
            + '\n   探针 ' + h.probe.kind + '（极性 ' + String(h.probe.polarity ?? '默认') + '）| 证据 ' + String(h.evidence.length) + '/' + String(h.threshold)
            + ' | 方向 ' + h.direction.direction + '（支持 ' + String(h.direction.support) + '/反对 ' + String(h.direction.refute) + '）| ' + h.status).join('\n'),
        }
      }

      if (action === 'archive') {
        if (args.id === undefined) return { text: 'archive 需要 id' }
        const h = state.hypotheses.find((x) => x.id === args.id)
        if (h === undefined) return { text: '假设不存在：' + args.id }
        h.status = 'archived'
        h.updatedAt = new Date().toISOString()
        h.resolution = args.resolution ?? 'archived'
        saveHypotheses(paths, state)
        return { text: '已淘汰 [' + h.id + ']（archived）' }
      }

      if (action === 'refine') {
        if (args.id === undefined) return { text: 'refine 需要 id' }
        const h = state.hypotheses.find((x) => x.id === args.id)
        if (h === undefined) return { text: '假设不存在：' + args.id }
        h.status = 'active'
        if (args.newStatement !== undefined) h.statement = args.newStatement
        if (args.newThreshold !== undefined) h.threshold = args.newThreshold
        h.evidence = []
        h.updatedAt = new Date().toISOString()
        h.resolution = args.resolution ?? 'refined, re-collecting evidence'
        saveHypotheses(paths, state)
        return { text: '已细化 [' + h.id + ']：判据更新，旧证据清空，重新采证' }
      }

      if (args.statement === undefined || args.prediction === undefined || args.kind === undefined) {
        return { text: 'add 需要 statement / prediction / kind' }
      }
      const added = addHypothesis(state, {
        statement: args.statement,
        prediction: args.prediction,
        kind: args.kind as Parameters<typeof addHypothesis>[1]['kind'],
        threshold: args.threshold ?? config.findingThreshold,
        ...(args.polarity !== undefined ? { polarity: args.polarity as Parameters<typeof addHypothesis>[1]['polarity'] } : {}),
      })
      saveHypotheses(paths, state)
      return {
        text: '已登记 [' + added.hypothesis.id + ']（active，阈值 ' + String(added.hypothesis.threshold) + '）——插件开始被动采证。'
          + (added.clusterNote.length > 0 ? '\n' + added.clusterNote : ''),
      }
    },
  }))

  // ---------- ③ rewrite_verdict（唯一写 AGENTS.md 的入口） ----------
  ctx.tools.register(tool({
    name: 'rewrite_verdict',
    description: '裁决 finding 并当场布线——**唯一写 AGENTS.md 标记段的入口**。verdict=confirm（需 finding）会按 ruleDraft 累积写入并生成记录；refute 淘汰；refine 细化后重新采证。'
      + '裁决前用 polarity.ts 算证据方向，动作与方向相悖时返回护栏提示（**只提示不阻断**，决策权归主体）。超预算一律拒写，绝不截断。',
    parameters: {
      id: { type: 'string', required: true, description: '假设 id' },
      verdict: { type: 'string', required: true, description: 'confirm | refute | refine' },
      ruleDraft: { type: 'string', description: 'confirm 时：要写入 AGENTS.md 的规则文本' },
      newStatement: { type: 'string', description: 'refine：新陈述' },
      newThreshold: { type: 'number', description: 'refine：新阈值' },
      polarity: { type: 'string', description: '修正极性：violation-refutes | violation-supports' },
      resolution: { type: 'string', description: '裁决记录' },
    },
    output: textOut,
    async execute(args: { id: string; verdict: Verdict; ruleDraft?: string; newStatement?: string; newThreshold?: number; polarity?: string; resolution?: string }) {
      const state = requireHypotheses(paths)
      const outcome = applyVerdict(state, {
        id: args.id,
        verdict: args.verdict,
        ...(args.ruleDraft !== undefined ? { ruleDraft: args.ruleDraft } : {}),
        ...(args.newStatement !== undefined ? { newStatement: args.newStatement } : {}),
        ...(args.newThreshold !== undefined ? { newThreshold: args.newThreshold } : {}),
        ...(args.polarity !== undefined ? { polarity: args.polarity as Parameters<typeof applyVerdict>[1]['polarity'] } : {}),
        ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
      })
      saveHypotheses(paths, state)

      let wired = ''
      if (outcome.needsWiring && args.ruleDraft !== undefined) {
        const full = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : ''
        const write = applyRuleUpsert(full, { blockId: config.rulesBlockId, draft: args.ruleDraft, maxBytes: config.maxBytes })
        if (write.ok && write.action !== 'exists') commitRulesWrite(rulesPath, write.content, backupsDir(paths))
        wired = '\n布线：' + describeWrite(write)
      }
      return {
        text: '裁决完成：[' + outcome.hypothesis.id + '] → ' + outcome.hypothesis.status
          + '（证据 ' + String(outcome.hypothesis.evidence.length) + ' 条；方向 ' + outcome.direction.direction + '）'
          + wired
          + (outcome.polarityWarning !== null ? '\n' + outcome.polarityWarning : ''),
      }
    },
  }))

  // ---------- ④ rewrite_evaluate（一个入口管完整轮） ----------
  ctx.tools.register(tool({
    name: 'rewrite_evaluate',
    description: '评测轮：action=init 初始化账本（幂等）/ start 起一代（清理跨代残留 + 重置坏项目 + 渲染配置）/ spawn 派发白纸子智能体 / submit 收尾（扫 child 终态 + 官方评测入账）/ reap 收尸（缺省只预览）/ orphans 列孤儿。',
    parameters: {
      action: { type: 'string', required: true, description: 'init | start | spawn | submit | reap | orphans' },
      runId: { type: 'string', description: 'submit / reap 时的 run id' },
      gen: { type: 'number', description: 'spawn：代数（缺省自动）' },
      task: { type: 'string', description: 'spawn：任务文本覆盖' },
      reason: { type: 'string', description: 'reap：收尸原因' },
      dryRun: { type: 'boolean', description: 'reap：true（缺省）只预览' },
      graceFactor: { type: 'number', description: 'orphans / reap：宽限倍数（缺省 3）' },
    },
    output: textOut,
    async execute(args: { action: string; runId?: string; gen?: number; task?: string; reason?: string; dryRun?: boolean; graceFactor?: number }, exec: { signal: AbortSignal }) {
      const action = args.action.trim()
      if (action === 'init') {
        const r = initLedger(store, roundConfig)
        return { text: '账本已初始化。锚点：' + JSON.stringify(r.anchors) + '\n任务说明书：' + r.candidatePromptFile }
      }
      if (action === 'start') {
        const r = await startRound(store, roundConfig)
        return { text: '一代开始：工作区已重置（清理 ' + r.swept + '），任务书 ' + r.candidatePromptVersion + '，本体规则 ' + r.rulesVersion + '\n工作区：' + r.workspace }
      }
      if (action === 'orphans') {
        const rows = listOrphans(store, args.graceFactor ?? 3)
        return { text: rows.length === 0 ? '无孤儿 run。' : '孤儿 ' + String(rows.length) + ' 条：\n' + rows.map((o) => '· ' + o).join('\n') }
      }
      if (action === 'reap') {
        const r = reapRuns(store, {
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          ...(args.runId !== undefined ? { runId: args.runId } : {}),
          ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
          ...(args.graceFactor !== undefined ? { graceFactor: args.graceFactor } : {}),
        })
        return { text: (r.dryRun ? '（预览，未写盘）' : '（已写盘）') + '收尸 ' + String(r.reaped.length) + ' 条'
          + (r.reaped.length > 0 ? '：\n' + r.reaped.map((s) => '· ' + s).join('\n') : '') }
      }
      if (action === 'spawn') {
        assertWorkspaceReady(roundConfig)
        const l = store.ensureLedger()
        const gen = args.gen ?? l.generations.length
        const runId = 'gen' + String(gen) + '-' + Date.now().toString(36)
        const rules = store.contentOf(l, 'agent-rules')
        const candidate = args.task ?? store.contentOf(l, 'candidate-prompt')
        const parent = resolveParentAgent()
        const started = await ctx.subagents.startContinuable({
          provider: 'spawn',
          label: 'rewrite-run-' + String(gen),
          request: { prompt: [{ type: 'text', text: buildTaskPrompt(candidate, rules) }], parent, agentOptions: undefined },
          signal: exec.signal,
        })
        recordRun(store, {
          runId,
          gen,
          sessionId: started.childId,
          ...((parent as { id?: string }).id !== undefined ? { parentSessionId: (parent as { id?: string }).id as string } : {}),
        })
        return { text: '子智能体已派发：run ' + runId + '（session ' + started.childId + '）\n注意：startContinuable 只投递初始 prompt 不唤醒——须由主会话显式发消息唤醒。' }
      }
      if (action === 'submit') {
        if (args.runId === undefined) return { text: 'submit 需要 runId' }
        const r = await submitRun(store, roundConfig, args.runId, {
          scanChild: makeChildScanner((sid) => ctx.agents.get(sid as SessionId)),
        })
        return { text: 'Ability=' + String(r.ability) + ' Ship=' + String(r.ship) + ' Class=' + r.releaseClass
          + (r.truncated ? '\n⚠ 已标记截断读数（child 无 turn/end）' : '') }
      }
      return { text: '未知 action：' + action + '（可用 init | start | spawn | submit | reap | orphans）' }
    },
  }))

  // ---------- ⑤ rewrite_commit ----------
  ctx.tools.register(tool({
    name: 'rewrite_commit',
    description: '资源与锚点：action=edit 写新版本（agent-rules 会经唯一写原语落盘 + 预算裁决）/ commit 浮动版本成为锚点 / rollback 回到最近锚点（不产生新版本号）。',
    parameters: {
      action: { type: 'string', required: true, description: 'edit | commit | rollback' },
      resource: { type: 'string', description: 'edit：agent-rules | candidate-prompt' },
      newContent: { type: 'string', description: 'edit：新内容全文' },
      note: { type: 'string', description: '说明' },
    },
    output: textOut,
    async execute(args: { action: string; resource?: string; newContent?: string; note?: string }) {
      const action = args.action.trim()
      if (action === 'edit') {
        if (args.resource === undefined || args.newContent === undefined) return { text: 'edit 需要 resource 与 newContent' }
        const r = editResource(store, args.resource as ResourceId, args.newContent, args.note ?? '')
        let wired = ''
        if (r.needsDiskWrite) {
          const full = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : ''
          const write = applyBlockSet(full, { blockId: RULES_BLOCK_ID, inner: r.rulesContent, maxBytes: config.maxBytes })
          if (write.ok) commitRulesWrite(rulesPath, write.content, backupsDir(paths))
          wired = '\n落盘：' + describeWrite(write)
        }
        const d = r.diff as { added?: number; removed?: number }
        return { text: '编辑完成：' + r.version + '（diff +' + String(d.added ?? 0) + '/-' + String(d.removed ?? 0) + ' 行）' + wired }
      }
      if (action === 'commit') {
        const r = commitOrRollback(store, false, args.note ?? '')
        return { text: '已提交，新锚点 ' + r.anchor }
      }
      if (action === 'rollback') {
        const r = commitOrRollback(store, true, args.note ?? '')
        if (r.needsDiskWrite) {
          const full = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : ''
          const write = applyBlockSet(full, { blockId: RULES_BLOCK_ID, inner: store.contentOf(store.ensureLedger(), 'agent-rules'), maxBytes: config.maxBytes })
          if (write.ok) commitRulesWrite(rulesPath, write.content, backupsDir(paths))
          return { text: '已回滚到锚点 ' + r.anchor + '（原 ' + String(r.rollbackFrom ?? '') + '）\n落盘：' + describeWrite(write) }
        }
        return { text: '已回滚到锚点 ' + r.anchor + '（无可回滚的浮动版本）' }
      }
      return { text: '未知 action：' + action + '（可用 edit | commit | rollback）' }
    },
  }))

  // ---------- ⑥ rewrite_history ----------
  ctx.tools.register(tool({
    name: 'rewrite_history',
    description: '履历：版本演进（代 / 版本 / 分数 / 结论）、活跃版本、锚点链、撤回记录。只读。',
    parameters: {},
    output: textOut,
    async execute() {
      const view = ledgerView(store) as { generations: unknown[]; anchors: Record<string, string[]>; rollbacks: unknown[] }
      const gens = view.generations as { gen: number; version: string; ability?: number; ship?: number; releaseClass?: string; note?: string }[]
      const lines = ['履历（账本视图）', '代：' + String(gens.length)]
      for (const g of gens) {
        lines.push('  gen' + String(g.gen) + ' · ' + g.version + ' · Ability=' + String(g.ability ?? '-') + ' Ship=' + String(g.ship ?? '-')
          + (g.releaseClass !== undefined ? ' · ' + g.releaseClass : '') + (g.note !== undefined && g.note !== '' ? ' · ' + g.note : ''))
      }
      lines.push('锚点链：' + JSON.stringify(view.anchors))
      lines.push('撤回记录：' + String(view.rollbacks.length))
      return { text: lines.join('\n') }
    },
  }))

  ctx.effect(() => () => {
    /* ctx.on 由 cordis 自动释放 */
  })

  ctx.logger('dsh-agent-self-rewrite').info(
    'ready（唯一写者：' + rulesPath + '，累积块=' + config.rulesBlockId + '，上限=' + String(config.maxBytes) + ' 字节）',
  )
}
