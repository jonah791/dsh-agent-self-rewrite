# dsh-agent-self-rewrite — 自改写引擎（语义文档）

## 1 · 元信息

| 项 | 值 |
|---|---|
| 能力名 | 自改写引擎（`AGENTS.md` 标记段的**唯一写者**） |
| 插件 | `self-plugins/dsh-agent-self-rewrite` |
| 状态 | implemented（工具面 6 个已落地并离线验收；退役与线上取证待做） |
| 替换 | `dsh-agent-self-test` + `dsh-agent-evolve`（14 工具 → 6） |
| 设计依据 | `docs/plans/插件融合设计_自改写与蒸馏_2026-09-23.md` |
| 事故背景 | `t-d7b9739f`（AGENTS.md 规则段被整块替换抹掉，两次） |
| 最近复核 | 2026-09-23 |

## 2 · 定位与反定位

**定位**：**改变我自己的唯一通道**——把「猜想 → 采证 → 裁决 → 写入 → 跨代验证 → 保留或回滚」做成一条有单一写者的闭环。

**反定位（不做）**：不做日常记忆沉淀（归 `dsh-agent-memory`）；不做五环状态的**只读**聚合与建议（归 `dsh-evolution-core`）；不做提示词/预设的渲染分发（那是消费端）；**不发送评测以外的任何消息**（finding 通知是唯一例外，且只投给触发工具调用的 agent）。

## 3 · 术语

| 术语 | 含义 |
|---|---|
| 假设（Hypothesis） | 一条**可证伪**的自我陈述 + 探针（探针决定它靠什么证据被检验） |
| 证据（Evidence） | 探针在真实工具调用中**被动**采到的观测（不是专门跑的实验） |
| finding | 证据达阈值的假设 + **方向**（支持 / 反对 / 混杂 + 倾向度分档） |
| 裁决 | 对 finding 的动作：`confirm`（布线）/ `refute`（淘汰）/ `refine`（改判据重采） |
| 标记段（Block） | `AGENTS.md` 里由起止 marker 围出的受管区段；本件按 id 登记并**独占**写入 |
| 资源（Resource） | 版本化本体资源：`agent-rules`（= `evolve` 标记段）/ `candidate-prompt` |
| 锚点（Anchor） | 已验证并冻结的版本；锚点链单调，回滚只回既有锚点 |
| 轮（Round） | 一次「起一代 → 派发白纸子智能体 → 评测 → 入账」 |
| 拒写（Reject） | 写原语的响亮失败：调用方**不得写盘** |

## 4 · 概念模型与不变量

概念：`Hypothesis` · `Evidence` · `Finding` · `Resource` · `Anchor` · `Round` · `Block` · `WriteOutcome`。

不变量：

- **I1 · AGENTS.md 只有一个写者**——本件；其他任何插件不得写该文件的标记段。
- **I2 · 无证据不写**——`confirm` 只接受 `finding` 状态的假设；跳过采证直接布线一律抛错。
- **I3 · 两条写路径，同一套守卫**——累积（`applyRuleUpsert`）与版本化替换（`applyBlockSet`）**共用**标记完整性守卫与字节预算裁决；超限一律拒写，绝不截断。
- **I4 · 只增不减（累积路径）**——新规则追加在块尾，既有条目顺序与内容原样保留；块外内容一律不动。
- **I5 · 标记损坏响亮失败**——起止标记只出现一个、或顺序颠倒 ⇒ 拒写（绝不产出读不回来的块）。
- **I6 · 锚点链单调、回滚可逆**——`commit` 只追加锚点，`rollback` 只回到既有锚点，不产生新版本号。
- **I7 · 观测不反噬**——采证回调整体包 `try/catch`，失败只留痕；与宿主同进程，逃逸异常会直接杀死 web（§5.24）。
- **I8 · 读不到 ≠ 为空**——假设库损坏 ⇒ 抛错（旧实现把它吞成空库，随后会把空库写回盘 = 静默清空）；账本不可读时锚点报「未知」而非 0。

## 5 · 契约

### 5.1 工具面（14 → 6）

| 工具 | 意图 | 合并了谁 |
|---|---|---|
| `rewrite_status` | 一屏看全：预算 / 假设四态 / 待裁决 finding / 锚点链 / 未收尾轮 / 孤儿 | `selftest_list` + `evolve_status` + `evolve_ledger` + `evolve_orphans` |
| `rewrite_hypothesis` | `add` 登记 / `refine` 细化 / `archive` 淘汰 / `list` 列出 | `selftest_add`（+ refine / archive 分支） |
| `rewrite_verdict` | 裁决并**当场布线**——**唯一写 `AGENTS.md` 的入口** | `selftest_review` + `evolve_edit` 的 agent-rules 分支 |
| `rewrite_evaluate` | `init` / `start` / `spawn` / `submit` / `reap` / `orphans` | `evolve_init` + `evolve_round_start` + `evolve_spawn` + `evolve_submit` + `evolve_reap` |
| `rewrite_commit` | `edit` 写新版本 / `commit` 锚定 / `rollback` 回滚 | `evolve_edit` + `evolve_commit` |
| `rewrite_history` | 履历：代 / 版本 / 分数 / 锚点链 / 撤回记录 | `evolve_ledger` 的读侧 |

`evolve_orphans` 不再作为独立工具——孤儿清单并入 `rewrite_status`，收尸是 `rewrite_evaluate` 的一个分支（不该由人手工触发两次）。

### 5.2 唯一写原语（`src/wiring.ts`）

两条路径，同一套守卫：

```ts
applyRuleUpsert(full, { blockId, draft, maxBytes })   // 累积：只增不减、幂等
applyBlockSet(full, { blockId, inner, maxBytes })     // 版本化替换：块内容整体换掉
```

| `reason` | 触发条件 |
|---|---|
| `unknown-block` | `blockId` 不在 `MANAGED_BLOCKS` 登记表内 |
| `empty-draft` | 草稿归一化后为空（仅累积路径） |
| `corrupt-markers` | 起止标记只出现一个，或起止顺序颠倒 |
| `over-budget` | 写入后的 UTF-8 字节数超过 `maxBytes` |

`MANAGED_BLOCKS` 是 marker 字面量的**唯一真源**：

| id | marker |
|---|---|
| `evolve` | `<!-- dsh-agent-evolve:start -->` … `<!-- dsh-agent-evolve:end -->` |
| `self-test` | `<!-- dsh-agent-self-test:start -->` … `<!-- dsh-agent-self-test:end -->` |

两个 id 都是**历史遗留段**：迁移期必须能按原 id 继续读写，否则新件上线当天就会与旧段脱钩（旧段留在文件里、新件往别处写 ⇒ 双份规则）。`rewrite_verdict` 的累积写入落 `self-test` 段（延续 `selftest_review` 的位置），`rewrite_commit` 的版本化替换落 `evolve` 段（延续 `evolve_edit` 的位置）——两处均可配。

### 5.3 状态落点契约（迁移期不得搬迁）

| 旧件 | 配置字段与缺省 | 落盘文件 |
|---|---|---|
| `dsh-agent-self-test` | `dataDir?: string` · 缺省 `join(dshHome, 'agent-self-test')` | `<base>/self-test.json`（本件改用原子写 tmp+rename）· `<base>/backups/` |
| `dsh-agent-evolve` | `dataDir: string` · 缺省 `$DSH_HOME/.evolve` | `<dataDir>/ledger.json` · `<dataDir>/resources/<id>` · `<dataDir>/runs/<runId>.json` · `<dataDir>/orphans.jsonl` |

⚠ 2026-09-23 实测：盘上 `.evolve/` **只有 `runs/`，没有 `ledger.json`**（evolve 从未初始化成功）⇒「账本不存在」是**合法状态**，读侧不伪造空账本。

### 5.4 调用点清单

| 调用方 | 调用点（文件:符号） | 时机 |
|---|---|---|
| cordis 宿主 | `src/index.ts:name / inject / Config / apply` | 插件激活 |
| 宿主 agent | `rewrite_status` → `src/status.ts:buildStatus` | 只读一屏 |
| 宿主 agent | `rewrite_hypothesis` → `src/hypotheses.ts:{addHypothesis,applyVerdict}` | 假设 CRUD |
| 宿主 agent | **`rewrite_verdict` → `src/wiring.ts:applyRuleUpsert`** | **唯一写 `AGENTS.md` 累积段的入口** |
| 宿主 agent | `rewrite_commit(edit/rollback)` → `src/wiring.ts:applyBlockSet` | 唯一写 `AGENTS.md` 版本段的入口 |
| 宿主 agent | `rewrite_evaluate` → `src/rounds.ts:{startRound,submitRun,reapRuns}` | 评测轮 |
| 宿主 agent | `rewrite_history` → `src/rounds.ts:ledgerView` | 读履历 |
| 宿主事件 | `tools/result` → `src/probes.ts:createProbeEngine.handle` | **每次工具调用**（被动采证） |
| 外部脚本 | `<modeltestDir>/evaluator/{make_broken_project,run_full_eval}.py` | 经 `pythonBin` 启动 |
| **禁止** | 任何其他插件写 `AGENTS.md` 标记段 | 由 I1 约束 |

### 5.5 类型可见性

`ctx.subagents` / `ctx.agents` / `MessageSourceMap` 的声明合并在各自包内，须进入编译单元 ⇒ `src/index.ts` 显式 `import type {}` 引入（纯类型，不产生运行时代码）。

## 6 · 边界与信任

- **信任源**：只有 `run_full_eval` 的 `summary.json` 是评分权威；本件不自行打分。
- **危险面**：`rewrite_verdict` / `rewrite_commit(edit|rollback)` 直接改我的规则 ⇒ 影响我自己的行为。兜底 = 锚点链 + `rollback` + **字节预算守卫（超限拒写）** + 写前备份。
- **预算口径**：UTF-8 字节数。`AGENTS.md` 在 2026-09-23 实测 64,434 字节，注入截断点约 65,242 ⇒ 余量仅约 808 字节，`maxBytes` 缺省取 64,800。
- **失败语义（不静默）**：四类拒写 · 假设库损坏 · 评测无 summary · 工作区缺失 · 未收尾轮——都抛带诊断的错误。
- **凭据**：不读凭据；联网仅限评测脚本自身。

## 7 · 可证伪验收

| 可证伪命题 | 证据（一次测量） | 状态 |
|---|---|---|
| 超预算时拒写而非截断（累积路径） | `node --test tests/*.test.mjs` 的「尸体：超预算」用例 | 已实测 |
| 起止标记只出现一个 / 顺序颠倒 ⇒ 拒写 | 同上两条尸体用例 | 已实测 |
| 空草稿 / 未登记段 ⇒ 拒写 | 同上两条尸体用例 | 已实测 |
| 累积写入保留块外内容与既有条目 | 同上「块外哨兵」「幂等」用例 | 已实测 |
| **版本化替换**保留块外内容、共用同一道预算闸门 | 同上 `applyBlockSet` 三条用例 | 已实测 |
| 非 finding 的假设 confirm ⇒ 抛错（无证据不写） | 同上「尸体：非 finding confirm」用例 | 已实测 |
| 极性物化进数据（不靠隐式默认表） | 同上 `addHypothesis` 用例 | 已实测 |
| 达阈值转 finding 且只报一次 | 同上 `recordEvidence` 用例 | 已实测 |
| 读不到 ≠ 为空（损坏抛错） | 同上 `requireHypotheses` 用例 | 已实测 |
| `extractRules` 只认登记段（marker 单一真源） | 同上 `extractRules` 用例 | 已实测 |
| 移植模块行为零漂移 | 旧件测试随模块一并迁入：`181/181` 全绿 | 已实测 |
| 构建通过 | `tsc -p tsconfig.json` 退出码 0 | 已实测 |
| 插件挂载且 6 工具可答 | `rewrite_status` 返回假设库与锚点链 | 待验收 |
| 全仓只有本件写 `AGENTS.md` 标记段 | `grep -rn 'AGENTS.md' self-plugins/*/src/*.ts` 后逐个确认**写调用** | 待验收 |
| 旧两件退役后五环仍完整 | `evolution_cycle` 报五环健康且无断点 | 待线上验收 |
| 采证不双记（旧件退役后单一引擎） | 退役前后同一次工具调用的证据增量比对 | 待线上验收 |

## 8 · 与实现的关系

**落点**：`src/wiring.ts`（唯一写原语，两条路径）· `src/store.ts`（兼容读取层 + 共享类型）· `src/status.ts`（状态聚合）· `src/hypotheses.ts`（假设与裁决）· `src/probes.ts`（探针引擎）· `src/rounds.ts`（账本与轮次）· `src/index.ts`（6 工具）· 移植模块：`polarity` / `probe` / `burst` / `failure-rate` / `claim-evidence` / `cluster` / `ledger-store` / `parent` / `orphans` / `workspace-reset` / `presets` / `evaluator` / `types`。

**生效判据**：

1. **构建-进程先后**：`lib/index.js` 的 mtime 晚于 web 进程启动时间。
2. **工具可答**：`rewrite_status` 能返回假设库与锚点链 ⇒ 已在本进程加载。
3. **唯一写者取证**：`grep -rn 'AGENTS.md' self-plugins/*/src/*.ts` 后逐个确认**写调用**——只有本件命中（注释里提到不算）。
4. **落盘产物**：`<dataDir>/ledger.json`、`self-test.json` 出现且 mtime 前进。

**回退**：unmount 本件 → 把 `dsh-agent-self-test` / `dsh-agent-evolve` 从 `_archive/` 还原并重挂；数据未动（同一 dataDir）⇒ 无损。

**依赖方**：`dsh-evolution-core` 读旧两件的状态 ⇒ 本件**保持同路径**即可兼容（§5.3）；只有改字段才需要同步其读取面。

## 9 · 实践修订记录

| 日期 | 修订 |
|---|---|
| 2026-09-23 | 首版：从设计稿迁入语义文档形状；落地唯一写原语（累积路径）与 14 个用例。 |
| 2026-09-23 | **尸体测试逼出一条真缺陷**：守卫原本只查「起止标记只出现一个」，两标记齐全但**顺序颠倒**时放行 ⇒ 追加出读不回来的块（写成功但读不回 = 静默损坏）。修复 + 把反证写进测试。 |
| 2026-09-23 | 移植 15 个模块 + 8 个测试文件，**零改动即编译通过、零漂移全绿**——说明旧两件的模块层本就自包含，融合的真实成本在工具层而非模块层。 |
| 2026-09-23 | **实现中发现设计稿的一处语义缺口**：设计说「evolve 的标记段重写逻辑改为调用 `upsertRuleBlock`」，但 upsert 表达的是「累积一条规则」，而资源模型要的是**版本化替换**。补第二条原语 `applyBlockSet`，**共用同一套守卫与预算**——这是刻意的：被替换的 `dsh-agent-evolve` 用 `full.replace(/start[\s\S]*end/, wrapped)` 做整块替换且**完全不做预算裁决**，那条路径可以在无人察觉时把我的规则段截掉。 |
| 2026-09-23 | 读旧实现确认了两处**必须不复制**的行为：① `loadState` 把「文件不存在」与「JSON 损坏」都吞成空库，随后会把空库写回盘（**静默清空整库**）⇒ 本件损坏即抛错；② 探针回调在旧件里未整体包 `guarded` ⇒ 本件包住（§5.24 逃逸异常会杀宿主）。 |

## 10 · 未决问题

1. **两个历史标记段是否合并**：`evolve` 与 `self-test` 语义已同源（都是规则），但合并会改 `AGENTS.md` 既有结构，且 `dsh-evolution-core` 可能按段名读取 ⇒ 迁移期保持两段。
2. **`AGENTS.md` 余量告急**：实测 64,434 / 截断点约 65,242 ⇒ 余量约 808 字节。`maxBytes` 缺省 64,800；是否继续把旧版史迁出以腾空间，待主人裁。
3. **`dsh-evolution-core` 的字段兼容**：路径已保持（§5.3），但若本件改了字段形状，其读取面需同步——待退役后实测确认。
4. **`rewrite_evaluate` 的评测链路未线上验证**：`startRound` / `submitRun` 依赖 modeltest 工作区与 `run_full_eval`，本次只做了编译与纯函数验收。
