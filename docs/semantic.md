# dsh-agent-self-rewrite — 自改写引擎（语义文档）

## 1 · 元信息

| 项 | 值 |
|---|---|
| 能力名 | 自改写引擎（AGENTS.md 标记段的唯一写者） |
| 插件 | `self-plugins/dsh-agent-self-rewrite` |
| 状态 | draft（工具面未落地，见 §7 的 `pending`） |
| 替换 | `dsh-agent-self-test` + `dsh-agent-evolve` |
| 设计依据 | `docs/plans/插件融合设计_自改写与蒸馏_2026-09-23.md` |
| 事故背景 | `t-d7b9739f`（AGENTS.md 规则段被整块替换抹掉，两次） |
| 最近复核 | 2026-09-23 |

## 2 · 定位与反定位

**定位**：**改变我自己的唯一通道**——把「猜想 → 采证 → 裁决 → 写入 → 跨代验证 → 保留或回滚」做成一条有单一写者的闭环。

**反定位（不做）**：不做日常记忆沉淀（归 `dsh-agent-memory`）；不做五环状态的**只读**聚合与建议（归 `dsh-evolution-core`）；不做提示词/预设的渲染分发（那是消费端）。

## 3 · 术语

| 术语 | 含义 |
|---|---|
| 假设（Hypothesis） | 一条**可证伪**的自我陈述 + 探针（探针决定它靠什么证据被检验） |
| 证据（Evidence） | 探针在真实工具调用中**被动**采到的观测（不是专门跑的实验） |
| finding | 证据达阈值的假设 + **方向**（支持 / 反对 / 混杂 + 倾向度分档） |
| 裁决 | 对 finding 的动作：`confirm`（布线）/ `refute`（淘汰）/ `refine`（改判据重采） |
| 标记段（Block） | `AGENTS.md` 里由起止 marker 围出的受管区段；本件按 id 登记并独占写入 |
| 资源（Resource） | 版本化本体资源：`agent-rules`（= 标记段）/ `candidate-prompt` |
| 锚点（Anchor） | 已验证并冻结的版本；锚点链单调，回滚只回既有锚点 |
| 轮（Round） | 一次「起一代 → 派发白纸子智能体 → 评测 → 入账」 |
| 拒写（Reject） | 唯一写入口的四类响亮失败之一：调用方**不得写盘** |

## 4 · 概念模型与不变量

概念：`Hypothesis` · `Evidence` · `Finding` · `Resource` · `Anchor` · `Round` · `Block`。

不变量：

- **I1 · AGENTS.md 只有一个写者**——本件；其他任何插件不得写该文件的标记段。
- **I2 · 无证据不写**——任何写入必须携带一个已裁决的 finding，或一个已版本化的资源变更。
- **I3 · 写入是 upsert + 预算守卫**——按内容合并，**绝不整块替换**；超预算时**拒写**并报错，不截断。
- **I4 · 只增不减**——新规则追加在块尾，既有条目顺序与内容原样保留；块外内容一律不动。
- **I5 · 标记损坏响亮失败**——起止标记只出现一个、或顺序颠倒 ⇒ 拒写（绝不产出读不回来的块）。
- **I6 · 锚点链单调、回滚可逆**——`commit` 只追加锚点，`rollback` 只回到既有锚点，不产生新版本号。

## 5 · 契约

### 5.1 唯一写原语（已落地）

`src/wiring.ts` 的 `applyRuleUpsert(full, req)` 是**唯一写入口**，纯函数、不碰文件系统：

```ts
applyRuleUpsert(full: string, req: { blockId: string; draft: string; maxBytes: number }): WriteOutcome
```

返回 `ok: true` 才允许落盘，其中 `content` 是应写盘的整文件新内容；任何拒绝路径都**不返回新内容**（调用方无从写盘），并带闭集 `reason` 与可诊断 `detail`。

| `reason` | 触发条件 |
|---|---|
| `unknown-block` | `blockId` 不在 `MANAGED_BLOCKS` 登记表内 |
| `empty-draft` | 草稿归一化后为空（调用方规则串构造有误，不静默跳过） |
| `corrupt-markers` | 起止标记只出现一个，或起止顺序颠倒 |
| `over-budget` | 写入后的 UTF-8 字节数超过 `maxBytes` |

### 5.2 受管标记段登记表（已落地）

`MANAGED_BLOCKS` 是 marker 字面量的**唯一真源**（写入与解析共用，避免两处各写一份）：

| id | marker |
|---|---|
| `evolve` | `<!-- dsh-agent-evolve:start -->` … `<!-- dsh-agent-evolve:end -->` |
| `self-test` | `<!-- dsh-agent-self-test:start -->` … `<!-- dsh-agent-self-test:end -->` |

两个 id 都是**历史遗留段**：它们由被替换的两件写入，迁移期必须能按原 id 继续读写，否则新件上线当天就会与旧段脱钩（旧段留在文件里、新件往别处写 ⇒ 双份规则）。

### 5.3 调用点清单

| 调用方 | 调用点（文件:符号） | 时机 | 状态 |
|---|---|---|---|
| cordis 宿主 | `src/index.ts:name / inject / Config / apply` | 插件激活 | 未落地 |
| 宿主 agent | `rewrite_status` | 一屏看全（活假设 / 待裁决 finding / 锚点链 / 未收尾轮） | 未落地 |
| 宿主 agent | `rewrite_hypothesis` → `src/hypotheses.ts` | 登记 / 细化 / 淘汰假设 | 未落地 |
| 宿主 agent | **`rewrite_verdict` → `src/wiring.ts:applyRuleUpsert`** | **唯一写 `AGENTS.md` 标记段的入口** | 原语已落地，工具未落地 |
| 宿主 agent | `rewrite_evaluate` → `src/evaluator.ts:runFullEval` | 起一代 → 派发 → 收尾 → 收尸 | 未落地 |
| 宿主 agent | `rewrite_commit` → `src/anchors.ts` | 提升则锚定，否则回滚 | 未落地 |
| 宿主 agent | `rewrite_history` → `src/store.ts:ledger` | 读履历 | 未落地 |
| 外部脚本 | `<modeltestDir>/evaluator/{make_broken_project,run_full_eval}.py` | 经 `pythonBin` 启动 | 未落地 |
| 本件 | `<dshHome>/.agent-presets/evolve-live/` | 渲染当前配置（运行时发现，无需重启） | 未落地 |
| **禁止** | 任何其他插件写 `AGENTS.md` 标记段 | 由 I1 约束（唯一写者） | 待退役验收 |

## 6 · 边界与信任

- **信任源**：只有 `run_full_eval` 的 `summary.json` 是评分权威；本件不自行打分。
- **危险面**：`rewrite_verdict` 直接改我的规则 ⇒ 影响我自己的行为。兜底 = 锚点链 + `rollback` + **字节预算守卫（超限拒写，不截断）**。
- **写入边界**：唯一写入是 `AGENTS.md` 的**标记段**（upsert 按内容合并，块外内容一律不动）。
- **预算口径**：UTF-8 字节数，不是字符数（中文按 3 字节计）。`AGENTS.md` 在 2026-09-23 实测 64,434 字节，而注入截断点实测约 65,242 ⇒ 余量仅约 808 字节，故 `maxBytes` 缺省值必须留出余量。
- **失败语义（不静默）**：四类拒写 + 父 agent 解析失败 + 评测无 summary + 未收尾轮——都抛带诊断的错误，不静默降级。
- **凭据**：不读凭据、不联网（除评测脚本自身）。

## 7 · 可证伪验收

| 可证伪命题 | 证据（一次测量） | 状态 |
|---|---|---|
| 超预算时拒写而非截断，且内容逐字节不变 | `node --test tests/*.test.mjs` 的「尸体：超预算」用例 | 已实测 |
| 起止标记只出现一个时拒写 | 同上「尸体：起止标记只出现一个」用例 | 已实测 |
| 起止标记顺序颠倒时拒写（且反证 naive 路径读不回） | 同上「尸体：起止标记顺序颠倒」用例 | 已实测 |
| 空草稿拒写而非静默跳过 | 同上「尸体：空草稿」用例 | 已实测 |
| 未登记 id 拒写且 detail 列出已登记 id | 同上「尸体：未登记的标记段 id」用例 | 已实测 |
| upsert 保留块外内容（三个哨兵逐字仍在） | 同上「块外哨兵全部保留」用例 | 已实测 |
| 重复 upsert 幂等（第二次内容逐字节不变） | 同上「重复 upsert 幂等」用例 | 已实测 |
| 文件里没有该标记段时追加到文件尾 | 同上「首次安装」用例 | 已实测 |
| 预算口径是 UTF-8 字节（`中文` = 6 字节） | 同上「预算口径是 UTF-8 字节」用例 | 已实测 |
| 构建通过且声明文件产出 | `tsc -p tsconfig.json` 退出码 0 | 已实测 |
| 全仓只有本件写 `AGENTS.md` 标记段 | `grep -rn 'AGENTS.md' self-plugins/*/src/*.ts` 后逐个确认写调用，只有本件命中 | 待验收 |
| 工具面 6 个可答 | `rewrite_status` 返回假设库与锚点链 | 待验收 |
| 回滚只回既有锚点、不产生新版本号 | `ledger.json` 的 `anchors` 长度与 `rollbacks` 记录 | 待验收 |
| 旧两件退役后五环仍完整 | `evolution_cycle` 报五环健康且无断点 | 待线上验收 |

## 8 · 与实现的关系

**生效判据**（改了代码后怎么证明真的在跑新构建）：

1. **构建-进程先后**：`lib/index.js` 的 mtime 必须**晚于** web 进程启动时间（mtime 新只证明构建过，不证明进程在跑它）。
2. **工具可答**：`rewrite_status` 能返回假设库与锚点链 ⇒ 已在本进程加载。
3. **唯一写者取证**：`grep -rn 'AGENTS.md' self-plugins/*/src/*.ts` 后逐个确认**写调用**——只有本件命中（注释里提到不算）。
4. **落盘产物**：`<dataDir>/ledger.json`、`hypotheses.json`、`runs/<runId>.json` 出现且 mtime 前进。

**当前落点**：`src/wiring.ts`（唯一写原语，已落地）、`tests/wiring.test.mjs`（14 用例，含 5 个尸体）、`lib/`（构建产物）。

**未落地落点**：`src/index.ts`、`src/hypotheses.ts`、`src/evaluator.ts`、`src/anchors.ts`、`src/store.ts`。**本件当前不可挂载**（`main` 指向的 `lib/index.js` 尚未实现）。

**回退**：unmount 本件 → 把 `dsh-agent-self-test` / `dsh-agent-evolve` 从 `_archive/` 还原并重挂；数据未动（同一 `dataDir`）⇒ 无损。

**依赖方**：`dsh-evolution-core` 读旧两件的状态 ⇒ 必须保持**同一状态文件路径与字段**，或同步更新其读取面（见 §10）。

## 9 · 实践修订记录

| 日期 | 修订 |
|---|---|
| 2026-09-23 | 首版：从设计稿迁入语义文档形状（术语 / 调用点清单 / 边界与信任 / 与实现的关系），并落地唯一写原语与尸体测试。 |
| 2026-09-23 | **尸体测试逼出一条真缺陷并当场闭合**：守卫原本只查「起止标记只出现一个」，两标记齐全但**顺序颠倒**时放行 ⇒ 走「无块」分支追加，而追加出的块按 first-start / first-end 永远读不回来（写成功但读不回 = 静默损坏）。修复：`applyRuleUpsert` 增加顺序颠倒判据，并把反证（naive 路径确实读不回）写进测试，证明该守卫不可省。 |

## 10 · 未决问题

1. **`dsh-evolution-core` 的读取面**：它聚合旧两件的实时状态。本件保留同路径状态文件即可兼容；但若改了字段，`evolution-core` 必须同步——是**保持兼容**还是**一起重设计**，待主人裁。
2. **`AGENTS.md` 余量告急**：实测 64,434 / 截断点约 65,242 ⇒ 余量约 808 字节。新件的 `maxBytes` 缺省值取多少、以及是否该把旧版史继续迁出以腾空间，待定。
3. **两个历史标记段是否合并**：`evolve` 与 `self-test` 两段语义已同源（都是「规则」），但合并会改 `AGENTS.md` 的既有结构，且 `dsh-evolution-core` 可能按段名读取 ⇒ 迁移期先保持两段，合并与否待裁。
4. **迁移窗口**：退役 + 重挂载是组合变更，需预检 + 重启；出行期不做。
