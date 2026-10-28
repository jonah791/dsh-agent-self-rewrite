import { readFileSync } from 'node:fs'

const P = process.argv[2] || 'E:/alice/AGENTS.md'
const lines = readFileSync(P, 'utf8').split('\n')
const bytesOf = (a, b) => Buffer.byteLength(lines.slice(a, b).join('\n'), 'utf8')

// index all headings at ## / ### level
const idx = []
lines.forEach((l, i) => { if (/^#{2,4} /.test(l)) idx.push(i) })

// auto-block ranges (must be excluded from "body" accounting)
const text = lines.join('\n')
const seg = (a, b) => {
  const i = text.indexOf(a), j = text.indexOf(b)
  if (i === -1 || j === -1) return null
  const before = text.slice(0, i).split('\n').length - 1
  const after = text.slice(0, j + b.length).split('\n').length - 1
  return [before, after + 1]
}
const autoRanges = []
for (const [s, e] of [['<!-- dsh-agent-evolve:start -->', '<!-- dsh-agent-evolve:end -->'],
['<!-- dsh-agent-self-test:start -->', '<!-- dsh-agent-self-test:end -->']]) {
  const r = seg(s, e)
  if (r) autoRanges.push(r)
}
const inAuto = (i) => autoRanges.some(([a, b]) => i >= a && i < b)
let autoB = 0
for (const [a, b] of autoRanges) autoB += bytesOf(a, b)

console.log(`文件 ${P}`)
console.log(`总 ${bytesOf(0, lines.length)} B · ${lines.length} 行 · 自动段 ${autoB} B · 正文本体 ${bytesOf(0, lines.length) - autoB} B\n`)
console.log('按节字节降序（只列 >1000 B；「右界」= 下一节标题，末节标 EOF）')
const rows = []
for (let k = 0; k < idx.length; k++) {
  const s = idx[k]
  const e = k + 1 < idx.length ? idx[k + 1] : lines.length
  if (inAuto(s)) continue
  // stop at auto-block start if it falls inside
  let realE = e
  for (const [a] of autoRanges) if (a > s && a < e) realE = Math.min(realE, a)
  const b = bytesOf(s, realE)
  rows.push({ s, e: realE, b, title: lines[s].slice(0, 62), next: k + 1 < idx.length ? lines[idx[k + 1]].slice(0, 40) : 'EOF' })
}
rows.sort((x, y) => y.b - x.b)
for (const r of rows.filter(r => r.b > 1000)) {
  console.log(`  ${String(r.b).padStart(6)} B  行 ${r.s + 1}-${r.e}  ${r.title}`)
  console.log(`            └ 右界: ${r.next}`)
}
const tot = rows.reduce((a, r) => a + r.b, 0)
console.log(`\n节合计 ${tot} B（节数 ${rows.length}）`)
