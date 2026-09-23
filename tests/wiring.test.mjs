/**
 * wiring.test.mjs — 唯一写原语的**离线尸体测试**。
 *
 * 纪律（§5.9 规则 2）：防线必须有**已知坏样本**证明它真会拦——恒为空的输出不是证据，是噪音。
 * 本文件里带「尸体」标注的用例就是坏样本：它们断言**拒写**，并断言文件内容**逐字节未变**。
 *
 * 判据来自 docs/semantic.md §7（可证伪验收）与设计稿 §2.6。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyRuleUpsert,
  buildBlock,
  byteLength,
  checkBudget,
  extractBlockInner,
  findBlock,
  normalizeRule,
  spliceBlock,
  upsertRuleBlock,
  MANAGED_BLOCKS,
} from '../lib/wiring.js'

const EVOLVE = findBlock('evolve')
const SELF_TEST = findBlock('self-test')

/** 一份带两个标记段 + 块外哨兵的夹具（哨兵用于证明「块外内容一律不动」） */
function fixture() {
  return [
    '# 我的灵魂（节选）',
    '',
    '块外哨兵·前：这一行不属于任何标记段。',
    '',
    buildBlock('- 规则甲：既有条目。', EVOLVE),
    '',
    '块外哨兵·中：两段之间的内容。',
    '',
    buildBlock('**既有自检规则**：原样保留。', SELF_TEST),
    '',
    '块外哨兵·后：文件结尾。',
    '',
  ].join('\n')
}

test('标记段登记表：两个历史段都在，且 marker 字面量与旧件一致', () => {
  assert.equal(MANAGED_BLOCKS.length, 2)
  assert.equal(EVOLVE.start, '<!-- dsh-agent-evolve:start -->')
  assert.equal(EVOLVE.end, '<!-- dsh-agent-evolve:end -->')
  assert.equal(SELF_TEST.start, '<!-- dsh-agent-self-test:start -->')
  assert.equal(SELF_TEST.end, '<!-- dsh-agent-self-test:end -->')
  assert.equal(findBlock('nope'), undefined)
})

test('normalizeRule：折叠空白与首尾（同一条规则的判定输入）', () => {
  assert.equal(normalizeRule('  规则甲：既有条目。\n'), '规则甲：既有条目。')
  assert.equal(normalizeRule('规则甲：\n  既有条目。'), '规则甲： 既有条目。')
})

test('upsertRuleBlock：既有块已含草稿 ⇒ exists（幂等，不产生重复）', () => {
  const r = upsertRuleBlock('- 规则甲：既有条目。', '  - 规则甲：既有条目。  ')
  assert.equal(r.action, 'exists')
  assert.equal(r.inner, '- 规则甲：既有条目。')
})

test('upsertRuleBlock：新规则追加在块尾，既有条目顺序与内容原样保留', () => {
  const r = upsertRuleBlock('- 规则甲：既有条目。', '- 规则乙：新条目。')
  assert.equal(r.action, 'added')
  assert.equal(r.inner, '- 规则甲：既有条目。\n- 规则乙：新条目。')
})

test('applyRuleUpsert：新增规则后——块外哨兵全部保留（不整块替换）', () => {
  const full = fixture()
  const out = applyRuleUpsert(full, { blockId: 'evolve', draft: '- 规则乙：新条目。', maxBytes: 1_000_000 })
  assert.equal(out.ok, true)
  assert.equal(out.action, 'added')
  for (const sentinel of ['块外哨兵·前：这一行不属于任何标记段。', '块外哨兵·中：两段之间的内容。', '块外哨兵·后：文件结尾。']) {
    assert.ok(out.content.includes(sentinel), `块外内容被改动：${sentinel}`)
  }
  // 既有条目仍在，新条目在块内
  assert.ok(out.content.includes('- 规则甲：既有条目。'))
  assert.ok(out.content.includes('- 规则乙：新条目。'))
  // 另一个标记段未被触碰
  assert.equal(extractBlockInner(out.content, SELF_TEST), '**既有自检规则**：原样保留。')
  // 块内顺序：既有在前
  assert.ok(out.content.indexOf('- 规则甲：既有条目。') < out.content.indexOf('- 规则乙：新条目。'))
})

test('applyRuleUpsert：重复 upsert 幂等——第二次 exists 且内容逐字节不变', () => {
  const full = fixture()
  const first = applyRuleUpsert(full, { blockId: 'evolve', draft: '- 规则乙：新条目。', maxBytes: 1_000_000 })
  assert.equal(first.ok, true)
  const second = applyRuleUpsert(first.content, { blockId: 'evolve', draft: '- 规则乙：新条目。', maxBytes: 1_000_000 })
  assert.equal(second.ok, true)
  assert.equal(second.action, 'exists')
  assert.equal(second.content, first.content, '幂等被破坏：第二次调用改变了内容')
})

test('尸体：超预算 ⇒ 拒写 over-budget，且内容逐字节未变', () => {
  const full = fixture()
  const maxBytes = byteLength(full) // 加任何内容都会超
  const out = applyRuleUpsert(full, { blockId: 'evolve', draft: '- 规则乙：这一条会让文件超限。', maxBytes })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'over-budget')
  assert.ok(out.detail.includes('拒绝写盘'))
  // 拒绝路径**不返回新内容**——调用方无从写盘
  assert.equal(out.content, undefined)
  // 且入参本身未被改动
  assert.equal(full, fixture())
})

test('尸体：起止标记只出现一个 ⇒ 拒写 corrupt-markers（不追加出第二个块）', () => {
  const full = '# 灵魂\n\n<!-- dsh-agent-evolve:start -->\n- 只有开始标记\n'
  const out = applyRuleUpsert(full, { blockId: 'evolve', draft: '- 新规则。', maxBytes: 1_000_000 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'corrupt-markers')
  assert.equal(full.match(/dsh-agent-evolve:start/g).length, 1)
})

test('尸体：空草稿 ⇒ 拒写 empty-draft（不静默什么都不做）', () => {
  const full = fixture()
  const out = applyRuleUpsert(full, { blockId: 'evolve', draft: '   \n\t ', maxBytes: 1_000_000 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'empty-draft')
})

test('尸体：未登记的标记段 id ⇒ 拒写 unknown-block，detail 列出已登记 id', () => {
  const out = applyRuleUpsert(fixture(), { blockId: 'no-such-block', draft: '- x', maxBytes: 1_000_000 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'unknown-block')
  assert.ok(out.detail.includes('evolve'))
  assert.ok(out.detail.includes('self-test'))
})

test('首次安装：文件里没有该标记段 ⇒ 追加到文件尾（块外内容仍在）', () => {
  const full = '# 灵魂\n\n还没有任何标记段。\n'
  const out = applyRuleUpsert(full, { blockId: 'self-test', draft: '**新规则**：首次布线。', maxBytes: 1_000_000 })
  assert.equal(out.ok, true)
  assert.equal(out.action, 'added')
  assert.ok(out.content.startsWith('# 灵魂\n\n还没有任何标记段。'))
  assert.equal(extractBlockInner(out.content, SELF_TEST), '**新规则**：首次布线。')
})

test('checkBudget：恰好等于上限 ⇒ allowed（边界含等号）', () => {
  const text = 'x'.repeat(100)
  assert.equal(byteLength(text), 100)
  assert.deepEqual(checkBudget(text, 100), { allowed: true, bytes: 100, headroom: 0 })
  assert.equal(checkBudget(text, 99).allowed, false)
  assert.equal(checkBudget(text, 99).headroom, -1)
})

test('预算口径是 UTF-8 字节，不是字符数（中文按 3 字节计）', () => {
  assert.equal(byteLength('中文'), 6)
  assert.equal(byteLength('abc'), 3)
})

test('尸体：起止标记顺序颠倒 ⇒ 拒写 corrupt-markers（追加会产出读不回来的块）', () => {
  const full = 'x\n<!-- dsh-agent-evolve:end -->\ny\n<!-- dsh-agent-evolve:start -->\nz\n'
  const out = applyRuleUpsert(full, { blockId: 'evolve', draft: '- 规则。', maxBytes: 1_000_000 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'corrupt-markers')
  assert.ok(out.detail.includes('顺序颠倒'))
  // 反证（这条守卫为什么不能省）：底层 spliceBlock 在「无块」分支会照常追加，
  // 而追加出来的块按 first-start/first-end 永远读不回来——写成功但读不回 = 静默损坏。
  const naive = spliceBlock(full, '- 规则。', EVOLVE)
  assert.ok(naive.includes('- 规则。'), 'spliceBlock 确实追加了')
  assert.equal(extractBlockInner(naive, EVOLVE), undefined, '若此处能读回，说明这条守卫可省')
})
