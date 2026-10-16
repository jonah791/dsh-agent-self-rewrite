#!/usr/bin/env node
/**
 * 落冻结账（外生接受位的前置动作）。
 *
 * **必须在 `rewrite_verdict confirm` 之前跑**——闸门的意义就在于账是「写规则前冻结」的，
 * 事后补账等于为这次改动定制，外生性消失。
 *
 * 用法：
 *   # 可执行类（有注入器）：落账前**先标定**——注入器必须真的能把该失败构造出来
 *   node scripts/seal-rule.mjs --rule h-xxx --draft-file draft.md \
 *        --injector injectors/h-xxx.inject.mjs --benign injectors/h-xxx.benign.mjs
 *
 *   # 行为倾向类（无自动 oracle）：不许伪造注入器，必须写明理由
 *   node scripts/seal-rule.mjs --rule h-xxx --draft-file draft.md --no-oracle "失败是我的行为倾向，不是可构造的状态"
 *
 * 标定纪律（本脚本的存在理由）：**落账前先跑一次注入器与良性对照**——
 * 若注入器跑不出非零（构造不出该失败），说明这条规则可能是**为不存在的失败写的**
 * （arXiv:2607.13083 的 phantom），此时**拒绝落账**并如实报出。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { runScript, SEALED_ROOT, INJECTOR_SUBDIR } from '../lib/gate-io.js'
import { hashRuleDraft } from '../lib/gate.js'

const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const ruleId = arg('rule')
const draftFile = arg('draft-file')
const injectorArg = arg('injector')
const benignArg = arg('benign')
const noOracle = arg('no-oracle')

if (!ruleId || !draftFile) {
  console.error('用法：node scripts/seal-rule.mjs --rule <id> --draft-file <path> [--injector <path> --benign <path>] | [--no-oracle <理由>]')
  process.exit(2)
}
if (!existsSync(draftFile)) {
  console.error(`✗ 规则草稿不存在：${draftFile}`)
  process.exit(2)
}

const draft = readFileSync(draftFile, 'utf8')
const ruleDraftHash = hashRuleDraft(draft)
const sealedDir = join(HOME, SEALED_ROOT)
const injectorDir = join(sealedDir, INJECTOR_SUBDIR)
mkdirSync(injectorDir, { recursive: true })

const account = {
  ruleId,
  sealedAt: new Date().toISOString(),
  ruleDraftHash,
  kind: noOracle ? 'no-oracle' : 'executable',
}

if (noOracle) {
  account.noOracleReason = noOracle
  console.log(`⚠ 行为倾向类（无自动 oracle）：${noOracle}`)
  console.log('  这条路径**不跑注入器**——不伪造 oracle 是刻意的（伪造正是 phantom 的生成机制）')
} else {
  if (!injectorArg || !benignArg) {
    console.error('✗ 可执行类必须同时给 --injector 与 --benign（良性对照：同位置、同表面角色）')
    process.exit(2)
  }
  const injector = resolve(injectorArg)
  const benign = resolve(benignArg)
  for (const [label, p] of [['注入器', injector], ['良性对照', benign]]) {
    if (!existsSync(p)) {
      console.error(`✗ ${label}不存在：${p}`)
      process.exit(2)
    }
  }
  // ★ 标定：先证明这两个脚本真的构成一对有区分力的判据
  const injExit = runScript(injector, HOME)
  const benExit = runScript(benign, HOME)
  console.log(`标定：注入器退出码 ${String(injExit)}（期望非零）· 良性对照退出码 ${String(benExit)}（期望零）`)
  if (injExit === null || benExit === null) {
    console.error('✗ 脚本跑不起来（路径越界 / 不存在 / 超时）——拒绝落账（fail-closed）')
    process.exit(1)
  }
  if (injExit === 0) {
    console.error('✗ 注入器**构造不出该失败**（退出码 0）——这条规则可能是为不存在的失败写的（phantom），拒绝落账')
    process.exit(1)
  }
  if (benExit !== 0) {
    console.error('✗ 良性对照也变红——判据过宽（会把正常情形也判成失败），拒绝落账')
    process.exit(1)
  }
  account.injector = { script: injector }
  account.benign = { script: benign }
  account.expect = { injected: injExit, benign: benExit }
}

const out = join(sealedDir, `${ruleId}.json`)
if (existsSync(out)) {
  console.error(`✗ 冻结账已存在：${out}（账是一次性的——要重落先手工删，且删除本身就是可审的动作）`)
  process.exit(2)
}
writeFileSync(out, JSON.stringify(account, null, 2), 'utf8')
try {
  chmodSync(out, 0o444) // 置只读：账在写规则后不可改（外生性的一半来自「不可改」）
} catch {
  console.log('⚠ 置只读失败（平台不支持）——请人工确认该文件未被改动')
}
console.log(`✔ 已落冻结账：${out}`)
console.log(`  规则哈希 ${ruleDraftHash}（改一个字都会让闸门拒——这是刻意的）`)
