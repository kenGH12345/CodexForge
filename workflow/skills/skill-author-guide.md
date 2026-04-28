---
name: skill-author-guide
version: 2.0.0
description: |
  Meta-skill：指导 LLM 在 `bridge gen-skill` 的 Step 2（IDE Agent 自合成 SKILL.md 环节）
  生成高质量、覆盖全面、带真实证据的项目专家 skill。v2.0 引入四维推导框架
  （D1 结构 / D2 行为 / D3 通讯 / D4 契约），让维度清单可自我补全。触发：当你收到
  `gen-skill` 返回 `nextStep=USER_CONFIRM_GENERATE` 或 `MANDATORY_NEXT_ACTION.type=READ_META_SKILL_FIRST` 时，
  MUST 完整读完本文件再开始生成。
triggers:
  keywords:
    - gen-skill
    - generate skill
    - 生成skill
    - 生成项目skill
    - 项目专家skill
    - skill-author
    - author skill
    - SKILL.md
    - 合成skill
  roles: [skill-author, developer, architect]
  phases: [gen-skill-step-2]
---

# Skill Author Guide — 项目专家 Skill 生成元技能

> 本文件是 **给 IDE Agent（LLM）看的**，不是给终端用户的文档。
> 作用：告诉你**该查什么、查到什么算够、怎么证明查过了**，从而产出高质量的项目专家 `SKILL.md`。

<!-- PROGRESSIVE_LOAD_TRIGGER: gen-skill|生成skill|author-skill|SKILL.md -->

---

## §0. 推导规则入口（v2.0 新增）

### 阅读顺序（MANDATORY）

```
[本文件主干] → [dimension-framework.md] → [p0-dimensions.md 对应维度] → [examples.md 对照好坏例]
```

**在开始写 SKILL.md 前**，你必须按顺序读取以下 meta-skill 组件：

1. **本文件**（你正在读的）— 提供 rubric + 强制前置动作 + 自检清单
2. **`workflow/skills/skill-author-guide-refs/dimension-framework.md`** — 定义 **D1~D4 四维正交坐标系**，是维度清单的**生成规则**，不是维度清单本身
3. **`workflow/skills/skill-author-guide-refs/p0-dimensions.md`** — 17 节具体 rubric（每节含象限徽章 `[D1/D2/D3/D4]`）
4. **`workflow/skills/skill-author-guide-refs/examples.md`** — 14+3 组 ❌坏例 vs ✅好例对比

### 为什么要读 dimension-framework.md

本文件给你的是**一份具体的 17 节清单**（§3 内容结构模板）。但清单是经验产物，**下次来新项目可能缺维度**。dimension-framework.md 给你的是**推导规则**：沿 D1 结构 / D2 行为 / D3 通讯 / D4 契约 四个正交维度逐项检查，**可以穷举**该项目的所有专家知识。

**具体价值**：
- 知道一个证据属于哪个象限 → 知道归到哪一节
- 知道某象限证据稀少 → 知道可能漏写了维度
- 知道项目确实不适用某象限 → 知道可以合法跳过

### 触发本文件的 3 种场景

| 场景 | 动作 |
|---|---|
| 收到 `bridge gen-skill` 的 JSON 响应，`nextStep=USER_CONFIRM_GENERATE` | ✅ 必读本文件 |
| 收到 `MANDATORY_NEXT_ACTION.type=READ_META_SKILL_FIRST` | ✅ 必读本文件 |
| 用户说"帮我生成项目专家 skill" / "给这个项目生成 SKILL.md" | ✅ 必读本文件 |
| 用户只是问"gen-skill 是什么" | ❌ 不需要读（只是讨论，没有生成任务） |

### 一句话定位

**本文件 + dimension-framework.md 共同定义：**
- 本文件 = "**怎么做**"（SOP/流程/自检）
- framework = "**检查什么**"（维度清单/完备性/盲区）
- p0-dimensions = "**每个维度要多深**"（rubric）
- examples = "**写成啥样才算对**"（对比样本）

---

## §0.1 使用场景与触发条件

### 何时读本 guide

| 场景 | 动作 |
|---|---|
| 收到 `bridge gen-skill` 的 JSON 响应，`nextStep=USER_CONFIRM_GENERATE` | ✅ 必读本文件 |
| 收到 `MANDATORY_NEXT_ACTION.type=READ_META_SKILL_FIRST` | ✅ 必读本文件 |
| 用户说"帮我生成项目专家 skill" / "给这个项目生成 SKILL.md" | ✅ 必读本文件 |
| 用户只是问"gen-skill 是什么" | ❌ 不需要读（只是讨论，没有生成任务） |

### 一句话定位

**本文件是 rubric + 清单，不是模板**。你不需要机械照抄章节，但你必须满足每个维度的最低证据要求。

---

## §1. 强制前置动作（MANDATORY — 落笔前必做）

### 1.1 并行读取 3 个核心数据源

**一次性并行发起**（同一个 tool_use 批次内），不要串行：

```
read_file output/code-graph.json
read_file output/business-logic.json   （如存在）
read_file output/api-endpoints.json    （如存在）
```

**如果项目没有 code-graph.json** → 立即停止，告诉用户先跑 `node workflow/init-project.js --path <dir>` 生成图谱，否则你产出的 skill 只能靠猜。

### 1.2 按 D 维度抽取 4 组关键信号（v2.0 升级）

读到 `codeGraph` 后，**按四维坐标系**（详见 dimension-framework.md）分 4 组提取信号。每组都是必查项：

#### 📘 D1 结构组（代码如何组织）

| 信号 | 字段 | 用途 |
|---|---|---|
| **filePaths 分层** | `codeGraph.filePaths[]` 按顶层目录归组 | §2 模块管理、§5 架构框架 |
| **categoryStats** | `codeGraph.categoryStats{}` | 符号分布推断范式 |
| **Reusable symbols** | `codeGraph.reusableSymbols[]` | §12 公共组件/工具库 |
| **目录树** | 从 filePaths 聚合顶层 2 级目录 | §1 项目概览 |

#### 📗 D2 行为组（运行时发生什么）

| 信号 | 字段 | 用途 |
|---|---|---|
| **Top-20 hotspots** | `codeGraph.hotspots[]` 按 cb/refs 倒序 | §3 设计模式、§1 项目流程 |
| **entryPoints** | `businessLogic.entryPoints` 或 filePaths 扫 main/Main | §2 项目流程与生命周期 |
| **businessFlows** | `businessLogic.businessFlows`（可选） | §2 典型处理链 |
| **生命周期钩子** | 符号名含 OnStart/Awake/Init/Dispose | §2 生命周期 |

#### 📕 D3 通讯组（组件间数据/控制流）← v2.0 重点强化

| 信号 | 字段/方法 | 用途 |
|---|---|---|
| **Top-20 跨模块 callEdges** | `codeGraph.callEdges{}` 聚合 fromMod→toMod+callCount | §14 模块间通讯、§M-2 修改影响半径 |
| **事件系统集群** | 符号名含 `Fire`/`Emit`/`Publish`/`Dispatch` | §6 事件系统 |
| **MVVM 数据绑定** | 符号名含 `addXxxListener`/`observe`/`subscribe`/`PropertyChanged` | §13 MVC 数据流 ✨ |
| **网络通讯类** | 符号名含 `Network`/`Connection`/`Socket` + 按模块路径 | §10 网络通信 |
| **DI/单例模式** | 命名：`Singleton<T>.Instance`/`XxxSys.I`/`getInstance()` | §14 模块间通讯选型 |

#### 📙 D4 契约组（接口/协议/DTO 约定）← v2.0 重点强化

| 信号 | 字段/方法 | 用途 |
|---|---|---|
| **接口集群** | `codeGraph.symbols.filter(s => s.k === 'interface' \|\| /^I[A-Z]/.test(s.n))` | §15 接口契约 |
| **协议文件** | filePaths 过滤 `/Proto\|Protocol\|Msg\|Packet\|Request\|Response\|DTO/` | §15 协议契约 ✨ |
| **最大文件 Top-5** | 按 `fs.statSync(fp).size` 倒序 | 发现自动生成协议代码 |
| **错误码/异常** | 符号名含 `Error`/`Exception`/`ErrCode`/`Result` | §M-1 错误处理 |
| **IDL 文件** | filePaths 过滤 `/\.(proto\|thrift\|fbs\|graphql)$/` | §15 协议工具链 |

### ⚠️ 必须平衡四维

**完成 1.2 后，强制自检**：四组信号**是否都有内容**？

- **D1/D2 为空** → 项目可能是纯协议/配置文件库（少见），但要确认
- **D3 为空** → **很可疑**（大部分项目都有模块间通讯），请回去扫跨模块 callEdges 和事件/单例命名
- **D4 为空** → 若项目是纯 CLI/本地工具可接受，否则检查是否漏扫 interface / 协议文件

**经验教训**：2026-04 之前的 meta-skill 只提取了 D1/D2 信号，导致 D3/D4 章节（MVC 数据流 / 模块间通讯 / 协议契约）普遍空白或缺失。v2.0 强制四维平衡就是补这个盲区。

### 1.3 强制深读 ≥ 5 个真实源文件

不要仅凭符号名猜语义。从 Top-20 hotspots 里挑 5 个不同文件 `read_file`，真正看代码。

**典型反面教训**：看到一个叫 `EventBus` 的类就断言"本项目用 Observer 模式"，但打开文件发现它只是个常量配置类。

### 1.4 按需读 references（本目录同级）

主文件只给你总纲。详细规则分散在 `workflow/skills/skill-author-guide-refs/` 下：

| 什么时候读 | 读哪个文件 |
|---|---|
| 开始为任一 P0 维度写内容前 | `workflow/skills/skill-author-guide-refs/p0-dimensions.md`（找到对应维度章节） |
| 项目有资源管理/并发/性能/构建等 P1 特性 | `workflow/skills/skill-author-guide-refs/p1-dimensions.md` |
| 不知道怎么从 code-graph 抽信号 | `workflow/skills/skill-author-guide-refs/evidence-recipes.md` |
| 不确定某节写得够不够好 | `workflow/skills/skill-author-guide-refs/examples.md`（对照 ❌坏例 vs ✅好例） |

### 1.5 决定跳过的维度

不是所有项目都需要全 14 节。若某维度项目**确实没有**（例如纯 CLI 工具没有事件系统），**写一句 "本项目未使用此维度" 即可**，但必须说明**为什么没有**（基于你的调研结论）。

❌ 严禁：整节留空或用"TODO"应付。

---

## §2. 质量 Rubric 总览

产出的 SKILL.md 按 6 维度打分，每维度 1-4 分，**总分 < 18 请回炉重写**。

| 维度 | 不合格 (1) | 合格 (2) | 良好 (3) | 优秀 (4) |
|---|---|---|---|---|
| **架构概览** | "本项目使用分层架构" | 列出实际层次+每层文件数 | + 每层核心职责 | + 每层交互数据流图 |
| **模式识别** | "使用 Observer 模式" | 模式出现的 ≥3 文件路径 | + 1 段真实代码 | + 为什么选这个模式的 rationale |
| **模块依赖** | 无 | Top-5 依赖列表 | + callCount 数字 | + 修改时的连带影响说明 |
| **可复用符号** | 随便列 10 个函数 | Top-20 hotspot + signature | + 使用示例代码 | + 注意事项 + 反例 |
| **踩坑指南** | 无/只写"注意错误处理" | 3 条项目特有坑 | + 每坑带源码位置 | + 规避的代码模板 |
| **扩展指引** | 无 | "添加新 X 去 Y 目录" | + step-by-step | + checklist + 必须遵守的约定 |

**合格线 = 18 分**。18 分意味着每个维度至少"合格 (2)"。

---

## §3. 内容结构模板（17 节固定结构 · v2.0 扩展）

产出的 SKILL.md **必须包含以下 17 节**（若某节不适用写一句跳过，详见 §1.5）。每节用中文，章节标题用 `## N. <中文名> [Dx]` 格式（Dx 是象限徽章，便于读者定位）。

| # | 章节 | 象限 | 期望字数 | 期望证据 |
|---|---|---|---|---|
| 1 | **项目概览** | 综合 | 300-500 | 表格：引擎/语言/规模/主模式；目录结构树 |
| 2 | **项目流程与生命周期** | [D2] | 400-600 | 入口文件路径 + 启动→处理→销毁主流程 + 至少 1 段调用链 |
| 3 | **模块管理** | [D1] | 400-600 | 模块清单 + 依赖关系 + 加载顺序 |
| 4 | **设计模式** | [D2] | 500-800 | ≥3 个具体模式，每个带代码证据 |
| 5 | **架构框架（MVC / 分层等）** | [D1] | 400-600 | 明确的数据流方向 + 每层职责 |
| 6 | **事件系统** | [D3] | 400-600 | 事件枚举 + 订阅/发布入口 + 典型事件链 |
| 7 | **状态管理** | [D2] | 400-600 | 状态归属 + 状态机 + 全局状态清单 |
| 8 | **配置与数据驱动** | [D4] | 300-500 | 配置文件清单 + 读取入口 + 环境差异说明 |
| 9 | **持久化与存档** | [D4] | 300-500 | 序列化格式 + 版本兼容策略 |
| 10 | **网络通信** | [D3] | 300-500 | 协议层 + 序列化 + 错误重连 |
| 11 | **日志系统** | [D2] | 200-400 | logger 入口 + 格式约定 + 分级规范 |
| 12 | **公共组件与工具库** | [D1] | 500-800 | ≥10 个 reusableSymbols，带 signature 和用法 |
| **13** | **✨ MVC 数据流与绑定** | **[D3]** | 400-700 | 数据层入口 + 视图绑定基类 + 生命周期 + "数据变→视图更"完整示例 |
| **14** | **✨ 模块间通讯契约** | **[D3]** | 500-800 | 跨模块 callEdges Top-10 + ≥3 种通讯手段 + 选型决策表 + 硬规则 |
| **15** | **✨ 协议与契约定义** | **[D4]** | 500-800 | 协议文件清单 + 工具链 + 编解码示例 + 版本兼容策略 |
| M-1 | **错误处理与容错策略** | [D4] | 300-500 | 错误哲学（抛异常 vs 返回错误码） + 主错误类型 |
| M-2 | **修改影响半径速查表** | [D3] | 400-600 | 按模块的 callEdges 统计 + 改此模块要连带检查的清单 |
| M-3 | **新人 Onboarding 路径** | 元 | 300-500 | 前 3 天该读的 5-7 个文件 + 阅读顺序 |

**总字数目标**：≥ 6000 字（不含代码块）。若 < 4000 字，说明没调研到位，回去重读源码。

**象限平衡要求**（v2.0 新增）：
- D1 至少 3 节有实质内容（§3/§5/§12）
- D2 至少 3 节有实质内容（§2/§4/§7/§11 中至少 3 节）
- **D3 至少 3 节有实质内容**（§6/§10/§13/§14/M-2 中至少 3 节，含至少 1 节新维度）
- **D4 至少 2 节有实质内容**（§8/§9/§15/M-1 中至少 2 节，含至少 1 节新维度）

**若某象限完全空白**：回头检查 §1.2 的 4 组信号抽取——大概率漏了。

---

## §4. 维度 Rubric 详细索引

主文件只给骨架。每个维度的 **调研配方 / 最低证据 / 输出 Schema / 反模式** 都在 references 里：

- P0 业务维度（11 项：§1-§12，不含 M）→ 读 `workflow/skills/skill-author-guide-refs/p0-dimensions.md`
- P0 元维度（3 项：M-1/M-2/M-3）→ 同上
- P1 可选维度（资源管理/并发/性能/构建/测试/术语词典）→ 读 `workflow/skills/skill-author-guide-refs/p1-dimensions.md`

**强烈建议**：对每个维度，先读 p0-dimensions.md 的对应小节再落笔。

---

## §5. 证据提取速查

不知道怎么从 `codeGraph` 的原始 JSON 里抽出想要的信号？→ 读 `workflow/skills/skill-author-guide-refs/evidence-recipes.md`，里面有：

- hotspots 排序 one-liner
- callEdges 聚合为模块级耦合矩阵的配方
- filePaths + symbols[i].f 关联的 schema 说明
- 如何用 `grep_search` 反查某符号是否真属于某模式

---

## §6. 实例参考

不确定某节该写多详细？→ 读 `workflow/skills/skill-author-guide-refs/examples.md`，覆盖 14 节 的 ❌坏例（~50字，空话）vs ✅好例（~200字，带证据）对比，**仅两档，无中庸例**。

**使用方式**：写完某节后 read_file 对应好例，对比自己是否达到同等深度。

---

## §7. 反模式清单（这样写就重写）

以下 9 类写法出现 **即判定不合格**，必须回炉重写：

1. ❌ **通用软件工程建议**：如"记得写注释"、"遵循 SOLID"、"保持代码简洁" —— 任何项目都能套用的话 = 零信息量
2. ❌ **模式名甩锅**：写"本项目使用 Observer 模式"但不说在哪几个文件、怎么用、为什么选它
3. ❌ **伪造文件路径**：写路径前必须 read_file 或 list_dir 验证存在；**宁缺毋滥**
4. ❌ **数字照搬无解释**：把 code-graph 的 "3633 refs" 原样抄进去而不说明为什么这么高（它代表什么模式/集中度）
5. ❌ **章节字数不够**：某节少于期望下限的 50%，说明该节没调研清楚
6. ❌ **Pitfalls 写空话**：如"注意线程安全"、"小心内存泄漏" —— 要具体到哪个类哪个方法为什么会出问题
7. ❌ **无代码片段**：SKILL.md 必须有 ≥ 10 段 copy-paste 可用的代码示例（每大节平均 1 段）
8. ❌ **不写 how-to**：只讲"是什么"不讲"怎么扩展"，skill 就失去指导新人的核心价值
9. ❌ **整节留空或 "TODO"**：若某维度项目没有，用一句话说明"未使用 + 原因"（详见 §1.5）

---

## §8. 落盘前自检（9 问必答 · v2.0 扩展）

写完 SKILL.md 后，**在 Write 到磁盘前**，你必须自问自答以下 9 问。**任何一问答不上来 = 回去补，不要落盘**。

### 纵向深度 6 问（原 v1.0 保留）

1. **新人可用性**：一个新来的工程师只读这份 skill 能独立修一个 P2 bug 吗？
   - 若答"不能" → 缺 §M-3 Onboarding 或 §12 公共组件说明
2. **证据密度**：每个"模式声明"是否都有 ≥ 2 处源码证据？（grep 自己写的 `使用`/`采用` 关键词，看每个后面有没有跟文件路径）
   - 若否 → 去掉该声明或补证据
3. **Pitfalls 具体性**：§M-1 的坑条目是否都有**具体到类/方法**的位置？
   - 若只写了"注意 XX" → 回 §M-1 补代码位置
4. **公共组件实用性**：§12 列出的符号是否都带 signature + 使用示例？
   - 若只列名字 → 补 signature（从 code-graph symbols[i].s 取）+ 1 段代码
5. **字数合规**：总字数是否 ≥ 4000（优秀目标 ≥ 6000）？每大节是否达到 §3 表格期望下限的 50%？
   - 若否 → 识别最短的节回去补
6. **术语真实性**：通读全文，是否所有章节都使用了项目的**真实术语**（从 filePaths/symbols 名取）而不是通用词？
   - 若全是 "module"/"component"/"service" 这种通用词 → 项目术语缺失，参考 P1 维度 "术语词典"

### 横向覆盖 3 问（v2.0 新增 ← 补 D3/D4 盲区）

7. **D3 模块间通讯是否写够？**
   - 提问自己："A 模块要用 B 模块的功能时，本项目用什么手段？为什么？"
   - 若 §14 整节缺失或少于期望下限的 50% → **强制回头补**
   - 合法跳过需在 §14 明确写"本项目不适用：<具体原因>"
8. **D3 数据流（MVC/MVVM）是否写够？**
   - 提问自己："数据改变时视图如何响应？绑定生命周期是什么？"
   - 若 §13 整节缺失或只有泛泛描述（无数据 → 视图的完整代码示例） → **强制回头补**
   - 若项目是纯后端无视图层 → 合法跳过，在 §13 明确声明
9. **D4 协议契约是否写够？**
   - 提问自己："本项目有没有跨进程/跨设备的数据交换？协议定义在哪？版本兼容怎么处理？"
   - 若 §15 整节缺失 → **强制回头补**
   - 合法跳过需在 §15 明确写"本项目不适用：<具体原因>"（如纯本地 CLI 工具）

### 自检结果记录（写入 SKILL.md 末尾）

落盘 SKILL.md 时，在文件末尾附上自检矩阵：

```markdown
---

## Meta-Skill 自检矩阵（生成时记录）

| # | 问题 | 答案 | 对应章节 |
|---|---|---|---|
| 1 | 新人可用性 | ✅ 通过 / ⚠️ 部分 / ❌ 不通过 | §M-3 / §12 |
| 2 | 证据密度 | ... | ... |
| ... |
| 9 | D4 协议契约 | ✅ 通过（§15 含 3 协议文件 + 版本兼容规则） | §15 |

生成工具：skill-author-guide v2.0（四维推导框架）
```

这个矩阵让后续审计可以快速定位 skill 薄弱维度，也是 `skill-freshness-check` 命令的输入。

---

## §9. 输出 SKILL.md 的 YAML Frontmatter 规范

你产出的 SKILL.md **必须以如下 YFM 起始**：

```yaml
---
name: <project-name-kebab-case>
version: 1.0.0
description: |
  <一句话说明本 skill 指导什么；≥ 50 字；中文>
triggers:
  keywords:
    - <项目名>
    - <3-5 个项目特有术语>
    - <2-3 个技术栈关键词>
  roles: [developer, architect, <其他角色>]
generatedAt: <ISO 8601 时间戳>
llmPowered: true
confidence: <0.0-1.0，基于自检 6 问的通过率>
sourceOfTruth:
  - output/code-graph.json
  - output/business-logic.json
  - <其他你 read_file 过的关键源文件>
---
```

关键字段：
- `keywords`：触发 ContextLoader 自动注入的信号词，务必具体（避开 "code"/"project" 这种过于宽泛的词）
- `sourceOfTruth`：列出你实际读过的证据文件，让后续审计可追溯
- `confidence`：6 问全部达标 → 0.95；达标 4-5 问 → 0.7；仅达标 2-3 问 → **不要落盘，回去补**

---

## 收尾提醒

> **遵守本 guide 的唯一标尺：生成的 SKILL.md 被阅读后，新人能否少走 3 天弯路。**
>
> 如果只是换了个漂亮排版但内容空洞，你就失败了。
> 如果章节虽然稀疏但每条都有真实代码/路径/数字做证，你就成功了。

**写之前再提醒一次**：§1 的 4 个 read_file + 5 个源文件深读是**不可跳过**的。
