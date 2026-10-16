/**
 * 外生接受位 · IO 层测试。
 *
 * 夹具纪律：**全部落在 os.tmpdir() 的临时目录**，绝不触碰生产资产
 * （`.dsh/acceptance-sealed/` 是真实冻结账所在，测试碰它 = 污染判据）。
 *
 * 本层的风险面是「会执行脚本」⇒ 路径校验必须有**尸体样本**证明它会拦。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { loadSealedAccount, runScript, runGate, SEALED_ROOT, INJECTOR_SUBDIR } from '../lib/gate-io.js'
import { hashRuleDraft } from '../lib/gate.js'

const DRAFT = '**规则草稿**'
const HASH = hashRuleDraft(DRAFT)

/** 建一个隔离的假 home（含 injectors 目录），返回 { home, inj, cleanup } */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'gate-io-'))
  const inj = join(home, SEALED_ROOT, INJECTOR_SUBDIR)
  mkdirSync(inj, { recursive: true })
  return { home, inj, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/** 写一个 node 脚本，退出指定码 */
function writeScript(dir, name, exitCode) {
  const p = join(dir, name)
  writeFileSync(p, `process.exit(${exitCode})\n`, 'utf8')
  return p
}

// ── loadSealedAccount ──────────────────────────────────────────────────
test('loadSealedAccount：不存在 ⇒ null（与「读坏了」是两件事）', () => {
  const { home, cleanup } = makeHome()
  try {
    assert.equal(loadSealedAccount(home, 'no-such-rule'), null)
  } finally {
    cleanup()
  }
})

test('★ loadSealedAccount：读坏了 ⇒ **抛**（不吞——读坏了不许静默成「没账」）', () => {
  const { home, cleanup } = makeHome()
  try {
    writeFileSync(join(home, SEALED_ROOT, 'bad.json'), '{ not json', 'utf8')
    assert.throws(() => loadSealedAccount(home, 'bad'))
  } finally {
    cleanup()
  }
})

// ── runScript：路径边界（★ 尸体）────────────────────────────────────────
test('★ 尸体①：路径越界（../..）⇒ null，脚本不执行', () => {
  const { home, inj, cleanup } = makeHome()
  try {
    const outside = writeScript(join(inj, '..', '..'), 'evil.mjs', 0) // 落在 home 下、injectors 外
    assert.equal(runScript(outside, home), null, '路径校验必须拦下 injectors 目录之外的脚本')
  } finally {
    cleanup()
  }
})

test('★ 尸体②：同前缀逃逸（injectors-evil）⇒ null', () => {
  const { home, cleanup } = makeHome()
  try {
    const evilDir = join(home, SEALED_ROOT, INJECTOR_SUBDIR + '-evil')
    mkdirSync(evilDir, { recursive: true })
    const evil = writeScript(evilDir, 'x.mjs', 0)
    assert.equal(runScript(evil, home), null, '前缀比对必须带分隔符，否则 injectors-evil 会漏过')
  } finally {
    cleanup()
  }
})

test('runScript：脚本不存在 ⇒ null（fail-closed，不许当成退出 0）', () => {
  const { home, inj, cleanup } = makeHome()
  try {
    assert.equal(runScript(join(inj, 'missing.mjs'), home), null)
  } finally {
    cleanup()
  }
})

test('runScript：正常脚本 ⇒ 返回真实退出码（0 与 3 都要对）', () => {
  const { home, inj, cleanup } = makeHome()
  try {
    assert.equal(runScript(writeScript(inj, 'ok.mjs', 0), home), 0)
    assert.equal(runScript(writeScript(inj, 'red.mjs', 3), home), 3, '非零退出码必须原样带出（注入样本靠它判红）')
  } finally {
    cleanup()
  }
})

// ── runGate：端到端 ─────────────────────────────────────────────────────
test('runGate：无账 ⇒ reject（stage=no-account）', () => {
  const { home, cleanup } = makeHome()
  try {
    const d = runGate(home, 'h-none', DRAFT)
    assert.equal(d.accepted, false)
    assert.equal(d.stage, 'no-account')
  } finally {
    cleanup()
  }
})

test('★ runGate：账读坏 ⇒ reject 且 reason 说清是「不可读」（不是「没账」）', () => {
  const { home, cleanup } = makeHome()
  try {
    writeFileSync(join(home, SEALED_ROOT, 'h-bad.json'), 'broken', 'utf8')
    const d = runGate(home, 'h-bad', DRAFT)
    assert.equal(d.accepted, false)
    assert.ok(d.reason.includes('不可读'), '读坏了与没账必须分型（否则「账没了」与「账坏了」同貌）')
  } finally {
    cleanup()
  }
})

test('★ runGate：完整流程（注入样本红 + 良性对照绿）⇒ accept', () => {
  const { home, inj, cleanup } = makeHome()
  try {
    const red = writeScript(inj, 'inject.mjs', 1)
    const green = writeScript(inj, 'benign.mjs', 0)
    writeFileSync(
      join(home, SEALED_ROOT, 'h-ok.json'),
      JSON.stringify({
        ruleId: 'h-ok',
        sealedAt: '2026-10-17T01:00:00+08:00',
        ruleDraftHash: HASH,
        kind: 'executable',
        injector: { script: red },
        benign: { script: green },
      }),
      'utf8',
    )
    const d = runGate(home, 'h-ok', DRAFT)
    assert.equal(d.accepted, true, `应通过，实得 ${d.stage}: ${d.reason}`)
    assert.equal(d.stage, 'passed')
  } finally {
    cleanup()
  }
})

test('★ runGate：良性对照也红 ⇒ reject（判据过宽）——证明闸门两侧都在工作', () => {
  const { home, inj, cleanup } = makeHome()
  try {
    const red = writeScript(inj, 'inject2.mjs', 1)
    const alsoRed = writeScript(inj, 'benign2.mjs', 1)
    writeFileSync(
      join(home, SEALED_ROOT, 'h-wide.json'),
      JSON.stringify({
        ruleId: 'h-wide',
        sealedAt: '2026-10-17T01:00:00+08:00',
        ruleDraftHash: HASH,
        kind: 'executable',
        injector: { script: red },
        benign: { script: alsoRed },
      }),
      'utf8',
    )
    const d = runGate(home, 'h-wide', DRAFT)
    assert.equal(d.accepted, false)
    assert.equal(d.stage, 'benign-nonzero')
  } finally {
    cleanup()
  }
})
