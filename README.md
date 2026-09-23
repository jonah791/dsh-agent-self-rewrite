# dsh-agent-self-rewrite — 自改写引擎

`AGENTS.md` 标记段的**唯一写者**：把「猜想 → 采证 → 裁决 → 写入 → 跨代验证 → 保留或回滚」做成一条有单一 owner 的闭环。

替换 `dsh-agent-self-test` + `dsh-agent-evolve`。设计依据：`docs/plans/插件融合设计_自改写与蒸馏_2026-09-23.md`；权威契约见 [docs/semantic.md](docs/semantic.md)。

## 为什么需要新件（而不是把两件合并）

`AGENTS.md` 的标记段被**两个插件**各自写入，且各自实现一套写入语义与预算守卫——这不是功能重复，是**同一份资源有两个 owner**，并且已经出过两次事故（2026-09-16 首次 / 2026-09-17 重演，事故号 `t-d7b9739f`）：旧实现 `full.replace(/start[\s\S]*end/, block)` 是整块替换，而块是累积的，两次各丢一条规则，且只有**字节数反降**才暴露（65,151 → 64,795）。

合并代码解决不了它——只有**让新件成为唯一写者**才解决。

## 实现进度（如实标注）

| 层 | 状态 |
|---|---|
| 脚手架（`package.json` / `tsconfig.json` / `dsh-plugin.json` / `cordis.patch.yml` / `.gitignore`） | 已落地 |
| 唯一写原语 `src/wiring.ts`（纯函数：upsert + 字节预算守卫 + 标记完整性守卫） | 已落地 + 离线尸体测试 |
| 工具面 6 个（`rewrite_status` / `rewrite_hypothesis` / `rewrite_verdict` / `rewrite_evaluate` / `rewrite_commit` / `rewrite_history`） | **未落地**（下一段） |
| `src/index.ts`（插件壳与工具注册） | **未落地**（下一段） |

⚠ **本件当前不可挂载**：`main` 指向的 `lib/index.js` 尚未实现。挂载与替换退役是组合变更，需预检 + 重启，属单独窗口。

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
