/**
 * wiring-recycle.test.mjs — 回收分支的**离线尸体测试**（v0.6.0 · 2026-10-08）。
 *
 * 为什么需要它：累积段（`self-test`）**只增不减、无回收**，实测 4,666 B / 11 条，
 * 全文件余量 1,245 B ÷ 条目中位 382 B ⇒ 再约 3 条规则就撞线。此前唯一的腾空间手段是
 * 「人肉降级一条正本规则的表达力」，是**单调消耗**。
 *
 * 判据来自 docs/semantic.md §7（判据①②③ + 有界 + 不静默 + 往返幂等）。
 * 纪律（§5.9 规则 2）：带「尸体」标注的用例是**已知坏样本**——它们断言**拒写**且**一字未写**。
 *
 * ⚠ 全部用例只碰纯函数，不触文件系统（回收的落盘由 index.ts 负责）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyRuleUpsert,
  applyRuleUpsertWithRecycle,
  buildBlock,
  byteLength,
  extractBlockInner,
  findBlock,
  joinEntries,
  recycleOldest,
  splitEntries,
} from '../lib/wiring.js'

const SELF_TEST = findBlock('self-test')
const ARCHIVE = 'docs/agents-md-archive.md'
const pointerFor = (n) => `> ⤵ 已回收 ${n} 条至 ${ARCHIVE}`

/** 一条规则：`**规则N**：` + pad 个 x ⇒ 字节数 = 14 + pad（中文各 3 B） */
const rule = (n, pad = 86) => `**规则${n}**：${'x'.repeat(pad)}`

/** 夹具：块外哨兵×2 + 一个 self-test 段（哨兵用于证明「块外内容一律不动」） */
function fixture(entries) {
  return [
    '# 灵魂节选',
    '',
    '块外哨兵·前',
    '',
    buildBlock(joinEntries(entries), SELF_TEST),
    '',
    '块外哨兵·后',
    '',
  ].join('\n')
}

// ---------- 纯原语：切分与回收循环 ----------

test('条目切分：非空行即条目，trim 后还原（往返幂等）', () => {
  assert.deepEqual(splitEntries('a\n\nb\n   \nc'), ['a', 'b', 'c'])
  assert.deepEqual(splitEntries('  a  \n b '), ['a', 'b'])
  assert.deepEqual(splitEntries(''), [])
  assert.deepEqual(splitEntries('   \n  '), [])
  // 幂等（不声称逐字：空行按分隔符规范化——段是规则清单，不是格式敏感文档）
  const x = 'a\n\nb\n   \nc'
  assert.deepEqual(splitEntries(joinEntries(splitEntries(x))), splitEntries(x))
  assert.equal(joinEntries([]), '')
})

test('recycleOldest：从最旧端迁，fits 一真即停；永不满足则迁到 keep 条保底', () => {
  const inner = joinEntries(['a', 'b', 'c'])

  const fit = recycleOldest(inner, (cand) => splitEntries(cand).length <= 2)
  assert.deepEqual(fit.recycled, ['a'], '迁满足条件的**最少**条数')
  assert.equal(fit.stopped, 'fits')
  assert.deepEqual(splitEntries(fit.inner), ['b', 'c'])

  const dead = recycleOldest(inner, () => false)
  assert.deepEqual(dead.recycled, ['a', 'b'], 'keep=1 ⇒ 绝不迁空')
  assert.equal(dead.stopped, 'exhausted')
  assert.deepEqual(splitEntries(dead.inner), ['c'])

  const keep2 = recycleOldest(inner, () => false, 2)
  assert.deepEqual(keep2.recycled, ['a'])
  assert.deepEqual(splitEntries(keep2.inner), ['b', 'c'])
})

// ---------- 判据①：撞线自动回收 + 不丢 ----------

test('判据①：写入超限 ⇒ 自动迁走最旧条，迁走的可逐字读回', () => {
  const e = [rule(1), rule(2), rule(3)] // 各 100 B
  const full = fixture(e)
  const draft = rule(4, 286) // 300 B —— 比单条旧规则长，因此需要迁 ≥2 条才放得下

  // 基准：不回收时的结果大小（用旧原语现算，不手算 splice 细节）
  const greedy = applyRuleUpsert(full, { blockId: 'self-test', draft, maxBytes: Number.MAX_SAFE_INTEGER })
  assert.equal(greedy.ok, true)
  const baseline = byteLength(greedy.content)

  // maxBytes 取「迁 1 条不够、迁 2 条够」的区间中值 ⇒ 同时证明「按最旧顺序、迁到够为止」
  const ptr = byteLength(pointerFor(2))
  const afterTwo = baseline + ptr - byteLength(e[0]) - byteLength(e[1])
  const afterOne = baseline + ptr - byteLength(e[0])
  const maxBytes = Math.floor((afterTwo + afterOne) / 2)
  assert.ok(afterTwo <= maxBytes && maxBytes < afterOne, '夹具区间自检：迁 2 能放、迁 1 放不下')

  const r = applyRuleUpsertWithRecycle(full, { blockId: 'self-test', draft, maxBytes, pointerFor, reserveBytes: 0 })

  assert.equal(r.outcome.ok, true, '回收后应放行（这正是治本：撞线不再只能人肉腾）')
  assert.equal(r.outcome.action, 'added')
  assert.equal(r.stopped, 'fits')
  assert.deepEqual(r.recycled, [e[0], e[1]], '迁走的是最旧两条，逐字')

  const inner = extractBlockInner(r.outcome.content, SELF_TEST)
  assert.ok(inner.includes(rule(4)), '新规则在段内')
  assert.ok(!inner.includes(rule(1)) && !inner.includes(rule(2)), '迁走的不在段内')
  assert.ok(inner.includes(rule(3)), '未迁的原样保留')
  assert.ok(inner.includes('已回收 2 条至 ' + ARCHIVE), 'I9：段内留一行指针')
  assert.equal(splitEntries(inner).filter((l) => l.startsWith('> ⤵')).length, 1, '指针只有一行')

  assert.ok(r.outcome.content.includes('块外哨兵·前') && r.outcome.content.includes('块外哨兵·后'))
  assert.ok(r.outcome.headroom >= 0)

  // 归档可**逐字**还原（I9 的另一半：不丢）
  assert.deepEqual(r.recycled, e.slice(0, 2).map((s) => s.trim()))
})

test('判据①附属：重复回收**替换**指针行，不叠加（指针是状态，不是日志）', () => {
  const e = [rule(1), rule(2), rule(3)]
  const full = fixture(e)
  const draft = rule(4, 286)
  const greedy = applyRuleUpsert(full, { blockId: 'self-test', draft, maxBytes: Number.MAX_SAFE_INTEGER })
  const baseline = byteLength(greedy.content)
  const ptr = byteLength(pointerFor(2))
  const maxBytes = Math.floor((baseline + ptr - byteLength(e[0]) - byteLength(e[1]) + baseline + ptr - byteLength(e[0])) / 2)

  const r1 = applyRuleUpsertWithRecycle(full, { blockId: 'self-test', draft, maxBytes, pointerFor, reserveBytes: 0 })
  assert.equal(r1.outcome.ok, true)

  // 第二次写入（同样的预算）⇒ 段内已有一条指针，回收后仍只应有一条
  const r2 = applyRuleUpsertWithRecycle(r1.outcome.content, { blockId: 'self-test', draft: rule(5, 286), maxBytes, pointerFor, reserveBytes: 0 })
  assert.equal(r2.outcome.ok, true)
  const inner = extractBlockInner(r2.outcome.content, SELF_TEST)
  assert.equal(splitEntries(inner).filter((l) => l.startsWith('> ⤵')).length, 1, '指针不叠加')
  assert.ok(inner.includes('已回收 ' + String(r2.recycled.length) + ' 条至 ' + ARCHIVE))
})

// ---------- 判据③（尸体）：回收判据有区分力 ----------

test('判据③（尸体）：逐字重复的旧规则 ⇒ exists，回收**不启动**', () => {
  const e = [rule(1), rule(2)]
  const full = fixture(e)

  const r = applyRuleUpsertWithRecycle(full, {
    blockId: 'self-test',
    draft: e[0],
    maxBytes: byteLength(full) + 10, // 余量很小：若判据失灵会去回收，进而「成功」写坏状态
    pointerFor,
  })

  assert.equal(r.outcome.ok, true)
  assert.equal(r.outcome.action, 'exists', '逐字重复 ⇒ 幂等跳过')
  assert.equal(r.outcome.content, full, '一字未写')
  assert.deepEqual(r.recycled, [], '回收不得被误触发')
  assert.equal(r.stopped, 'not-needed')
})

test('尸体：迁到只剩 1 条（keep）仍放不下 ⇒ over-budget 拒写，绝不截断', () => {
  const full = fixture([rule(1)])
  const r = applyRuleUpsertWithRecycle(full, {
    blockId: 'self-test',
    draft: rule(9, 5000),
    maxBytes: byteLength(full) + 10,
    pointerFor,
  })

  assert.equal(r.outcome.ok, false)
  assert.equal(r.outcome.reason, 'over-budget')
  assert.equal(r.stopped, 'exhausted')
  assert.deepEqual(r.recycled, [], '唯一那条不得被迁走（I10：保留至少 1 条）')
  assert.equal(Object.hasOwn(r.outcome, 'content'), false, '拒绝路径不得给出新内容')
})

// ---------- 格式契约：一条一行 ----------

test('多行 draft 折叠为单行（段是规则清单：一条一行 ⇒ 回收按行切分才安全）', () => {
  const full = fixture([rule(1)])
  const r = applyRuleUpsertWithRecycle(full, {
    blockId: 'self-test',
    draft: '**多行规则**：第一句\n第二句\n\t第三句',
    maxBytes: 999999,
    pointerFor,
  })

  assert.equal(r.outcome.ok, true)
  const inner = extractBlockInner(r.outcome.content, SELF_TEST)
  assert.ok(inner.includes('**多行规则**：第一句 第二句 第三句'), '内容不丢，只规范化空白')
  assert.equal(splitEntries(inner).length, 2, '折叠后只多一条')
})

// ---------- 与既有语义的兼容 ----------

test('回收分支不改变「不超限」时的行为（既有 upsert 语义原样）', () => {
  const full = fixture([rule(1)])
  const a = applyRuleUpsert(full, { blockId: 'self-test', draft: rule(2), maxBytes: 999999 })
  const b = applyRuleUpsertWithRecycle(full, { blockId: 'self-test', draft: rule(2), maxBytes: 999999, pointerFor })

  assert.equal(a.ok, true)
  assert.equal(b.outcome.ok, true)
  assert.equal(b.outcome.content, a.content, '未触发回收时与旧原语逐字节相同')
  assert.equal(b.outcome.headroom, a.headroom)
  assert.deepEqual(b.recycled, [])
  assert.equal(b.stopped, 'not-needed')
})

test('未登记段 / 标记损坏仍走同一套守卫（回收不绕过它们）', () => {
  const full = fixture([rule(1)])
  const unknown = applyRuleUpsertWithRecycle(full, { blockId: 'nope', draft: rule(2), maxBytes: 999999, pointerFor })
  assert.equal(unknown.outcome.ok, false)
  assert.equal(unknown.outcome.reason, 'unknown-block')

  const broken = full.replace(SELF_TEST.end, '')
  const corrupt = applyRuleUpsertWithRecycle(broken, { blockId: 'self-test', draft: rule(2), maxBytes: 999999, pointerFor })
  assert.equal(corrupt.outcome.ok, false)
  assert.equal(corrupt.outcome.reason, 'corrupt-markers')
})

test('判据②：回收以**目标余量**为准，而不只求「刚好放下」（同条件下 reserve 真的改变迁移条数）', () => {
  const e = [rule(1), rule(2), rule(3), rule(4)] // 各 100 B
  const full = fixture(e)
  const draft = rule(5, 586) // 600 B：迁 2 条只够放得下（余量恰好 0），迁 3 条才够安全区
  const baseline = byteLength(applyRuleUpsert(full, { blockId: 'self-test', draft, maxBytes: Number.MAX_SAFE_INTEGER }).content)
  const reserve = 100
  const maxBytes = baseline + byteLength(pointerFor(3)) - 3 * byteLength(e[0]) + reserve

  assert.ok(maxBytes < baseline, '夹具自检：不回收必然超限')

  const driven = applyRuleUpsertWithRecycle(full, { blockId: 'self-test', draft, maxBytes, pointerFor, reserveBytes: reserve })
  assert.equal(driven.outcome.ok, true)
  assert.equal(driven.stopped, 'fits')
  assert.equal(driven.recycled.length, 3, '迁到满足目标余量为止')
  assert.ok(driven.outcome.headroom >= reserve, '余量进了安全区：' + String(driven.outcome.headroom))

  // 对照组：同预算、reserve=0 ⇒ 只迁 2 条（放得下即停）。**若两者相同，说明 reserve 是装饰品**
  const bare = applyRuleUpsertWithRecycle(full, { blockId: 'self-test', draft, maxBytes, pointerFor, reserveBytes: 0 })
  assert.equal(bare.outcome.ok, true)
  assert.equal(bare.recycled.length, 2, '无目标余量时只求放得下')
  assert.ok(bare.recycled.length < driven.recycled.length, 'reserve 有区分力（不是恒不动）')
})

test('尽力而为：达不到目标余量 ⇒ 报 `tight` 并**回到最少迁移量**，不为没达到的目标白迁条目', () => {
  const e = [rule(1), rule(2), rule(3), rule(4)]
  const full = fixture(e)
  const draft = rule(5, 286)
  const baseline = byteLength(applyRuleUpsert(full, { blockId: 'self-test', draft, maxBytes: Number.MAX_SAFE_INTEGER }).content)
  const maxBytes = baseline + byteLength(pointerFor(1)) - byteLength(e[0]) + 1 // 迁 1 条后只剩 1 B

  const r = applyRuleUpsertWithRecycle(full, { blockId: 'self-test', draft, maxBytes, pointerFor, reserveBytes: 500 })

  assert.equal(r.outcome.ok, true, '放得下就放行')
  assert.equal(r.stopped, 'tight', '如实报「没到安全区」，不谎报 fits')
  assert.equal(r.recycled.length, 1, '截断回最少迁移量')
  assert.ok(r.outcome.headroom >= 0 && r.outcome.headroom < 500)
})

// ---------- 保护（pinned）· 2026-10-14 加 ----------
//
// 存在理由（实测）：纯 FIFO 回收会把「报时前必读时钟」「交付进正文」这类**高频核心纪律**
// 一并迁走 ⇒ 不再进每轮注入 ⇒ **静默行为退化**，而报告里那句还是 `stopped:'fits'`（成功）。
// 重要性**不可由程序推断**（那是判断代填）⇒ 只执行主体显式声明的保护。

/** 共用夹具：draft 大到必须回收才放得下，且只够迁 1–2 条 */
function tightFixture() {
  const e = [rule(1), rule(2), rule(3), rule(4)]
  const full = fixture(e)
  const draft = rule(5, 286)
  const baseline = byteLength(
    applyRuleUpsert(full, { blockId: 'self-test', draft, maxBytes: Number.MAX_SAFE_INTEGER }).content,
  )
  const maxBytes = baseline + byteLength(pointerFor(1)) - byteLength(e[0]) + 1
  return { e, full, draft, maxBytes }
}

test('保护生效：受保护条目永不被迁出，且原位保留（回收照旧继续）', () => {
  const { full, draft, maxBytes } = tightFixture()
  const isPinned = (entry) => entry.includes('规则1')

  const r = applyRuleUpsertWithRecycle(full, {
    blockId: 'self-test',
    draft,
    maxBytes,
    pointerFor,
    reserveBytes: 0,
    pinned: isPinned,
  })

  assert.equal(r.outcome.ok, true)
  assert.ok(!r.recycled.some((x) => x.includes('规则1')), '受保护条目不得进迁出集合')
  assert.ok(r.recycled.length >= 1, '保护 ≠ 停止回收：未受保护的照迁')
  const inner = extractBlockInner(r.outcome.content, SELF_TEST)
  assert.ok(inner.includes('规则1'), '受保护条目留在段内')
  assert.equal(r.pinnedRemaining, 1, '可见面：段内受保护条数报出来')
})

test('负对照：不配 pinned ⇒ 与旧行为逐字节一致（保护是纯增量）', () => {
  const { full, draft, maxBytes } = tightFixture()

  const a = applyRuleUpsertWithRecycle(full, { blockId: 'self-test', draft, maxBytes, pointerFor, reserveBytes: 0 })
  const b = applyRuleUpsertWithRecycle(full, {
    blockId: 'self-test',
    draft,
    maxBytes,
    pointerFor,
    reserveBytes: 0,
    pinned: undefined,
  })
  assert.equal(a.outcome.content, b.outcome.content, '逐字节一致')
  assert.deepEqual(a.recycled, b.recycled)
  assert.equal(a.stopped, b.stopped)
  assert.equal(b.pinnedRemaining, 0, '没配保护 ⇒ 计数 0（与「配了但没命中」分得开）')

  // 关键：pin 必须**真的改变**迁出集合——否则这条负对照没有区分力（恒同 = 装饰品）
  const c = applyRuleUpsertWithRecycle(full, {
    blockId: 'self-test',
    draft,
    maxBytes,
    pointerFor,
    reserveBytes: 0,
    pinned: (x) => x.includes('规则1'),
  })
  assert.notDeepEqual(c.recycled, a.recycled, 'pin 改变迁出集合（有区分力）')
})

test('全被保护且仍放不下 ⇒ 如实 `exhausted` + 拒写 + 一字未迁（不静默放行）', () => {
  const e = [rule(1), rule(2), rule(3)]
  const full = fixture(e)
  const draft = rule(4, 900)
  const baseline = byteLength(
    applyRuleUpsert(full, { blockId: 'self-test', draft, maxBytes: Number.MAX_SAFE_INTEGER }).content,
  )
  const maxBytes = baseline - 10

  const r = applyRuleUpsertWithRecycle(full, {
    blockId: 'self-test',
    draft,
    maxBytes,
    pointerFor,
    pinned: () => true,
  })

  assert.equal(r.outcome.ok, false, '放不下就拒写')
  assert.equal(r.recycled.length, 0, '拒写 ⇒ 迁出恒为空（调用方不可能误把没收到的迁移写进归档）')
})

test('两实现的**保护语义**一致：同一 pinned 下两边都不迁受保护条目', () => {
  // ⚠ 立判据时的坑（实测踩过，第一版红）：不能断言「两实现的迁出集合相同」——它们的
  // **预算口径本就不同**（端到端那条含指针行，`recycleOldest` 的 fits 只吃候选段内文本）
  // ⇒ 迁移条数可以不同。真正必须一致的是**保护语义**：受保护条目在两条路径上都不被迁出。
  const e = [rule(1), rule(2), rule(3), rule(4)]
  const full = fixture(e)
  const inner = joinEntries(e)
  const isPinned = (x) => x.includes('规则1')

  // ① 纯函数侧：用一个纯计数谓词（不涉字节）⇒ 必然迁到剩 2 条，与 pin 无因果纠缠
  const viaOldest = recycleOldest(inner, (cand) => splitEntries(cand).length <= 2, 1, isPinned)
  assert.ok(viaOldest.recycled.length >= 2, '夹具自检：确实迁了（否则「没违规」是假绿）')
  assert.ok(!viaOldest.recycled.some(isPinned), '受保护条目不迁（纯函数侧）')
  assert.equal(viaOldest.pinnedRemaining, 1)

  // ② 端到端侧：同一 pinned，用字节预算逼它迁
  const draft = rule(5, 286)
  const baseline = byteLength(
    applyRuleUpsert(full, { blockId: 'self-test', draft, maxBytes: Number.MAX_SAFE_INTEGER }).content,
  )
  const maxBytes = baseline + byteLength(pointerFor(1)) - byteLength(e[0]) + 1
  const viaWrite = applyRuleUpsertWithRecycle(full, {
    blockId: 'self-test',
    draft,
    maxBytes,
    pointerFor,
    reserveBytes: 0,
    pinned: isPinned,
  })
  assert.ok(viaWrite.recycled.length >= 1, '夹具自检：端到端侧确实迁了')
  assert.ok(!viaWrite.recycled.some(isPinned), '受保护条目不迁（端到端侧）')
})
