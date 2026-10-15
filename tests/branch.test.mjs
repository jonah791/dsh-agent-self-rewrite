/**
 * branch.test.mjs — 分支（RSI topology = Tree · 域图 P2）的判据。
 *
 * 修的是什么：旧形态只有一条链——`anchors` 是**线性数组**、`active` 是**单值**，
 * 于是「两条竞争性改动」在账本里**结构上装不下**（只能串行，或整体回滚）。
 *
 * 判据（域图 §4 P2 原文）：「能从既有锚点分叉出新版本并**并存**；判据：两条竞争性改动同时在账本里」。
 *
 * 判据与尸体：
 * ① 并存——主干浮动版本与分支 head **同时在账本**；**尸体**：分叉不许动主干
 * ② 分叉点可以是**历史**版本（不只尾部）；**尸体**：`from` 不存在 ⇒ 拒开（不许凭空造祖先）
 * ③ merge = **择一**（head 成主干浮动版本，不是合体）；**尸体**：重复收口 ⇒ 抛错
 * ④ abandon：主干不动、版本不删；**尸体**：id 不复用（历史不重名）
 * ⑤ `ledgerView` 报 branches——**空数组也是读数**（「没有分支」≠「读不到」）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeBranch, ledgerView, openBranch } from '../lib/rounds.js'
import { EvolveStore } from '../lib/ledger-store.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'selfrewrite-branch-'))
  const modeltestDir = join(root, 'modeltest')
  mkdirSync(modeltestDir, { recursive: true })
  return {
    root,
    store: new EvolveStore(join(root, 'evolve'), modeltestDir, '', ''),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** 造一条基线版本链并把首版锚定（模拟 initLedger 的产物） */
function seed(store, resource, content) {
  const l = store.ensureLedger()
  const v = store.addVersion(l, resource, content, '基线')
  const res = l.resources[resource]
  res.anchors.push(v)
  store.writeLedger(l)
  return v
}

/** 主干加一条浮动版本（模拟一次 edit 之后、commit 之前的状态） */
function setMainActive(store, resource, content) {
  const l = store.ensureLedger()
  const v = store.addVersion(l, resource, content, '主干改动')
  l.active[resource] = v
  store.writeLedger(l)
  return v
}

// ── ① 并存（P2 的核心判据） ────────────────────────────────────────────────

test('并存：从既有锚点分叉后，主干浮动版本与分支 **同时在账本里**（P2 判据原文）', () => {
  const f = fixture()
  try {
    const base = seed(f.store, 'agent-rules', '规则 v0.0')
    const mainVer = setMainActive(f.store, 'agent-rules', '主干改动')

    const b = openBranch(f.store, 'agent-rules', base, '竞争性改动', '方案 B')

    const l = f.store.ensureLedger()
    assert.equal(l.active['agent-rules'], mainVer, '主干浮动版本不受分叉影响')
    assert.equal(l.branches.length, 1)
    assert.equal(l.branches[0].head, b.version)
    assert.notEqual(b.version, mainVer, '两条改动是两个不同版本')

    // 判据的正面：两个版本**同时**存在于该资源的版本链里
    const ids = l.resources['agent-rules'].versions.map((v) => v.version)
    assert.ok(ids.includes(mainVer), '主干改动仍在')
    assert.ok(ids.includes(b.version), '分支改动也在——两者并存')
  } finally {
    f.cleanup()
  }
})

// ── ② 分叉点可以不是尾部 ───────────────────────────────────────────────────

test('分叉点可以是**历史**版本（Tree 的意义：不只从尾部起分支）', () => {
  const f = fixture()
  try {
    const v0 = seed(f.store, 'agent-rules', 'v0.0')
    const l = f.store.ensureLedger()
    const v1 = f.store.addVersion(l, 'agent-rules', 'v0.1')
    l.resources['agent-rules'].anchors.push(v1)
    f.store.writeLedger(l)

    const b = openBranch(f.store, 'agent-rules', v0, '从历史点分叉', '回退式探索')
    assert.equal(b.from, v0, '分叉点就是那个历史版本')
    assert.notEqual(b.from, v1, '不是尾部锚点')
  } finally {
    f.cleanup()
  }
})

test('尸体：`from` 不是已有版本 ⇒ 拒开分支（不许凭空造祖先，谱系会断）', () => {
  const f = fixture()
  try {
    seed(f.store, 'agent-rules', 'v0.0')
    assert.throws(() => openBranch(f.store, 'agent-rules', 'v9.9', 'x', ''), /不许凭空造祖先/)
  } finally {
    f.cleanup()
  }
})

test('尸体：资源没有版本链 ⇒ 拒开分支（给不存在的资源开分支 = 造幽灵资源）', () => {
  const f = fixture()
  try {
    assert.throws(() => openBranch(f.store, 'agent-rules', 'v0.0', 'x', ''), /没有版本链/)
  } finally {
    f.cleanup()
  }
})

// ── ③ merge = 择一 ─────────────────────────────────────────────────────────

test('merge = **择一**：分支 head 成为主干浮动版本（不是合体成第三份内容）', () => {
  const f = fixture()
  try {
    const base = seed(f.store, 'agent-rules', 'v0.0')
    const b = openBranch(f.store, 'agent-rules', base, '分支内容', 'B')

    const r = closeBranch(f.store, b.branchId, 'merge', '采用 B')
    assert.equal(r.state, 'merged')
    assert.equal(r.activated, b.version)

    const l = f.store.ensureLedger()
    assert.equal(l.active['agent-rules'], b.version, '主干浮动版本 = 分支 head（择一）')
    assert.equal(l.branches[0].state, 'merged')
    assert.equal(l.branches[0].closedNote, '采用 B')
    assert.ok(l.branches[0].closedAt !== undefined, '收口必须留时刻')
  } finally {
    f.cleanup()
  }
})

test('尸体：重复收口 ⇒ 抛错（静默成功会让「合并了两次」这种事实消失）', () => {
  const f = fixture()
  try {
    const base = seed(f.store, 'agent-rules', 'v0.0')
    const b = openBranch(f.store, 'agent-rules', base, 'x', '')
    closeBranch(f.store, b.branchId, 'abandon', '不要了')
    assert.throws(() => closeBranch(f.store, b.branchId, 'merge', '再合一次'), /已是 abandoned/)
  } finally {
    f.cleanup()
  }
})

test('尸体：未知分支 id ⇒ 抛错（不静默当成功）', () => {
  const f = fixture()
  try {
    seed(f.store, 'agent-rules', 'v0.0')
    assert.throws(() => closeBranch(f.store, 'b99', 'merge', ''), /未知分支/)
  } finally {
    f.cleanup()
  }
})

// ── ④ abandon ──────────────────────────────────────────────────────────────

test('abandon：主干不动、版本不删（放弃 ≠ 抹掉历史）', () => {
  const f = fixture()
  try {
    const base = seed(f.store, 'agent-rules', 'v0.0')
    const mainVer = setMainActive(f.store, 'agent-rules', '主干')
    const b = openBranch(f.store, 'agent-rules', base, '竞争', 'B')

    closeBranch(f.store, b.branchId, 'abandon', '不采用')

    const l = f.store.ensureLedger()
    assert.equal(l.active['agent-rules'], mainVer, '主干浮动版本一字未动')
    assert.ok(l.resources['agent-rules'].versions.some((v) => v.version === b.version), '分支版本仍在（不删）')
    assert.equal(l.branches[0].state, 'abandoned')
  } finally {
    f.cleanup()
  }
})

test('分支 id 递增且**不复用**（已收口的 id 不重名——历史可追溯）', () => {
  const f = fixture()
  try {
    const base = seed(f.store, 'agent-rules', 'v0.0')
    const b0 = openBranch(f.store, 'agent-rules', base, 'a', '')
    closeBranch(f.store, b0.branchId, 'abandon', '')
    const b1 = openBranch(f.store, 'agent-rules', base, 'b', '')

    assert.equal(b0.branchId, 'b0')
    assert.equal(b1.branchId, 'b1', '已收口的 id 不复用')
    const l = f.store.ensureLedger()
    assert.equal(l.branches.length, 2, '两条记录都在（收口 ≠ 删除）')
  } finally {
    f.cleanup()
  }
})

// ── ⑤ 视图 ─────────────────────────────────────────────────────────────────

test('ledgerView 报 branches：**空数组也是读数**（「没有分支」≠「读不到」）', () => {
  const f = fixture()
  try {
    seed(f.store, 'agent-rules', 'v0.0')
    const view = ledgerView(f.store)
    assert.deepEqual(view.branches, [], '无分支时报空数组，不是 undefined')
  } finally {
    f.cleanup()
  }
})

test('向后兼容：旧账本（无 branches 字段）读出来仍是空数组，不抛错', () => {
  const f = fixture()
  try {
    seed(f.store, 'agent-rules', 'v0.0')
    // 模拟旧账本：手动把 branches 抹掉
    const l = f.store.readLedger()
    delete l.branches
    f.store.writeLedger(l)

    const view = ledgerView(f.store)
    assert.deepEqual(view.branches, [], '缺字段 ⇒ 空数组（缺省即纯线性，与旧版一致）')
    // 且仍可正常开分支（缺省被当成「还没有分支」，不是「不可用」）
    const b = openBranch(f.store, 'agent-rules', 'v0.0', 'x', '')
    assert.equal(b.branchId, 'b0')
  } finally {
    f.cleanup()
  }
})
