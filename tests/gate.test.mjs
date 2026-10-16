/**
 * 外生接受位 · 纯函数层测试。
 *
 * 判据纪律（§5.9 规则 2）：防线必须有**尸体样本**证明它会拦。
 * 本文件的三具尸体：① 无冻结账 ② 落账后被改过 ③ 注入器跑不起来（fail-closed）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hashRuleDraft, decideGate, gateTraceLine } from '../lib/gate.js'

const DRAFT = '**规则草稿**：某条新规则'
const HASH = hashRuleDraft(DRAFT)

const OK_ACCOUNT = {
  ruleId: 'h-test-1',
  sealedAt: '2026-10-17T01:00:00+08:00',
  ruleDraftHash: HASH,
  kind: 'executable',
  injector: { script: 'inject.mjs' },
  benign: { script: 'benign.mjs' },
}

// ── hashRuleDraft ──────────────────────────────────────────────────────
test('hashRuleDraft：确定性 + 不同文本不同哈希', () => {
  assert.equal(hashRuleDraft(DRAFT), HASH, '同文本必须同哈希（否则闸门每次误拒）')
  assert.notEqual(hashRuleDraft(DRAFT), hashRuleDraft(DRAFT + ' '))
  assert.ok(HASH.startsWith('djb2:'))
})

// ── decideGate：正常路径 ────────────────────────────────────────────────
test('decideGate：注入样本红 + 良性对照绿 ⇒ accept', () => {
  const d = decideGate(OK_ACCOUNT, HASH, 1, 0)
  assert.equal(d.accepted, true)
  assert.equal(d.stage, 'passed')
  assert.equal(d.reason, '', '接受时不给理由（单比特）')
})

// ── ★ 三具尸体 ─────────────────────────────────────────────────────────
test('★ 尸体①：无冻结账 ⇒ 必须拒（外生接受位的第一道门）', () => {
  const d = decideGate(null, HASH, 1, 0)
  assert.equal(d.accepted, false)
  assert.equal(d.stage, 'no-account')
  assert.ok(d.reason.includes('未落冻结账'))
})

test('★ 尸体②：规则文本在落账后被改过 ⇒ 必须拒（哈希不符）', () => {
  // 冻结账的意义在于「不可为这次改动定制」——改过就等于定制了
  const d = decideGate(OK_ACCOUNT, hashRuleDraft(DRAFT + '（临时加一句）'), 1, 0)
  assert.equal(d.accepted, false)
  assert.equal(d.stage, 'hash-mismatch')
  assert.ok(d.reason.includes('改过'))
})

test('★ 尸体③：注入器跑不起来 ⇒ 必须拒（fail-closed，不许当成通过）', () => {
  assert.equal(decideGate(OK_ACCOUNT, HASH, null, 0).accepted, false)
  assert.equal(decideGate(OK_ACCOUNT, HASH, 1, null).accepted, false)
  const d = decideGate(OK_ACCOUNT, HASH, null, null)
  assert.equal(d.stage, 'injector-nonzero')
  assert.ok(d.reason.includes('跑不起来'))
})

// ── decideGate：判据两侧都要对 ──────────────────────────────────────────
test('decideGate：注入样本没变红 ⇒ 拒（判据可能没区分力）', () => {
  const d = decideGate(OK_ACCOUNT, HASH, 0, 0)
  assert.equal(d.accepted, false)
  assert.equal(d.stage, 'injector-nonzero')
  assert.ok(d.reason.includes('未按预期变红'))
})

test('decideGate：良性对照没变绿 ⇒ 拒（判据可能过宽）', () => {
  const d = decideGate(OK_ACCOUNT, HASH, 1, 1)
  assert.equal(d.accepted, false)
  assert.equal(d.stage, 'benign-nonzero')
  assert.ok(d.reason.includes('未按预期变绿'))
  assert.ok(d.reason.includes('过宽'), '拒因要说清方向（过宽 vs 无区分力）')
})

// ── no-oracle 路径（行为倾向类：不伪造注入器，但必须留痕）────────────────
test('★ no-oracle：无理由 ⇒ 拒（「无 oracle」的声明本身要可审）', () => {
  const acc = { ...OK_ACCOUNT, kind: 'no-oracle' }
  const d = decideGate(acc, HASH, null, null)
  assert.equal(d.accepted, false)
  assert.equal(d.stage, 'no-oracle')
})

test('no-oracle：有理由 ⇒ accept 且理由进 reason（留痕可见）', () => {
  const acc = { ...OK_ACCOUNT, kind: 'no-oracle', noOracleReason: '行为倾向类：失败是我的行为倾向，不是可构造的状态' }
  const d = decideGate(acc, HASH, null, null)
  assert.equal(d.accepted, true)
  assert.ok(d.reason.includes('行为倾向类'), '无 oracle 这件事必须留在裁决里，不许静默')
})

// ── 单比特：轨迹里不许有分数 ────────────────────────────────────────────
test('★ gateTraceLine：只记单比特 + 拒因，**不含分数与逐样本结果**', () => {
  // 依据 leaky-anchor：公开审计分六行里五行严格更差 ⇒ 分数会变成新目标
  const line = gateTraceLine('h-test-1', decideGate(OK_ACCOUNT, HASH, 1, 0), '2026-10-17T01:00:00+08:00')
  const obj = JSON.parse(line)
  assert.deepEqual(Object.keys(obj).sort(), ['accepted', 'at', 'reason', 'ruleId', 'stage'])
  assert.equal(obj.accepted, true)
  const raw = line.toLowerCase()
  for (const forbidden of ['score', 'rate', 'passed_count', 'failed_count', 'percent']) {
    assert.ok(!raw.includes(forbidden), `轨迹里不该出现 ${forbidden}（审计分泄露会变成新目标）`)
  }
})
