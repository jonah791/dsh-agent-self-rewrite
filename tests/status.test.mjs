/**
 * status.test.mjs — 状态聚合的离线测试。
 *
 * 核心判据：**不可用与为空必须长得不一样**——「读不到」不许被报成 0（§5.9 规则 6 的机器化）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildStatus, collectStatus, countAnchors, countHypotheses } from '../lib/status.js'
import { resolveLegacyPaths } from '../lib/store.js'

const ok = (value) => ({ ok: true, value })
const fail = (reason, detail = 'x') => ({ ok: false, reason, detail })

const h = (status) => ({ id: `h-${status}-${Math.random()}`, statement: 's', prediction: 'p', status, threshold: 3, probe: {}, evidence: [] })

test('countHypotheses：四态分类，未知状态进 other（不猜不吞）', () => {
  const c = countHypotheses([h('active'), h('active'), h('finding'), h('confirmed'), h('refuted'), h('weird')])
  assert.deepEqual(c, { hypotheses: 6, active: 2, findings: 1, confirmed: 1, refuted: 1, other: 1 })
})

test('countAnchors：账本不可读 ⇒ null（**不是 0**——「没有锚点」与「读不到账本」是两件事）', () => {
  assert.equal(countAnchors(fail('missing')), null)
  assert.equal(countAnchors(ok({ resources: {} })), 0)
  assert.equal(
    countAnchors(ok({ resources: { a: { id: 'a', versions: ['v0.0'], anchors: ['v0.0'] }, b: { id: 'b', versions: [], anchors: [] } } })),
    1,
  )
})

test('尸体：假设库读不到 ⇒ 计数为 0 但**明说不可用**，且断言 0 不代表没有假设', () => {
  const r = buildStatus({ selfTest: fail('missing', '文件不存在：X'), ledger: ok({ resources: {} }), runIds: [] })
  assert.equal(r.counts.hypotheses, 0)
  assert.equal(r.counts.anchors, 0)
  assert.ok(r.notes.some((n) => n.includes('假设库不可用') && n.includes('不代表没有假设')))
  assert.ok(r.text.includes('未知') === false, '账本可读时不该出现「未知」')
})

test('尸体：账本读不到 ⇒ 锚点报「未知」，文本里**不得出现 0 作为锚点值**', () => {
  const r = buildStatus({ selfTest: ok({ hypotheses: [h('active')] }), ledger: fail('missing', '文件不存在：Y'), runIds: [] })
  assert.equal(r.counts.anchors, null)
  assert.ok(r.notes.some((n) => n.includes('锚点链不可用') && n.includes('不是 0')))
  assert.ok(r.text.includes('锚点：未知（账本不可读）'))
})

test('尸体：受管文件不存在 ⇒ 预算行报「不存在」，**不报 0 字节**', () => {
  const r = buildStatus({
    selfTest: ok({ hypotheses: [] }),
    ledger: ok({ resources: {} }),
    runIds: [],
    rules: { path: 'E:/nope/AGENTS.md', bytes: null, maxBytes: 64800 },
  })
  const line = r.text.split('\n').find((l) => l.startsWith('受管文件：'))
  assert.ok(line !== undefined && line.includes('不存在'))
  assert.ok(!/\d+ 字节/.test(line), '预算行不得渲染任何字节数字（值的位置上不许出现 0）')
})

test('预算行：文件存在 ⇒ 报字节数、上限与余量', () => {
  const r = buildStatus({
    selfTest: ok({ hypotheses: [] }),
    ledger: ok({ resources: {} }),
    runIds: [],
    rules: { path: 'E:/x/AGENTS.md', bytes: 64434, maxBytes: 64800 },
  })
  assert.ok(r.text.includes('64434 字节 / 上限 64800，余量 366'))
})

test('空假设库 ⇒ 明说「猜想环当前无内容」，而不是沉默', () => {
  const r = buildStatus({ selfTest: ok({ hypotheses: [] }), ledger: ok({ resources: {} }), runIds: [] })
  assert.ok(r.notes.some((n) => n.includes('假设库为空')))
})

test('未知状态计数出现时，注里如实披露（不静默归类）', () => {
  const r = buildStatus({ selfTest: ok({ hypotheses: [h('weird'), h('weird')] }), ledger: ok({ resources: {} }), runIds: [] })
  assert.equal(r.counts.other, 2)
  assert.ok(r.notes.some((n) => n.includes('2 条假设的状态不在已知四态内')))
})

test('真实语料形状：32 条全终态 ⇒ active/finding 均为 0，计数与文本一致', () => {
  const hypotheses = [...Array(13).fill(0).map(() => h('confirmed')), ...Array(19).fill(0).map(() => h('refuted'))]
  const r = buildStatus({ selfTest: ok({ hypotheses }), ledger: fail('missing'), runIds: [] })
  assert.deepEqual(r.counts, { hypotheses: 32, active: 0, findings: 0, confirmed: 13, refuted: 19, other: 0, anchors: null, runs: 0 })
  assert.ok(r.text.includes('假设：32 条（active 0 / finding 0 / confirmed 13 / refuted 19）'))
  assert.ok(r.notes.some((n) => n.includes('无未收尾评测轮')))
})

test('collectStatus：夹具目录上端到端可跑（读不到 ⇒ 三态如实）', () => {
  const root = mkdtempSync(join(tmpdir(), 'selfrewrite-status-'))
  try {
    const paths = resolveLegacyPaths(root)
    const empty = collectStatus(paths)
    assert.equal(empty.counts.hypotheses, 0)
    assert.equal(empty.counts.anchors, null)

    mkdirSync(paths.selfTestDir, { recursive: true })
    writeFileSync(paths.selfTestFile, JSON.stringify({ hypotheses: [h('finding')] }), 'utf8')
    const one = collectStatus(paths)
    assert.equal(one.counts.hypotheses, 1)
    assert.equal(one.counts.findings, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
