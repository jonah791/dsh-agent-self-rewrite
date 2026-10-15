/**
 * borrow.test.mjs — 借鉴边（RSI topology = Graph · 域图 P6）的判据。
 *
 * 修的是什么：`branches` 只记**分叉**（每个版本一个父）⇒ 版本层是**树**，
 * 「同时借鉴多条历史线索」在账本里结构上装不下（跨 resource / 跨分支都装不下）。
 *
 * 判据（域图 §4 P6 原文）：「版本谱系可跨线索借鉴」。
 *
 * 判据与尸体：
 * ① 跨线索登记——一条边两端分属不同 resource；**尸体**：版本不存在 ⇒ 拒（不许凭空造来源）
 * ② 自指 ⇒ 拒；**尸体**：同一坐标两端
 * ③ 重复边 ⇒ 拒（图里出现两条同样的边会让读数虚高）
 * ④ **成环 ⇒ 拒**（谱系必须是 DAG——它同时是 `lineageOf` 终止的前提）；
 *    **尸体**：两节点环与**三节点环**都要拦住（只拦两节点环是「够用的错觉」）
 * ⑤ `lineageOf`（祖先）与 `borrowedBy`（后代）——多跳、跨线索、双向可查
 * ⑥ **空谱系分型**：「版本不在账本里」≠「在册但没有登记来源」
 * ⑦ `ledgerView` 报 borrowings——**空数组也是读数**（「没登记过借鉴」≠「读不到」）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { borrowedBy, borrowingsOf, ledgerView, lineageOf, openBorrowing } from '../lib/rounds.js'
import { EvolveStore } from '../lib/ledger-store.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'selfrewrite-borrow-'))
  const modeltestDir = join(root, 'modeltest')
  mkdirSync(modeltestDir, { recursive: true })
  return {
    root,
    store: new EvolveStore(join(root, 'evolve'), modeltestDir, '', ''),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** 造一条版本链，返回各版本号（模拟 initLedger / edit 的产物） */
function seed(store, resource, contents) {
  const l = store.ensureLedger()
  const out = []
  for (const c of contents) out.push(store.addVersion(l, resource, c, '基线'))
  const res = l.resources[resource]
  if (!res.anchors.includes(out[0])) res.anchors.push(out[0])
  store.writeLedger(l)
  return out
}

const ref = (resource, version) => ({ resource, version })

// ── ① 跨线索登记（P6 核心判据） ────────────────────────────────────────────

test('跨线索登记：一条边的两端分属不同 resource（P6 判据原文）', () => {
  const f = fixture()
  try {
    const [arV0] = seed(f.store, 'agent-rules', ['规则 v0.0'])
    const [cpV0, cpV1] = seed(f.store, 'candidate-prompt', ['说明书 v0.0', '说明书 v0.1（借鉴了规则）'])

    const r = openBorrowing(f.store, ref('agent-rules', arV0), ref('candidate-prompt', cpV1), '把规则里的教训写进说明书')

    const l = f.store.ensureLedger()
    assert.equal(l.borrowings.length, 1, '边进了账本')
    assert.equal(l.borrowings[0].id, r.borrowingId)
    assert.equal(l.borrowings[0].from.resource, 'agent-rules', '两端资源不同 = 跨线索')
    assert.equal(l.borrowings[0].to.resource, 'candidate-prompt')
    assert.equal(l.borrowings[0].to.version, cpV1)
    assert.notEqual(cpV0, cpV1)
  } finally {
    f.cleanup()
  }
})

test('同线索借鉴也允许：能力不设限（「跨」是能做什么，不是只能做什么）', () => {
  const f = fixture()
  try {
    const [v0, v1, v2] = seed(f.store, 'agent-rules', ['v0', 'v1', 'v2'])
    openBorrowing(f.store, ref('agent-rules', v0), ref('agent-rules', v2), '跳版借鉴')
    const l = f.store.ensureLedger()
    assert.equal(l.borrowings.length, 1)
    assert.equal(l.borrowings[0].from.version, v0)
    assert.equal(l.borrowings[0].to.version, v2)
    assert.equal(borrowingsOf(l).length, 1)
    assert.notEqual(v1, v2)
  } finally {
    f.cleanup()
  }
})

// ── ② 尸体：自指 ⇒ 拒 ─────────────────────────────────────────────────────

test('尸体：自指 ⇒ 拒（同一个版本借自己会让谱系凭空多一环）', () => {
  const f = fixture()
  try {
    const [v0] = seed(f.store, 'agent-rules', ['v0'])
    assert.throws(
      () => openBorrowing(f.store, ref('agent-rules', v0), ref('agent-rules', v0), '自指'),
      /两端是同一个版本/,
    )
    assert.equal(f.store.ensureLedger().borrowings, undefined, '被拒的边不许留下痕迹')
  } finally {
    f.cleanup()
  }
})

// ── ③ 尸体：版本不存在 ⇒ 拒 ───────────────────────────────────────────────

test('尸体：两端版本必须已存在（from 与 to 各拦一次）——不许凭空造来源', () => {
  const f = fixture()
  try {
    const [arV0] = seed(f.store, 'agent-rules', ['v0'])
    const [cpV0] = seed(f.store, 'candidate-prompt', ['v0'])

    assert.throws(
      () => openBorrowing(f.store, ref('agent-rules', 'v9.9'), ref('candidate-prompt', cpV0), '凭空来源'),
      /from = agent-rules@v9\.9 不是\*\*已有\*\*版本/,
    )
    assert.throws(
      () => openBorrowing(f.store, ref('agent-rules', arV0), ref('candidate-prompt', 'v9.9'), '凭空产物'),
      /to = candidate-prompt@v9\.9 不是\*\*已有\*\*版本/,
    )
    // 没有版本链的资源（composition 未注册）也被同一条守卫拦住——不另开分支
    assert.throws(
      () => openBorrowing(f.store, ref('composition', 'v0.0'), ref('agent-rules', arV0), '幽灵资源'),
      /不是\*\*已有\*\*版本/,
    )
  } finally {
    f.cleanup()
  }
})

// ── ④ 尸体：重复边 ⇒ 拒 ───────────────────────────────────────────────────

test('尸体：同一条边重复登记 ⇒ 拒（图里两条同样的边会让读数虚高）', () => {
  const f = fixture()
  try {
    const [arV0] = seed(f.store, 'agent-rules', ['v0'])
    const [cpV0] = seed(f.store, 'candidate-prompt', ['v0'])
    openBorrowing(f.store, ref('agent-rules', arV0), ref('candidate-prompt', cpV0), '第一次')
    assert.throws(
      () => openBorrowing(f.store, ref('agent-rules', arV0), ref('candidate-prompt', cpV0), '第二次'),
      /这条边已存在/,
    )
    assert.equal(f.store.ensureLedger().borrowings.length, 1)
  } finally {
    f.cleanup()
  }
})

// ── ⑤ 尸体：成环 ⇒ 拒（两节点环 + 三节点环） ──────────────────────────────

test('尸体：成环 ⇒ 拒——两节点环与**三节点环**都要拦住（只拦两节点环是「够用的错觉」）', () => {
  const f = fixture()
  try {
    const [a, b, c] = seed(f.store, 'agent-rules', ['a', 'b', 'c'])
    openBorrowing(f.store, ref('agent-rules', a), ref('agent-rules', b), 'a→b')
    openBorrowing(f.store, ref('agent-rules', b), ref('agent-rules', c), 'b→c')

    // 三节点环：c→a 会让 a→b→c→a
    assert.throws(
      () => openBorrowing(f.store, ref('agent-rules', c), ref('agent-rules', a), 'c→a 成环'),
      /会成环/,
    )
    // 两节点环：b→a 会让 a→b→a
    assert.throws(
      () => openBorrowing(f.store, ref('agent-rules', b), ref('agent-rules', a), 'b→a 成环'),
      /会成环/,
    )
    assert.equal(f.store.ensureLedger().borrowings.length, 2, '两条被拒的边都没进账本')

    // 反向确认判据有分辨力：**不成环**的边照常放行（否则「一律拒绝」也能通过上面两条）
    openBorrowing(f.store, ref('agent-rules', a), ref('agent-rules', c), 'a→c 不成环')
    assert.equal(f.store.ensureLedger().borrowings.length, 3)
  } finally {
    f.cleanup()
  }
})

// ── ⑥ 谱系查询：多跳 + 跨线索 + 双向 ──────────────────────────────────────

test('lineageOf：多跳 + 跨线索（祖先）——「我从哪来」', () => {
  const f = fixture()
  try {
    const [arV0] = seed(f.store, 'agent-rules', ['规则 v0.0'])
    const [cpV0, cpV1] = seed(f.store, 'candidate-prompt', ['说明书 v0.0', '说明书 v0.1'])

    openBorrowing(f.store, ref('agent-rules', arV0), ref('candidate-prompt', cpV0), '一跳')
    openBorrowing(f.store, ref('candidate-prompt', cpV0), ref('candidate-prompt', cpV1), '二跳')

    const l = f.store.ensureLedger()
    const up = lineageOf(l, ref('candidate-prompt', cpV1))
    assert.equal(up.length, 2, '两个祖先（一跳 + 二跳）')
    assert.deepEqual(
      up.map((r) => r.resource + '@' + r.version).sort(),
      ['agent-rules@' + arV0, 'candidate-prompt@' + cpV0].sort(),
    )
    assert.equal(up.find((r) => r.version === cpV0).depth, 1, '直接来源 depth=1')
    assert.equal(up.find((r) => r.resource === 'agent-rules').depth, 2, '**跨线索**的二跳 depth=2')
  } finally {
    f.cleanup()
  }
})

test('borrowedBy：反向（后代）——「谁用过我」', () => {
  const f = fixture()
  try {
    const [arV0] = seed(f.store, 'agent-rules', ['规则 v0.0'])
    const [cpV0, cpV1] = seed(f.store, 'candidate-prompt', ['说明书 v0.0', '说明书 v0.1'])

    openBorrowing(f.store, ref('agent-rules', arV0), ref('candidate-prompt', cpV0), '一跳')
    openBorrowing(f.store, ref('candidate-prompt', cpV0), ref('candidate-prompt', cpV1), '二跳')

    const l = f.store.ensureLedger()
    const down = borrowedBy(l, ref('agent-rules', arV0))
    assert.equal(down.length, 2, '两个后代')
    assert.equal(down.find((r) => r.version === cpV0).depth, 1)
    assert.equal(down.find((r) => r.version === cpV1).depth, 2)
    // 无后代的一端：空数组是读数
    assert.deepEqual(borrowedBy(l, ref('candidate-prompt', cpV1)), [], '末端没有后代')
  } finally {
    f.cleanup()
  }
})

// ── ⑦ 空谱系分型 + ledgerView 读数 ────────────────────────────────────────

test('空谱系：在册但没有登记来源 ⇒ 空数组（是读数，不是「读不到」）', () => {
  const f = fixture()
  try {
    const [v0] = seed(f.store, 'agent-rules', ['v0'])
    const l = f.store.ensureLedger()
    assert.deepEqual(lineageOf(l, ref('agent-rules', v0)), [])
    assert.deepEqual(borrowedBy(l, ref('agent-rules', v0)), [])
    assert.deepEqual(borrowingsOf(l), [], '没登记过借鉴 ⇒ 0 条边')
  } finally {
    f.cleanup()
  }
})

test('ledgerView 报 borrowings——**空数组也是读数**（「没有借鉴」≠「读不到」）', () => {
  const f = fixture()
  try {
    const [v0] = seed(f.store, 'agent-rules', ['v0'])
    const empty = ledgerView(f.store)
    assert.ok(Array.isArray(empty.borrowings), '字段存在（不是 undefined）')
    assert.equal(empty.borrowings.length, 0, '空数组是「没有登记借鉴」的读数')

    const [cpV0] = seed(f.store, 'candidate-prompt', ['v0'])
    openBorrowing(f.store, ref('agent-rules', v0), ref('candidate-prompt', cpV0), '跨线索')
    const filled = ledgerView(f.store)
    assert.equal(filled.borrowings.length, 1)
    assert.equal(filled.borrowings[0].from.resource, 'agent-rules')
    assert.equal(filled.borrowings[0].to.resource, 'candidate-prompt')
  } finally {
    f.cleanup()
  }
})
