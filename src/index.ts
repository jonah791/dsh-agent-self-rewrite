/**
 * dsh-agent-self-rewrite — 自改写引擎（`AGENTS.md` 标记段的**唯一写者**）。
 *
 * 替换 `dsh-agent-self-test` + `dsh-agent-evolve`：设计见
 * `docs/plans/插件融合设计_自改写与蒸馏_2026-09-23.md`，权威契约见 `docs/semantic.md`。
 *
 * 不变量 I1：`AGENTS.md` 只有一个写者——本件；其他任何插件不得写该文件的标记段。
 *
 * ⚠ 本段只注册**只读**工具 `rewrite_status`。写入路径（`rewrite_verdict`）与其余四个工具尚未落地，
 * 故本件**尚不可挂载**（`lib/index.js` 已产出，但工具面不完整）。
 *
 * @module dsh-agent-self-rewrite
 */

import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildStatus } from './status.js'
import { listRuns, loadLedger, loadSelfTestState, resolveLegacyPaths } from './store.js'
import { MANAGED_BLOCKS } from './wiring.js'

/** 插件名（与 `cordis.patch.yml` 的 id `agent-self-rewrite` 对齐）。 */
export const name = 'agent-self-rewrite'

/** 只依赖工具面。 */
export const inject = ['tools'] as const

export interface Config {
  enabled: boolean
  /** 工作区根；留空 ⇒ 取 `DSH_HOME` 的父目录 */
  workspaceDir: string
  /** 受管文件名或绝对路径 */
  rulesFile: string
  /** 字节预算上限（缺省留余量于实测注入截断点 ~65,242 之下） */
  maxBytes: number
  /** 覆盖旧件 `dsh-agent-self-test` 的 dataDir（留空 ⇒ `<DSH_HOME>/agent-self-test`） */
  selfTestDataDir: string
  /** 覆盖旧件 `dsh-agent-evolve` 的 dataDir（留空 ⇒ `<DSH_HOME>/.evolve`） */
  evolveDataDir: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  workspaceDir: z.string().default(''),
  rulesFile: z.string().default('AGENTS.md'),
  maxBytes: z.number().default(64800),
  selfTestDataDir: z.string().default(''),
  evolveDataDir: z.string().default(''),
})

const textOut = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
} as const

const tool = (spec: unknown): never => defineTool(spec as never) as never

/** 解析 `DSH_HOME`：环境变量是运行时真源，硬编码只是最后的回退（缺两者则回退并如实报出路径） */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const v = env['DSH_HOME']
  return v !== undefined && v.trim().length > 0 ? v : 'E:/alice/.dsh'
}

/** 受管文件路径：`rulesFile` 含路径分隔符则视为绝对/相对路径，否则落到 `<workspaceDir>/<rulesFile>` */
export function resolveRulesPath(config: Config, dshHome: string): string {
  const raw = config.rulesFile.trim()
  const named = raw.length > 0 ? raw : 'AGENTS.md'
  if (named.includes('/') || named.includes('\\')) return named
  const root = config.workspaceDir.trim().length > 0 ? config.workspaceDir.trim() : dirname(dshHome)
  return join(root, named)
}

/** 读受管文件字节数：**不存在 ⇒ `null`**（与「0 字节」严格区分） */
export function readRulesBytes(rulesPath: string): number | null {
  if (!existsSync(rulesPath)) return null
  try {
    return statSync(rulesPath).size
  } catch {
    return null
  }
}

export function apply(ctx: Context, config: Config): void {
  const dshHome = resolveDshHome()
  const rulesPath = resolveRulesPath(config, dshHome)
  const paths = resolveLegacyPaths(dshHome, {
    selfTestDataDir: config.selfTestDataDir.trim() || undefined,
    evolveDataDir: config.evolveDataDir.trim() || undefined,
  })

  ctx.tools.register(tool({
    name: 'rewrite_status',
    description: '自改写引擎状态：受管文件的字节预算 / 假设库四态计数 / 锚点链 / 未收尾评测轮。只读，不写任何东西。'
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
      const tail = '受管标记段：' + MANAGED_BLOCKS.map((b) => b.id).join(' / ')
      return { text: report.text + '\n' + tail }
    },
  }))
}
