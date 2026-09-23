/**
 * index.test.mjs — 插件壳的**模块加载冒烟** + 纯解析函数测试。
 *
 * 为什么值得测：`tool()` 把 spec 断言成 `never`，**tsc 查不出工具形状错**；且 import 路径写错
 * 只在运行时暴露。本文件 import 构建产物 `lib/index.js`，把这两类错误提前到闸门里。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Config, apply, inject, name, readRulesBytes, resolveDshHome, resolveRulesPath } from '../lib/index.js'

test('模块加载：导出形状完整（name 与 cordis.patch.yml 的 id 对齐、inject 含 tools、apply 是函数）', () => {
  assert.equal(name, 'agent-self-rewrite')
  assert.ok([...inject].includes('tools'))
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function')
})

test('resolveDshHome：环境变量优先；缺失时回退到硬编码锚点', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'X:/home' }), 'X:/home')
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), 'E:/alice/.dsh')
  assert.equal(resolveDshHome({}), 'E:/alice/.dsh')
})

test('resolveRulesPath：含分隔符视为路径本身；否则落 workspaceDir（缺省 DSH_HOME 的父目录）', () => {
  const base = { workspaceDir: '', rulesFile: 'AGENTS.md' }
  assert.equal(resolveRulesPath({ ...base }, 'E:/alice/.dsh'), join('E:/alice', 'AGENTS.md'))
  assert.equal(resolveRulesPath({ ...base, workspaceDir: 'X:/ws' }, 'E:/alice/.dsh'), join('X:/ws', 'AGENTS.md'))
  assert.equal(resolveRulesPath({ ...base, rulesFile: 'E:/other/SOUL.md' }, 'E:/alice/.dsh'), 'E:/other/SOUL.md')
  assert.equal(dirname('E:/alice/.dsh'), 'E:/alice')
})

test('尸体：受管文件不存在 ⇒ readRulesBytes 返回 null（**不是 0**）', () => {
  assert.equal(readRulesBytes('E:/definitely/not/here/AGENTS.md'), null)
})

test('readRulesBytes：文件存在 ⇒ 返回真实字节数（用临时夹具，不碰生产文件）', () => {
  const root = mkdtempSync(join(tmpdir(), 'selfrewrite-idx-'))
  try {
    const f = join(root, 'AGENTS.md')
    writeFileSync(f, '中文abc', 'utf8')
    assert.equal(readRulesBytes(f), 9) // 中文 6 字节 + abc 3 字节
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
