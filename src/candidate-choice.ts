/**
 * @module dsh-agent-self-rewrite/candidate-choice
 *
 * 候选选择的**合成判据**（性能 × 成本 × 噪声三要素）——纯函数，无 I/O、无 cordis 依赖。
 *
 * **论文依据**（RRSI 的用法，域图 §3.3 G7）：**候选选择要求「成本增加被性能增益证明」**。
 *
 * **修的是什么**：三个读数此前各说各话——性能 = 评测轮分数（`Generation.ability`）、
 * 成本 = 轮次墙钟时长（`RunState.at → doneAt`）、噪声 = TEB 分半复核（`stabilityOf().unstable`）
 * ——**没有任何一处把它们合成一个裁决**。于是「性能涨了，代价是两倍时长」这种事实
 * 在读数里**不可见**：每一处单独看都是绿的。
 *
 * 三处刻意的语义精确性（§5.9 规则 1：语义不许互相掩盖）：
 * - **「不可判」独立成态**：噪声带内 ⇒ `indistinguishable`——**不是**「平局」，也**不是**
 *   「A 略胜」（TEB 判据原文：「超出量在带内 ⇒ 不报为进化」）；
 * - **缺读数 ⇒ 不可比**（`incomparable`），**不按缺省算**——拿 0 当代替会把「不知道」变成
 *   「很差」，那是本件最想避免的失效形态；
 * - **成本增加必须被证明**：性能增益 / 成本增加 低于下限比 ⇒ `cost-unjustified`
 *   （**只报不拦**：给出裁决与理由，选谁仍归主体，§2.4）。
 */

/** 一个候选的三要素读数。两个 `null` 都是「**没有这个读数**」，不是 0。 */
export interface CandidateReading {
  readonly id: string
  /** 性能读数（越大越好）；`null` = 没有 */
  readonly performance: number | null
  /** 成本读数（越小越好，本件用轮次墙钟毫秒）；`null` = 没有 */
  readonly costMs: number | null
  /**
   * 该性能读数是否**在噪声带内**（分半复核给出不同方向）。
   *
   * ⚠ **三态**：`true` 在带内 / `false` 明确不在带内 / **`null` = 噪声读数不可得**
   * （没有重复测量就谈不上「带」）。第三态是刻意的——把「测不出噪声」当成「没有噪声」
   * 正是 TEB 论文要防的事：它的判据建立在**四次冻结重评**之上，而单次评测**给不出带**。
   */
  readonly noisy: boolean | null
}

export type ChoiceVerdict =
  | { readonly kind: 'pick'; readonly winner: string; readonly reason: string }
  | { readonly kind: 'indistinguishable'; readonly reason: string }
  | { readonly kind: 'incomparable'; readonly reason: string }
  | { readonly kind: 'cost-unjustified'; readonly reason: string }

export interface ChoicePolicy {
  /**
   * 性能增益 / 成本增加 的**下限比**（单位：性能分 / 毫秒）。
   *
   * ⚠ **无缺省值**：它是**主体给的判据**（「多少增益才配得上多少代价」是价值取舍），
   * 本件不代填（§2.4）。缺省一个数会让「我没想清楚」被静默读成「用某个数」。
   */
  readonly minGainPerCost: number
}

/** 把裁决渲染成一行（工具面与测试共用同一句话——单一真源，免得两处措辞漂移） */
export function describeChoice(verdict: ChoiceVerdict): string {
  switch (verdict.kind) {
    case 'pick': return '✅ 选 ' + verdict.winner + '：' + verdict.reason
    case 'indistinguishable': return '⚖ 不可判：' + verdict.reason
    case 'incomparable': return '⚠ 不可比：' + verdict.reason
    case 'cost-unjustified': return '⚠ 成本未被证明：' + verdict.reason
  }
}

/**
 * 合成裁决：给定两个候选的三要素读数，给出**可解释**的结论。
 *
 * 决策顺序即优先级（改序即改语义）：
 * 1. 缺读数 ⇒ `incomparable`（先排除「拿不知道当知道」）
 * 2. 任一 noisy ⇒ `indistinguishable`（噪声带内不比大小——TEB 判据）
 * 3. 性能相同 ⇒ 成本低者胜；成本也相同 ⇒ `indistinguishable`
 * 4. 性能高者成本**不高于**对手 ⇒ 直接胜（无争议）
 * 5. 性能高者成本**更高** ⇒ 比 ≥ 下限 ⇒ 胜；否则 `cost-unjustified`
 */
export function compareCandidates(a: CandidateReading, b: CandidateReading, policy: ChoicePolicy): ChoiceVerdict {
  // ① 缺读数 ⇒ 不可比（**不按缺省算**）
  const missing: string[] = []
  if (a.performance === null) missing.push(a.id + ' 缺性能')
  if (b.performance === null) missing.push(b.id + ' 缺性能')
  if (a.costMs === null) missing.push(a.id + ' 缺成本')
  if (b.costMs === null) missing.push(b.id + ' 缺成本')
  if (missing.length > 0) {
    return {
      kind: 'incomparable',
      reason: '缺读数 ⇒ 不可比（拿 0 当代替会把「不知道」变成「很差」）：' + missing.join('；'),
    }
  }
  const pa = a.performance as number
  const pb = b.performance as number
  const ca = a.costMs as number
  const cb = b.costMs as number

  // ②a 噪声读数**不可得** ⇒ 不可比（把「测不出噪声」当成「没有噪声」正是 TEB 要防的）
  if (a.noisy === null || b.noisy === null) {
    const who = [a.noisy === null ? a.id : null, b.noisy === null ? b.id : null].filter((x): x is string => x !== null)
    return {
      kind: 'incomparable',
      reason: '噪声读数**不可得**（没有重复测量就谈不上「带」）⇒ 无法判断分数差是否在带内：'
        + who.join(' / '),
    }
  }

  // ②b 噪声带内 ⇒ 不可判（不是平局、不是略胜）
  if (a.noisy || b.noisy) {
    const who = [a.noisy ? a.id : null, b.noisy ? b.id : null].filter((x): x is string => x !== null)
    return {
      kind: 'indistinguishable',
      reason: '噪声带内 ⇒ 不可判（TEB：超出量在带内不报为进化）——'
        + who.join(' / ') + ' 的分半复核给出不同方向',
    }
  }

  // ③ 性能相同 ⇒ 比成本
  if (pa === pb) {
    if (ca === cb) return { kind: 'indistinguishable', reason: '性能与成本都相同 ⇒ 没有可据以选择的差异' }
    const winner = ca < cb ? a.id : b.id
    return {
      kind: 'pick',
      winner,
      reason: '性能相同（' + String(pa) + '）⇒ 成本低者胜（'
        + String(Math.min(ca, cb)) + ' ms < ' + String(Math.max(ca, cb)) + ' ms）',
    }
  }

  const better = pa > pb ? a : b
  const worse = pa > pb ? b : a
  const gain = (better.performance as number) - (worse.performance as number)
  const extra = (better.costMs as number) - (worse.costMs as number)

  // ④ 性能更高且成本不增加 ⇒ 无争议
  if (extra <= 0) {
    return {
      kind: 'pick',
      winner: better.id,
      reason: '性能更高（+' + String(gain) + '）且成本不增加（' + String(extra) + ' ms）⇒ 无争议',
    }
  }

  // ⑤ 成本更高 ⇒ 增益必须证明它
  const ratio = gain / extra
  if (ratio >= policy.minGainPerCost) {
    return {
      kind: 'pick',
      winner: better.id,
      reason: '性能增益 +' + String(gain) + ' 由成本 +' + String(extra) + ' ms 证明（比 '
        + ratio.toFixed(4) + ' ≥ 下限 ' + String(policy.minGainPerCost) + '）',
    }
  }
  return {
    kind: 'cost-unjustified',
    reason: better.id + ' 性能 +' + String(gain) + ' 但成本 +' + String(extra) + ' ms（比 '
      + ratio.toFixed(4) + ' < 下限 ' + String(policy.minGainPerCost) + '）',
  }
}
