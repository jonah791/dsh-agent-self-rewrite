import { readFileSync } from 'node:fs'

const P = 'E:/alice/AGENTS.md'
const raw = readFileSync(P)
const s = raw.toString('utf8')

const BLOCKS = [
  ['self-test', '<!-- dsh-agent-self-test:start -->', '<!-- dsh-agent-self-test:end -->'],
  ['evolve', '<!-- dsh-agent-evolve:start -->', '<!-- dsh-agent-evolve:end -->'],
]

let total = 0
for (const [id, st, en] of BLOCKS) {
  const i = s.indexOf(st)
  const j = s.indexOf(en)
  if (i === -1 || j === -1) { console.log(`${id}: 段不存在`); continue }
  const inner = s.slice(i + st.length, j).replace(/^\s*\n/, '').replace(/\s+$/, '')
  const lines = inner.split('\n').filter((l) => l.trim() !== '')
  const bytes = Buffer.byteLength(inner, 'utf8')
  total += bytes
  const sizes = lines.map((l) => Buffer.byteLength(l, 'utf8'))
  console.log(`\n=== ${id} ===  段内 ${bytes} B · 条目 ${lines.length} 条`)
  console.log(`  最长 ${Math.max(...sizes)} B · 最短 ${Math.min(...sizes)} B · 均值 ${Math.round(bytes / lines.length)} B`)
  console.log(`  中位 ${sizes.slice().sort((a, b) => a - b)[Math.floor(sizes.length / 2)]} B`)
  lines.forEach((l, k) => console.log(`  [${String(k).padStart(2)}] ${String(sizes[k]).padStart(5)}B :: ${l.slice(0, 58)}`))
}
console.log(`\n两个自动段合计 ${total} B`)
console.log(`AGENTS.md 总 ${raw.length} B ${raw.length === Buffer.byteLength(s, 'utf8') ? '(ASCII 安全)' : '(含多字节)'}`)
console.log(`引擎受管预算 64800 ⇒ 余量 ${64800 - raw.length} B`)
