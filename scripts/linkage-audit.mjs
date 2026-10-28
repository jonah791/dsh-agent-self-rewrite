import { readFileSync } from 'node:fs'

const A = 'E:/alice/AGENTS.md'
const R = 'E:/alice/docs/rulebook.md'
const aTxt = readFileSync(A, 'utf8')
const rTxt = readFileSync(R, 'utf8')

// ---- 1. AGENTS.md §5.x 节大小（bytes）----
const aLines = aTxt.split('\n')
const aIdx = []
aLines.forEach((l, i) => { if (/^#{2,4} /.test(l)) aIdx.push(i) })
const aSec = []
for (let k = 0; k < aIdx.length; k++) {
  const s = aIdx[k], e = k + 1 < aIdx.length ? aIdx[k + 1] : aLines.length
  const t = aLines[s]
  const m = t.match(/^#{2,4} (?:§)?(5\.\d+)/)
  aSec.push({ s, e, b: Buffer.byteLength(aLines.slice(s, e).join('\n'), 'utf8'), t, id: m ? m[1] : null })
}

// ---- 2. rulebook 节 + 入链计数 ----
const rLines = rTxt.split('\n')
const rIdx = []
rLines.forEach((l, i) => { if (/^#{2,3} /.test(l)) rIdx.push(i) })
const rSec = []
for (let k = 0; k < rIdx.length; k++) {
  const s = rIdx[k], e = k + 1 < rIdx.length ? rIdx[k + 1] : rLines.length
  const t = rLines[s]
  const m = t.match(/§(5\.\d+)/)
  const id = m ? m[1] : null
  const chars = rLines.slice(s, e).join('\n').length
  let inbound = 0
  if (id) {
    const re = new RegExp('§' + id.replace('.', '\\.'), 'g')
    // count in AGENTS.md (excluding the rulebook pointer line itself is hard; count all)
    inbound = (aTxt.match(re) || []).length
  }
  rSec.push({ s, e, chars, t, id, inbound })
}

console.log('=== AGENTS.md §5.x 正文本（bytes，降序）===')
const a5 = aSec.filter(x => x.id).sort((x, y) => y.b - x.b)
let a5tot = 0
for (const x of a5) a5tot += x.b
console.log(`共 ${a5.length} 节 · 合计 ${a5tot} B\n`)
const SHOWN = parseInt(process.argv[2] || '20', 10)
a5.slice(0, SHOWN).forEach(x => {
  const r = rSec.find(y => y.id === x.id)
  console.log(`  ${String(x.b).padStart(5)}B  行${String(x.s + 1).padStart(4)}  §${x.id.padEnd(6)} rulebook:${r ? String(r.chars).padStart(5) + '字/入链' + r.inbound : '  无'}`)
})

console.log('\n=== rulebook 零入链节（AGENTS.md 里没有任何 §NN 引用）===')
const orphan = rSec.filter(x => x.id && x.inbound === 0).sort((x, y) => y.chars - x.chars)
let otot = 0
for (const x of orphan) { otot += x.chars; console.log(`  ${String(x.chars).padStart(5)}字  行${String(x.s + 1).padStart(4)}  ${x.t.slice(0, 70)}`) }
console.log(`  零入链合计 ${otot} 字 · ${orphan.length} 节`)

console.log('\n=== rulebook 无 §编号 的节（叙述/其它）===')
const nonum = rSec.filter(x => !x.id).sort((x, y) => y.chars - x.chars)
let ntot = 0
for (const x of nonum) { ntot += x.chars; console.log(`  ${String(x.chars).padStart(5)}字  行${String(x.s + 1).padStart(4)}  ${x.t.slice(0, 70)}`) }
console.log(`  合计 ${ntot} 字 · ${nonum.length} 节`)

console.log(`\n=== 总账 ===`)
console.log(`rulebook 总 ${rTxt.length} 字符 / 上限 40000 / 余量 ${40000 - rTxt.length}`)
console.log(`零入链 ${otot} 字 + 无编号 ${ntot} 字 = 候选合计 ${otot + ntot} 字`)
