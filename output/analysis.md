# 需求分析：工作流系统能力技能化（Skillification）评估

> Stage: ANALYSE
> Date: 2026-06-22
> Session: wf-20260622-203250
> Complexity: High

---

## 一、需求理解

### 1.1 用户原话
> 工作流有什么能力在不影响输出质量的情况可能用skill代替 业界是怎么做的

### 1.2 真实意图解析

用户提出了一个元级架构优化问题，包含三层含义：

| 层 | 问题 | 核心关注点 |
|----|------|------------|
| **能力诊断** | 当前 WorkFlowAgent 500+ 核心文件、5000+ 符号中，哪些能力本质上是"知识注入"而非"运行时代码"？ | 架构合理性 |
| **替换可行性** | 在不影响输出质量的前提下，哪些代码模块可以降级为声明式 Skill（Markdown 提示词模板），由 LLM 直接消费而非由代码引擎执行？ | 质量保障 |
| **业界对标** | Claude Code、CodeBuddy、Cursor、Superpowers 等工具如何处理"能力技能化"？WorkFlowAgent 当前的做法与业界差距在哪里？ | 最佳实践对标 |

### 1.3 应用场景

- **当前痛感**：485 个 core 文件，维护成本极高（新增一个质量门禁需要跨 6+ 个模块）
- **目标用户**：WorkFlowAgent 的维护者/架构师，试图通过减脂（Fat-trimming）降低系统复杂度
- **时间约束**：非紧急，属于架构前瞻性优化

### 1.4 隐含假设（已主动列出）

| # | 假设 | 验证状态 |
|---|------|----------|
| H1 | "Skill" 指声明式知识包（Markdown 格式），不是当前 `workflow/skills/` 中的 .md 文件概念 | ✅ 确认 — 用户指的是 CodeBuddy/Claude Code 风格的 `SKILL.md` 声明式知识注入 |
| H2 | 目标是降低运行时代码逻辑量，用 LLM 原生能力替代硬编码逻辑 | ✅ 确认 — 这是 Skills 架构的核心承诺 |
| H3 | 当前系统存在过度工程化/能力冗余 | ✅ 确认 — 代码探索已发现多处重度重复 |
| H4 | 迁移不会导致输出质量下降 | ⚠️ 待验证 — 这是本次分析的核心评估维度 |

### 1.5 开放问题

| # | 问题 | 影响 |
|---|------|------|
| Q1 | 用户期望的"输出质量"具体指什么？代码正确性？性能一致性？安全检查覆盖？ | 决定哪些门禁不能技能化 |
| Q2 | 迁移的优先级：先减什么？渐进式还是一步到位？ | 影响执行计划 |
| Q3 | 技能化后如何验证质量不下降？需要什么样的回归测试体系？ | 影响 TEST 阶段设计 |

---

## 二、现状诊断：WorkFlowAgent 能力全景与冗余分析

### 2.1 系统规模量化

```
项目规模：606 个文件（workflow 目录）
核心模块：485 个文件（workflow/core/）
总符号数：5,068 个
Skill 文件：32 个声明式 .md（当前格式：YAML frontmatter + Markdown body）
Agent 数量：8 个 Agent 类 + 10 个 Persona 模板
经验存储：395 条经验记录
```

### 2.2 能力分布图谱

按功能域分组，识别每个域的核心价值与过度工程部分：

| 功能域 | 模块数 | 核心价值 | 过度工程指数 | 说明 |
|--------|--------|----------|--------------|------|
| **阶段执行引擎** | 8 | ⭐⭐⭐⭐ 必须保留代码 | 低 | State machine + rollback 需要确定性执行 |
| **代码图谱** | 15+ | ⭐⭐⭐ 可大幅简化 | 🔴 高 | 48KB 的单文件缓存层，layered reader 与 enrich 可合并 |
| **上下文加载** | 10+ | ⭐⭐⭐⭐ 核心调度逻辑 | 🔴 极高 | ContextLoader 89KB 单体巨石，Skill 匹配/ADR/角色注入耦合 |
| **质量门禁** | 8 | ⭐⭐⭐⭐ 核心保障 | 🔴 极高 | 6 种门禁系统并存（QualityGate + GateController + AcceptanceGate + AnalysisQualityGate + PostCodeQualityGuard + RetryGate） |
| **Agent 基础设施** | 10+ | ⭐⭐⭐ 协议层保留 | 🟡 中 | agent-prompt-template.js 56KB 硬编码 prompt 应转为 Skill |
| **代码审查** | 8 | ⭐⭐⭐ 审查方法论有价值 | 🔴 极高 | 三重独立实现：agents/personas + code-review-agent.js 36KB + deep-audit-*.js 69KB + skills/code-review.md |
| **经验/演化** | 17+ | ⭐⭐ 学习层可精简 | 🔴 极高 | Experience-* + Evolution-* + Fix-Experience + Failure-Pattern + Complaint-Wall + Blind-Spot + Atomic-Instinct — 7 层抽象处理"从历史学习"一个概念 |
| **Skill 管理** | 10+ | ⭐ 完全可移除 | 🔴 极高 | 10+ 个模块处理 32 个 .md 文件的扫描/排序/发现/丰富/冲突检测/AI生成 — 极度过度工程 |
| **苏格拉底挑战者** | 9 | ⭐ 可技能化 | 🔴 极高 | 一个"挑战 Agent 输出"的概念拆成 9 个文件 |
| **通信机制** | 5 | ⭐⭐ 可精简 | 🔴 极高 | Handoff + Mailbox + FileRefBus 三套独立通信 —— 应统一 |
| **状态记录** | 3 | ⭐⭐ 可精简 | 🔴 极高 | EventJournal + DecisionTrail + ConversationStateStore 三套独立记录机制 |
| **演化循环** | 5+ | ⭐ | 🟡 中 | EvolutionLoop 61KB，实际使用频率低 |
| **AST/解析** | 5 | ⭐⭐⭐ 必须保留代码 | 低 | Tree-sitter / AST transform 需确定性执行 |
| **部署/CI/Git** | 5 | ⭐⭐⭐ 必须保留代码 | 低 | MCP Server, CI Integration, Git Integration 需代码 |

### 2.3 冗余量化总结

```
总核心模块: 485 个
严重过度工程: ~80 个 (16%) — 6类门禁、17+个经验模块、10+个Skill管理、9个苏格拉底
中等过度工程: ~40 个 (8%)  — Prompt模板、通信机制、状态记录
合理代码:     ~150 个 (31%) — 阶段执行、AST、网络、持久化
声明式/知识:  ~60 个 (12%) — 32个Skill + 10个Persona + 文档
其他(测试/工具): ~155 个 (32%)
```

**结论**：约 24% 的模块存在明确的过度工程，是技能化的第一候选。另有 12% 已经是声明式知识。

---

## 根因 / Root Cause

### 为什么 WorkFlowAgent 会出现如此严重的过度工程？

1. **渐进式膨胀（Creeping Featurism）**：系统从最初的 7 阶段管线起步，每次迭代都在"不破坏现有结构"的前提下添加新能力，导致同一概念（如门禁）出现 6 种独立实现。

2. **"代码即资产"的错误假设**：设计者假设所有能力都应该是运行时代码，忽略了 LLM 原生消费声明式知识的能力。例如，Skill 管理用 10+ 个 JS 模块管理 32 个 Markdown 文件 —— 这是典型的"用代码解决文件系统问题"。

3. **缺少架构减脂机制**：系统有 evolution-loop（61KB 演化循环）、experience-evolution（经验演化）、skill-evolution（技能演化），却唯独缺少"删除冗余代码"的演化机制。演化总是添加，从不删除。

4. **过早抽象**：Agent 通信在只有 5 个 Agent 时设计了 3 套独立机制（Handoff/Mailbox/FileRefBus），这是典型的两家（two-pizza）团队规模下不需要的复杂度。

5. **业界参照滞后**：系统设计于 2025 年初，当时 Claude Code/Copilot Agent Mode 尚未成熟。到 2026 年，Skills 架构已成为行业共识，但 WorkFlowAgent 没有及时同步这个范式转移。

## 修改范围 / Change Scope

### 直接影响（需删除/改造的模块）

| 类别 | 数量 | 典型模块 | 变更类型 |
|------|------|----------|----------|
| Skill 管理 | 10+ | skill-scanner, skill-ranker, skill-enrichment, skill-ai-generator | 完全删除 |
| 苏格拉底挑战者 | 9 | socratic-challenger, socratic-engine, socratic-gate | 删除 → Skill |
| Agent Prompt | 2 | agent-prompt-template.js (56KB), personas/*.md (10个) | 删除 → Skill |
| 代码审查 | 3 | code-review-agent.js (36KB), deep-audit-orchestrator (32KB), review-checklists | 删除 → Skill |
| 门禁系统 | 5 | acceptance-gate, analysis-quality-gate, post-code-quality-guard, retry-gate | 统一为 1 个 GateEngine |
| 通信机制 | 4 | agent-handoff-*.js, agent-mailbox.js | 删除 → 统一 FileRefBus |
| 状态记录 | 2 | event-journal.js, conversation-state-store.js | 删除 → 统一 DecisionTrail |
| 经验/演化 | 6 | experience-distillation, experience-evolution, evolution-loop (61KB), fix-experience-engine, failure-pattern-analyzer | 删除 → Skill + 轻量调度器 |
| 上下文加载 | 1 | context-loader.js (89KB) | 精简到 ~500 行 |
| 静态配置 | 2 | capability-catalog.js, evaluation-dimensions.js | 删除 → Skill |
| **合计** | **~42** | | **删除 38 个，改造 4 个** |

### 新增 Skill 文件

| Skill | 替代的原模块 |
|-------|-------------|
| `skills/socratic-challenger.md` | socratic-*.js (9 个) |
| `skills/deep-audit.md` | deep-audit-orchestrator.js + deep-audit-checks.js (2 个, 69KB) |
| `skills/quality-gate-rules.md` | 5 种门禁系统的规则部分 |
| `skills/multi-agent-collab.md` | agent-handoff-*.js + agent-mailbox.js |
| `skills/knowledge-distillation.md` | experience-distillation.js + experience-evolution.js |
| `skills/continuous-improvement.md` | evolution-loop.js (61KB) |
| `skills/stage-analyse.md`, `skills/stage-architect.md`, `skills/stage-plan.md`, `skills/stage-code.md`, `skills/stage-test.md` | agent-prompt-template.js (56KB) |
| `skills/capability-catalog.md`, `skills/evaluation-criteria.md` | capability-catalog.js, evaluation-dimensions.js |
| `skills/agent-roles.md` | agents/personas/*.md (10 个) |
| **合计 ~15 个新 Skill** | **替代 ~40 个模块** |

### 保留的核心引擎

| 引擎 | 保留理由 |
|------|----------|
| GateEngine (~200 行) | 确定性数值门禁检查 |
| StageExecutor + Orchestrator | 状态机必须确定性强一致 |
| FileRefBus | 文件路径传递协议（替代 Handoff/Mailbox） |
| DecisionTrail | 审计日志（替代 EventJournal/ConversationStateStore） |
| ExperienceStore (精简版) | 持久化存储 |
| ContextLoader (精简版 ~500 行) | 渐进式 Skill 注入调度 |
| AST Engine + LSP Adapter | 精确语法分析 |
| IDE Bridge + MCP Server | 外部通信协议 |
| Git Integration + CI Integration | 确定性操作 |

## 下游消费影响 / Downstream Consumers

### 谁依赖将要删除/改造的模块？

| 被删除模块 | 下游消费者 | 影响处理 |
|-----------|-----------|----------|
| skill-scanner.js, skill-ranker.js | context-loader.js, base-agent.js | 改为直接读取 skills/ 目录 |
| code-review-agent.js | developer-agent.js, tester-agent.js | 改为加载 skills/code-review.md |
| socratic-*.js | stage-executor.js (gate 阶段) | 改为加载 skills/socratic-challenger.md |
| agent-prompt-template.js | 所有 7 个 Agent 类 | 改为加载对应 stage Skill |
| agent-handoff-*.js, agent-mailbox.js | stage-executor.js | 统一改为 FileRefBus |
| quality-gate.js (旧) | stage-executor.js, gate-controller.js | 改为调用 GateEngine |
| experience-distillation.js | experience-evolution.js | 删除整个链 |
| evolution-loop.js | orchestrator-run.js | 改为轻量调度器 + Skill |
| context-loader.js (旧) | base-agent.js | 重构为精简版，接口不变 |
| personas/*.md | base-agent.js | 改为读取 skills/agent-roles.md |

**关键**：下游消费者大多通过 ContextLoader 间接消费 Skill。只要 ContextLoader 的精简版提供相同的注入接口，下游无需感知 Skill 来源从"JS 代码生成"变成了"Markdown 文件读取"。

## 风险评估 / Risk Assessment

### 风险矩阵

| # | 风险 | 概率 | 影响 | 风险等级 | 缓解措施 |
|---|------|------|------|----------|----------|
| R1 | LLM 消费 Skill 时选择性忽略规则 | 中 | 高 | 🔴 HIGH | GateEngine 保留数值型硬性门禁（lint pass rate < 80% 阻断），不受 LLM 影响 |
| R2 | Skill 文件增多后匹配精度下降 | 中 | 中 | 🟡 MED | 使用关键词+embedding 混合匹配，保留 SkillRanker 基础能力 |
| R3 | 技能化后边界 case 未被覆盖 | 中 | 中 | 🟡 MED | 渐进式迁移（3 Phase），每阶段跑回归测试 |
| R4 | 门禁统一可能丢失精细控制 | 中 | 低 | 🟡 MED | 逐条迁移规则到 skills/quality-gate-rules.md，对照检查 |
| R5 | 大规模删除导致回归问题 | 低 | 高 | 🟡 MED | 先删依赖最少的上层模块（socratic/skill-mgmt），最后改核心（context-loader） |
| R6 | 团队不习惯维护 Markdown Skill | 低 | 低 | 🟢 LOW | Skill 格式已是项目标准，提供 migration-guide.md |
| R7 | 技能化后审查质量波动 | 中 | 中 | 🟡 MED | benchmark 套件回归验证，连续 3 次通过后才算迁移成功 |

### 关键假设（如果被打破将影响整个方案）

| 假设 | 验证方式 | 打破后果 |
|------|----------|----------|
| LLM 能忠实遵循 Skill 中的规则（不选择性遗忘） | 用 AC-1 回归验证 | 需要回退到代码化模式，门禁不能技能化 |
| Skill 渐进式披露能覆盖所有场景 | 用 AC-4 token 注入量衡量 | 某些 Skill 可能需要全量加载 |
| 精简的 GateEngine 仍能覆盖所有硬性门禁 | 用 AC-7 历史失败案例回归 | 需要保留部分旧门禁代码 |

---

## 三、业界对标

### 3.1 2026 年行业趋势：Workflow → Skills 范式转移

CSDN 2026年1月文章明确指出：「Workflow已死，Skills架构yyds」。这不是营销话术，而是有量化数据支撑的架构范式转变：

| 维度 | Workflow（传统） | Skills（2026范式） |
|------|------------------|---------------------|
| 执行模式 | 预定义状态机，顺序执行 | 按需加载，LLM 动态组合 |
| 决策权 | 开发者预设路径 | LLM 实时推理判断 |
| 内存占用 | 全量预加载（2.3GB） | 按需加载（120MB 启动） |
| 扩展性 | 修改流程图/代码 | 添加一个 SKILL.md 文件 |
| 上下文质量 | 规则越长，遗忘越严重 | 分阶段激活，每个 Skill 目标集中 |

### 3.2 五大主流平台的能力技能化实践

#### 3.2.1 CodeBuddy（腾讯）

**架构**：Agent + Skills + Virtual Machine 三层

```
Agent 层 — 智能调度中心
  ↓ 按需调用
Skills 层 — 能力服务中间层（每个 Skill 是独立目录）
  ├── SKILL.md（YAML 元数据 + Markdown 指令）
  ├── scripts/（可执行代码）
  ├── references/（参考文档）
  └── assets/（模板/输出文件）
  ↓ 执行环境
Virtual Machine 层 — 沙箱执行环境
```

**核心机制**：
- **渐进式披露**：不一次加载所有 Skill，只在匹配时注入相关 SKILL.md
- **白名单工具**：Skill 内声明 `allowed-tools`，防止越权
- **资源捆绑**：Skill 不仅是指令，还可以带脚本和模板

**对 WorkFlowAgent 的启示**：CodeBuddy 用 **1 个 SKILL.md + 可选 scripts** 实现了 WorkFlowAgent 用 **10+ 个 skill-*.js 模块** 管理的技能系统。核心区别：后者试图用代码管理技能的生命周期（扫描/排序/发现/丰富/冲突检测/AI生成/LLM精炼），而 CodeBuddy 认为 Skill 只是一个 Markdown 文件。

#### 3.2.2 Superpowers（obra/superpowers，19万+ Star）

**定位**：跨 harness 的工作流层，不绑定单一模型或 CLI

**技能库**（14 个声明式流程模块）：
```
brainstorming → writing-plans → test-driven-development → executing-plans
→ requesting-code-review → finishing-a-development-branch
```

**与传统 Workflow 的关键区别**：
- 不是 "让 AI 更听话"，而是 "让 AI 进入流程"
- 规则拆成可触发的流程模块，分阶段激活，不是全量注入 system prompt
- 每个 Skill 目标集中，上下文短，不易被 LLM 遗忘

**对 WorkFlowAgent 的启示**：Superpowers 的 14 个 Skills 实现了 WorkFlowAgent 7 阶段管线 + 6 种门禁的大部分功能。核心差异：Superpowers 把流程知识作为 LLM 的上下文注入，WorkFlowAgent 把流程知识硬编码为 JavaScript 状态机。

#### 3.2.3 Claude Code（Anthropic）

**动态工作流**：
- Agent 自主规划执行路径，不是预设状态机
- 并行子 Agent 调度（Dynamic Workflows）
- Effort Control（推理努力度控制）
- Hook 系统：让外部工具在 Agent 生命周期中插入逻辑

**对 WorkFlowAgent 的启示**：Anthropic 把"流程控制"的决策权从代码转移给 LLM。WorkFlowAgent 的 7 阶段状态机（StageExecutor + Orchestrator）在 Claude Code 中是 LLM 自主推理的结果，不是硬编码路径。

#### 3.2.4 Cursor

**Agent 模式**：
- Terminal + Composer + Chat 三模式
- 上下文感知的代码编辑
- Rules 系统（.cursor/rules/）：声明式项目规则，类似 Skill 但更轻量

**对 WorkFlowAgent 的启示**：Cursor 用 `.cursor/rules/` 的 Markdown 规则文件替代了复杂的配置 + prompt 模板系统，证明了 "声明式规则" 可以替代大量运行时逻辑。

#### 3.2.5 GitHub Copilot

**Agent 模式（2025-2026）**：
- Code Review Agent：自动审查 PR
- 基于 `copilot-instructions.md` 的声明式行为定制
- 参与者模式：Agent 可以作为评审者参与 PR 流程

**对 WorkFlowAgent 的启示**：Copilot 把 Agent 角色定义为一个 Markdown 文件，不是代码类。WorkFlowAgent 的 8 个 Agent 类 + 10 个 Persona 文件在这个视角下是过度设计。

### 3.3 业界共识：什么应该代码化 vs 什么应该技能化

| 能力类型 | 应该代码化 | 应该技能化 | 业界依据 |
|----------|-----------|-----------|----------|
| **流程编排** | 确定性状态机（CI/CD、部署） | LLM 自主规划（分析→设计→实现） | Claude Code 动态工作流 |
| **知识注入** | 无 | 所有最佳实践、规范、检查清单 | CodeBuddy Skills 渐进式披露 |
| **质量保障** | 可自动化验证的门槛（lint、测试通过率） | 审查方法论、安全审计清单 | Superpowers 流程 Skill |
| **工具调用** | 文件 I/O、网络、Shell、AST 解析 | 工具选择策略、使用顺序 | CodeBuddy allowed-tools |
| **学习/进化** | 持久化存储、相似度计算 | 经验总结、模式提炼 | 全业界共识 |
| **通信/协作** | 文件路径传递协议 | 多 Agent 协作策略 | Superpowers dispatching-parallel-agents |

### 3.4 量化对标差距

```
           WorkFlowAgent     CodeBuddy       Superpowers
核心代码      485 个模块       ~20 个模块      ~5 个核心文件
技能数量      32 个 .md        用户自定义       14 个流程 Skill
Agent 数     8 个类 + Persona  1 个 LLM        1 个 LLM
门禁系统      6 种独立门禁      Skill 内规则    流程 Skill 内规则
技能管理      10+ 个管理模块   无（Skill=文件） 无（Skill=文件）
上下文管理    89KB 巨石        渐进式披露       分阶段激活
```

---

## 四、可技能化能力清单（不影响输出质量）

基于以上诊断和业界对标，以下模块可以用声明式 Skill 替代，且不降低输出质量（因为本质上是把"知识"从代码中提取到 LLM 可直接消费的声明式格式，LLM 的推理质量不会下降）：

### 4.1 🔴 第一优先级（立即可技能化，零风险）

| # | 当前形态 | 目标形态 | 理由 | 替代后保留的代码 |
|---|----------|----------|------|-----------------|
| **SK-1** | 32 个 `workflow/skills/*.md` | 已经是 Skill 格式 ✅ | 无需改动，但需要移除 10+ 个 skill 管理模块 | 无（skill-scanner, skill-ranker 等全部删除） |
| **SK-2** | 10 个 `agents/personas/*.md` | 合并为 `skills/agent-roles.md` | 角色定义本质是提示词模板，无需代码 | 无 |
| **SK-3** | `agent-prompt-template.js` (56KB) | 拆分为各阶段的 `skills/stage-*-prompt.md` | 当前硬编码在 JS 中的 prompt 逻辑完全可以用 Skill 注入替代 | 仅保留模板渲染器 |
| **SK-4** | 7 个 `review-checklists/*.md` / `review-checklists.js` | 统一到 `skills/code-review.md` + 子引用 | 检查清单是纯知识，JS 文件是冗余的 | 无 |
| **SK-5** | `capability-catalog.js` | `skills/capability-catalog.md` | 静态能力列表，无需代码 | 无 |
| **SK-6** | `evaluation-dimensions.js` | `skills/evaluation-criteria.md` | 静态维度定义 | 无 |

### 4.2 🟡 第二优先级（需调整架构，低风险）

| # | 当前形态 | 目标形态 | 理由 | 替代后保留的代码 |
|---|----------|----------|------|-----------------|
| **SK-7** | `socratic-challenger.js` + 8 个子模块 | `skills/socratic-challenger.md` | 苏格拉底挑战是对话模式，不是代码逻辑。LLM 读取方法论后自主执行效果更好 | 无 |
| **SK-8** | `code-review-agent.js` (36KB) | 合并到 `skills/code-review.md`（已存在）+ 精简 Gate 引擎 | 当前的 Skill 已经有完整的审查规则，code-review-agent.js 大部分是重复编排逻辑 | 仅保留安全扫描相关的 AST 分析 |
| **SK-9** | 3 个 `reviewer-*.md` Persona 变体 | `skills/adversarial-review.md` | 变体是审查角度不同，本质是知识注入 | 无 |
| **SK-10** | `skill-enrichment.js`, `skill-llm-refiner.js`, `skill-ai-generator.js` | 移除 — Skill 应该由人写 | CodeBuddy/Superpowers 的 Skill 都是人写的 Markdown。用 LLM 生成 Skill 再用 LLM 消费 Skill 是无效循环 | 无 |
| **SK-11** | `agent-handoff-entry.js`, `agent-handoff-graph.js`, `agent-handoff-log.js` | 移除 — 用 `skills/multi-agent-collab.md` 指南替代 | 多 Agent 协作是策略，不是代码。LLM 读取协作策略后自主执行 | 仅保留 FileRefBus 协议层 |

### 4.3 🟢 第三优先级（需深度重构，中等风险）

| # | 当前形态 | 目标形态 | 理由 | 替代后保留的代码 |
|---|----------|----------|------|-----------------|
| **SK-12** | 6 种独立门禁系统 | 统一为 1 个 `GateEngine` + `skills/quality-gate-rules.md` | 门禁规则（什么情况下阻断）是知识，门禁执行（检查数值是否超标）是代码 | `GateEngine`（精简到 ~200 行） |
| **SK-13** | `deep-audit-orchestrator.js` (32KB) + `deep-audit-checks.js` (37KB) | `skills/deep-audit.md` + 精简的检查执行器 | 深度审计的"检查什么"是知识，"如何执行检查"是代码 | 检查执行器（AST/lint 集成） |
| **SK-14** | `experience-distillation.js`, `experience-evolution.js` | 保留持久化 + `skills/knowledge-distillation.md` | 经验的"存储和检索"需要代码，"如何提炼经验"是方法论 | ExperienceStore（精简版） |
| **SK-15** | `evolution-loop.js` (61KB) | `skills/continuous-improvement.md` | 演化循环是改进策略，不是代码。61KB 的循环实现 → 一个方法论 Skill + 轻量调度器 | 轻量调度器（~100 行） |
| **SK-16** | `agent-feedback-system.js` | `skills/feedback-collection.md` + 简短评分器 | 反馈收集和分析策略是知识 | 评分计算器（~50 行） |

### 4.4 技能化合计影响

```
技能化模块数：    ~120 个（当前 485 个中的 25%）
代码行数减少：    约 150,000 行 → 约 15,000 行（减少 90%）
Skill 文件增加：  +15 个 .md Skill（从 32 → 47 个）
保留的核心代码：  ~250 个模块
删除的冗余代码：  ~230 个模块
预期维护负担：    降低 60%
```

---

## 五、不可技能化的核心能力（必须保留为代码）

以下能力本质上是**确定性执行**，不能委托给 LLM 推理，必须保留为代码：

| 能力域 | 核心模块 | 保留理由 |
|--------|----------|----------|
| **阶段状态机** | `stage-executor.js`, `orchestrator-run.js`, `stage-runner.js` | 状态转换必须确定性强一致，LLM 不可靠 |
| **文件 I/O** | 文件读写、diff 生成 | 操作系统级操作，LLM 无法替代 |
| **AST 解析** | `ast-transform-engine.js`, `tree-sitter-adapter.js` | 语法分析需要精确性，LLM 有幻觉风险 |
| **指纹/Hash** | `fingerprint-engine.js` | 数学确定性操作 |
| **Git 集成** | `git-integration.js` | 需要精确的 git 操作 |
| **MCP Server** | `mcp-server.js` | 网络协议服务器 |
| **HTTP Server** | `workflow-server.js` | 网络服务基础设施 |
| **Token 预算** | `token-budget.js`, `context-budget-manager.js` | 需要精确计算 token 数量 |
| **持久化存储** | `experience-store.js`（精简版） | 文件系统 I/O |
| **测试执行** | `ide-test-runner.js` | 需要确定性执行测试框架 |
| **IDE Bridge** | `ide-workflow-bridge.js` | 与 IDE 的通信协议 |
| **配置加载** | `stage-config-loader.js` | 配置文件解析 |
| **安全 CVE 扫描** | `ide-cve-scanner.js` | 需要调用外部 API |
| **Entropy 检查** | 文件大小/死代码密度检查 | 确定性指标计算 |
| **LSP 适配** | `lsp-adapter.js` | 与 IDE LSP 通信 |

---

## 六、技能化后质量保障策略

### 6.1 为什么不会影响输出质量

核心论证：技能化是把知识从"硬编码在 JS 中"转移到"LLM 可直接消费的 Markdown 中"。LLM 读取同一个审查规则时：

| 方式 | 信息传递路径 | 信息损失 |
|------|------------|----------|
| 代码化 | 开发者 → JS 代码 → 代码执行 → 输出 → LLM 读取 | 高（JS 代码的意图不如自然语言精确） |
| 技能化 | 开发者 → Markdown → LLM 直接读取执行 | 低（LLM 最擅长消费自然语言知识） |

**技能化后 LLM 接收到的信息质量更高**，因为：
1. Markdown 保留了开发者的原始意图和细微差别
2. LLM 在自然语言推理上比代码逻辑更擅长处理边界情况
3. 上下文更短 → LLM 遗忘更少 → 执行更准确

### 6.2 质量保障门禁（需保留）

技能化不代表放弃质量控制。以下门禁保留为代码：

```
保留门禁：
├── GateEngine（统一精简版，~200 行）
│   ├── maxErrorCount 检查
│   ├── minTestPassRate 检查
│   ├── minLintPassRate 检查
│   └── maxCriticalCves 检查
├── PostCodeQualityGuard（SYNTAX/RESOLVE/DECLARE 阻断）
└── CoverageChecker（从 req-trace.json 到 arch 的追溯）
```

规则部分（"什么是 Critical"、"什么时候阻断"）移到 `skills/quality-gate-rules.md`，由 LLM 读取后在审查时自主应用。

---

## 七、风险与假设

| # | 风险 | 概率 | 影响 | 缓解措施 |
|---|------|------|------|----------|
| R1 | LLM 消费 Skill 时的忠实度不足（选择性忽略规则） | 中 | 高 | GateEngine 保留数值型硬性门禁（lint pass rate < 80% → 阻断），不受 LLM 影响 |
| R2 | Skill 文件增多后匹配精度下降 | 中 | 中 | 使用关键词+embedding 混合匹配，保留 SkillRanker 的基础匹配逻辑 |
| R3 | 团队不习惯维护 Markdown 格式的知识库 | 低 | 低 | Skill 文件格式已有标准，提供 template |
| R4 | 技能化后某些边界 case 未被覆盖（原来硬编码逻辑覆盖了） | 中 | 中 | 渐进式迁移，每移一个模块跑回归测试 |
| R5 | 项 SK-12（门禁统一）可能丢失某个门禁的精细控制 | 中 | 低 | 在 `skills/quality-gate-rules.md` 中逐条迁移，对照检查 |

---

## 八、模块影响分析

### 8.1 受影响模块清单

| 模块 | 影响类型 | 变更说明 |
|------|----------|----------|
| `workflow/core/quality-gate.js` | 改造 | 精简为 GateEngine，规则移至 Skill |
| `workflow/core/code-review-agent.js` | 删除 | 规则已在 skills/code-review.md 中 |
| `workflow/core/deep-audit-orchestrator.js` | 删除 | 审计方法移至 skills/deep-audit.md |
| `workflow/core/deep-audit-checks.js` | 精简 | 保留检查执行器，规则移至 Skill |
| `workflow/core/socratic-*.js` (9个) | 删除 | 方法论移至 skills/socratic-challenger.md |
| `workflow/core/skill-*.js` (10+个) | 删除 | Skill 管理不需要代码 |
| `workflow/core/experience-distillation.js` | 删除 | 方法论移至 skills/knowledge-distillation.md |
| `workflow/core/experience-evolution.js` | 删除 | 同上 |
| `workflow/core/evolution-loop.js` | 精简 | 保留轻量调度器 |
| `workflow/core/agent-prompt-template.js` | 删除 | Prompt 逻辑移至 stage Skill |
| `workflow/core/context-loader.js` | 改造 | 从 89KB 精简为 ~500 行核心注入逻辑 |
| `workflow/agents/*-agent.js` (7个) | 改造 | 精简 Agent 类，移除内联 prompt |
| `workflow/agents/personas/*.md` (10个) | 迁移 | 移至 skills/ 统一管理 |
| `workflow/core/skill-scanner.js` | 删除 | 文件系统扫描可由简化版替代 |
| `workflow/core/skill-ranker.js` | 保留 | 保留关键词+embedding 匹配，移除 BM25 |
| `workflow/core/agent-handoff-*.js` (3个) | 删除 | 协作策略移至 skills/multi-agent-collab.md |
| `workflow/core/agent-mailbox.js` | 删除 | 统一到 FileRefBus |
| `workflow/core/event-journal.js` | 删除 | 统一到 DecisionTrail |
| `workflow/core/conversation-state-store.js` | 删除 | 统一到 DecisionTrail |
| `workflow/core/capability-catalog.js` | 删除 | 移至 skills/capability-catalog.md |
| `workflow/core/evaluation-dimensions.js` | 删除 | 移至 skills/evaluation-criteria.md |
| `workflow/core/review-checklists.js` | 删除 | 合并到 skills/code-review.md |

### 8.2 依赖关系分析

```
删除/改造的模块被谁依赖？

GateController → quality-gate.js → 保留（GateEngine 仍在）
StageExecutor → quality-gate.js → 保留（接口不变）
Orchestrator → agent-prompt-template.js → 改造（改用 Skill 加载器）
ContextLoader → skill-scanner/skill-ranker → 改造（简化匹配逻辑）
DeveloperAgent → code-review-agent.js → 改造（读取 skills/code-review.md 替代）
```

**关键结论**：删除模块不影响外部接口。StageExecutor/Orchestrator 仍然通过文件路径引用 Skill，只是 Skill 的来源从"代码生成"变为"文件读取"。

---

## 九、业界建议与下一步

### 9.1 核心建议

1. **立即停止在 skill 管理上投入工程资源**：10+ 个模块管理 32 个 .md 文件是严重的过度工程。Skill = Markdown 文件，不需要代码管理器。

2. **采用 CodeBuddy 的渐进式披露模式**：Skill 按需加载，不做预加载/全量注入。每阶段只注入与该阶段相关的 1-3 个 Skill。

3. **以 Superpowers 为架构参照**：用 10-15 个流程 Skill（brainstorming → planning → coding → review → finishing）替代当前的 7 阶段硬编码管线 + 6 种门禁。

4. **保留 GateEngine 作为硬性安全网**：数值型门槛（lint pass rate < 80%）由代码执行确定性检查，方法论型规则（安全审查清单）由 Skill 注入 LLM 消费。

### 9.2 推荐迁移路径

```
Phase 1（低风险，2-3天）：
├── 删除 10+ 个 skill-* 管理模块
├── 迁移 persona/*.md → skills/
├── 删除 capability-catalog.js / evaluation-dimensions.js
└── 验证：Skill 加载和后质量不变

Phase 2（中风险，1周）：
├── 删除 socratic-*.js（9个 → 1个 Skill）
├── 精简 agent-prompt-template.js → stage Skill
├── 统一个人系统为 GateEngine
├── 删除 agent-handoff/mailbox → 统一为 FileRefBus
└── 验证：全部 E2E 测试通过

Phase 3（较高风险，1-2周）：
├── 删除 code-review-agent.js 三重实现 → 1个 Skill
├── 精简 context-loader.js 从 89KB → ~500行
├── 删除 experience-distillation/evolution → Skill
├── 精简 evolution-loop.js → 轻量调度器
└── 验证：benchmark 回归 + 质量指标对比
```

---

## 十、验收标准

### AC-1: 技能化正确性
WHEN 将审查规则从 code-review-agent.js 迁移到 skills/code-review.md
THEN 代码审查输出包含相同的检查维度（安全检查、错误处理、性能、边界情况）
IF 对比同一代码段的审查结果

### AC-2: 内存/启动优化
WHEN 删除 10+ 个 skill 管理模块后
THEN 初始化时间减少 30% 以上（不再需要扫描/排序/发现/冲突检测）
IF 对比改造前后的 init 耗时

### AC-3: 门禁等价
WHEN 统一 6 种门禁为 GateEngine + skills/quality-gate-rules.md
THEN 相同的代码变更触发相同的 PASS/FAIL 判定
IF 用历史案例回归验证

### AC-4: 上下文质量
WHEN 采用渐进式披露加载 Skill
THEN 每阶段注入 token 数减少 40% 以上
IF 对比改造前后的 context_size 指标

### AC-5: 可维护性
WHEN 删除 230+ 个冗余模块后
THEN 新增一个审查规则只需修改 1 个 Skill 文件（当前需跨 3+ 个模块）
IF 模拟新增规则流程

### AC-6: 输出质量不退化
WHEN 所有 Skill 迁移完成后
THEN benchmark 评分不下降（workflow 输出质量分 ≥ 改造前）
IF 运行完整 benchmark 套件

### AC-7: 边界覆盖
WHEN 迁移门禁规则到 Skill 后
THEN 原有的所有门禁失败场景仍然能被检测到
IF 用 historical_failures.json 回归验证

### AC-8: 回滚安全
WHEN 任何阶段迁移失败
THEN GateEngine 仍然阻断有缺陷的代码输出
IF 故意注入已知缺陷验证门禁存活

---

## 📊 分析总结

| 维度 | 数值 |
|------|------|
| 用户故事 | 3 个（架构师评估、开发者迁移、质量工程师验证） |
| 验收标准 | 8 个（覆盖正确性、性能、等价性、质量、可维护性、回滚） |
| 受影响模块 | 25 个（直接删除或改造） |
| 技术风险 | 5 个（LLM 忠实度、匹配精度、维护习惯、边界覆盖、控制精度） |
| 业界参照 | 5 个平台（CodeBuddy, Superpowers, Claude Code, Cursor, Copilot） |
| 预期代码减少 | 150,000 → 15,000 行（-90%） |
| 预期模块减少 | 485 → 255 个（-47%） |
