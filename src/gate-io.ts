/**
 * 外生接受位 · IO 层（读冻结账 + 跑注入器）。
 *
 * 与 `gate.ts` 的分工：那边是**纯裁决**（可离线测），这边是**取数与执行**。
 * 裁决逻辑一律在纯层，本层只做「把磁盘上的事实搬进来」与「把脚本跑起来」。
 *
 * 安全边界（本层唯一的风险面）：**会执行冻结账里指定的脚本**。三条约束：
 * ① 脚本路径必须落在 `<home>/acceptance-sealed/injectors/` 之内（`resolve` 后前缀比对，防 `..` 逃逸）
 * ② 用 `process.execPath`（当前 node）执行，不经过 shell ⇒ 无 shell 注入面
 * ③ 30s 超时 + `stdio: 'ignore'`（输出不进上下文；单比特判据不需要看输出）
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { canaryProbe, decideGate, hashRuleDraft, type CanaryResult, type GateDecision, type SealedAccount } from './gate.js'

/** 冻结账根目录（相对 DSH_HOME） */
export const SEALED_ROOT = 'acceptance-sealed'
/** 注入器脚本目录（相对冻结账根） */
export const INJECTOR_SUBDIR = 'injectors'

export function sealedDir(home: string): string {
  return join(home, SEALED_ROOT)
}

/** 读冻结账。文件不存在 ⇒ null（**与「读坏了」不同**——读坏了要响亮报，见下） */
export function loadSealedAccount(home: string, ruleId: string): SealedAccount | null {
  const p = join(sealedDir(home), `${ruleId}.json`)
  if (!existsSync(p)) return null
  const raw = readFileSync(p, 'utf8')
  // 读坏了**不吞**：抛出去由调用方记成「账不可读」（与「没账」是两件事）
  return JSON.parse(raw) as SealedAccount
}

/**
 * 跑一个脚本并返回退出码。
 * 返回 `null` = **跑不起来**（路径越界 / 不存在 / 超时 / 无退出码）——调用方据此 fail-closed。
 */
export function runScript(scriptPath: string, home: string): number | null {
  const allowRoot = resolve(join(sealedDir(home), INJECTOR_SUBDIR))
  const target = resolve(scriptPath)
  // ① 路径必须落在允许根之内（前缀 + 分隔符，防 `../..` 与 `/root-evil` 这类同前缀逃逸）
  if (target !== allowRoot && !target.startsWith(allowRoot + sep)) return null
  if (!existsSync(target)) return null
  try {
    // ② 不经 shell（无注入面）· ③ 输出丢弃（单比特判据不看输出）
    execFileSync(process.execPath, [target], { windowsHide: true, timeout: 30_000, stdio: 'ignore' })
    return 0
  } catch (e) {
    const status = (e as { status?: unknown }).status
    return typeof status === 'number' ? status : null
  }
}

/**
 * 完整闸门（取数 + 裁决）。**任何异常都不许变成「通过」**（fail-closed）。
 *
 * 第一拍是**金丝雀自检**：闸门可能已被改成 fail-open 而无人察觉——
 * 尤其在本机「真实调用次数为 0」的现状下，没有任何读数会因此变化
 * ⇒ 每次调用先证明门还在工作，再让它裁决真实候选。
 *
 * @param canary 自检函数（缺省真品；测试注入坏门来证明自检抓得住）
 */
export function runGate(
  home: string,
  ruleId: string,
  draft: string,
  canary: () => CanaryResult = canaryProbe,
): GateDecision {
  const self = canary()
  if (!self.healthy) {
    return {
      accepted: false,
      stage: 'canary-failed',
      reason: `闸门自检失败（${self.reason}）——门已不可信，一律 fail-closed`,
    }
  }
  const hash = hashRuleDraft(draft)
  let account: SealedAccount | null = null
  try {
    account = loadSealedAccount(home, ruleId)
  } catch (e) {
    // 账读坏了：**不是「没账」**——响亮拒，并说清是读坏
    return {
      accepted: false,
      stage: 'no-account',
      reason: `冻结账不可读（${e instanceof Error ? e.message : String(e)}）——读坏了与没账是两件事，一律 fail-closed`,
    }
  }
  if (account === null) return decideGate(null, hash, null, null)
  if (account.kind === 'no-oracle') return decideGate(account, hash, null, null)
  const injected = account.injector ? runScript(account.injector.script, home) : null
  const benign = account.benign ? runScript(account.benign.script, home) : null
  return decideGate(account, hash, injected, benign)
}
