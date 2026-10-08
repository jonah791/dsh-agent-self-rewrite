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
- **I9 · 回收不丢信息**——累积段撞预算时，最旧条目迁往**归档层**（文件追加），段内留**一行指针**指向它；迁走的条目必须可从归档层逐字读回。
- **I10 · 回收有界且有方向**——只从**最旧**一端迁，且**保留至少 1 条**（迁空段 = 该段机制失效）；迁完仍放不下 ⇒ 照旧 `over-budget` 拒写（fail-loud，绝不截断）。
- **I11 · 回收不静默**——返回值必须报「迁了几条 / 去了哪 / 停止原因」；只报「写成功」而隐去回收 = 把「人肉腾空间」变成看不见的机制行为，不可接受。

## 5 · 契约

### 5.1 工具面（14 → 6）

| 工具 | 意图 | 合并了谁 |
|---|---|---|
| `rewrite_status` | 一屏看全：预算 / 假设四态 / 待裁决 finding / 锚点链 / **runs 记录分布 + 未收尾数** / 孤儿 | `selftest_list` + `evolve_status` + `evolve_ledger` + `evolve_orphans` |
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

**回收分支（v0.6.0 · 2026-10-08）**：累积路径在「写入后超预算」时**不再直接拒写**，先尝试回收最旧条目：

```ts
splitEntries(inner)                    // 段内条目 = 非空行（格式契约：一条一行）
joinEntries(entries)                   // 逆操作（逐字还原，往返零漂移）
recycleOldest(inner, fits, keep = 1)   // 从最旧端逐条移出，直到 fits 为真或只剩 keep 条
```

`fits` 是**注入的谓词**（`(candidateInner: string) => boolean`）⇒ 回收循环可离线证伪，不必构造真文件。
生产调用点的 `fits` = 「把候选段内容拼回整文件后通过预算裁决」——回收的**目的是让本次写入成立**，不是无触发条件的自动瘦身。**不做预防性回收**：段上限若写成配置值，它会随正文本体增长而腐化（§5.16 锚点腐化），且提前回收 = 白白牺牲表达力。触发判据就是真判据（`allowed === false`），不是我造的阈值。

**目标余量（`reserveBytes`，缺省 1,024）**：只迁到「刚好放下」是不够的——真字节账端到端实测，迁到 `allowed` 时余量只剩 **490 B**，下一次写入立刻又撞线（这正是判据② 当初**抓出的设计缺陷**，不是夹具没调好）。⇒ 回收以「余量回到安全区」为目标：

| `stopped` | 含义 |
|---|---|
| `not-needed` | 没撞线（走的是普通 upsert 语义） |
| `fits` | 迁到目标余量 |
| `tight` | 放得下但**没到**目标余量 ⇒ 放行，但**截断回最少迁移量**（不为没达到的目标白迁条目）并如实报出 |
| `exhausted` | 迁到只剩 `keep` 条仍放不下 ⇒ 照旧 `over-budget` 拒写 |

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
| `dsh-agent-evolve` | `dataDir: string` · 源码缺省 `$DSH_HOME/.evolve` | `<dataDir>/ledger.json` · `<dataDir>/resources/<id>` · `<dataDir>/runs/<runId>.json` · `<dataDir>/orphans.jsonl` |

⚠ **本部署的 `dataDir` 被 profile 覆盖为 `E:/alice/.evolve`**（不是 `<DSH_HOME>/.evolve`）——账本实际在那里（2026-09-23 实测 61,233 字节 / 20 个 run / `resources/` 齐全）。⇒ 新件配置必须显式传 `evolveDataDir: E:/alice/.evolve`，否则会读到一个空的默认路径并误判「从未初始化」。

⚠ 2026-09-23 实测：`<DSH_HOME>/.evolve` 不存在（那是源码缺省值，不是本部署的落点）⇒「账本不存在」**是合法状态**（读侧不伪造空账本），但判断它之前必须先确认读的是哪个 `dataDir`。

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

### 5.6 回收归档层（迁出条目的归宿）

| 项 | 值 |
|---|---|
| 路径 | `E:/alice/docs/agents-md-archive.md`（可配 `archivePath`） |
| 写入 | **只追加**：一条一行，前缀 `- [<date> · <blockId>] ` |
| 唯一写者 | 本件（与 I1 同源：AGENTS.md 标记段的写者，同时是它回收产物的写者——两处都不得有第二写者） |
| 段内指针 | 一行 `> ⤵ 已回收 N 条至 docs/agents-md-archive.md（<date>）`；**重复回收替换该行**，不叠加（指针是状态，不是日志） |
| 为什么不进 `docs/rulebook.md` | rulebook 是纪律正本、**自身有 40,000 字符上限且当前贴顶** ⇒ 迁进去只是把撞线从一个容器搬到另一个。技能 `soul-file-budget-edit` 的结论：**建归档层，不抬上限、不换容器** |

**指针的唯一职责是「可达」**——读到段的人能据此找到迁走的条目；它不承载条目内容，也不累计历史（历史在归档行的 `[date]` 前缀里）。

⚠ **归档层自己没有上限**（只追加）。何时给它加回收，取决于它长到多大——**不预先设计**（「不为不存在的问题付代价」）。它的体量读数进 `rewrite_status`。

## 6 · 边界与信任

- **信任源**：只有 `run_full_eval` 的 `summary.json` 是评分权威；本件不自行打分。
- **危险面**：`rewrite_verdict` / `rewrite_commit(edit|rollback)` 直接改我的规则 ⇒ 影响我自己的行为。兜底 = 锚点链 + `rollback` + **字节预算守卫（超限拒写）** + 写前备份。
- **预算口径**：UTF-8 字节数。`AGENTS.md` 在 2026-09-23 实测 64,434 字节，注入截断点约 65,242 ⇒ 余量仅约 808 字节，`maxBytes` 缺省取 64,800。
- **失败语义（不静默）**：四类拒写 · 假设库损坏 · 评测无 summary · 工作区缺失 · 未收尾轮——都抛带诊断的错误。
- **runs 读数的口径（2026-10-03 修正）**：`listRuns` 返回**记录对象**（含 `status`）；`rewrite_status` 报「runs 记录 N（分布）· 未收尾 M」。⚠ **`runs` 目录条目数 ≠ 未收尾数**——此前把前者标成「未收尾评测轮」曾误导一整圈排查（实测 20 条为 done 11 / failed 9 / 未收尾 **0**）。未收尾判据是**白名单**：`status ∉ {done, failed}`，**未知状态一律计入未收尾**（宁可多报不可漏报）。坏 JSON 与形状不符的条目**逐条跳过**，不让整批失败。
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
| **runs 记录数 ≠ 未收尾数**（旧标签「未收尾评测轮：N」不再出现） | `node --test tests/*.test.mjs` 的「全终态：记录数与未收尾分离」「未收尾判据是白名单」「端到端：夹具目录真写 run 文件」三条用例 | 已实测（184/184 全绿） |
| 坏 JSON / 形状不符（空壳 `{}`）的 run 条目**逐条跳过**，不让整批失败、不把空壳当记录 | 同上「端到端」用例（夹一个坏 JSON + 一个空壳）；`store.test.mjs` 同名用例 | 已实测 |
| **判据①**：写入超限 ⇒ 引擎**自动迁走最旧条**，且**不丢任何规则**（迁走的可从归档层逐字读回） | `node --test tests/wiring-recycle.test.mjs`「判据①」＋真字节账端到端（副本：迁 6 条 → 归档 6/6 逐字找回、段内残留 0、指针 1 行） | 已实测（离线＋端到端） |
| **判据②**：回收后余量回到安全区（≥ 1,000 B） | 同上「判据②：目标余量驱动」＋端到端实测 `1,245 → 1,130 B` | 已实测（离线＋端到端） |
| **判据③**（尸体）：喂一条**逐字重复**的旧规则 ⇒ 被识别为 `exists` 而非新增（证明回收判据有区分力，不是恒不动） | 同上「判据③：逐字重复 ⇒ exists，回收不启动」 | 已实测 |
| **目标余量有区分力**（不是装饰品）：同预算同输入，`reserveBytes` 0 vs 100 ⇒ 迁移条数 2 vs 3 | 同上「判据②」的对照组断言 | 已实测 |
| **回收有界**：迁到只剩 1 条仍放不下 ⇒ 照旧 `over-budget` 拒写，绝不截断（I10） | 同上「尸体：迁空即止 + 仍超则拒写」 | 已实测 |
| **回收不静默**：`ok:true` 时返回值带 `recycled` 与停止原因；`tight` 如实标注「未达安全区」并截断回最少迁移量（I11） | 同上「回收记录回传」＋「尽力而为 ⇒ tight」 | 已实测 |
| **指针不叠加**：重复回收**替换**段内指针行，而非追加第二条 | 同上「判据①附属：重复回收替换指针行」 | 已实测 |
| **条目往返幂等**：`splitEntries` ∘ `joinEntries` 幂等（空行/尾空白按**分隔符**规范化） | 同上「条目切分」用例 | 已实测 |
| **不越界**：未登记段 / 标记损坏仍走同一套守卫（回收不绕过它们）；未撞线时与旧原语**逐字节相同** | 同上两条用例（`unknown-block` / `corrupt-markers` / 兼容性） | 已实测 |
| **线上生效**：重启后 `rewrite_status` 出现「回收归档」读数 | 2026-10-08 23:05 web 重启后实调 `rewrite_status`，实报 `回收归档：docs/agents-md-archive.md（尚未产生——累积段还没撞过预算）` | 已实测（线上） |

## 8 · 与实现的关系

**落点**：`src/wiring.ts`（唯一写原语，两条路径 + 回收）· `src/store.ts`（兼容读取层 + 共享类型）· `src/status.ts`（状态聚合）· `src/hypotheses.ts`（假设与裁决）· `src/probes.ts`（探针引擎）· `src/rounds.ts`（账本与轮次）· `src/index.ts`（6 工具）· **常驻体检脚本** `scripts/segment-metrics.mjs`（段字节账：总字节 / 条目数 / 中位 / 逐条清单）· `scripts/recycle-e2e.mjs`（真字节账端到端回归：判据①②③ + 「真文件一字未动」断言，只碰副本）· 移植模块：`polarity` / `probe` / `burst` / `failure-rate` / `claim-evidence` / `cluster` / `ledger-store` / `parent` / `orphans` / `workspace-reset` / `presets` / `evaluator` / `types`。

> 两个脚本是**排障脚本升级进工具链**的形态（§5.22 规则 6：不留一次性碎片）——量段账、验回收，各一条命令。⚠ 它们硬编码 `AGENTS.md` 路径与 `maxBytes`（**锚点不是真源**）：改 profile 配置时要同步改脚本，否则其字节账不再代表线上。

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
| 2026-10-03 | **名实不符的读数制造了不存在的矛盾**：`listRuns` 的唯一调用方 `rewrite_status` 把「runs 目录条目数」显示为「未收尾评测轮：20」；实测该目录 20 条为 `done 11 · failed 9`、**未收尾 0**。我为这个假矛盾排查一整圈（先后排除孤儿 / stale 构建 / 未收尾三个假设）；真因另有独立一层——`evolveDataDir` 被 profile patch 覆盖到 `E:/alice/.evolve`，而 `plugin_inspect` 的 `config` 字段报空、看不出该配置。**修正**：`listRuns` 返回记录对象（含 `status`，过形状白名单），`status.ts` 报「runs 记录 N（分布）· 未收尾 M」，未收尾取白名单（未知一律计入）。**教训**：只报一个数、且措辞不准的读数，比不报更危险——它让读者（包括我）为一个不存在的问题投入整圈。 |
| 2026-10-08 | **第三版能力：回收**（v0.5.0 管「不丢」⇒ upsert；v0.5.1 管「不超」⇒ 预算守卫；本轮管「**变旧**」）。触发背景：`self-test` 段实测 **4,666 B / 11 条**且只增不减，全文件余量 1,245 B ÷ 条目中位 382 B ⇒ **再约 3 条规则就撞线**；而每次人肉腾空间都要降级一条正本规则的表达力（**单调消耗，不可持续**，当日已用「§5.20 降为骨架」治标）。治本 = 撞线时自动迁最旧条至归档层 + 段内留一行指针。**刻意不做的事**：① 不设「段上限」配置（会随正文本体增长而腐化，且提前回收＝白牺牲表达力）；② 不迁进 `docs/rulebook.md`（它自己贴顶 ⇒ 换容器不解决撞线）；③ 不在 `applyBlockSet` 路径上加回收（版本化替换是整体换，天然有界——**只有累积段会单调增长**，机制只加在真需要它的地方）。 |
| 2026-10-08 | **判据② 抓出一处真设计缺陷（不是夹具没调好）**：回收最初只求「放得下」（`allowed`），真字节账端到端实测**迁完余量只剩 490 B**——下一次写入立刻又撞线，等于把「人肉腾空间」换成「每次写入都回收」。⇒ 引入**目标余量** `reserveBytes`（缺省 1,024）：以「回到安全区」为目标，达不到时尽力而为并如实报 `tight`（截断回最少迁移量，不为没达到的目标白迁条目）。**方法论**：判据②（余量 ≥ 1,000）看起来像「测试参数没设好」，实为**设计意图缺失**的探针——先怀疑夹具、再复算，直到算出**条件互相矛盾**（`指针 + reserve > 可迁移量`）才定论是设计问题。**改判据之前先算完不等式**。 |

## 10 · 未决问题

1. **两个历史标记段是否合并**：`evolve` 与 `self-test` 语义已同源（都是规则），但合并会改 `AGENTS.md` 既有结构，且 `dsh-evolution-core` 可能按段名读取 ⇒ 迁移期保持两段。
2. **`AGENTS.md` 余量**：2026-10-08 实测 **63,555 / 64,800 ⇒ 余量 1,245 字节**（当日已用「降级 §5.20 为骨架」治标腾出）。自 v0.6.0 起累积段有了回收，**撞线不再需要人肉腾空间**；但**正文本体仍只增**，且 `docs/rulebook.md` 另有 40,000 字符上限、当前贴顶 ⇒ 那两处的腾挪仍待主人裁。
3. **`dsh-evolution-core` 的字段兼容**：路径已保持（§5.3），但若本件改了字段形状，其读取面需同步——待退役后实测确认。
4. **`rewrite_evaluate` 的评测链路未线上验证**：`startRound` / `submitRun` 依赖 modeltest 工作区与 `run_full_eval`，本次只做了编译与纯函数验收。
