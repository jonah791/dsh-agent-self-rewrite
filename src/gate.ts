/**
 * 外生接受位（Exogenous Acceptance Gate）· 纯函数层。
 *
 * 存在理由（2026-10-17 · 4 篇论文迁移 · 设计见 `docs/design/exogenous-acceptance-gate.md`）：
 * 我的「裁决 → 布线」环是**纯内生的**——写判据的是我、被审的也是我。
 * arXiv:2607.24300 给出信息论下界：任**内生门**假拒率 α、假受率 β，则
 * **α + β ≥ 1 − TV(P₊,P₋)** ⇒ 当两个世界难以从可见证据区分时，
 * **没有任何纯内生门能把两个错误都做小**。这不是纪律问题，是下界。
 *
 * 本层只管**裁决**（可离线测）；IO（读冻结账、跑注入器）在 index.ts。
 *
 * 判据纪律：
 * ① **fail-closed**——账不存在 / 哈希不符 / 注入器跑不起来 ⇒ 一律 reject
 * ② **单比特 + 拒因**——除「接受/拒绝」外只给拒因，**不给分数、不给逐样本结果**
 *    （依据 arXiv:2607.24300 的 leaky-anchor：公开审计分六行里五行严格更差）
 * ③ **行为倾向类显式豁免**——无自动 oracle 的规则（如「报时前读时钟」）不许伪造注入器
 *    （那正是 arXiv:2607.13083 的 phantom 生成机制），走 `no-oracle` 路径并**留痕**
 */

/** 冻结账形态：**写规则之前**落盘，写完置只读 */
export interface SealedAccount {
  ruleId: string
  sealedAt: string
  /** 规则文本的哈希（写账时的快照）——落账后被改过 ⇒ 拒 */
  ruleDraftHash: string
  /**
   * 判据类型：
   * - `executable`：有可执行注入器（**能构造出该失败的代码**）⇒ 真外生门
   * - `no-oracle`：**无自动 oracle** 的行为倾向类 ⇒ 不跑注入器，但必须写明理由并留痕
   */
  kind: 'executable' | 'no-oracle'
  /** kind=executable 时必填 */
  injector?: { script: string }
  /** 良性对照：必须与注入器**同位置、同表面角色**（arXiv:2609.00069 的配对构造法） */
  benign?: { script: string }
  /** kind=no-oracle 时必填：为什么这条规则没有可执行的 oracle */
  noOracleReason?: string
  /** 期望退出码（缺省 注入样本非零 / 良性对照零） */
  expect?: { injected: number; benign: number }
}

/** 闸门裁决：单比特 + 拒因（不含分数） */
export interface GateDecision {
  accepted: boolean
  /** 阶段枚举（可诊断「断在哪一段」，不是笼统 error） */
  stage: 'canary-failed' | 'no-account' | 'hash-mismatch' | 'no-oracle' | 'injector-nonzero' | 'benign-nonzero' | 'passed'
  /** 唯一附加信息：为什么拒（接受时为空串） */
  reason: string
}

/** 规则文本哈希（简单确定性：djb2 的十六进制——不引入 crypto 依赖，够用且可离线测） */
export function hashRuleDraft(draft: string): string {
  let h = 5381
  for (let i = 0; i < draft.length; i += 1) {
    h = ((h << 5) + h + draft.charCodeAt(i)) | 0
  }
  return `djb2:${(h >>> 0).toString(16)}`
}

/**
 * 裁决（**纯函数，可离线测**）。
 *
 * @param account 冻结账（null = 不存在）
 * @param actualHash 当前规则文本的哈希
 * @param injectedExit 注入器对**注入样本**的退出码（null = 跑不起来）
 * @param benignExit 注入器对**良性对照**的退出码（null = 跑不起来）
 */
export function decideGate(
  account: SealedAccount | null,
  actualHash: string,
  injectedExit: number | null,
  benignExit: number | null,
): GateDecision {
  if (account === null) {
    return {
      accepted: false,
      stage: 'no-account',
      reason: '未落冻结账（外生接受位要求：写规则前先把注入器 + 判据落盘并置只读）',
    }
  }
  if (account.ruleDraftHash !== actualHash) {
    return {
      accepted: false,
      stage: 'hash-mismatch',
      reason: '规则文本在落账后被改过（哈希不符）——冻结账的意义在于不可为这次改动定制',
    }
  }
  if (account.kind === 'no-oracle') {
    // 行为倾向类：**不伪造注入器**（那是 phantom 的生成机制），但必须留痕放行
    if (!account.noOracleReason) {
      return {
        accepted: false,
        stage: 'no-oracle',
        reason: 'kind=no-oracle 必须写明 noOracleReason（无 oracle 的声明本身要可审）',
      }
    }
    return {
      accepted: true,
      stage: 'passed',
      reason: `无外生 oracle（已留痕）：${account.noOracleReason}`,
    }
  }
  if (injectedExit === null || benignExit === null) {
    return {
      accepted: false,
      stage: 'injector-nonzero',
      reason: '注入器跑不起来（脚本缺失 / 执行失败）——fail-closed，不许当成通过',
    }
  }
  const expect = account.expect ?? { injected: 1, benign: 0 }
  if (injectedExit !== expect.injected) {
    return {
      accepted: false,
      stage: 'injector-nonzero',
      reason: `注入样本未按预期变红（期望退出码 ${String(expect.injected)}，实得 ${String(injectedExit)}）`,
    }
  }
  if (benignExit !== expect.benign) {
    return {
      accepted: false,
      stage: 'benign-nonzero',
      reason: `良性对照未按预期变绿（期望退出码 ${String(expect.benign)}，实得 ${String(benignExit)}）——判据可能过宽`,
    }
  }
  return { accepted: true, stage: 'passed', reason: '' }
}

/**
 * 闸门轨迹行（**单比特 + 拒因**，不含分数与逐样本结果）。
 *
 * 依据：leaky-anchor 实测「同一审计但公开分数」六行里五行严格更差
 * ⇒ 审计分泄露会变成新目标；轨迹只记「过没过」与「为什么」。
 */
export function gateTraceLine(ruleId: string, d: GateDecision, at: string): string {
  return JSON.stringify({
    at,
    ruleId,
    accepted: d.accepted,
    stage: d.stage,
    reason: d.reason,
  })
}

// ────────────────────────────────────────────────────────────────────────────
// 金丝雀自检（2026-11-03 · t-366b5933）
// ────────────────────────────────────────────────────────────────────────────

/** 金丝雀账户的保留 id——不与真实假设 id 形态冲突（真实 id 形如 `h-xxxxxxxx-1`） */
export const CANARY_RULE_ID = '__gate-canary__'

/** 金丝雀账户的哈希：故意是不可达的常量，任何真实草稿都不会撞上 */
const CANARY_HASH = 'djb2:canary-never-matches'

/** 金丝雀自检结果 */
export interface CanaryResult {
  /** 闸门在四个角落上都给出了正确裁决 */
  healthy: boolean
  /** 不健康时说清哪一格坏了（健康时为空串） */
  reason: string
}

/**
 * 金丝雀自检：**闸门自己是否还在工作**。
 *
 * 判据形状借 arXiv:2609.02246 的「满分本身就是作弊的证据」——
 * 金丝雀是一组**必然该被拒**的账户形态，它的**通过**就是闸门失效的证据。
 * ⇒ 这里「被接受」等于「作弊」；健康的信号是**它被拒绝**。
 *
 * **本机的真实缺口（这是它存在的理由）**：闸门实现于 2026-10-17，但
 * `.dsh/acceptance-sealed/` 至今为空、`acceptance-gate-trace.jsonl` 不存在
 * ⇒ 真实运行次数 **0**。零读数的门无法自证还在工作：它可能已被改成 fail-open
 * （改了 `decideGate` 的某个分支）而**没有任何读数会变**——因为没有任何一次调用。
 *
 * **四个角落**（两侧都测，缺一即可被「恒拒」或「恒受」骗过）：
 * ① 无冻结账 ⇒ 必须拒　　　② 哈希不符 ⇒ 必须拒
 * ③ 注入器没变红 ⇒ 必须拒　④ **正常形态 ⇒ 必须接受**
 *
 * ⚠ 只测 ①②③ 的话，「拒绝一切」也能满分（`acceptance-integrity` 承重判据 6）。
 * ④ 是防这一点的；它的代价是金丝雀必须承认「闸门确实会通过学习形态」。
 *
 * @param decide 裁决函数（缺省真品；测试可注入替身来证明金丝雀抓得住坏门）
 */
export function canaryProbe(decide: (a: SealedAccount | null, h: string, i: number | null, b: number | null) => GateDecision = decideGate): CanaryResult {
  const good: SealedAccount = {
    ruleId: CANARY_RULE_ID,
    sealedAt: '1970-01-01T00:00:00.000Z',
    ruleDraftHash: CANARY_HASH,
    kind: 'executable',
    injector: { script: '<canary>' },
    benign: { script: '<canary>' },
    expect: { injected: 1, benign: 0 },
  }

  // ① 无冻结账：这是「外生」的最外一圈，被接受 ⇒ 任何人都能绕过冻结
  if (decide(null, CANARY_HASH, 1, 0).accepted) {
    return { healthy: false, reason: '无冻结账却被接受——外生性整条失效（fail-open）' }
  }
  // ② 落账后改过规则：被接受 ⇒ 「不可为这次改动定制」这条约束失效
  if (decide(good, hashRuleDraft('canary-draft-that-differs'), 1, 0).accepted) {
    return { healthy: false, reason: '哈希不符却被接受——冻结变可改，外生性只剩时序' }
  }
  // ③ 注入器构造不出失败（退出码 0）：被接受 ⇒ phantom 规则的生成机制复活
  if (decide(good, CANARY_HASH, 0, 0).accepted) {
    return { healthy: false, reason: '注入器未变红却被接受——phantom（为不存在的失败写规则）会漏过' }
  }
  // ④ 良性对照变红：被接受 ⇒ 判据过宽，会把正常情形判成失败
  if (decide(good, CANARY_HASH, 1, 1).accepted) {
    return { healthy: false, reason: '良性对照变红却被接受——判据过宽（会把正常情形判成失败）' }
  }
  // ⑤ **反向**：正常形态必须被接受。恒拒的门在 ①-④ 上全绿，但它同样没有区分力
  if (!decide(good, CANARY_HASH, 1, 0).accepted) {
    return { healthy: false, reason: '正常形态（注入红 + 对照绿 + 账齐 + 哈希符）被拒——闸门恒拒，无区分力' }
  }
  return { healthy: true, reason: '' }
}
