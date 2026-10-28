import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = 'E:/alice'
const A = join(ROOT, 'AGENTS.md')
const R = join(ROOT, 'docs/rulebook.md')

const aTxt = readFileSync(A, 'utf8')
const rTxt = readFileSync(R, 'utf8')

// ---- 收集工作区内所有 md 文件（限深度/目录，避免 node_modules 等噪音）----
const SKIP = new Set(['node_modules', '.git', 'dist', 'lib', 'build', 'coverage', '.dsh', '_tmp_review', 'vendor', 'sessions'])
const files = []
function walk(dir, depth) {
  if (depth > 3) return
  let ents
  try { ents = readdirSync(dir) } catch { return }
  for (const e of ents) {
    if (SKIP.has(e) || e.startsWith('.')) continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, depth + 1)
    else if (extname(e) === '.md' && st.size < 400000) files.push(p)
  }
}
walk(ROOT, 0)
console.log(`扫描 md 文件 ${files.length} 个\n`)

const corpus = files.map((p) => ({ p, t: (() => { try { return readFileSync(p, 'utf8') } catch { return '' } })() }))

// ---- rulebook 节清单 ----
const rLines = rTxt.split('\n')
const rIdx = []
rLines.forEach((l, i) => { if (/^#{2,3} /.test(l)) rIdx.push(i) })
const rSec = []
for (let k = 0; k < rIdx.length; k++) {
  const s = rIdx[k], e = k + 1 < rIdx.length ? rIdx[k + 1] : rLines.length
  const title = rLines[s].replace(/^#+\s*/, '').trim()
  rSec.push({ s, e, title, chars: rLines.slice(s, e).join('\n').length, raw: rLines[s] })
}

// ---- 入链检测：① §NN  ② 标题本身（去掉 § 与后缀）----
function inboundOf(sec) {
  const hits = []
  const idm = sec.raw.match(/§(5\.\d+)/)
  const id = idm ? idm[1] : null
  // 标题核心词：去掉编号/版本/括注
  const core = sec.title
    .replace(/^§[\d.]+\s*/, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[·・]\s*(完整版|增补).*$/, '')
    .trim()
  for (const { p, t } of corpus) {
    if (p === R) continue          // 不看 rulebook 自己
    let n = 0
    if (id) n += (t.match(new RegExp('§' + id.replace('.', '\\.'), 'g')) || []).length
    if (core && core.length >= 4) {
      const idx = t.indexOf(core)
      if (idx !== -1) n += 1
    }
    if (n > 0) hits.push(`${p.replace(ROOT + '/', '')}×${n}`)
  }
  return { id, core, hits }
}

console.log('=== rulebook 全部节 · 入链分析（§NN + 标题双判据）===')
const rows = rSec.map((s) => ({ ...s, ...inboundOf(s) }))
rows.sort((x, y) => y.chars - x.chars)
for (const r of rows.slice(0, 42)) {
  const tag = r.hits.length === 0 ? '★零入链' : `${r.hits.length}处`
  console.log(`  ${String(r.chars).padStart(5)}字 行${String(r.s + 1).padStart(4)} [${tag.padEnd(6)}] ${r.title.slice(0, 52)}`)
  if (r.core.length >= 4) console.log(`          core="${r.core}"  → ${r.hits.slice(0, 3).join(' · ') || '（无）'}`)
}

const orphan = rows.filter((r) => r.hits.length === 0)
const otot = orphan.reduce((a, r) => a + r.chars, 0)
console.log(`\n=== 真·零入链 ${orphan.length} 节 · 合计 ${otot} 字 ===`)
orphan.forEach((r) => console.log(`  ${String(r.chars).padStart(5)}字 行${String(r.s + 1).padStart(4)}  ${r.title.slice(0, 66)}`))
console.log(`\nrulebook 总 ${rTxt.length} 字符 / 余量 ${40000 - rTxt.length}`)
