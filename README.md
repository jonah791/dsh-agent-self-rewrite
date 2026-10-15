<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 自改写引擎：AGENTS.md 标记段的唯一写者——把「猜想 → 采证 → 裁决 → 写入 → 跨代验证 → 保留或回滚」做成一条有单一 owner 的闭环
  inject: ['tools', 'agents', 'subagents']
  tools: rewrite_status,rewrite_hypothesis,rewrite_verdict,rewrite_evaluate,rewrite_commit,rewrite_history
  runtime: host-only
  envDeps: 见 README「配置」节
  boundary: 见 README「设计要点」与「生效判据与回退」节
  compat: cordis ^4.0.1 / dsh-tools >=0.1.0-rc.6
-->
# dsh-agent-self-rewrite — 自改写引擎

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-self-rewrite"><img src="https://img.shields.io/badge/version-0.10.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-282%20passed-brightgreen" alt="tests">
</p>

`AGENTS.md` 标记段的**唯一写者**：把「猜想 → 采证 → 裁决 → 写入 → 跨代验证 → 保留或回滚」做成一条有单一 owner 的闭环。

替换 `dsh-agent-self-test` + `dsh-agent-evolve`。设计依据：`docs/plans/插件融合设计_自改写与蒸馏_2026-09-23.md`；权威契约见 [docs/semantic.md](docs/semantic.md)。

## 快速开始

**1) 装依赖**（在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-self-rewrite": "link:E:/alice/self-plugins/dsh-agent-self-rewrite"
```

**2) 挂组合**：

```yaml
- id: dsh-agent-self-rewrite
  name: dsh-agent-self-rewrite
```

**3) 30 秒验证**：`rewrite_status` → 应报受管产物字节数 / 假设四态 / 锚点链 / 推进面

## 为什么需要新件（而不是把两件合并）

`AGENTS.md` 的标记段被**两个插件**各自写入，且各自实现一套写入语义与预算守卫——这不是功能重复，是**同一份资源有两个 owner**，并且已经出过两次事故（2026-09-16 首次 / 2026-09-17 重演，事故号 `t-d7b9739f`）：旧实现 `full.replace(/start[\s\S]*end/, block)` 是整块替换，而块是累积的，两次各丢一条规则，且只有**字节数反降**才暴露（65,151 → 64,795）。

合并代码解决不了它——只有**让新件成为唯一写者**才解决。

## 实现进度（如实标注）

| 层 | 状态 |
|---|---|
| 脚手架（`package.json` / `tsconfig.json` / `dsh-plugin.json` / `cordis.patch.yml` / `.gitignore`） | 已落地 |
| 唯一写原语 `src/wiring.ts`（两条路径：累积 upsert + 版本化替换 set，共用标记守卫与字节预算裁决） | 已落地 + 离线尸体测试 |
| 迁移期兼容读取层 `src/store.ts`（旧路径解析 + 缺失/损坏/形状三态 fail-loud + 原子写 + 共享类型） | 已落地 + 夹具测试 + 真实语料冒烟 |
| 状态聚合读侧 `src/status.ts` | 已落地 + 尸体测试 |
| 假设与裁决 `src/hypotheses.ts` · 探针引擎 `src/probes.ts` · 账本与轮次 `src/rounds.ts` | 已落地 + 测试 |
| 移植模块（`polarity` / `probe` / `burst` / `failure-rate` / `claim-evidence` / `cluster` / `ledger-store` / `parent` / `orphans` / `workspace-reset` / `presets` / `evaluator` / `types`） | 已移植，**零改动编译通过、零漂移全绿** |
| 工具面 6 个（`rewrite_status` / `rewrite_hypothesis` / `rewrite_verdict` / `rewrite_evaluate` / `rewrite_commit` / `rewrite_history`） | 已落地 + **226/226 测试**（v0.6.0） |

**已挂载**（web profile）。v0.6.0 起带**使能型声明**：给 `rewrite_hypothesis(action=add)` 传 `deps` 即登记一条「**不改变即时读数、但支撑后续动作**」的改动（论文 `arXiv:2610.14625v1` §3.6 的维度失配），状态停在 `pending`（**不进 active** ⇒ 探针不采它、不污染采证链与信号面），兑现走 `action=fulfill`，未兑现在 `rewrite_status` 的**承诺面**浮出。

## 能力（计划中的工具面 14 → 6）

| 新工具 | 意图 | 合并了谁 |
|---|---|---|
| `rewrite_status` | 一屏看全：活假设 / 待裁决 finding / 锚点链 / 当前版本 / 未收尾评测轮 | `selftest_list` + `evolve_status` + `evolve_ledger` + `evolve_orphans` |
| `rewrite_hypothesis` | 登记 / 细化 / 淘汰假设（含极性校正） | `selftest_add`（+ refine 分支） |
| `rewrite_verdict` | 裁决 finding 并当场布线——**唯一写 `AGENTS.md` 的入口** | `selftest_review` + `evolve_edit` 的 agent-rules 分支 |
| `rewrite_evaluate` | 起一代 → 派发 → 收尾 → 收尸（一个入口管完整轮） | `evolve_round_start` + `evolve_spawn` + `evolve_submit` + `evolve_reap` |
| `rewrite_commit` | 提升则锚定，否则回滚 | `evolve_commit` |
| `rewrite_history` | 履历：版本演进 / 分数 / 撤回记录 | `evolve_ledger` 的读侧 |

## 配置（计划）

| 字段 | 含义 |
|---|---|
| `enabled` | 开关 |
| `rulesFile` | 受管文件（缺省 `AGENTS.md`，相对工作区根） |
| `maxBytes` | 字节预算上限（缺省留余量于实测截断点之下） |
| `dataDir` | 状态落点（与旧两件同路径，迁移期不搬迁数据） |

## 生效判据

1. **构建-进程先后**：`lib/index.js` 的 mtime 必须**晚于** web 进程启动时间（mtime 新只证明构建过，不证明进程在跑它）。
2. **工具可答**：`rewrite_status` 能返回假设库与锚点链 ⇒ 已在本进程加载。
3. **唯一写者取证**：`grep -rn 'AGENTS.md' self-plugins/*/src/*.ts` 后逐个确认**写调用**——只有本件命中（注释里提到不算）。
4. **落盘产物**：`<dataDir>/ledger.json`、`hypotheses.json`、`runs/<runId>.json` 出现且 mtime 前进。

## 回退

unmount 本件 → 把 `dsh-agent-self-test` / `dsh-agent-evolve` 从 `_archive/` 还原并重挂；数据未动（同一 `dataDir`）⇒ 无损。

## 测试

```bash
cd self-plugins/dsh-agent-self-rewrite && npm test
```

**282 条用例**（跑一次得到）。