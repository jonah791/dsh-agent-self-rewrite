/**
 * recycle-e2e.mjs — 回收机制的端到端验证（判据①②③ 的**真文件字节账**版）。
 *
 * 用真实 AGENTS.md 的**副本**（逐字节拷贝）+ 真实 maxBytes，模拟 index.ts 的落盘顺序
 * （先归档、后写段），跑完断言三件事：
 * ① 撞线自动迁最旧条，迁出的逐字可在归档层找到、段内不再有；
 * ② 余量回到安全区（≥ 1,000 B）；
 * ③ 真文件一字未动（脚本只碰副本）。
 */

import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  applyRuleUpsertWithRecycle,
  byteLength,
  extractBlockInner,
  findBlock,
  RECYCLE_POINTER_PREFIX,
  splitEntries,
} from '../lib/wiring.js'

// ⚠ 这两个常量必须与 web profile 的插件配置一致（maxBytes 缺省 64800 / rulesFile 缺省 AGENTS.md）。
// 它们是**锚点**不是真源——配置一改，本脚本的字节账就不再代表线上（改配置时同步改这里）。
const REAL = 'E:/alice/AGENTS.md'
const MAX_BYTES = 64800
const WORK = join(tmpdir(), 'dsh-recycle-e2e')

const realBefore = readFileSync(REAL)

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
const copy = join(WORK, 'AGENTS.md')
copyFileSync(REAL, copy)

const full0 = readFileSync(copy, 'utf8')
const block = findBlock('self-test')
const inner0 = extractBlockInner(full0, block) ?? ''
const headroom0 = MAX_BYTES - byteLength(full0)

console.log('=== 起点（真实字节账） ===')
console.log(`AGENTS.md ${byteLength(full0)} B / 上限 ${MAX_BYTES} ⇒ 余量 ${headroom0} B`)
console.log(`self-test 段 ${byteLength(inner0)} B / ${splitEntries(inner0).length} 条（中位 ${(() => {
  const s = splitEntries(inner0).map((l) => byteLength(l)).sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
})()} B）`)

// 一条**足够长**的验证规则（只为驱动机制；写在副本里，永不入真文件）
const draft = '**端到端验证用规则（离线副本专用）**：' + '验证回收路径是否按最旧一端迁出并留下指针。'.repeat(45)
console.log(`\n拟写入 ${byteLength(draft)} B ⇒ 不回收将超 ${byteLength(draft) - headroom0} B`)

const archive = join(WORK, 'docs', 'agents-md-archive.md')
const pointerFor = (n) => `${RECYCLE_POINTER_PREFIX} 已回收 ${n} 条至 docs/agents-md-archive.md（2026-10-08）`

const r = applyRuleUpsertWithRecycle(full0, { blockId: 'self-test', draft, maxBytes: MAX_BYTES, pointerFor })

console.log('\n=== 引擎结果 ===')
console.log(`ok=${r.outcome.ok} action=${r.outcome.ok ? r.outcome.action : '—'} stopped=${r.stopped} 迁走 ${r.recycled.length} 条`)
if (r.outcome.ok) console.log(`余量 ${headroom0} → ${r.outcome.headroom} B`)

if (!r.outcome.ok) {
  console.log('✗ 未放行 —— 端到端失败')
  process.exit(1)
}

// 按 index.ts 的顺序落盘：**先归档、后写段**
mkdirSync(dirname(archive), { recursive: true })
appendFileSync(
  archive,
  '# AGENTS.md 受管段 · 回收归档\n\n' + r.recycled.map((e) => `- [2026-10-08 · self-test] ${e}`).join('\n') + '\n',
  'utf8',
)
writeFileSync(copy, r.outcome.content, 'utf8')

// ---------- 判据 ----------
const full1 = readFileSync(copy, 'utf8')
const inner1 = extractBlockInner(full1, block) ?? ''
const ents1 = splitEntries(inner1)
const archText = readFileSync(archive, 'utf8')

console.log('\n=== 判据 ===')

let lost = 0
let lingering = 0
for (const e of r.recycled) {
  if (!archText.includes(e)) {
    lost += 1
    console.log(`  ✗ 归档层缺：${e.slice(0, 34)}…`)
  }
  if (inner1.includes(e)) {
    lingering += 1
    console.log(`  ✗ 段内仍在：${e.slice(0, 34)}…`)
  }
}
const pointerLines = ents1.filter((l) => l.startsWith(RECYCLE_POINTER_PREFIX)).length
const oldEntries = splitEntries(inner0)
const oldestKept = oldEntries.slice(r.recycled.length).every((e) => inner1.includes(e))
const newPresent = inner1.includes(draft.trim())

console.log(`① 迁出 ${r.recycled.length} 条：归档可逐字找回 ${r.recycled.length - lost}/${r.recycled.length} · 段内残留 ${lingering} · 指针 ${pointerLines} 行`)
console.log(`① 迁的是**最旧一端**：${JSON.stringify(r.recycled) === JSON.stringify(oldEntries.slice(0, r.recycled.length))}`)
console.log(`① 未迁的原样保留：${oldestKept} · 新条在段内：${newPresent}`)
console.log(`② 余量 ${r.outcome.headroom} B（判据 ≥ 1000）⇒ ${r.outcome.headroom >= 1000 ? '通过' : '未达'}`)
console.log(`   段内 ${splitEntries(inner0).length} → ${ents1.length} 条 · ${byteLength(inner0)} → ${byteLength(inner1)} B`)
console.log(`   归档层 ${byteLength(archText)} B · ${archText.split('\n').filter((l) => l.startsWith('- [')).length} 条`)
console.log(`   块外内容未动（evolve 段 + 正文头）：${full1.includes('dsh-agent-evolve:start') && full1.includes('# SOUL.md — 爱丽丝之魂')}`)
console.log(`③ 真文件一字未动：${Buffer.compare(realBefore, readFileSync(REAL)) === 0}（${byteLength(full0)} B 副本 vs ${readFileSync(REAL).length} B 正本）`)
