/**
 * enabling.test.mjs — 使能型声明（论文 `arXiv:2610.14625v1` §3.6 的维度失配本地化）的离线判据。
 *
 * 判据核心：**使能型改动不改变即时读数**（改日志、修判据一类），若用即时分数验收就会被判「无收益」而丢弃，
 * 从而失去它支撑的后续修复（论文的例子：改日志让下一轮能看出日期格式问题，但该改动本身不加分）。
 * ⇒ 本引擎给它一条独立路径：**不进 active、不靠证据、靠依赖路径兑现**；未兑现是事后可算的。
 *
 * 每条判据都配尸体样本（证明它有区分力，不是恒为真的装饰）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { addHypothesis, fulfillHypothesis } from '../lib/hypotheses.js'
import { advanceQueue, countHypotheses, promisesOf, stalenessOf, starvationOf } from '../lib/status.js'

const fresh = () => ({ hypotheses: [] })

/** 登记一条使能型声明 */
const addEnabling = (state, deps = ['skill:demo 生效'], now = new Date('2026-10-15T00:00:00Z')) =>
  addHypothesis(state, {
    statement: '加了这行诊断日志，后续才看得出参数缺失',
    prediction: '（使能型声明）',
    kind: 'enabling',
    threshold: 0,
    enabling: { deps },
  }, now).hypothesis

test('登记使能型声明 ⇒ status=pending，且**不进 active**（探针因此天然不采它）', () => {
  const state = fresh()
  const h = addEnabling(state)
  assert.equal(h.status, 'pending')
  assert.deepEqual(h.enabling.deps, ['skill:demo 生效'])
  assert.equal(h.enabling.fulfilledAt, undefined)
  // 关键：不进 active ⇒ 采证链读数不受影响
  const stale = stalenessOf(state.hypotheses, new Date('2026-10-15T12:00:00Z'))
  assert.equal(stale.collecting, 0, '使能型声明不得计入「在采证」')
  assert.equal(advanceQueue(state.hypotheses).length, 0, '不得进入推进队列（它没有可采的证据）')
})

test('尸体：空 deps ⇒ 拒登记（空 deps 会让声明变成永真，没有可证伪判据）', () => {
  const state = fresh()
  assert.throws(() => addEnabling(state, []), /必须指认依赖路径/)
  assert.throws(() => addEnabling(state, ['   ']), /必须指认依赖路径/)
  assert.equal(state.hypotheses.length, 0, '拒登记不得留下半条记录')
})

test('尸体：使能型声明**不污染信号面**（否则「零证据」会恒报饥饿）', () => {
  const state = fresh()
  addEnabling(state)
  const starve = starvationOf(state.hypotheses, new Date('2026-10-15T12:00:00Z'))
  assert.equal(starve.zeroEvidence, 0, '使能型声明天然零证据，但不得计入饥饿')
  assert.equal(starve.rows.length, 0)
})

test('兑现：pending → confirmed，记兑现时刻与指针', () => {
  const state = fresh()
  const h = addEnabling(state)
  const done = fulfillHypothesis(state, { id: h.id, refs: ['AGENTS.md:12'], note: '后续那轮确实用上了' }, new Date('2026-10-16T00:00:00Z'))
  assert.equal(done.status, 'confirmed')
  assert.equal(done.enabling.fulfilledAt, '2026-10-16T00:00:00.000Z')
  assert.deepEqual(done.enabling.fulfilledRefs, ['AGENTS.md:12'])
  assert.deepEqual(done.enabling.deps, ['skill:demo 生效'], '兑现不得丢掉 deps')
})

test('尸体：非使能型 / 非 pending / 不存在 ⇒ 兑现抛错（两条路不混，重复兑现响亮失败）', () => {
  const state = fresh()
  const plain = addHypothesis(state, { statement: 's', prediction: 'p', kind: 'read-repeat', threshold: 3 }).hypothesis
  assert.throws(() => fulfillHypothesis(state, { id: plain.id }), /不是使能型声明/)
  const en = addEnabling(state)
  fulfillHypothesis(state, { id: en.id })
  assert.throws(() => fulfillHypothesis(state, { id: en.id }), /只有 pending/)
  assert.throws(() => fulfillHypothesis(state, { id: 'h-nope' }), /假设不存在/)
})

test('承诺面：只列 pending，按年龄降序；兑现后即消失（兑现前后对照）', () => {
  const state = fresh()
  const oldOne = addEnabling(state, ['旧承诺'], new Date('2026-10-01T00:00:00Z'))
  const newOne = addEnabling(state, ['新承诺'], new Date('2026-10-15T00:00:00Z'))
  const now = new Date('2026-10-16T00:00:00Z')

  const before = promisesOf(state.hypotheses, now)
  assert.equal(before.length, 2)
  assert.equal(before[0].id, oldOne.id, '最老在前')
  assert.equal(before[0].ageDays, 15)
  assert.deepEqual(before[0].deps, ['旧承诺'], '承诺面要能看出它在等什么，而不是只有 id')

  fulfillHypothesis(state, { id: oldOne.id })
  const after = promisesOf(state.hypotheses, now)
  assert.equal(after.length, 1, '兑现后必须离开承诺面（否则它就是恒亮的装饰）')
  assert.equal(after[0].id, newOne.id)
})

test('假活防护：兑现后的 confirmed **不计入「最后布线」**（它是承诺，不是规则布线）', () => {
  const state = fresh()
  const en = addEnabling(state)
  fulfillHypothesis(state, { id: en.id }, new Date('2026-10-16T00:00:00Z'))
  const stale = stalenessOf(state.hypotheses, new Date('2026-10-20T00:00:00Z'))
  assert.equal(stale.lastWiredAt, null, '使能型声明的兑现不得让「最后布线」看起来变新')
  assert.equal(stale.daysSinceWired, null)
})

test('计数：pending 独立一档，不并入 active（并入会掩盖「采证链停」）', () => {
  const state = fresh()
  addEnabling(state)
  const c = countHypotheses(state.hypotheses)
  assert.equal(c.pending, 1)
  assert.equal(c.active, 0)
  assert.equal(c.hypotheses, 1)
})
