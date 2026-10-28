/**
 * probe-domain 离线单测（2026-10-28 · 探针域声明）
 *
 * 纪律：尸体测试——**坏样本必测触发，好样本必测不触发**。
 * 坏样本取真实事故：h-mvpruyw0-1 的陈述讲「报数时点」，挂在 probe-before-action
 * （观测「写类动作前的读数」）上 ⇒ 域错配 ⇒ 必须提示。
 * 好样本取同探针的匹配用法：「实施类改动动手前先做一次探测」⇒ 必须**不**提示，
 * 否则提示本身会变成噪音（每次登记都念一遍 = 没人再看）。
 *
 * 运行：先 npm run build，再 node --test tests/probe-domain.test.mjs
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PROBE_DOMAINS, domainOf, domainLine, domainHints } from '../lib/probe-domain.js'

/** 与 hypotheses.ts 的 kind 联合保持一致的硬编码清单（穷尽性检查用） */
const ALL_KINDS = ['tool-failure-rate', 'read-repeat', 'plan-before-action', 'probe-before-action', 'claim-vs-evidence', 'enabling']

describe('PROBE_DOMAINS · 声明完整性', () => {
  test('六种 kind 全部有域声明（穷尽）', () => {
    for (const k of ALL_KINDS) {
      assert.ok(PROBE_DOMAINS[k] !== undefined, `缺域声明：${k}`)
      assert.ok(PROBE_DOMAINS[k].observes.length > 0, `${k} 的 observes 为空`)
    }
    assert.equal(Object.keys(PROBE_DOMAINS).length, ALL_KINDS.length)
  })

  test('每种探针都必须声明「它答不了什么」——否则域声明退化成域自夸', () => {
    for (const k of ALL_KINDS) {
      assert.ok(Array.isArray(PROBE_DOMAINS[k].notFor), `${k}.notFor 不是数组`)
      assert.ok(PROBE_DOMAINS[k].notFor.length > 0, `${k} 没有声明 notFor`)
    }
  })

  test('enabling 明确声明自己不采证据', () => {
    assert.match(PROBE_DOMAINS.enabling.observes, /不采证据|依赖路径/)
    assert.deepEqual(PROBE_DOMAINS.enabling.mismatchMarkers, [])
  })
})

describe('domainOf / domainLine', () => {
  test('已知 kind 返回声明', () => {
    const d = domainOf('probe-before-action')
    assert.ok(d !== undefined)
    assert.match(d.observes, /写类动作/)
  })

  test('未知 kind 返回 undefined（不抛错、不假装有）', () => {
    assert.equal(domainOf('不存在的探针'), undefined)
  })

  test('domainLine 未知 kind 如实说「未声明」而不是空', () => {
    assert.match(domainLine('不存在的探针'), /未声明/)
    assert.match(domainLine('read-repeat'), /^域：/)
  })
})

describe('domainHints · 尸体测试（坏样本必触发）', () => {
  test('h-mvpruyw0-1 的真实陈述 + probe-before-action ⇒ 必须提示', () => {
    const statement = '我在报告或判读里写下任何聚合计数（「N 篇」「N 条」「N 处」「N 个文件」）之前，本轮已经有一次能产出该计数的现读输出。'
    const hints = domainHints('probe-before-action', statement)
    assert.ok(hints.length > 0, '域错配的真实事故样本未触发提示 ⇒ 防线是哑的')
    assert.match(hints.join('\n'), /mixed/)
    assert.match(hints.join('\n'), /域错配/)
  })

  test('todo 型陈述挂 probe-before-action ⇒ 提示（todo 属 plan-before-action）', () => {
    const hints = domainHints('probe-before-action', '实施类任务开始前我会先落 todo_write 台账')
    assert.ok(hints.length > 0)
  })

  test('claim-vs-evidence 被挂到降级归因上 ⇒ 提示', () => {
    const hints = domainHints('claim-vs-evidence', '产出浓度异常时先做换模型对照以定位降级归因')
    assert.ok(hints.length > 0)
  })
})

describe('domainHints · 好样本必不触发（防噪音）', () => {
  test('匹配用法的陈述 ⇒ 零提示', () => {
    assert.deepEqual(domainHints('probe-before-action', '实施类改动动手前我会先做一次最小证伪探测'), [])
  })

  test('read-repeat 的正常陈述 ⇒ 零提示', () => {
    assert.deepEqual(domainHints('read-repeat', '我倾向于在十分钟内重复读取同一文件'), [])
  })

  test('plain 陈述（不含任何 marker）⇒ 零提示', () => {
    assert.deepEqual(domainHints('tool-failure-rate', 'pwsh 在近期调用中是可靠的'), [])
  })

  test('enabling 永远零提示', () => {
    assert.deepEqual(domainHints('enabling', '这条改动是后续诊断的前提'), [])
  })

  test('未知 kind 零提示（不抛错）', () => {
    assert.deepEqual(domainHints('不存在的探针', '任意陈述'), [])
  })
})
