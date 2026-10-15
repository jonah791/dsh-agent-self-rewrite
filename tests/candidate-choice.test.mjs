/**
 * candidate-choice.test.mjs — P4（Combined metrics）的判据。
 *
 * 修的是什么：三个读数（性能 / 成本 / 噪声）各说各话，**没有合成判据** ⇒
 * 「性能涨了但代价是两倍时长」在读数里**不可见**（每处单独看都是绿的）。
 *
 * 判据与尸体：
 * ① 成本增加未被证明 ⇒ `cost-unjustified`（RRSI：候选选择要求成本增加被性能增益证明）
 * ② 噪声带内 ⇒ **不可判**（不是平局、不是略胜——TEB「超出量在带内不报为进化」）
 * ③ 缺读数 ⇒ **不可比**（不按缺省算）；**尸体**：注入「null 当 0」⇒ 这条红
 * ④ 性能高 + 成本不增 ⇒ 无争议胜；性能相同 ⇒ 成本低者胜
 * ⑤ 四态各自可渲染（不许把两态合成一句——合成即语义掩盖）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compareCandidates, describeChoice } from '../lib/candidate-choice.js'
import { choiceLines } from '../lib/index.js'
import { EvolveStore } from '../lib/ledger-store.js'

/** 接入点测试的夹具（临时目录 + 真 EvolveStore；不碰生产资产） */
function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'selfrewrite-choice-'))
  const modeltestDir = join(root, 'modeltest')
  mkdirSync(modeltestDir, { recursive: true })
  return {
    store: new EvolveStore(join(root, 'evolve'), modeltestDir, '', ''),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

const POLICY = { minGainPerCost: 0.01 } // 每毫秒 0.01 分

const cand = (id, performance, costMs, noisy = false) => ({ id, performance, costMs, noisy })

// ── ① 成本必须被证明 ───────────────────────────────────────────────────────

test('成本增加**未被证明** ⇒ cost-unjustified（RRSI：候选选择要求成本增加被性能增益证明）', () => {
  // A 性能 +1 但成本 +1000ms ⇒ 比 = 0.001 < 0.01 ⇒ 未证明
  const v = compareCandidates(cand('A', 6, 3000), cand('B', 5, 2000), POLICY)
  assert.equal(v.kind, 'cost-unjustified')
  assert.ok(v.reason.includes('0.0010'), '理由里要有那个比值（可复算）：' + v.reason)
})

test('成本增加**被证明** ⇒ 选性能高者（同一个函数，只差比值）', () => {
  // A 性能 +10 成本 +100ms ⇒ 比 = 0.1 ≥ 0.01 ⇒ 证明成立
  const v = compareCandidates(cand('A', 60, 2100), cand('B', 50, 2000), POLICY)
  assert.equal(v.kind, 'pick')
  assert.equal(v.winner, 'A')
})

test('阈值是**主体给的**：同两个候选，阈值抬高 ⇒ 结论翻转（判据真的在起作用）', () => {
  const a = cand('A', 60, 2100)
  const b = cand('B', 50, 2000)
  assert.equal(compareCandidates(a, b, { minGainPerCost: 0.01 }).kind, 'pick')
  assert.equal(compareCandidates(a, b, { minGainPerCost: 1 }).kind, 'cost-unjustified')
})

// ── ② 噪声带内 ⇒ 不可判 ───────────────────────────────────────────────────

test('噪声带内 ⇒ **不可判**（不是平局、不是略胜——TEB 判据）', () => {
  const v = compareCandidates(cand('A', 9, 1000, true), cand('B', 5, 2000), POLICY)
  assert.equal(v.kind, 'indistinguishable')
  assert.ok(v.reason.includes('TEB'), '理由要点明判据来源')
})

test('尸体：**任一** noisy 即不可判（不许「另一条稳就先比」）', () => {
  const v = compareCandidates(cand('A', 5, 2000), cand('B', 9, 1000, true), POLICY)
  assert.equal(v.kind, 'indistinguishable', '稳的那条性能低，也不许因此判它输')
})

// ── ③ 缺读数 ⇒ 不可比 ─────────────────────────────────────────────────────

test('缺读数 ⇒ **不可比**（不按缺省算——拿 0 当代替会把「不知道」变成「很差」）', () => {
  const v = compareCandidates(cand('A', null, 1000), cand('B', 5, 2000), POLICY)
  assert.equal(v.kind, 'incomparable')
  assert.ok(v.reason.includes('A 缺性能'))
})

test('尸体：两个读数都缺 ⇒ 四条缺失逐条点名（不静默只说一条）', () => {
  const v = compareCandidates(cand('A', null, null), cand('B', null, null), POLICY)
  assert.equal(v.kind, 'incomparable')
  assert.ok(v.reason.includes('A 缺性能') && v.reason.includes('B 缺成本'), '四条都要在：' + v.reason)
})

test('尸体：噪声读数**不可得**（`null`）⇒ 不可比（把「测不出噪声」当成「没有噪声」正是 TEB 要防的）', () => {
  const v = compareCandidates(cand('A', 9, 1000, null), cand('B', 5, 2000, false), POLICY)
  assert.equal(v.kind, 'incomparable', '单次评测给不出「带」⇒ 不许凭分数差选候选')
  assert.ok(v.reason.includes('不可得'), '理由要区分「不可得」与「在带内」：' + v.reason)
})

test('三态不合并：不可得（null）**优先于**在带内（true）', () => {
  const both = compareCandidates(cand('A', 9, 1000, null), cand('B', 5, 2000, true), POLICY)
  assert.equal(both.kind, 'incomparable', '更根本的那一层先报——两者不是同一件事')
})

test('缺读数**优先于**噪声**优先于**成本比（顺序即语义，改序即改语义）', () => {
  // 同时 noisy + 缺读数 ⇒ 应报 incomparable（更根本的那一层）
  const v = compareCandidates(cand('A', null, 1000, true), cand('B', 5, 2000), POLICY)
  assert.equal(v.kind, 'incomparable', '缺读数比噪声更根本——没有读数谈不上「在带内」')
})

// ── ④ 无争议与同性能 ───────────────────────────────────────────────────────

test('性能更高且**成本不增加** ⇒ 无争议胜', () => {
  const v = compareCandidates(cand('A', 8, 1000), cand('B', 5, 2000), POLICY)
  assert.equal(v.kind, 'pick')
  assert.equal(v.winner, 'A')
})

test('性能相同 ⇒ 成本低者胜；成本也相同 ⇒ 不可判', () => {
  const cheap = compareCandidates(cand('A', 5, 1000), cand('B', 5, 2000), POLICY)
  assert.equal(cheap.kind, 'pick')
  assert.equal(cheap.winner, 'A')

  const tie = compareCandidates(cand('A', 5, 1000), cand('B', 5, 1000), POLICY)
  assert.equal(tie.kind, 'indistinguishable', '没有可据以选择的差异 ⇒ 不许硬选一个')
})

// ── ⑤ 四态可渲染 ───────────────────────────────────────────────────────────

test('四态各自可渲染，且**互不合并**（合成一句即语义掩盖）', () => {
  const texts = [
    describeChoice({ kind: 'pick', winner: 'A', reason: 'r' }),
    describeChoice({ kind: 'indistinguishable', reason: 'r' }),
    describeChoice({ kind: 'incomparable', reason: 'r' }),
    describeChoice({ kind: 'cost-unjustified', reason: 'r' }),
  ]
  assert.equal(new Set(texts).size, 4, '四个前缀必须各不相同')
  assert.ok(texts[0].includes('选 A'))
  assert.ok(texts[1].includes('不可判'))
  assert.ok(texts[2].includes('不可比'))
  assert.ok(texts[3].includes('成本未被证明'))
})

// ── ⑥ 接入点（工具面真的用了它） ───────────────────────────────────────────

test('接入点：代不足两代 ⇒ 明说「无从比较」（不硬造比较）', () => {
  const f = storeFixture()
  try {
    const out = choiceLines([{ gen: 1, ability: 5 }], f.store, 0.01)
    assert.ok(out.join('\n').includes('代不足两代'))
  } finally {
    f.cleanup()
  }
})

test('接入点：**不给阈值 ⇒ 不裁**（价值取舍不代填，§2.4）', () => {
  const f = storeFixture()
  try {
    const out = choiceLines([{ gen: 1, ability: 5 }, { gen: 2, ability: 6 }], f.store, undefined)
    const text = out.join('\n')
    assert.ok(text.includes('未给判据'), text)
    assert.ok(text.includes('不裁'), '不许替主体决定阈值')
  } finally {
    f.cleanup()
  }
})

test('接入点：给阈值 ⇒ 走裁决；**噪声不可得** ⇒ 如实报「不可比」（不是硬选一个）', () => {
  const f = storeFixture()
  try {
    const out = choiceLines([{ gen: 1, ability: 5 }, { gen: 2, ability: 9 }], f.store, 0.01)
    const text = out.join('\n')
    assert.ok(text.includes('噪声=**不可得**'), '三要素的第三要素要如实标注来源：' + text)
    assert.ok(text.includes('不可比'), '本件每代只评测一次 ⇒ 给不出带 ⇒ 按判据报不可比（这正是 TEB 要防的）')
  } finally {
    f.cleanup()
  }
})
