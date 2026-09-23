/**
 * rewrite-core.test.mjs — 新工具层核心逻辑的离线测试。
 *
 * 覆盖三块：唯一写原语的**第二条路径**（版本化替换）、假设裁决、轮次辅助。
 * 尸体用例证明坏样本真会被拦（恒为空的输出不是证据）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyBlockSet, applyRuleUpsert, buildBlock, byteLength, extractBlockInner, findBlock, MANAGED_BLOCKS } from '../lib/wiring.js'
import { addHypothesis, applyVerdict, enrich, recordEvidence, requireHypotheses, saveHypotheses } from '../lib/hypotheses.js'
import { buildTaskPrompt, extractRules } from '../lib/rounds.js'
import { resolveLegacyPaths } from '../lib/store.js'

const EVOLVE = findBlock('evolve')
const SELF_TEST = findBlock('self-test')

function fixture() {
  return [
    '# 灵魂（节选）',
    '',
    '块外哨兵·前',
    '',
    buildBlock('- 规则甲：既有。', EVOLVE),
    '',
    '块外哨兵·后',
    '',
  ].join('\n')
}

test('applyBlockSet：版本化替换——块内容整体换掉，块外一字不动', () => {
  const full = fixture()
  const out = applyBlockSet(full, { blockId: 'evolve', inner: '- 规则甲：新版全文。', maxBytes: 1_000_000 })
  assert.equal(out.ok, true)
  assert.equal(out.action, 'replaced')
  assert.equal(extractBlockInner(out.content, EVOLVE), '- 规则甲：新版全文。')
  assert.ok(out.content.includes('块外哨兵·前'))
  assert.ok(out.content.includes('块外哨兵·后'))
})

test('尸体：applyBlockSet 超预算 ⇒ 拒写（与 upsert 共用同一道预算闸门）', () => {
  const full = fixture()
  const out = applyBlockSet(full, { blockId: 'evolve', inner: 'x'.repeat(5000), maxBytes: byteLength(full) })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'over-budget')
  assert.equal(full, fixture(), '拒绝路径改动了入参')
})

test('尸体：applyBlockSet 未登记段 / 标记只出现一个 ⇒ 拒写', () => {
  assert.equal(applyBlockSet(fixture(), { blockId: 'nope', inner: 'x', maxBytes: 1e6 }).reason, 'unknown-block')
  const broken = '# x\n<!-- dsh-agent-evolve:start -->\n只有开始\n'
  assert.equal(applyBlockSet(broken, { blockId: 'evolve', inner: 'x', maxBytes: 1e6 }).reason, 'corrupt-markers')
})

test('两条写路径共用登记表：upsert 与 set 认识的段完全一致', () => {
  assert.deepEqual(MANAGED_BLOCKS.map((b) => b.id), ['evolve', 'self-test'])
  const up = applyRuleUpsert(fixture(), { blockId: 'self-test', draft: '**新规则**', maxBytes: 1e6 })
  assert.equal(up.ok, true)
  assert.equal(extractBlockInner(up.content, SELF_TEST), '**新规则**')
})

test('addHypothesis：极性物化进数据（不靠消费方回退隐式默认表）', () => {
  const state = { hypotheses: [] }
  const a = addHypothesis(state, { statement: '我会先读再写', prediction: '写前必有 read', kind: 'probe-before-action', threshold: 3 })
  assert.equal(a.hypothesis.status, 'active')
  assert.equal(a.hypothesis.probe.kind, 'probe-before-action')
  assert.ok(typeof a.hypothesis.probe.polarity === 'string' && a.hypothesis.probe.polarity.length > 0, '极性未物化')
  assert.equal(state.hypotheses.length, 1)
  assert.equal(a.hypothesis.source, 'alice')
})

test('addHypothesis：探针参数逐字段写入；未给的键不存在（形状与旧数据一致）', () => {
  const state = { hypotheses: [] }
  const a = addHypothesis(state, {
    statement: 's', prediction: 'p', kind: 'read-repeat', threshold: 2,
    probeParams: { windowMs: 600000, repeatCount: 2 },
  })
  assert.equal(a.hypothesis.probe.windowMs, 600000)
  assert.equal(a.hypothesis.probe.repeatCount, 2)
  assert.ok(!('tool' in a.hypothesis.probe))
})

test('recordEvidence：达阈值转 finding 且只报一次「刚转」', () => {
  const state = { hypotheses: [] }
  const { hypothesis: h } = addHypothesis(state, { statement: 's', prediction: 'p', kind: 'read-repeat', threshold: 2 })
  assert.equal(recordEvidence(h, { ts: 't1', kind: 'read-repeat', detail: {} }), false)
  assert.equal(recordEvidence(h, { ts: 't2', kind: 'read-repeat', detail: {} }), true)
  assert.equal(h.status, 'finding')
  assert.equal(recordEvidence(h, { ts: 't3', kind: 'read-repeat', detail: {} }), false, '已转 finding 后不该重复报')
})

test('尸体：非 finding 的假设 confirm ⇒ 抛错（不许跳过采证直接布线）', () => {
  const state = { hypotheses: [] }
  const { hypothesis: h } = addHypothesis(state, { statement: 's', prediction: 'p', kind: 'read-repeat', threshold: 5 })
  assert.throws(() => applyVerdict(state, { id: h.id, verdict: 'confirm', ruleDraft: 'x' }), /只有 finding 可以 confirm/)
})

test('applyVerdict：confirm 返回 needsWiring=true（布线由调用方执行，本模块不写文件）', () => {
  const state = { hypotheses: [] }
  const { hypothesis: h } = addHypothesis(state, { statement: 's', prediction: 'p', kind: 'read-repeat', threshold: 1 })
  recordEvidence(h, { ts: 't', kind: 'read-repeat', detail: { verdict: 'violated' } })
  const out = applyVerdict(state, { id: h.id, verdict: 'confirm', ruleDraft: '规则文本' })
  assert.equal(out.hypothesis.status, 'confirmed')
  assert.equal(out.needsWiring, true)
  assert.equal(out.hypothesis.note, '规则文本')
})

test('applyVerdict：refine 清空旧证据并回到 active', () => {
  const state = { hypotheses: [] }
  const { hypothesis: h } = addHypothesis(state, { statement: 's', prediction: 'p', kind: 'read-repeat', threshold: 1 })
  recordEvidence(h, { ts: 't', kind: 'read-repeat', detail: {} })
  applyVerdict(state, { id: h.id, verdict: 'refine', newStatement: '新陈述', newThreshold: 4 })
  assert.equal(h.status, 'active')
  assert.equal(h.evidence.length, 0)
  assert.equal(h.statement, '新陈述')
  assert.equal(h.threshold, 4)
})

test('enrich：confirmed 但方向非纯支持 ⇒ 标极性存疑（待复核指纹）', () => {
  const state = { hypotheses: [] }
  const { hypothesis: h } = addHypothesis(state, { statement: 's', prediction: 'p', kind: 'read-repeat', threshold: 1 })
  h.status = 'confirmed'
  h.evidence = []
  const [row] = enrich(state)
  assert.equal(row.polaritySuspect, true)
})

test('requireHypotheses：文件不存在 ⇒ 空库；损坏 ⇒ 抛错（不静默清空整库）', () => {
  const root = 'E:/definitely/not/here/selfrewrite'
  const paths = resolveLegacyPaths(root)
  assert.deepEqual(requireHypotheses(paths).hypotheses, [])
})

test('saveHypotheses + requireHypotheses 往返（临时目录夹具）', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'selfrewrite-core-'))
  try {
    const paths = resolveLegacyPaths(root)
    const state = { hypotheses: [] }
    addHypothesis(state, { statement: 's', prediction: 'p', kind: 'read-repeat', threshold: 3 })
    saveHypotheses(paths, state)
    const back = requireHypotheses(paths)
    assert.equal(back.hypotheses.length, 1)
    assert.equal(back.hypotheses[0].probe.kind, 'read-repeat')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extractRules：只认本件登记的 evolve 段（marker 字面量单一真源）', () => {
  const full = buildBlock('规则正文', EVOLVE) + '\n\n' + buildBlock('自检正文', SELF_TEST)
  assert.equal(extractRules(full), '规则正文')
  assert.equal(extractRules('没有标记段的文件'), '')
})

test('buildTaskPrompt：有规则则附「本体规则」节，无规则则不附', () => {
  const withRules = buildTaskPrompt('任务说明书', '规则甲')
  assert.ok(withRules.includes('【本体规则（继承自宿主，必须遵守）】'))
  assert.ok(withRules.includes('规则甲'))
  const without = buildTaskPrompt('任务说明书', '   ')
  assert.ok(!without.includes('【本体规则'))
  assert.ok(without.includes('【输出】'))
})
