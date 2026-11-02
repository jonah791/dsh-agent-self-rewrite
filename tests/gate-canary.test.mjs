/**
 * 外生接受位 · 金丝雀自检（2026-11-03 · t-366b5933）。
 *
 * 存在理由（这是本文件唯一需要记住的一句）：
 * 闸门实现于 2026-10-17，但 `.dsh/acceptance-sealed/` 至今为空、
 * `acceptance-gate-trace.jsonl` 不存在 ⇒ **真实运行次数 0**。
 * 零读数的门无法自证还在工作：它可能已被改成 fail-open 而**没有任何读数会变**。
 *
 * 判据形状借 arXiv:2609.02246 的「满分本身就是作弊的证据」——
 * 金丝雀的**通过**就是闸门失效的证据；健康信号是**它被拒绝**。
 *
 * 本文件的尸体样本（§5.9 规则 2：防线必须有尸体证明它会拦）：
 * ① 恒 accept 的门（fail-open）—— 金丝雀必须报不健康
 * ② 恒 reject 的门（拒绝一切）—— 同样必须报不健康（否则「拒绝一切」也能满分）
 * ③ **只在注入器分支 fail-open** 的门 —— 最贴近真实退化的形态
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CANARY_RULE_ID, canaryProbe, decideGate } from '../lib/gate.js'
import { runGate } from '../lib/gate-io.js'

// ── 正例：真品必须健康 ─────────────────────────────────────────────────
test('canaryProbe：对真品裁决 ⇒ healthy（否则闸门一上线就自锁）', () => {
  const r = canaryProbe()
  assert.equal(r.healthy, true, `真品被判不健康：${r.reason}`)
  assert.equal(r.reason, '')
})

test('canaryProbe：缺省参数就是真品（不传也健康）', () => {
  assert.equal(canaryProbe(decideGate).healthy, true)
})

// ── ★ 尸体①：恒 accept（fail-open）────────────────────────────────────
test('★ 尸体①：恒 accept 的门 ⇒ 金丝雀必须报不健康（fail-open 检测）', () => {
  const alwaysAccept = () => ({ accepted: true, stage: 'passed', reason: '' })
  const r = canaryProbe(alwaysAccept)
  assert.equal(r.healthy, false, '恒 accept 的门被放过了——金丝雀没有区分力')
  assert.ok(r.reason.length > 0, '不健康时必须说清哪一格坏了')
})

// ── ★ 尸体②：恒 reject（拒绝一切）──────────────────────────────────────
test('★ 尸体②：恒 reject 的门 ⇒ 金丝雀也必须报不健康（「拒绝一切」不能满分）', () => {
  const alwaysReject = () => ({ accepted: false, stage: 'no-account', reason: 'no' })
  const r = canaryProbe(alwaysReject)
  assert.equal(r.healthy, false, '恒拒的门被当成健康——那任何无区分力的门都能过关')
  assert.ok(r.reason.includes('恒拒') || r.reason.includes('区分力'), `拒因应指向「恒拒」而非别的：${r.reason}`)
})

// ── ★ 尸体③：只在注入器分支 fail-open（最贴近真实退化的形态）──────────
// 真实退化通常不会「整扇门恒 accept」——那太显眼。更可能的形态是
// 某个分支被改成放行（例如为了「不阻塞紧急布线」），其余照旧。
test('★ 尸体③：只在「注入器未变红」那格 fail-open ⇒ 必须被抓到', () => {
  const leaky = (account, hash, injected) => {
    const real = decideGate(account, hash, injected, 0)
    // 退化点：注入器没抓住失败（退出码 0）时放行——正是 phantom 的生成机制
    if (injected === 0 && account !== null && account.ruleDraftHash === hash) {
      return { accepted: true, stage: 'passed', reason: '' }
    }
    return real
  }
  const r = canaryProbe(leaky)
  assert.equal(r.healthy, false, '单点 fail-open 逃过了金丝雀——那它防不住真实退化')
  assert.ok(r.reason.includes('phantom') || r.reason.includes('未变红'), `拒因应指向注入器那格：${r.reason}`)
})

test('★ 尸体④：只在「哈希不符」那格 fail-open ⇒ 必须被抓到', () => {
  const leaky = (account, hash, injected, benign) => {
    if (account !== null && account.ruleDraftHash !== hash) {
      // 退化点：忽略了「落账后改过规则」，冻结只剩时序
      return decideGate({ ...account, ruleDraftHash: hash }, hash, injected, benign)
    }
    return decideGate(account, hash, injected, benign)
  }
  const r = canaryProbe(leaky)
  assert.equal(r.healthy, false, '哈希校验被绕过而金丝雀没发现')
  assert.ok(r.reason.includes('哈希') || r.reason.includes('冻结'), `拒因应指向哈希那格：${r.reason}`)
})

// ── runGate 接线：自检不健康 ⇒ 一律 fail-closed ────────────────────────
test('runGate：金丝雀不健康 ⇒ 返回 canary-failed（不进入取数/裁决）', () => {
  const d = runGate('E:/alice/.dsh', 'h-x-1', '任意草稿', () => ({ healthy: false, reason: '测试用坏门' }))
  assert.equal(d.accepted, false)
  assert.equal(d.stage, 'canary-failed')
  assert.ok(d.reason.includes('自检失败'), d.reason)
  assert.ok(d.reason.includes('测试用坏门'), '必须把自检的具体故障原因带出来')
})

test('runGate：金丝雀健康但无冻结账 ⇒ no-account（自检不掩盖真拒因）', () => {
  const d = runGate('E:/alice/.dsh', 'h-不存在的账户-9f3a', '任意草稿')
  assert.equal(d.accepted, false)
  assert.equal(d.stage, 'no-account', `自检把拒因顶掉了：${d.stage} / ${d.reason}`)
})

// ── 保留 id 不得与真实假设形态相撞 ──────────────────────────────────────
test('CANARY_RULE_ID 不落入真实假设 id 形态（h-<8位>-<n>）', () => {
  assert.equal(/^h-[a-z0-9]{8}-\d+$/.test(CANARY_RULE_ID), false,
    `金丝雀 id 撞上真实形态会被 seal-rule 误认为已存在的账：${CANARY_RULE_ID}`)
  assert.ok(CANARY_RULE_ID.startsWith('__'), '保留 id 应带 __ 前缀以便一眼区分')
})
