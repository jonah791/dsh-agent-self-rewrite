/**
 * sink-routing.test.mjs — 落点路由（P1）的判据。
 *
 * 修的是什么：`candidate-prompt` 有版本链、有锚点、有评测轮（三环齐），却**没有布线环**——
 * `editResource` 对它返回 `needsDiskWrite: false` ⇒ 编辑只在账本里产生版本，
 * 盘上 `CANDIDATE_PROMPT.md` **永不同步**。这不是「功能少一环」，是**账本与盘上静默漂移**：
 * 账本说 v0.1 已提交，盘上还是 v0.0 的文本。
 *
 * 判据与尸体（每条判据都配一个「旧行为会让它红」的对照）：
 * ① 落点表给 `candidate-prompt` 一条 `file` 落点（无上限）；**尸体**：`composition` 没有落点
 * ② `editResource` 的落点带**本次编辑的文本**；**尸体**：旧版返回的是 `agent-rules` 的文本
 * ③ `applySink` **真的改了盘上文件**；**尸体**：超预算的 block 落点**一字不写**
 * ④ 回滚**遍历全部落点**；**尸体**：旧版的单个 boolean 表达不了「写哪个」
 * ⑤ `artifactsOf` 遍历落点表产读数；**尸体**：旧版只报一条
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildBlock, extractBlockInner, findBlock } from '../lib/wiring.js'
import {
  CANDIDATE_PROMPT_FILE,
  SINK_RESOURCE_IDS,
  commitOrRollback,
  editResource,
  sinkOf,
} from '../lib/rounds.js'
import { applySink, artifactsOf } from '../lib/index.js'
import { EvolveStore } from '../lib/ledger-store.js'

const env = (rulesPath, modeltestDir) => ({ rulesPath, modeltestDir, maxBytes: 64800 })

/** 落点测试夹具：临时目录 + 一个真实的 EvolveStore（不碰生产资产） */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'selfrewrite-sink-'))
  const modeltestDir = join(root, 'modeltest')
  mkdirSync(modeltestDir, { recursive: true })
  return {
    root,
    modeltestDir,
    rulesPath: join(root, 'AGENTS.md'),
    store: new EvolveStore(join(root, 'evolve'), modeltestDir, '', ''),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// ── ① 落点表 ────────────────────────────────────────────────────────────────

test('落点表：agent-rules → block（标记段 evolve + 预算）；candidate-prompt → file（无上限）', () => {
  const e = env('E:/ws/AGENTS.md', 'E:/mt')

  const rules = sinkOf(e, 'agent-rules', '- 规则')
  assert.equal(rules.mode, 'block')
  assert.equal(rules.path, 'E:/ws/AGENTS.md')
  assert.equal(rules.blockId, 'evolve')
  assert.equal(rules.maxBytes, 64800)
  assert.equal(rules.content, '- 规则')

  const cp = sinkOf(e, 'candidate-prompt', '任务说明书正文')
  assert.equal(cp.mode, 'file')
  assert.equal(cp.path, join('E:/mt', CANDIDATE_PROMPT_FILE))
  assert.equal(cp.maxBytes, null, '无上限是 null，不是 0——0 是「上限为零字节」')
  assert.equal(cp.content, '任务说明书正文')
})

test('尸体：composition **没有落点**（「已声明未实现」——给它落点会造出第二个写者）', () => {
  assert.equal(sinkOf(env('E:/ws/AGENTS.md', 'E:/mt'), 'composition', 'x'), null)
  assert.ok(!SINK_RESOURCE_IDS.includes('composition'), 'composition 不得出现在「会写盘」的资源表里')
})

// ── ② editResource 的落点内容 ───────────────────────────────────────────────

test('editResource(candidate-prompt)：落点带**本次编辑的文本**（旧版返回的是 agent-rules 的文本）', () => {
  const f = fixture()
  try {
    const r = editResource(f.store, env(f.rulesPath, f.modeltestDir), 'candidate-prompt', '新版任务说明书', 'P1 判据')
    assert.ok(r.sink !== null, 'candidate-prompt 必须有落点——否则编辑只在账本里产生版本')
    assert.equal(r.sink.id, 'candidate-prompt')
    assert.equal(r.sink.mode, 'file')
    assert.equal(r.sink.content, '新版任务说明书', '落点内容必须是本次编辑的文本，不是另一个资源的内容')
  } finally {
    f.cleanup()
  }
})

test('尸体：编辑 candidate-prompt 后，**盘上文件真的变了**（端到端——不是只看返回值）', () => {
  const f = fixture()
  try {
    const target = join(f.modeltestDir, CANDIDATE_PROMPT_FILE)
    writeFileSync(target, '旧的任务说明书', 'utf8')

    const r = editResource(f.store, env(f.rulesPath, f.modeltestDir), 'candidate-prompt', '新的任务说明书', 'e2e')
    applySink(r.sink, join(f.root, 'bak'))

    assert.equal(readFileSync(target, 'utf8'), '新的任务说明书')
  } finally {
    f.cleanup()
  }
})

// ── ③ applySink 的真写盘与拒绝 ──────────────────────────────────────────────

test('applySink(block)：段内替换，段外一字不动（回归——新分派不许改变原有行为）', () => {
  const f = fixture()
  try {
    const target = join(f.root, 'AGENTS.md')
    writeFileSync(target, ['# 头', '', '块外哨兵', '', buildBlock('- 旧规则', findBlock('evolve')), ''].join('\n'), 'utf8')

    const msg = applySink(
      { id: 'agent-rules', path: target, mode: 'block', blockId: 'evolve', maxBytes: 1_000_000, content: '- 新规则' },
      join(f.root, 'bak'),
    )
    const after = readFileSync(target, 'utf8')
    assert.ok(after.includes('块外哨兵'), '段外内容不得被动')
    assert.equal(extractBlockInner(after, findBlock('evolve')), '- 新规则')
    assert.ok(msg.includes('已替换块内容'))
  } finally {
    f.cleanup()
  }
})

test('尸体：applySink(block) 超预算 ⇒ **一字不写**（盘上文件逐字保持原样）', () => {
  const f = fixture()
  try {
    const target = join(f.root, 'AGENTS.md')
    const original = ['# 头', '', buildBlock('- 旧规则', findBlock('evolve')), ''].join('\n')
    writeFileSync(target, original, 'utf8')

    const msg = applySink(
      { id: 'agent-rules', path: target, mode: 'block', blockId: 'evolve', maxBytes: 10, content: 'x'.repeat(500) },
      join(f.root, 'bak'),
    )
    assert.equal(readFileSync(target, 'utf8'), original, '超预算的写必须留下**逐字相同**的文件')
    assert.ok(msg.includes('未写入'), '拒绝必须当场可见（不许静默通过）')
  } finally {
    f.cleanup()
  }
})

test('尸体：applySink(file) 对**不存在**的目标 ⇒ 新建（不是报错、也不是静默跳过）', () => {
  const f = fixture()
  try {
    const target = join(f.root, 'nope', 'CANDIDATE_PROMPT.md')
    mkdirSync(join(f.root, 'nope'), { recursive: true })
    const msg = applySink({ id: 'candidate-prompt', path: target, mode: 'file', maxBytes: null, content: '首次写入' }, join(f.root, 'bak'))
    assert.equal(readFileSync(target, 'utf8'), '首次写入')
    assert.ok(msg.includes('已整文件写入'))
  } finally {
    f.cleanup()
  }
})

// ── ④ 回滚遍历全部落点 ──────────────────────────────────────────────────────

test('回滚**遍历全部落点**：两条资源的浮动版本各自回锚点，各返回一个落点', () => {
  const f = fixture()
  try {
    const e = env(f.rulesPath, f.modeltestDir)
    const l = f.store.ensureLedger()
    f.store.addVersion(l, 'agent-rules', '规则 v0.0', '基线')
    f.store.addVersion(l, 'candidate-prompt', '说明书 v0.0', '基线')
    l.resources['agent-rules'].anchors.push('v0.0')
    l.resources['candidate-prompt'].anchors.push('v0.0')
    f.store.writeLedger(l)

    editResource(f.store, e, 'agent-rules', '规则 v0.1（浮动）', 'x')
    editResource(f.store, e, 'candidate-prompt', '说明书 v0.1（浮动）', 'x')

    const r = commitOrRollback(f.store, e, true, '回滚')
    assert.equal(r.action, 'rollback')
    assert.equal(r.sinks.length, 2, '两条资源都要落盘——旧版只有一个 boolean，回滚 candidate-prompt 时无从落盘')
    assert.deepEqual(r.sinks.map((s) => s.id).sort(), ['agent-rules', 'candidate-prompt'])
    assert.equal(r.anchor, 'v0.0')
  } finally {
    f.cleanup()
  }
})

test('尸体：无浮动版本 ⇒ 回滚返回**零个落点**（不是「一个 boolean 为 false」）', () => {
  const f = fixture()
  try {
    const e = env(f.rulesPath, f.modeltestDir)
    const l = f.store.ensureLedger()
    f.store.addVersion(l, 'agent-rules', '规则 v0.0', '基线')
    l.resources['agent-rules'].anchors.push('v0.0')
    f.store.writeLedger(l)

    const r = commitOrRollback(f.store, e, true, '空回滚')
    assert.equal(r.sinks.length, 0)
    assert.equal(r.rollbackFrom, undefined, '无可回滚的浮动版本 ⇒ 不报 rollbackFrom')
  } finally {
    f.cleanup()
  }
})

// ── ⑤ 读数遍历落点表 ────────────────────────────────────────────────────────

test('artifactsOf：遍历落点表产出**每条**读数（含 maxBytes=null 的那条）', () => {
  const f = fixture()
  try {
    writeFileSync(f.rulesPath, 'abc', 'utf8')
    const rows = artifactsOf(env(f.rulesPath, f.modeltestDir))

    assert.equal(rows.length, 2, '落点表里几个资源就报几条——少一条就是静默不可见')
    assert.equal(rows[0].id, 'agent-rules')
    assert.equal(rows[0].bytes, 3)
    assert.equal(rows[0].maxBytes, 64800)

    assert.equal(rows[1].id, 'candidate-prompt')
    assert.equal(rows[1].bytes, null, '文件不存在 ⇒ null（不是 0）')
    assert.equal(rows[1].maxBytes, null, '无上限 ⇒ null（不是 0）')
    assert.equal(rows[1].path, join(f.modeltestDir, CANDIDATE_PROMPT_FILE))
  } finally {
    f.cleanup()
  }
})
