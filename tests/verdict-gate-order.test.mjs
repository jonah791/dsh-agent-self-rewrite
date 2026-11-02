/**
 * 接线层：闸门在 `rewrite_verdict` 里的**顺序**（2026-11-03 · t-366b5933「验收优先于 Teacher」）。
 *
 * 为什么这个文件存在：`gate.ts` 10/10 · `gate-io.ts` 10/10，而**接线层 0 条测试**——
 * 三层里唯一天天在用的那一层没测。结果就是闸门从 2026-10-17 实现至今真实运行 **0 次**，
 * 而没有任何读数因此变化（`.dsh/acceptance-sealed/` 为空、trace 不存在）。
 *
 * 本文件测的不是「闸门判得对不对」（那是 gate.test.mjs），而是三件接线层的事：
 * ① **顺序**：闸门拒 ⇒ 裁决**没发生**（假设状态不变），不留「已确认但规则不在文件里」的脏状态
 * ② **绕过可审**：`acceptanceGate=false` ⇒ 规则照写，但输出带警告 + 落 trace（不留痕的绕过才是危险的）
 * ③ **不恒拒**：造一份合法冻结账 ⇒ 必须真的放行并写入（否则闸门变成恒拒，同样无区分力）
 *
 * 三具尸体：① 顺序错位（旧行为）② 静默绕过 ③ 恒拒。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashRuleDraft } from '../lib/gate.js'
import { Config, apply } from '../lib/index.js'

const RULE = '**新规则**：pwsh 里禁用空值合并运算符'

/** 最小假 ctx：捕获注册的工具，日志进数组 */
function makeCtx() {
  const tools = new Map()
  const logs = []
  const logger = () => ({ info: (s) => logs.push(s), warn: (s) => logs.push(s), error: (s) => logs.push(s) })
  return {
    tools,
    logs,
    ctx: {
      tools: { register: (t) => { tools.set(t.name, t) } },
      on: () => {},
      effect: () => () => {},
      provide: () => {},
      set: () => {},
      get: () => undefined,
      emit: () => {},
      logger,
      agents: { list: () => [] },
    },
  }
}

/**
 * 夹具：临时 DSH_HOME + 受管文件 + 一条 `finding` 态假设。
 * `process.env.DSH_HOME` 是全局副作用 —— 一律 finally 恢复。
 */
async function withFixture(fn, configPatch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'selfrewrite-gate-order-'))
  const oldHome = process.env.DSH_HOME
  try {
    const home = join(root, '.dsh')
    mkdirSync(home, { recursive: true })
    process.env.DSH_HOME = home
    const rules = join(root, 'AGENTS.md')
    writeFileSync(rules, '# 测试用 AGENTS\n\n<!-- self-test:start -->\n<!-- self-test:end -->\n', 'utf8')
    const dataDir = join(home, 'agent-self-test')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'self-test.json'), JSON.stringify({
      hypotheses: [{
        id: 'h-testgate-1',
        statement: '测试假设：某工具在 N 步内报错',
        prediction: '会命中',
        probe: { kind: 'error-burst' },
        threshold: 3,
        status: 'finding',
        evidence: [],
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      }],
    }), 'utf8')

    const { ctx, tools, logs } = makeCtx()
    // Config 是 cordis schema（可调用工厂），**不是 zod 的 `.parse`**——探测一次胜过猜
    apply(ctx, Config({ rulesFile: rules, ...configPatch }))
    return await fn({ root, home, rules, dataDir, tools, logs })
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
}

const runVerdict = (tools, args) =>
  tools.get('rewrite_verdict').execute(args, { signal: new AbortController().signal })

const statusOf = (dataDir) =>
  JSON.parse(readFileSync(join(dataDir, 'self-test.json'), 'utf8')).hypotheses[0].status

// ── ★ 尸体①：顺序错位（旧行为的形状）─────────────────────────────────
test('★ 闸门拒（无冻结账）⇒ **裁决未发生**：假设仍是 finding，规则未写入', async () => {
  await withFixture(async ({ rules, dataDir, tools }) => {
    const r = await runVerdict(tools, { id: 'h-testgate-1', verdict: 'confirm', ruleDraft: RULE })

    assert.ok(r.text.includes('⛔'), `闸门应显式拒绝：${r.text}`)
    assert.ok(r.text.includes('外生接受位拒绝'), r.text)
    assert.ok(r.text.includes('no-account'), `拒因应点出阶段：${r.text}`)

    // 核心：状态**没被改**。旧实现这里是 confirmed —— 那正是脏状态的来源
    assert.equal(statusOf(dataDir), 'finding',
      '闸门拒了但假设被标成 confirmed —— 留下「已确认但规则不在 AGENTS.md」的脏状态')

    // 规则确实没进文件
    assert.equal(readFileSync(rules, 'utf8').includes('空值合并运算符'), false,
      '闸门拒了但规则被写进受管文件')
  })
})

// ── ★ 尸体②：静默绕过 ────────────────────────────────────────────────
test('★ acceptanceGate=false ⇒ 规则照写，但输出带警告 + trace 落 bypassed（绕过不静默）', async () => {
  await withFixture(async ({ rules, home, dataDir, tools }) => {
    const r = await runVerdict(tools, { id: 'h-testgate-1', verdict: 'confirm', ruleDraft: RULE })

    assert.ok(r.text.includes('未过外生接受位'),
      `关掉闸门必须在输出里说出来（静默绕过才是危险的）：${r.text}`)
    assert.equal(statusOf(dataDir), 'confirmed', '闸门关掉时裁决应正常生效')
    assert.ok(readFileSync(rules, 'utf8').includes('空值合并运算符'), '闸门关掉时规则应写入')

    const tracePath = join(home, 'acceptance-gate-trace.jsonl')
    assert.ok(existsSync(tracePath), '绕过没有留痕——那它事后不可审')
    const trace = readFileSync(tracePath, 'utf8')
    assert.ok(trace.includes('bypassed'), `trace 应记 bypassed：${trace}`)
  }, { acceptanceGate: false })
})

// ── 正例：闸门通过必须真的放行（防「恒拒」）──────────────────────────
test('闸门通过（合法冻结账 + 注入器红 + 对照绿）⇒ confirmed 且规则写入', async () => {
  await withFixture(async ({ home, rules, dataDir, tools }) => {
    const sealedDir = join(home, 'acceptance-sealed')
    const injectorDir = join(sealedDir, 'injectors')
    mkdirSync(injectorDir, { recursive: true })
    // 注入样本：构造出该失败 ⇒ 退出 1；良性对照：不触发 ⇒ 退出 0
    writeFileSync(join(injectorDir, 'h-testgate-1.inject.mjs'), 'process.exit(1)\n', 'utf8')
    writeFileSync(join(injectorDir, 'h-testgate-1.benign.mjs'), 'process.exit(0)\n', 'utf8')
    writeFileSync(join(sealedDir, 'h-testgate-1.json'), JSON.stringify({
      ruleId: 'h-testgate-1',
      sealedAt: '2026-11-01T00:00:00.000Z',
      ruleDraftHash: hashRuleDraft(RULE),
      kind: 'executable',
      injector: { script: join(injectorDir, 'h-testgate-1.inject.mjs') },
      benign: { script: join(injectorDir, 'h-testgate-1.benign.mjs') },
      expect: { injected: 1, benign: 0 },
    }), 'utf8')

    const r = await runVerdict(tools, { id: 'h-testgate-1', verdict: 'confirm', ruleDraft: RULE })

    assert.equal(statusOf(dataDir), 'confirmed', `闸门应放行：${r.text}`)
    assert.ok(readFileSync(rules, 'utf8').includes('空值合并运算符'),
      `闸门放行了但规则没写进去：${r.text}`)

    // 放行也要留 trace（否则「走门占比」永远算不出来）
    const trace = readFileSync(join(home, 'acceptance-gate-trace.jsonl'), 'utf8')
    assert.ok(trace.includes('"accepted":true'), `通过也要留痕：${trace}`)
  })
})

// ── 单比特：trace 不得含分数与逐样本结果 ──────────────────────────────
test('★ trace 只有单比特 + 拒因，**不含分数与逐样本结果**（leaky-anchor）', async () => {
  await withFixture(async ({ home, tools }) => {
    await runVerdict(tools, { id: 'h-testgate-1', verdict: 'confirm', ruleDraft: RULE })
    const trace = readFileSync(join(home, 'acceptance-gate-trace.jsonl'), 'utf8').trim()
    const row = JSON.parse(trace.split('\n')[0])
    assert.deepEqual(Object.keys(row).sort(), ['accepted', 'at', 'reason', 'ruleId', 'stage'],
      `trace 键集被污染（分数会变成新目标）：${trace}`)
  })
})
