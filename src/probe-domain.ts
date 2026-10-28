/**
 * probe-domain.ts — 探针域声明（2026-10-28 · 主人要求「都需要完成」）
 *
 * ## 存在理由（实测驱动，不是设计洁癖）
 *
 * 同一探针的 `violated` / `survived` 对不同假设含义不同——探针不知道被问了什么。
 * 2026-10-28 把库里挂 `probe-before-action` 的 7 条假设全量对照后：
 *
 * | 域 | 假设 | 方向 |
 * |---|---|---|
 * | 匹配 | 能力断言前先探测 / 机制异常先取证 / 机制类改动前先探测 | 纯 refute（0/3、0/5、0/5） |
 * | 匹配 | 实施突发动手前读数 | mixed 4/1，**在带内** |
 * | 错配 | 任务前落 todo（todo≠读数） | mixed 7/1，**在带内** |
 * | 错配 | 报数时点（写计数≠写类动作） | mixed 1/2，**在带内** |
 *
 * ⇒ **规律**：域匹配时探针给得出明确方向；域错配时全部 mixed 且全部在带内。
 * 也就是说 **`mixed` 常常是域错配的指纹，不是行为读数**。当天据此把
 * `h-mvpruyw0-1` 裁成 `confounded` 而非硬选方向。
 *
 * ## 本模块做两件事，且只做这两件
 *
 * 1. **声明**：每种探针自报「观测什么时点的什么行为」+「它答不了什么」
 * 2. **可见性**：假设登记时，若陈述里出现该探针覆盖不到的时点词 ⇒ 给一条**提示**
 *
 * ## 明确不做拦截
 *
 * 语义判断不可靠（错配也可能是有意的），而拒绝会让人转向绕过它。
 * AGENTS.md §3.2：防御只让我**看得见、可追溯**，不替我决定。
 * ⇒ `domainHints()` 只返回字符串，调用方把它拼进工具输出，**登记照常完成**。
 *
 * 纯函数、无 IO、无时间依赖 ⇒ 可离线单测（tests/probe-domain.test.mjs）。
 */

import type { Hypothesis } from './store.js'

/** 探针类型（与 hypotheses.ts 的 kind 联合保持一致） */
export type ProbeKind = Hypothesis['probe']['kind']

export interface ProbeDomain {
  /** 观测的时点 + 对象（一句话；它会直接显示在 list 输出里） */
  readonly observes: string
  /** **它答不了什么** —— 反向声明，防止把 mixed 读成行为读数 */
  readonly notFor: readonly string[]
  /** 陈述里出现这些词、而该探针又观测不到那个时点 ⇒ 提示可能错配 */
  readonly mismatchMarkers: readonly string[]
}

/**
 * 六种 kind 的域声明。`enabling` 也收进来：它同样挂着 kind，
 * 而「不采证据、靠依赖路径兑现」正是一条必须显式声明的域属性。
 */
export const PROBE_DOMAINS: Readonly<Record<ProbeKind, ProbeDomain>> = {
  'tool-failure-rate': {
    observes: '某个工具在一段时间内的调用失败比例（含跨检查点仍未违规的反向证据）',
    notFor: [
      '行为纪律是否成立（失败率低不等于我按纪律做）',
      '我是否先做了某个动作',
      '某次具体决策的对错',
    ],
    mismatchMarkers: ['先做', '之前', '报数', '消费', '读取后', '规划'],
  },
  'read-repeat': {
    observes: '同一文件在一个时间窗内被 `read` / `read_image` 的重复次数',
    notFor: [
      '我为什么重复读（健忘 / 上下文缺失 / 有意复核，行为同形）',
      '重复读的内容是否被理解',
      '其它类型工具的重复调用',
    ],
    mismatchMarkers: ['为什么', '原因', '理解', '其它工具', '写'],
  },
  'plan-before-action': {
    observes: '实施突发（连续调用中写类动作 ≥ minSteps）之前，是否先调用过 `todo_write`',
    notFor: [
      'todo 的内容质量与是否被遵守',
      '非写类任务的规划',
      '「该不该规划」这类价值判断',
    ],
    mismatchMarkers: ['报数', '引用', '探测', '读数', 'todo 内容'],
  },
  'probe-before-action': {
    observes: '实施突发的首个写类动作之前（probeWindowMs 内），是否出现过一次探针类调用',
    notFor: [
      '**报数 / 引用 / 判读时点**是否查过（写计数不是写类动作）',
      '探测的质量与深度（阳性对照、读数分辨力属 skills/acceptance-integrity）',
      'todo 是否先落（那是 plan-before-action）',
    ],
    mismatchMarkers: ['报数', '计数', '引用', '写进报告', '判读', '聚合', 'N 篇', 'N 条', 'todo'],
  },
  'claim-vs-evidence': {
    observes: '自述的**持续性动作**（自我安排 / 正在跑 / 已守）与 life-log 落盘实证的对应',
    notFor: [
      '一次性完成声明（「已修好」不是持续性动作）',
      '产出质量与降级归因',
      '没有 life-log 节点的机制',
    ],
    mismatchMarkers: ['降级', '产出', '质量', '归因', '浓度', '画质'],
  },
  enabling: {
    observes: '不采证据——它靠**依赖路径兑现**（deps 里的后续动作是否真的接上）',
    notFor: [
      '任何行为读数（它没有探针）',
      '「等价于成立」（兑现 ≠ 有效）',
    ],
    mismatchMarkers: [],
  },
}

/** 取域声明；未知 kind 返回 undefined（调用方负责降级显示，不抛错） */
export function domainOf(kind: string): ProbeDomain | undefined {
  return (PROBE_DOMAINS as Record<string, ProbeDomain>)[kind]
}

/** `list` 输出用的一行域摘要（未知 kind 如实说「未声明」，不假装没有） */
export function domainLine(kind: string): string {
  const d = domainOf(kind)
  return d === undefined
    ? '域：未声明（该 kind 不在 PROBE_DOMAINS 里）'
    : '域：' + d.observes
}

/**
 * 登记时的域提示。**只提示、不拦截** —— 返回值是给人读的字符串数组。
 * 命中判据刻意保守：只在陈述里出现该探针明确观测不到的时点词时才提示，
 * 避免「任何假设都提示一句」地把提示本身变成噪音。
 */
export function domainHints(kind: string, statement: string): string[] {
  const d = domainOf(kind)
  if (d === undefined || d.mismatchMarkers.length === 0) return []
  const hits = d.mismatchMarkers.filter((m) => statement.includes(m))
  if (hits.length === 0) return []
  return [
    '⚠ 探针域提示：`' + kind + '` 观测的是「' + d.observes + '」，'
      + '而陈述里出现了「' + hits.join('」「') + '」——'
      + '若你要判的正是那个时点，这个探针很可能给出 **mixed**（域错配的指纹，不是行为读数）。',
    '它答不了：' + d.notFor.join('；') + '。',
    '登记照常完成（只提示、不拦）。裁 finding 时若方向是 mixed 且在带内，先查域是否匹配，'
      + '不匹配就走 `confounded` 而不是硬选方向。',
  ]
}
