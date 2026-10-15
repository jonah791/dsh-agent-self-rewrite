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

import { advanceQueue, buildStatus, collectStatus, countAnchors, countHypotheses, selfRewriteSnapshot, stalenessOf, starvationOf } from '../lib/status.js'
import { resolveLegacyPaths } from '../lib/store.js'

const ok = (value) => ({ ok: true, value })
const fail = (reason, detail = 'x') => ({ ok: false, reason, detail })

const h = (status) => ({ id: `h-${status}-${Math.random()}`, statement: 's', prediction: 'p', status, threshold: 3, probe: {}, evidence: [] })

test('countHypotheses：六态分类，未知取值进 other（不猜不吞）', () => {
  const c = countHypotheses([h('active'), h('active'), h('finding'), h('confirmed'), h('refuted'), h('weird')])
  assert.deepEqual(c, { hypotheses: 6, active: 2, findings: 1, confirmed: 1, refuted: 1, archived: 0, pending: 0, other: 1 })
})

test('尸体：archived 是**正常状态**，不得混进 other（t-2a164936 的判据）', () => {
  const c = countHypotheses([h('archived'), h('archived'), h('weird')])
  assert.equal(c.archived, 2, 'archived 必须独立成档')
  assert.equal(c.other, 1, 'other 只该装六态之外的取值——archived 混进来这条会变成 3')
  assert.equal(c.active, 0)
  assert.equal(c.pending, 0)
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
  const r = buildStatus({ selfTest: fail('missing', '文件不存在：X'), ledger: ok({ resources: {} }), runs: [] })
  assert.equal(r.counts.hypotheses, 0)
  assert.equal(r.counts.anchors, 0)
  assert.ok(r.notes.some((n) => n.includes('假设库不可用') && n.includes('不代表没有假设')))
  assert.ok(r.text.includes('未知') === false, '账本可读时不该出现「未知」')
})

test('尸体：账本读不到 ⇒ 锚点报「未知」，文本里**不得出现 0 作为锚点值**', () => {
  const r = buildStatus({ selfTest: ok({ hypotheses: [h('active')] }), ledger: fail('missing', '文件不存在：Y'), runs: [] })
  assert.equal(r.counts.anchors, null)
  assert.ok(r.notes.some((n) => n.includes('锚点链不可用') && n.includes('不是 0')))
  assert.ok(r.text.includes('锚点：未知（账本不可读）'))
})

test('尸体：受管产物不存在 ⇒ 预算行报「不存在」，**不报 0 字节**', () => {
  const r = buildStatus({
    selfTest: ok({ hypotheses: [] }),
    ledger: ok({ resources: {} }),
    runs: [],
    artifacts: [{ id: 'agent-rules', path: 'E:/nope/AGENTS.md', bytes: null, maxBytes: 64800 }],
  })
  const line = r.text.split('\n').find((l) => l.startsWith('受管产物 ['))
  assert.ok(line !== undefined && line.includes('不存在'))
  assert.ok(!/\d+ 字节/.test(line), '预算行不得渲染任何字节数字（值的位置上不许出现 0）')
})

test('预算行：文件存在 ⇒ 报字节数、上限与余量', () => {
  const r = buildStatus({
    selfTest: ok({ hypotheses: [] }),
    ledger: ok({ resources: {} }),
    runs: [],
    artifacts: [{ id: 'agent-rules', path: 'E:/x/AGENTS.md', bytes: 64434, maxBytes: 64800 }],
  })
  assert.ok(r.text.includes('64434 字节 / 上限 64800，余量 366'))
})

test('预算行：**无上限**的产物报「无上限」，不报「上限 0」也不报余量', () => {
  const r = buildStatus({
    selfTest: ok({ hypotheses: [] }),
    ledger: ok({ resources: {} }),
    runs: [],
    artifacts: [{ id: 'candidate-prompt', path: 'E:/x/CANDIDATE_PROMPT.md', bytes: 1234, maxBytes: null }],
  })
  const line = r.text.split('\n').find((l) => l.startsWith('受管产物 [candidate-prompt]'))
  assert.ok(line !== undefined && line.includes('无上限'))
  assert.ok(!line.includes('上限 0'), '「无上限」不得渲染成「上限 0」——那是两个意思')
  assert.ok(!line.includes('余量'), '无上限就没有余量可言')
})

test('多产物：**每条落点各一行**（旧版只报一条，其余静默不可见）', () => {
  const r = buildStatus({
    selfTest: ok({ hypotheses: [] }),
    ledger: ok({ resources: {} }),
    runs: [],
    artifacts: [
      { id: 'agent-rules', path: 'E:/x/AGENTS.md', bytes: 100, maxBytes: 200 },
      { id: 'candidate-prompt', path: 'E:/x/CANDIDATE_PROMPT.md', bytes: 50, maxBytes: null },
    ],
  })
  const rows = r.text.split('\n').filter((l) => l.startsWith('受管产物 ['))
  assert.equal(rows.length, 2, '两条落点必须各占一行——少一行就是静默不可见')
  assert.ok(rows[0].includes('[agent-rules]'))
  assert.ok(rows[1].includes('[candidate-prompt]'))
})

test('尸体：旧字段 `rules` 已退役 —— 传它**不产生任何预算行**（两个字段都读 = 双源）', () => {
  const r = buildStatus({
    selfTest: ok({ hypotheses: [] }),
    ledger: ok({ resources: {} }),
    runs: [],
    rules: { path: 'E:/x/AGENTS.md', bytes: 100, maxBytes: 200 },
  })
  assert.equal(r.text.split('\n').filter((l) => l.startsWith('受管产物 [')).length, 0)
})

test('空假设库 ⇒ 明说「猜想环当前无内容」，而不是沉默', () => {
  const r = buildStatus({ selfTest: ok({ hypotheses: [] }), ledger: ok({ resources: {} }), runs: [] })
  assert.ok(r.notes.some((n) => n.includes('假设库为空')))
})

test('未知状态计数出现时，注里如实披露（不静默归类）', () => {
  const r = buildStatus({ selfTest: ok({ hypotheses: [h('weird'), h('weird')] }), ledger: ok({ resources: {} }), runs: [] })
  assert.equal(r.counts.other, 2)
  assert.ok(r.notes.some((n) => n.includes('2 条假设的状态不在 HypothesisStatus 六态')))
})

test('尸体：archived 假设不触发「未知取值」注（它是正常状态）', () => {
  const r = buildStatus({ selfTest: ok({ hypotheses: [h('archived'), h('archived')] }), ledger: ok({ resources: {} }), runs: [] })
  assert.equal(r.counts.archived, 2)
  assert.equal(r.counts.other, 0)
  assert.ok(!r.notes.some((n) => n.includes('不在 HypothesisStatus 六态')), 'archived 不该触发未知取值注')
})

test('真实语料形状：32 条全终态 ⇒ active/finding 均为 0，计数与文本一致', () => {
  const hypotheses = [...Array(13).fill(0).map(() => h('confirmed')), ...Array(19).fill(0).map(() => h('refuted'))]
  const r = buildStatus({ selfTest: ok({ hypotheses }), ledger: fail('missing'), runs: [] })
  assert.deepEqual(r.counts, { hypotheses: 32, active: 0, findings: 0, confirmed: 13, refuted: 19, archived: 0, pending: 0, other: 0, anchors: null, runs: 0, unclosed: 0 })
  assert.ok(r.text.includes('假设：32 条（active 0 / finding 0 / confirmed 13 / refuted 19 / archived 0 / pending 0）'))
  // 2026-10-03 修正：空目录与「跑了但都收尾了」必须长得不一样（不许都报「未收尾 0」）
  assert.ok(r.notes.some((n) => n.includes('runs 目录为空')))
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

// ── 2026-10-03 修正的回归门：runs「记录数」≠「未收尾数」 ────────────────────────
// 事故：`rewrite_status` 把 runs 目录的**条目数**标成「未收尾评测轮：20」；实测该 20 条
// 为 done 11 / failed 9、未收尾 **0** ⇒ 一个措辞不准的读数制造了不存在的矛盾（排查一整圈）。

const runRec = (i, status) => ({ runId: `gen${i}-x`, gen: i, status, at: `2026-10-0${(i % 9) + 1}T00:00:00.000Z` })

test('全终态：记录数与未收尾分离，文本给出分布且旧标签消失', () => {
  const runs = [...Array(11).fill(0).map((_, i) => runRec(i, 'done')),
    ...Array(9).fill(0).map((_, i) => runRec(i + 11, 'failed'))]
  const r = buildStatus({ selfTest: ok({ hypotheses: [] }), ledger: ok({ resources: {} }), runs })
  assert.equal(r.counts.runs, 20, 'runs = 目录记录数')
  assert.equal(r.counts.unclosed, 0, 'done/failed 皆终态 ⇒ 未收尾 0')
  assert.ok(r.text.includes('done 11 · failed 9'), '分布必须出现在文本里')
  assert.ok(r.text.includes('未收尾 0'))
  assert.ok(!r.text.includes('未收尾评测轮：'), '旧标签必须消失——它是本次事故的根源')
  assert.ok(r.notes.some((n) => n.includes('无挂起轮次')))
})

test('未收尾判据是白名单：pending/running/未知都算，未知不放过', () => {
  const runs = [runRec(1, 'done'), runRec(2, 'pending'), runRec(3, 'running'), runRec(4, 'weird')]
  const r = buildStatus({ selfTest: ok({ hypotheses: [] }), ledger: ok({ resources: {} }), runs })
  assert.equal(r.counts.unclosed, 3, 'pending + running + 未知 = 3（终态是白名单）')
})

test('端到端：夹具目录里真写 run 文件 ⇒ collectStatus 读数与文件一致，坏条目跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'selfrewrite-runs-'))
  try {
    const paths = resolveLegacyPaths(root)
    mkdirSync(paths.runsDir, { recursive: true })
    for (const [i, s] of [['1', 'done'], ['2', 'done'], ['3', 'failed'], ['4', 'pending']]) {
      writeFileSync(join(paths.runsDir, `gen${i}-fix.json`),
        JSON.stringify({ runId: `gen${i}-fix`, gen: Number(i), status: s, at: '2026-10-03T00:00:00.000Z' }), 'utf8')
    }
    writeFileSync(join(paths.runsDir, 'broken.json'), '{not json', 'utf8')
    const r = collectStatus(paths)
    assert.equal(r.counts.runs, 4, '坏条目跳过，不得伪装成第 5 条')
    assert.equal(r.counts.unclosed, 1)
    assert.ok(r.text.includes('pending 1 · done 2 · failed 1'), '分布按「未收尾在前」排列')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 2026-10-15 加：停滞面 + 归一化推进队列（论文 SpecForge arXiv:2610.15708v1 迁移） ──
// 实测缺口：假设库 active 0 / finding 0、最新 confirmed 停在 25 天前，而**没有任何面报出这件事**。
// 论文的教训是「改进必须累积而非震荡」；本引擎当时的病是**停滞且不可见**。
// 推进排序取论文 §3.2 `r̂ = Δφ/(1−φ)` 的**归一化缺口**含义：奖励接近完成的，而非绝对进展大的。

const fixedNow = new Date('2026-10-15T12:00:00.000Z')
// ⚠ `h()` 工厂**不含 `updatedAt`**（它是全量状态测试用的最小形状）——而 `stalenessOf` 正是读它，
// 所以这里必须补上：漏了它，`lastWiredAt` 会**正确地**返回 null（2026-10-15 实测：两条红都源于此，
// 是**夹具不完整**而不是实现缺陷）。
const withEv = (status, evCount, thr, ts, updatedAt) => ({
  ...h(status),
  threshold: thr,
  updatedAt: updatedAt ?? ts,
  evidence: Array.from({ length: evCount }, (_, i) => ({ ts, kind: 'k', detail: 'd' + String(i) })),
})

test('stalenessOf：库空 ⇒ 天数全为 null（**不是 0**——「今天动过」与「算不出来」是两件事）', () => {
  const s = stalenessOf([], fixedNow)
  assert.equal(s.lastWiredAt, null)
  assert.equal(s.daysSinceWired, null)
  assert.equal(s.daysSinceEvidence, null)
  assert.equal(s.collecting, 0)
})

test('stalenessOf：天数按 now 现算；在采证数**只数 active**（终态假设不算在采证）', () => {
  const hs = [
    withEv('confirmed', 3, 3, '2026-09-20T16:10:00.000Z'),
    withEv('active', 1, 5, '2026-09-25T00:00:00.000Z'),
    withEv('refuted', 5, 5, '2026-08-01T00:00:00.000Z'),
  ]
  const s = stalenessOf(hs, fixedNow)
  assert.equal(s.lastWiredAt, '2026-09-20T16:10:00.000Z')
  assert.equal(s.daysSinceWired, 24, '09-20T16:10Z → 10-15T12:00Z = 24 天 19h50m ⇒ 向下取整 24')
  assert.equal(s.lastEvidenceAt, '2026-09-25T00:00:00.000Z')
  assert.equal(s.daysSinceEvidence, 20)
  assert.equal(s.collecting, 1)
})

test('advanceQueue：按**归一化剩余缺口**升序——接近完成的排前，而不是证据多的排前', () => {
  const hs = [
    withEv('active', 1, 10, '2026-10-01T00:00:00.000Z'), // 缺口 9/10 = 0.90
    withEv('active', 4, 5, '2026-10-01T00:00:00.000Z'), // 缺口 1/5  = 0.20 ← 最该推进
    withEv('active', 5, 20, '2026-10-01T00:00:00.000Z'), // 缺口 15/20 = 0.75
  ]
  const q = advanceQueue(hs)
  assert.deepEqual(q.map((r) => r.evidence), [4, 5, 1], '顺序 = 缺口比升序（按证据数降序会给出 [5,4,1]）')
  assert.equal(q[0].gapRatio, 0.2)
})

test('advanceQueue：比率型阈值（< 1）不得算出负缺口；分母有防除零', () => {
  const q = advanceQueue([withEv('active', 1, 0.25, '2026-10-01T00:00:00.000Z'), withEv('active', 0, 0, '2026-10-01T00:00:00.000Z')])
  assert.ok(q.every((r) => r.gapRatio >= 0), '缺口比恒非负')
  assert.ok(q.every((r) => Number.isFinite(r.gapRatio)), '零阈值不得产生 NaN/Infinity')
})

test('尸体：假设库**读不到** ⇒ 推进面整块缺席（「读不到」不许印成「无假设」）', () => {
  const r = buildStatus({ selfTest: fail('missing', '文件不存在：Z'), ledger: ok({ resources: {} }), runs: [] }, fixedNow)
  assert.ok(!r.text.includes('推进面：'), '不可用时推进面必须缺席——否则两种情形同貌')
  assert.ok(r.notes.some((n) => n.includes('假设库不可用')))
})

test('推进面三态不许同貌：库空 / 有布线 / 采证链停 各说各的', () => {
  const empty = buildStatus({ selfTest: ok({ hypotheses: [] }), ledger: ok({ resources: {} }), runs: [] }, fixedNow)
  assert.ok(empty.text.includes('推进面：无假设'))

  const stopped = buildStatus({
    selfTest: ok({ hypotheses: [withEv('confirmed', 3, 3, '2026-09-20T16:10:00.000Z')] }),
    ledger: ok({ resources: {} }),
    runs: [],
  }, fixedNow)
  assert.ok(stopped.text.includes('最后布线 24 天前'), '天数必须出现在推进面')
  assert.ok(stopped.text.includes('在采证 0 条'), '0 条必须与「读不到」分开')
  assert.ok(stopped.text.includes('采证链停'), '停滞的**根因**是采证链停，不是天数')

  const live = buildStatus({
    selfTest: ok({ hypotheses: [withEv('confirmed', 3, 3, '2026-09-20T16:10:00.000Z'), withEv('active', 4, 5, '2026-10-01T00:00:00.000Z')] }),
    ledger: ok({ resources: {} }),
    runs: [],
  }, fixedNow)
  assert.ok(live.text.includes('在采证 1 条'))
  assert.ok(live.text.includes('最接近阈值'), '有 active 时必须给出推进队列')
  assert.ok(!live.text.includes('采证链停'), '有 active 时不得报链停')
})

// ── 2026-10-15 加：信号饥饿面（论文 TESEARCH arXiv:2610.15964v1 迁移） ──────────
// 论文 §4 landing kernel：LLM 是 noisy actuator——「请求生成 N 个」与「实际落 M 个」有系统性偏差，
// 论文建模它并在请求时补偿。本引擎的对应物：登记时设 `threshold = N`（请求 N 条证据），探针落
// `evidence.length` 条，而**系统从不比较这两者**。
// 实测（2026-10-15）：32 条假设里 12 条证据恒 0，其中 8 条已裁 `refuted` ⇒ 采证链静默停摆 24 天。

const bare = (status, kind, threshold, createdAt, evidenceCount = 0) => ({
  id: `h-${status}-${kind}-${Math.random().toString(36).slice(2, 7)}`,
  statement: 's', prediction: 'p', status, threshold,
  probe: { kind }, createdAt, updatedAt: createdAt,
  evidence: Array.from({ length: evidenceCount }, (_, i) => ({ ts: createdAt, kind, detail: { i } })),
})

test('starvationOf：零证据与「已裁 refuted」分开报——后者是「未被检验被记成被证伪」的直接量化', () => {
  const hs = [
    bare('refuted', 'probe-before-action', 8, '2026-09-11T00:00:00.000Z'),
    bare('refuted', 'tool-failure-rate', 8, '2026-09-12T00:00:00.000Z'),
    bare('active', 'plan-before-action', 5, '2026-09-13T00:00:00.000Z'),
    bare('confirmed', 'tool-failure-rate', 3, '2026-09-14T00:00:00.000Z', 3),
  ]
  const s = starvationOf(hs, fixedNow)
  assert.equal(s.zeroEvidence, 3, '三条零证据（含已裁的——三种状态指向三种不同的病）')
  assert.equal(s.refutedWithoutEvidence, 2, 'refuted 且零证据 = 2')
  assert.equal(s.confirmedWithoutEvidence, 0)
  assert.equal(s.oldestZeroAgeDays, 34, '09-11 → 10-15 = 34 天')
})

test('starvationOf：按探针分档（论文 niche 的对应物）——饥饿集中在哪类探针上必须看得见', () => {
  const hs = [
    bare('refuted', 'probe-before-action', 8, '2026-09-11T00:00:00.000Z'),
    bare('refuted', 'probe-before-action', 8, '2026-09-12T00:00:00.000Z'),
    bare('active', 'plan-before-action', 5, '2026-09-13T00:00:00.000Z'),
    bare('confirmed', 'tool-failure-rate', 3, '2026-09-14T00:00:00.000Z', 3),
    bare('confirmed', 'tool-failure-rate', 3, '2026-09-15T00:00:00.000Z', 3),
  ]
  const s = starvationOf(hs, fixedNow)
  assert.deepEqual(s.byProbe.map((p) => p.kind), ['probe-before-action', 'plan-before-action'], '全采到的探针档不占版面')
  assert.deepEqual(s.byProbe[0], { kind: 'probe-before-action', total: 2, zeroEvidence: 2, maxAgeDays: 34 })
})

test('starvationOf：清单按年龄降序（最老在前）；年龄算不出的排最后而不是当「最年轻」', () => {
  const hs = [
    bare('active', 'k', 3, '2026-10-14T00:00:00.000Z'),
    bare('active', 'k', 3, 'not-a-date'),
    bare('active', 'k', 3, '2026-09-15T00:00:00.000Z'),
  ]
  const s = starvationOf(hs, fixedNow)
  assert.deepEqual(s.rows.map((r) => r.ageDays), [30, 1, null])
  assert.equal(s.oldestZeroAgeDays, 30, 'null 不进最老比较（「不知道」不是「最年轻」）')
})

test('信号面三态不许同貌：全采到 / 有零证据 / 库读不到', () => {
  const allCollected = buildStatus({
    selfTest: ok({ hypotheses: [bare('confirmed', 'tool-failure-rate', 3, '2026-09-14T00:00:00.000Z', 3)] }),
    ledger: ok({ resources: {} }), runs: [],
  }, fixedNow)
  assert.ok(allCollected.text.includes('信号面：全部假设都已采到证据'), '全采到是一个好读数，要明说')

  const starved = buildStatus({
    selfTest: ok({ hypotheses: [bare('refuted', 'probe-before-action', 8, '2026-09-11T00:00:00.000Z')] }),
    ledger: ok({ resources: {} }), runs: [],
  }, fixedNow)
  assert.ok(starved.text.includes('信号面：零证据 1 条'))
  assert.ok(starved.text.includes('未被检验 ≠ 被证伪'), '「已裁 refuted 却零证据」必须显式点名')
  assert.ok(starved.text.includes('probe-before-action 1/1'), '按探针分档必须在文本里')

  const unreadable = buildStatus({ selfTest: fail('missing', '文件不存在：Q'), ledger: ok({ resources: {} }), runs: [] }, fixedNow)
  assert.ok(!unreadable.text.includes('信号面：'), '库读不到时信号面必须整块缺席（不许印成「全部采到」）')
})

test('尸体：零证据判定改坏（把 0 条也当已采到）⇒ 该红；对照组零误伤', () => {
  const s = starvationOf([bare('refuted', 'k', 8, '2026-09-11T00:00:00.000Z')], fixedNow)
  assert.equal(s.zeroEvidence, 1, '真·零证据必须进清单')
  const s2 = starvationOf([bare('refuted', 'k', 8, '2026-09-11T00:00:00.000Z', 1)], fixedNow)
  assert.equal(s2.zeroEvidence, 0, '有证据者不得进零证据清单')
  assert.equal(s2.byProbe.length, 0, '没有零证据的探针档不该占版面')
})

test('防御性读数：confirmed 却零证据 ⇒ 如实报（状态机不该产出此组合，不许吞）', () => {
  const r = buildStatus({
    selfTest: ok({ hypotheses: [bare('confirmed', 'k', 3, '2026-09-11T00:00:00.000Z', 0)] }),
    ledger: ok({ resources: {} }), runs: [],
  }, fixedNow)
  assert.ok(r.text.includes('已裁 confirmed 1 条（状态机不该产出此组合，请查）'))
})

// ── 2026-10-15 加：信号面进感知圈载荷 ────────────────────────────────────────
// 判据：读数要我主动查 ⇒ 停滞正是「没人推我」的结果（SpecForge 那轮的教训）。故信号面必须进载荷。

test('snapshot：饥饿读数进载荷；hint 优先级 = 链停 > 饥饿 > 最接近阈值', () => {
  const stopped = selfRewriteSnapshot([bare('confirmed', 'k', 3, '2026-09-14T00:00:00.000Z', 3)], fixedNow)
  assert.ok(stopped.hint.includes('采证链停'), '无 active ⇒ 链停优先')

  const hungry = selfRewriteSnapshot([
    bare('active', 'probe-before-action', 8, '2026-09-11T00:00:00.000Z'),
    bare('refuted', 'probe-before-action', 8, '2026-09-12T00:00:00.000Z'),
  ], fixedNow)
  assert.equal(hungry.starved, 2)
  assert.equal(hungry.refutedWithoutEvidence, 1)
  assert.equal(hungry.oldestStarvedDays, 34)
  assert.ok(hungry.hint.includes('信号饥饿'), '有 active 且零证据 ⇒ 报饥饿（比「最接近阈值」更根本）')
  assert.ok(hungry.hint.includes('未被检验 ≠ 被证伪'))
  assert.ok(hungry.line.includes('零证据 2 条'), '一行摘要也要带饥饿读数')

  const healthy = selfRewriteSnapshot([bare('active', 'k', 3, '2026-10-01T00:00:00.000Z', 1)], fixedNow)
  assert.equal(healthy.starved, 0)
  assert.ok(!healthy.line.includes('零证据'), '全采到时摘要不带饥饿段')
  assert.ok(healthy.hint.includes('最接近阈值'), '正常状态给推进提示')
})
