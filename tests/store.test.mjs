/**
 * store.test.mjs — 兼容读取层的离线测试（夹具全部在临时目录，**不触碰生产资产**）。
 *
 * 尸体用例（已知坏样本）证明「缺失 / 损坏 / 形状不符」三态真能被区分——
 * 恒为空的输出不是证据（§5.9 规则 2）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isLedger,
  isSelfTestState,
  listRuns,
  loadLedger,
  loadSelfTestState,
  readJsonStrict,
  resolveLegacyPaths,
  writeJsonAtomic,
} from '../lib/store.js'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'selfrewrite-'))
  return { root, paths: resolveLegacyPaths(root) }
}

test('resolveLegacyPaths：缺省落点与旧两件源码一致', () => {
  const p = resolveLegacyPaths('D:/home')
  assert.equal(p.selfTestFile, join('D:/home', 'agent-self-test', 'self-test.json'))
  assert.equal(p.selfTestBackupsDir, join('D:/home', 'agent-self-test', 'backups'))
  assert.equal(p.ledgerFile, join('D:/home', '.evolve', 'ledger.json'))
  assert.equal(p.runsDir, join('D:/home', '.evolve', 'runs'))
  assert.equal(p.orphansFile, join('D:/home', '.evolve', 'orphans.jsonl'))
})

test('resolveLegacyPaths：给了 dataDir 则覆盖（旧两件都是可选/带默认的配置）', () => {
  const p = resolveLegacyPaths('D:/home', { selfTestDataDir: 'X:/a', evolveDataDir: 'X:/b' })
  assert.equal(p.selfTestFile, join('X:/a', 'self-test.json'))
  assert.equal(p.ledgerFile, join('X:/b', 'ledger.json'))
})

test('尸体：文件不存在 ⇒ missing（不是 corrupt，也不是空值）', () => {
  const { root, paths } = sandbox()
  try {
    const r = loadSelfTestState(paths)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('尸体：截断的 JSON ⇒ corrupt，且与 missing 可区分', () => {
  const { root, paths } = sandbox()
  try {
    mkdirSync(paths.selfTestDir, { recursive: true })
    writeFileSync(paths.selfTestFile, '{"hypotheses": [ {"id": "h-1"', 'utf8')
    const r = loadSelfTestState(paths)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'corrupt')
    assert.notEqual(r.reason, 'missing')
    assert.ok(r.detail.includes('JSON 解析失败'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('尸体：JSON 合法但形状不符（缺 hypotheses）⇒ corrupt，不猜测', () => {
  const { root, paths } = sandbox()
  try {
    mkdirSync(paths.selfTestDir, { recursive: true })
    writeFileSync(paths.selfTestFile, JSON.stringify({ hypothesis: [] }), 'utf8')
    const r = loadSelfTestState(paths)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'corrupt')
    assert.ok(r.detail.includes('形状不符'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('形状守卫：数组 / null / 字符串一律不通过（外部 JSON 不当已知类型用）', () => {
  assert.equal(isSelfTestState([]), false)
  assert.equal(isSelfTestState(null), false)
  assert.equal(isSelfTestState('x'), false)
  assert.equal(isSelfTestState({ hypotheses: [] }), true)
  assert.equal(isSelfTestState({ hypotheses: {} }), false)
  assert.equal(isLedger({ resources: {} }), true)
  assert.equal(isLedger({ resources: [] }), false)
})

test('loadSelfTestState：形状正确 ⇒ ok，且逐条读出（用真实语料的最小切片）', () => {
  const { root, paths } = sandbox()
  try {
    mkdirSync(paths.selfTestDir, { recursive: true })
    const state = {
      hypotheses: [
        {
          id: 'h-1',
          statement: '我倾向于重复读同一文件',
          prediction: '窗口内 ≥2 次会记证据',
          probe: { kind: 'read-repeat', windowMs: 600000, repeatCount: 2 },
          threshold: 3,
          status: 'confirmed',
          evidence: [{ ts: '2026-08-30T06:25:58.378Z', kind: 'read-repeat', detail: { readsInWindow: 2 } }],
        },
      ],
    }
    writeFileSync(paths.selfTestFile, JSON.stringify(state), 'utf8')
    const r = loadSelfTestState(paths)
    assert.equal(r.ok, true)
    assert.equal(r.value.hypotheses.length, 1)
    assert.equal(r.value.hypotheses[0].status, 'confirmed')
    assert.equal(r.value.hypotheses[0].probe.kind, 'read-repeat')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('尸体：账本不存在 ⇒ missing，**不伪造空账本**（未初始化 ≠ 已初始化但为空）', () => {
  const { root, paths } = sandbox()
  try {
    const r = loadLedger(paths)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listRuns：目录不存在 ⇒ 空表（不是错误）；存在则只取 .json 并剥扩展名', () => {
  const { root, paths } = sandbox()
  try {
    assert.deepEqual(listRuns(paths), [])
    mkdirSync(paths.runsDir, { recursive: true })
    writeFileSync(join(paths.runsDir, 'run-a.json'), '{}', 'utf8')
    writeFileSync(join(paths.runsDir, 'run-b.json'), '{}', 'utf8')
    writeFileSync(join(paths.runsDir, 'notes.txt'), 'x', 'utf8')
    assert.deepEqual([...listRuns(paths)].sort(), ['run-a', 'run-b'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('writeJsonAtomic：写入后可读回，且**不留下临时文件**', () => {
  const { root, paths } = sandbox()
  try {
    writeJsonAtomic(paths.ledgerFile, { resources: { 'agent-rules': { id: 'agent-rules', versions: [], anchors: [] } } })
    const r = loadLedger(paths)
    assert.equal(r.ok, true)
    assert.ok('agent-rules' in r.value.resources)
    const leftovers = readdirSync(paths.evolveDir).filter((n) => n.includes('.tmp-'))
    assert.deepEqual(leftovers, [], '临时文件未被清理')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readJsonStrict：可读文件返回 ok 并给出解析后的值', () => {
  const { root, paths } = sandbox()
  try {
    mkdirSync(paths.evolveDir, { recursive: true })
    writeFileSync(paths.orphansFile, 'x', 'utf8')
    writeJsonAtomic(join(paths.evolveDir, 'probe.json'), { a: 1 })
    const r = readJsonStrict(join(paths.evolveDir, 'probe.json'))
    assert.equal(r.ok, true)
    assert.deepEqual(r.value, { a: 1 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
