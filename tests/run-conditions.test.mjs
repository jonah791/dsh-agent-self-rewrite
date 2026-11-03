/**
 * run-conditions.test.mjs — 「同起点 + 同预算的前后对照」在账本里**能不能表达**。
 *
 * 修的是什么（台账 lh-7603c358 / docs/reports/self-improvement-retest-2026-10-27.md 层 A）：
 * 账本字段只有 `runId / gen / sessionId / status / at / doneAt` —— **没有预算、没有起点快照**。
 * 于是那一列读数是 **0 代**，而且报告特意说清：**不是我没做对照，是账本结构上无法表达**——
 * 没有起点快照与预算，跑两次也证明不了「同条件」。
 *
 * 判据（每条都能区分新旧；改前 lib 里 recordRun 不写这两个字段 ⇒ ①②③④ 全红）：
 * ① ★ startSnapshot 由 recordRun **自动采集**自 ledger 版本
 * ② ★ 同一账本两次派发 ⇒ 快照相同（「同起点」可判定）
 * ③ ★ 起点变了（加了一版）⇒ 快照不同（能看出来）
 * ④ ★ **快照不可伪造**：即便调用方硬塞一个 startSnapshot，也只认真实版本
 * ⑤ ★ budget 按传入写；不传则**键不存在**（不是空对象）
 * ⑥ 旧记录（无这两个字段）读回不崩 —— 向后兼容
 * ⑦ 对照组：expectedMs 仍写入（新字段没把老字段挤掉）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { recordRun } from '../lib/rounds.js'
import { EvolveStore } from '../lib/ledger-store.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'selfrewrite-runcond-'))
  const modeltestDir = join(root, 'modeltest')
  mkdirSync(modeltestDir, { recursive: true })
  return {
    root,
    store: new EvolveStore(join(root, 'evolve'), modeltestDir, '', ''),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** 造一条版本链（沿用 borrow.test.mjs 的做法：模拟 initLedger / edit 的产物） */
function seed(store, resource, contents) {
  const l = store.ensureLedger()
  const out = []
  for (const c of contents) out.push(store.addVersion(l, resource, c, '基线'))
  const res = l.resources[resource]
  if (!res.anchors.includes(out[0])) res.anchors.push(out[0])
  store.writeLedger(l)
  return out
}

/** 记一轮并读回 */
function run(store, id, extra = {}) {
  recordRun(store, { runId: id, gen: 0, sessionId: 'sess-' + id, ...extra })
  return store.readRun(id)
}

test('① 空账本的起点是 `{}`——「起点什么都没有」是读数，不是缺失', () => {
  const f = fixture()
  try {
    const r = run(f.store, 'r-empty')
    assert.deepEqual(r.startSnapshot, {}, '缺键 = 起点没有这个资源；不许用 v0.0 兜底冒充真实版本')
  } finally {
    f.cleanup()
  }
})

test('②★ 同一账本两次派发 ⇒ 起点快照相同（「同起点」可判定）', () => {
  const f = fixture()
  try {
    const vs = seed(f.store, 'agent-rules', ['规则 v0', '规则 v1'])
    // 把 active 指向第二版：这样判据比的是**动态值**，不是常量 'v0.0'
    const l = f.store.ensureLedger()
    l.active['agent-rules'] = vs[1]
    f.store.writeLedger(l)
    const a = run(f.store, 'r-a')
    const b = run(f.store, 'r-b')
    assert.deepEqual(a.startSnapshot, b.startSnapshot)
    assert.equal(a.startSnapshot['agent-rules'], vs[1], '应取到 active 版本')
    assert.equal('candidate-prompt' in a.startSnapshot, false, '没种过的资源不该凭空出现在快照里')
  } finally {
    f.cleanup()
  }
})

test('③★ 起点变了 ⇒ 快照不同（改动看得出来）', () => {
  const f = fixture()
  try {
    seed(f.store, 'agent-rules', ['规则 v0'])
    const a = run(f.store, 'r-before')
    seed(f.store, 'agent-rules', ['规则 v1（改了）'])
    const b = run(f.store, 'r-after')
    assert.notDeepEqual(a.startSnapshot, b.startSnapshot, '改了规则，起点必须不同')
  } finally {
    f.cleanup()
  }
})

test('④★ 尸体：快照不可伪造——调用方硬塞也只认真实版本', () => {
  const f = fixture()
  try {
    seed(f.store, 'agent-rules', ['规则 v0'])
    const r = run(f.store, 'r-forged', { startSnapshot: { 'agent-rules': 'FAKE-v9.9.9' } })
    assert.notEqual(r.startSnapshot['agent-rules'], 'FAKE-v9.9.9', '参数里的起点快照不得被采纳')
  } finally {
    f.cleanup()
  }
})

test('⑤★ budget 按传入写；不传则键不存在（不是空对象）', () => {
  const f = fixture()
  try {
    const withB = run(f.store, 'r-budget', { budget: { evalTimeoutMs: 600_000 } })
    assert.deepEqual(withB.budget, { evalTimeoutMs: 600_000 })
    const without = run(f.store, 'r-nobudget')
    assert.equal('budget' in without, false, '不传就该没有这个键，而不是 {}')
  } finally {
    f.cleanup()
  }
})

test('⑥ 旧记录（无 budget / startSnapshot）读回不崩、字段为 undefined', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'evolve', 'runs'), { recursive: true })
    writeFileSync(
      join(f.root, 'evolve', 'runs', 'legacy.json'),
      JSON.stringify({
        runId: 'legacy',
        gen: 3,
        status: 'done',
        at: '2026-10-01T00:00:00.000Z',
        doneAt: '2026-10-01T01:00:00.000Z',
      }),
    )
    const r = f.store.readRun('legacy')
    assert.equal(r.runId, 'legacy')
    assert.equal(r.budget, undefined)
    assert.equal(r.startSnapshot, undefined)
  } finally {
    f.cleanup()
  }
})

test('⑦ 对照组：expectedMs 仍写入（新字段没把老字段挤掉）', () => {
  const f = fixture()
  try {
    const r = run(f.store, 'r-expected')
    assert.equal(typeof r.expectedMs, 'number')
    assert.ok(r.expectedMs > 0)
  } finally {
    f.cleanup()
  }
})
