import { readFileSync, existsSync } from 'node:fs'

const ROOT = 'E:/alice/'
const aTxt = readFileSync(ROOT + 'AGENTS.md', 'utf8')
const aLines = aTxt.split('\n')

// 收集所有「指向 rulebook / rulebook-archive / 其它文档」的引用
const refRe = /(?:docs\/rulebook(?:-archive)?\.md|[`\s]rulebook[`\s])[^\n]{0,80}/g
const secRe = /§(\d+\.\d+)/g

const targets = [
  { name: 'rulebook', path: ROOT + 'docs/rulebook.md' },
  { name: 'rulebook-archive', path: ROOT + 'docs/rulebook-archive.md' },
  { name: 'agents-md-archive', path: ROOT + 'docs/agents-md-archive.md' },
  { name: 'semantics-README', path: ROOT + 'docs/semantics/README.md' },
  { name: 'design-prompt-defense', path: ROOT + 'docs/design/prompt-defense.md' },
  { name: 'design-evolution-core', path: ROOT + 'docs/design/evolution-core-design.md' },
  { name: 'rulebook-docs(AGENTS)', path: ROOT + 'docs/AGENTS.md' },
  { name: 'harness-AGENTS', path: ROOT + 'deepseek-harness/AGENTS.md' },
  { name: 'identity-docs', path: ROOT + 'projects/self/alice-identity/docs/identity.md' },
  { name: 'ghost-docs', path: ROOT + 'projects/self/alice-identity/docs/ghost.md' },
]
console.log('=== 被引用文件存在性 ===')
for (const t of targets) {
  const ok = existsSync(t.path)
  let size = ''
  if (ok) { try { size = readFileSync(t.path).length + ' 字符' } catch { size = '（读失败）' } }
  console.log(`  ${ok ? '✓' : '✗ 缺失'}  ${t.name.padEnd(24)} ${size}`)
}

// 抽取 AGENTS.md 中每个「§NN + 附近出现的 rulebook 字样」的配对
console.log('\n=== AGENTS.md 里「指向 rulebook 的具体小节」核验 ===')
const rTxt = existsSync(ROOT + 'docs/rulebook.md') ? readFileSync(ROOT + 'docs/rulebook.md', 'utf8') : ''
const raTxt = existsSync(ROOT + 'docs/rulebook-archive.md') ? readFileSync(ROOT + 'docs/rulebook-archive.md', 'utf8') : ''

// 找形如「docs/rulebook.md §5.13」「rulebook §5.13」「§5.13 增补」的引用
const found = new Map()
aLines.forEach((l, i) => {
  const mentionsRb = /rulebook/i.test(l)
  const ids = [...l.matchAll(/§(\d+\.\d+)/g)].map((m) => m[1])
  for (const id of ids) {
    if (!found.has(id)) found.set(id, [])
    found.get(id).push({ line: i + 1, mentionsRb, text: l.slice(0, 96) })
  }
})

const misses = []
for (const [id, sites] of [...found.entries()].sort()) {
  const re = new RegExp('§' + id.replace('.', '\\.'))
  const inRb = re.test(rTxt)
  const inRa = re.test(raTxt)
  const anyRbMention = sites.some((s) => s.mentionsRb)
  const flag = !inRb && !inRa && anyRbMention ? '✗ 目标不存在' : (!inRb && !inRa ? '· 仅正本提及' : '✓')
  if (flag.startsWith('✗')) misses.push({ id, sites })
  console.log(`  ${flag.padEnd(14)} §${id.padEnd(6)} rulebook:${inRb ? '有' : '无'} archive:${inRa ? '有' : '无'}  引用${sites.length}处`)
}

console.log('\n=== 悬空指针（声称在 rulebook，实际找不到）===')
if (misses.length === 0) console.log('  （无）')
for (const m of misses) {
  console.log(`  §${m.id}:`)
  m.sites.filter((s) => s.mentionsRb).forEach((s) => console.log(`    行${s.line}: ${s.text}`))
}

// 反向：rulebook 里声明「自 AGENTS.md 迁入」但正本已无该节
console.log('\n=== 反向核验（rulebook 声称迁入 · 正本是否仍有同编号）===')
const rbLines = rTxt.split('\n')
rbLines.forEach((l, i) => {
  if (/自\s*AGENTS\.md\s*迁入/.test(l)) {
    const id = (l.match(/§(\d+\.\d+)/) || [])[1]
    if (id) {
      const re = new RegExp('^#{2,4} (?:§)?' + id.replace('.', '\\.'), 'm')
      const inA = re.test(aTxt)
      console.log(`  ${inA ? '⚠ 正本仍有' : '✓ 已迁净'}  行${i + 1} ${l.slice(0, 74)}`)
    }
  }
})
