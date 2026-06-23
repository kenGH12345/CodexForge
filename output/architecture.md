# 技能化架构设计：WorkFlowAgent Skillification Architecture

> Stage: ARCHITECT
> Session: wf-20260622-203250
> Date: 2026-06-23
> Based on: output/analysis.md (ANALYSE stage)

---

## 1. Architecture Overview (C4 Context)

### 1.1 系统上下文 (System Context)

```mermaid
C4Context
    title WorkFlowAgent Skillification — System Context
    
    Person(developer, "开发者/维护者", "发起代码任务、维护 Skill 文件")
    System(wf, "WorkFlowAgent", "AI 驱动的工作流执行引擎")
    System_Ext(llm, "LLM 模型服务", "Claude/GPT，消费 Skill 并自主推理")
    System_Ext(ide, "IDE (VS Code/Cursor)", "提供 LSP、文件I/O、终端执行")
    System_Ext(vcs, "Git", "版本控制")
    
    Rel(developer, "编写/更新", wf, "Markdown Skill 文件")
    Rel(developer, "发起任务", wf, "/wf 命令")
    Rel(wf, "注入 Skill 上下文", llm, "声明式知识包")
    Rel(llm, "推理+决策", wf, "返回解决方案")
    Rel(wf, "调用工具", ide, "LSP/文件读写/终端")
    Rel(wf, "提交变更", vcs, "版本追踪")
```

### 1.2 容器图 (Container Diagram)

```mermaid
C4Container
    title WorkFlowAgent — Container View (After Skillification)
    
    Container_Boundary(engine, "执行引擎层 (保留代码)") {
        Container(orch, "Orchestrator", "Node.js", "阶段调度、状态机、桥接")
        Container(gate, "GateEngine", "Node.js", "统一数值门禁检查 (~200行)")
        Container(fbus, "FileRefBus", "Node.js", "文件路径通信协议")
        Container(storage, "ExperienceStore", "Node.js", "精简持久化存储")
        Container(ast, "AST Engine", "Node.js", "Tree-sitter 语法分析")
    }
    
    Container_Boundary(skills, "声明式技能层 (Skill .md 文件)") {
        Container(sk_stage, "Stage Skills (5个)", "Markdown", "每阶段的方法论和规则")
        Container(sk_domain, "Domain Skills (15个)", "Markdown", "代码审查、安全审计、测试生成等")
        Container(sk_flow, "Flow Skills (3个)", "Markdown", "多Agent协作、持续改进、知识蒸馏")
        Container(sk_config, "Config Skills (4个)", "Markdown", "门禁规则、能力目录、评估维度、角色定义")
    }
    
    Container_Boundary(infra, "基础设施层") {
        Container(mcp, "MCP Server", "HTTP", "外部协议集成")
        Container(ci, "CI Integration", "Node.js", "CI/CD 管道")
        Container(git, "Git Integration", "Node.js", "工作区管理")
    }
    
    Rel(orch, "按需加载", sk_stage, "阶段开始注入")
    Rel(orch, "按需加载", sk_domain, "任务匹配注入")
    Rel(orch, "调用检查", gate, "数值门禁")
    Rel(orch, "通过", fbus, "文件路径传递")
    Rel(orch, "写入读取", storage, "经验持久化")
```

---

## 2. Constraints

| # | 约束 | 类型 | 说明 |
|---|------|------|------|
| C1 | **向后兼容** | 技术 | StageExecutor 和 Orchestrator 的外部接口（`run()`、`runTaskBased()`）不变 |
| C2 | **LLM 不可用于确定性判断** | 架构 | 数值型门禁（lint pass rate、test pass rate）必须由代码执行，不能委托 LLM |
| C3 | **Skill 文件即唯一真相源** | 组织 | 知识不再存在于 JS 代码中，Skill .md 是唯一的规则定义来源 |
| C4 | **渐进式迁移** | 组织 | 三阶段迁移，每阶段独立可验证、可回滚 |
| C5 | **文件路径不变** | 技术 | `output/analysis.md`、`output/architecture.md` 等产物路径和格式不变 |
| C6 | **Node.js 运行时** | 技术 | 保持 Node.js 运行时，不引入新的运行时依赖 |

---

## 3. Context & Scope (系统边界与外部接口)

### 3.1 系统边界

```
┌──────────────────────────────────────────────────────┐
│              WorkFlowAgent (技能化后)                  │
│                                                      │
│  ┌──────────────┐   ┌────────────────────┐          │
│  │ 执行引擎       │   │ 声明式技能层         │          │
│  │ (代码 ~250模块)│◄──│ (Skill .md ~47文件) │          │
│  │              │   │                    │          │
│  │ Orchestrator │   │ stage-analyse.md   │          │
│  │ GateEngine   │   │ code-review.md     │          │
│  │ FileRefBus   │   │ quality-gate-rules  │          │
│  │ AST Engine   │   │ socratic-challenger │          │
│  └──────┬───────┘   └────────────────────┘          │
│         │                                            │
│         ▼                                            │
│  ┌──────────────────┐                               │
│  │ LLM 接口          │                               │
│  │ (Skill 上下文注入) │                               │
│  └──────────────────┘                               │
└──────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────┐
│              外部系统                                  │
│  IDE (LSP/文件I/O) │ LLM API │ Git │ OS Shell        │
└──────────────────────────────────────────────────────┘
```

### 3.2 外部接口清单

| 接口 | 方向 | 协议 | 说明 |
|------|------|------|------|
| LLM API | 出站 | HTTP/gRPC | 发送 Skill 注入的上下文，接收推理结果 |
| IDE LSP | 入站/出站 | LSP Protocol | 定义跳转、引用查找、类型推断 |
| IDE File I/O | 出站 | IDE Tools API | 读写文件、目录遍历 |
| IDE Terminal | 出站 | Shell | 执行 lint、test、git 命令 |
| Git | 出站 | git CLI | 分支管理、提交、PR |
| MCP Server | 入站 | MCP Protocol | 外部工具调用 |

### 3.3 不在范围内

- 不改变 MCP Server / WorkflowServer 的外部 HTTP 接口
- 不改变 CI Integration 的管道契约
- 不修改 `workflow/skills/` 下现有的 32 个 Skill 文件内容（只删除管理它们的 JS 代码）
- 不改变 IDE Bridge 的协议

---

## 4. Component Breakdown (组件分解)

### 4.1 目标架构组件树

```
WorkFlowAgent (技能化后, ~250 模块)
│
├─ 执行引擎层 (保留为代码, ~30 模块)
│   ├─ Orchestrator (结合: orchestrator-run + stage-runner + rollback-coordinator)
│   │   └─ 职责: 阶段调度、状态机、阶段间上下文传递
│   ├─ StageExecutor (保留, 精简版)
│   │   └─ 职责: 单阶段执行、前后门禁触发
│   ├─ GateEngine (NEW — 统一6种门禁, ~200行)
│   │   ├─ checkLintPassRate(threshold)
│   │   ├─ checkTestPassRate(threshold)
│   │   ├─ checkCriticalCves(maxCount)
│   │   ├─ checkSyntaxValidity()
│   │   └─ checkFileSizeViolation()
│   ├─ FileRefBus (保留, 统一通信)
│   │   └─ 职责: 文件路径传递 (取代 Handoff/Mailbox)
│   ├─ DecisionTrail (保留, 统一记录)
│   │   └─ 职责: 审计日志 (取代 EventJournal/ConversationStateStore)
│   ├─ ContextLoader (精简, ~500行)
│   │   ├─ SkillMatcher: 关键词 + embedding 匹配
│   │   ├─ SkillInjector: 按阶段注入 Skill 到 LLM 上下文
│   │   └─ TokenBudget: 3层预算管理 (保留)
│   ├─ ExperienceStore (精简版)
│   │   └─ 职责: 经验 CRUD + 语义搜索
│   ├─ AST Engine (保留)
│   │   ├─ Tree-sitter Adapter
│   │   └─ Fingerprint Engine
│   └─ BaseAgent (精简)
│       └─ 职责: 公共 buildPrompt() + executeTask()
│
├─ 声明式技能层 (.md 文件, ~47 个 Skill)
│   ├─ 阶段技能 (5个, 替代 agent-prompt-template.js 56KB)
│   │   ├─ skills/stage-analyse.md
│   │   ├─ skills/stage-architect.md
│   │   ├─ skills/stage-plan.md
│   │   ├─ skills/stage-code.md
│   │   └─ skills/stage-test.md
│   ├─ 领域技能 (8个扩展现有 + 7个新增)
│   │   ├─ skills/code-review.md (扩展现有 — 合并 deep-audit + code-review-agent)
│   │   ├─ skills/security-audit.md (扩展现有)
│   │   ├─ skills/test-generation.md (扩展现有)
│   │   ├─ skills/deep-audit.md (NEW — 替代 deep-audit-orchestrator 32KB)
│   │   ├─ skills/socratic-challenger.md (NEW — 替代 socratic-*.js 9个)
│   │   ├─ skills/multi-agent-collab.md (NEW — 替代 handoff + mailbox)
│   │   ├─ skills/knowledge-distillation.md (NEW — 替代 experience-distillation)
│   │   └─ ... 8个现有领域 Skill 保留
│   ├─ 流程技能 (3个新增)
│   │   ├─ skills/continuous-improvement.md (NEW — 替代 evolution-loop 61KB)
│   │   ├─ skills/brainstorming.md (NEW — 需求澄清)
│   │   └─ skills/finishing.md (NEW — 收尾检查)
│   └─ 配置技能 (4个新增)
│       ├─ skills/quality-gate-rules.md (NEW — 门禁规则)
│       ├─ skills/capability-catalog.md (NEW — 能力目录)
│       ├─ skills/evaluation-criteria.md (NEW — 评估维度)
│       └─ skills/agent-roles.md (NEW — 合并10个 persona)
│
└─ 基础设施层 (保留, 不变)
    ├─ MCP Server
    ├─ CI Integration
    ├─ Git Integration
    ├─ IDE Bridge
    └─ WorkflowServer
```

### 4.2 组件职责矩阵

| 组件 | 代码/声明式 | 行数 (before) | 行数 (after) | 减少 |
|------|-----------|---------------|--------------|------|
| Orchestrator | 代码 | ~3000 | ~1500 | -50% |
| StageExecutor | 代码 | ~2000 | ~1000 | -50% |
| GateEngine (NEW) | 代码 | 6 种门禁 ~5000 | ~200 | -96% |
| FileRefBus | 代码 | ~300 | ~300 | 0% |
| DecisionTrail | 代码 | ~400 | ~400 | 0% |
| ContextLoader | 代码 | ~89KB (~4000行) | ~500 | -87% |
| ExperienceStore | 代码 | ~2000 | ~500 | -75% |
| AST Engine | 代码 | ~1500 | ~1500 | 0% |
| Agent 类 (8个→精简) | 代码 | ~8000 | ~2000 | -75% |
| **代码小计** | — | **~28,200 行** | **~7,900 行** | **-72%** |
| Skill 文件 (32→47) | 声明式 | ~50KB | ~80KB | +60% |

---

## 5. Data Flow

### 5.1 阶段执行数据流

```
┌──────────┐   1. /wf 命令       ┌──────────────┐
│  用户      │ ─────────────────► │ Orchestrator │
└──────────┘                    └──────┬───────┘
                                      │ 2. 确定阶段
                                      ▼
┌──────────────────┐   3. 请求上下文   ┌──────────────┐
│  ContextLoader    │◄────────────────│ StageExecutor│
│  (精简 ~500行)    │                 └──────┬───────┘
└──────┬───────────┘                        │
       │ 4. 匹配 Skill                      │
       │ (关键词+embedding)                  │
       ▼                                    │
┌──────────────────┐                        │
│  skills/ 目录     │                        │
│  (47 个 .md)     │                        │
└──────┬───────────┘                        │
       │ 5. 注入匹配的 Skill                │
       │ (2-3 个, ~3000 tokens)             │
       ▼                                    │
┌──────────────────┐   6. 注入上下文        │
│  LLM 模型         │◄──────────────────────┘
│  (Claude/GPT)    │
└──────┬───────────┘
       │ 7. LLM 消费 Skill + 推理
       │ 8. 返回: 代码变更方案
       ▼
┌──────────────────┐   9. 执行工具调用      ┌──────────────┐
│  IDE Bridge       │◄──────────────────────│  LLM 响应     │
│  (文件读写/LSP)   │                       └──────────────┘
└──────┬───────────┘
       │ 10. 变更后触发
       ▼
┌──────────────────┐   11. 检查 pass/fail   ┌──────────────┐
│  GateEngine        │◄──────────────────────│ StageExecutor │
│  (数值门禁 ~200行) │                       │ (post-gate)   │
└──────┬───────────┘                       └──────────────┘
       │ 12. 结果 (pass → 下一阶段, fail → 阻断)
       ▼
┌──────────────────┐   13. 记录决策         ┌──────────────┐
│  DecisionTrail    │◄──────────────────────│ Orchestrator │
└──────────────────┘                       └──────────────┘
```

### 5.2 Skill 注入时机

| 阶段 | 注入 Skill | Token 预算 |
|------|-----------|------------|
| ANALYSE | `stage-analyse.md` + `brainstorming.md` + 领域匹配 | ≤2000 |
| ARCHITECT | `stage-architect.md` + `socratic-challenger.md` + `code-review.md`(参考)  | ≤2500 |
| PLAN | `stage-plan.md` + `multi-agent-collab.md` | ≤1500 |
| CODE | `stage-code.md` + `code-review.md` + `security-audit.md` | ≤2000 |
| TEST | `stage-test.md` + `test-generation.md` + `quality-gate-rules.md` | ≤2000 |

---

## 6. Technology Stack

| 层级 | 技术 | 原因 |
|------|------|------|
| 运行时 | Node.js 22+ | 保持现有 |
| Skill 格式 | Markdown + YAML frontmatter | 业界标准（CodeBuddy, Superpowers 均采用） |
| Skill 匹配 | 关键词匹配 + embedding (cosine) | 保留 SkillRanker 的基础匹配 |
| 门禁执行 | 纯 JavaScript (数值比较) | 确定性执行 |
| LLM 接口 | HTTP/gRPC | 保持现有 adapter 模式 |
| 持久化 | JSON 文件 (ExperienceStore) | 保持现有 |
| AST 解析 | Tree-sitter | 保持现有 |

---

## 7. Interface Contracts

### 7.1 GateEngine 接口契约

```javascript
// GateEngine — 统一门禁检查器
// 替代: QualityGate + GateController + AcceptanceGate + AnalysisQualityGate + PostCodeQualityGuard + RetryGate
// 规则来源: skills/quality-gate-rules.md (LLM 消费)
// 执行: 纯数值检查 (代码执行)

interface GateEngine {
  // 核心检查方法
  checkLintPassRate(minRate: number): { pass: boolean, actual: number, threshold: number };
  checkTestPassRate(minRate: number): { pass: boolean, actual: number, threshold: number };
  checkCriticalCves(maxCount: number): { pass: boolean, found: CVE[], count: number };
  checkSyntaxValidity(files: string[]): { pass: boolean, errors: SyntaxError[] };
  checkFileSizeViolation(maxLines: number): { pass: boolean, violations: FileViolation[] };
  
  // 批量检查
  runAllChecks(context: StageContext): GateReport;
  
  // 报告
  interface GateReport {
    passed: boolean;
    checks: CheckResult[];
    blockedBy: string[];  // 阻断原因列表
    warnings: string[];   // 非阻断警告
  }
}
```

### 7.2 ContextLoader 接口契约

```javascript
// ContextLoader — 精简版 (~500行)
// 替代: 原 ContextLoader (89KB), skill-scanner, skill-ranker 等
// 核心: 按需加载 Skill .md 文件，注入 LLM 上下文

interface ContextLoader {
  // 加载阶段上下文
  loadStageContext(stage: string, requirement: string): ContextBundle;
  
  // Skill 匹配
  matchSkills(stage: string, keywords: string[]): SkillMatch[];
  
  // 注入到 LLM prompt
  injectIntoPrompt(basePrompt: string, skills: SkillMatch[]): string;
  
  interface ContextBundle {
    stageSkill: SkillContent;      // 对应阶段的 Skill
    domainSkills: SkillContent[];  // 匹配的领域 Skill (1-2个)
    adrs: ADR[];                   // 相关决策记录
    totalTokens: number;           // 总 token 数
  }
  
  interface SkillMatch {
    skillPath: string;             // skills/code-review.md
    skillName: string;
    matchScore: number;            // 匹配得分
    triggerReason: string;         // 匹配原因
  }
}
```

### 7.3 Skill 文件格式契约

```yaml
# Skill 文件标准格式 (所有 Skill 统一)
---
name: <skill-name>           # 唯一标识
version: <semver>            # 语义版本
type: stage|domain|flow|config  # Skill 类型
description: "<简短描述>"
triggers:
  keywords: [<关键词列表>]   # 用于自动匹配
  stages: [<适用阶段>]       # 阶段约束 (stage skill 必填)
max_tokens: <number>         # 最大注入 token 数
dependencies: [<依赖的 Skill>] # 可选
---

# Skill: <名称>

## Rules
(规则 — 必须遵守的约束)

## Best Practices
(最佳实践 — 推荐做法)

## Anti-Patterns
(反模式 — 应避免的做法)

## SOP (Standard Operating Procedure)
(标准操作流程 — 步骤指南)

## Checklist
(检查清单 — 可验证的检查项)
```

### 7.4 FileRefBus 接口契约 (统一通信)

```javascript
// FileRefBus — 文件路径传递协议
// 替代: agent-handoff-*.js + agent-mailbox.js
// 原则: 只传路径，不传内容

interface FileRefBus {
  // 发送文件引用
  send(sender: string, receiver: string, filePath: string): void;
  
  // 接收文件引用
  receive(receiver: string): FileRef[];
  
  // 确认消费
  ack(receiver: string, filePath: string): void;
  
  interface FileRef {
    sender: string;
    filePath: string;     // 文件路径，不是内容
    timestamp: number;
  }
}
```

---

## 8. Deployment View

### 8.1 部署拓扑

```
┌─────────────────────────────────────────────────┐
│              开发者机器 (VS Code)                  │
│                                                 │
│  ┌────────────────┐   ┌──────────────────┐     │
│  │ IDE Agent       │   │ skills/ 目录       │     │
│  │ (workflow-agent │   │ (47 个 .md 文件)   │     │
│  │  .md prompt)    │   │ ~80KB 声明式知识   │     │
│  └───────┬────────┘   └──────────────────┘     │
│          │                                       │
│  ┌───────▼────────┐                             │
│  │ WorkFlowAgent   │                             │
│  │ (Node.js 运行时) │                             │
│  │ ~250 模块, ~8K行 │                             │
│  └───────┬────────┘                             │
│          │                                       │
│  ┌───────▼────────┐                             │
│  │ output/ 产物     │                             │
│  │ analysis.md     │                             │
│  │ architecture.md │                             │
│  │ execution-plan  │                             │
│  └────────────────┘                             │
└─────────────────────────────────────────────────┘
         │
         ▼ (网络)
┌─────────────────────────────────────────────────┐
│              LLM 服务 (外部)                      │
└─────────────────────────────────────────────────┘
```

### 8.2 环境要求

| 环境 | 配置 | 说明 |
|------|------|------|
| 开发 | Node.js 22+, VS Code | 当前环境 |
| 测试 | Node.js 22+, 无 IDE 依赖 | CI 环境，仅运行单元测试 |
| 生产 | Node.js 22+, IDE Agent 模式 | 用户本地 IDE |

---

## Consumer Adoption Design / 下游消费方案

### 谁消费技能化后的架构，需要什么改动？

| 下游消费者 | 当前消费方式 | 技能化后消费方式 | 改动量 |
|-----------|-------------|-----------------|--------|
| **AnalystAgent** | 读取 `agent-prompt-template.js` 生成 prompt | 读取 `skills/stage-analyse.md` + ContextLoader 注入 | 修改 `buildPrompt()` 一行 |
| **ArchitectAgent** | 读取 `agent-prompt-template.js` + 独立构建评审 prompt | 读取 `skills/stage-architect.md` + `skills/socratic-challenger.md` | 修改 `buildPrompt()` 一行 |
| **PlannerAgent** | 读取 `agent-prompt-template.js` + 构建任务列表 | 读取 `skills/stage-plan.md` + `skills/multi-agent-collab.md` | 修改 `buildPrompt()` 一行 |
| **DeveloperAgent** | 读取 `agent-prompt-template.js` + 调用 `code-review-agent.js` | 读取 `skills/stage-code.md` + `skills/code-review.md` (直接消费) | 修改 `buildPrompt()` + 删除 code-review-agent 调用 |
| **TesterAgent** | 读取 `agent-prompt-template.js` + 调用测试生成器 | 读取 `skills/stage-test.md` + `skills/test-generation.md` | 修改 `buildPrompt()` 一行 |
| **StageExecutor** | 调用 `quality-gate.js` → `gate-controller.js` 等多层门禁 | 调用 `GateEngine.runAllChecks()` (统一入口) | 修改 pre-gate/post-gate 调用 |
| **Orchestrator** | 调用 `evolution-loop.js` 自动演化 | 读取 `skills/continuous-improvement.md` (手动/半自动触发) | 删除 evolution-loop 调用，添加 advisory prompt |
| **ContextLoader** (自身) | 89KB 包含 skill-scanner/skill-ranker 等子模块 | 精简为 ~500行，直接读取 skills/ 目录 | 完全重写（外部接口不变） |
| **BaseAgent** | 依赖 `agents/personas/*.md` (10个) + `agent-handoff` 通信 | 读取 `skills/agent-roles.md` + 使用 FileRefBus | 简化 `_loadPersona()` 方法 |

### 消费验证清单

每个下游消费者的改动必须通过以下验证：

```
□ buildPrompt() 调用后 Skill 内容已注入到 LLM 上下文
□ LLM 输出中包含 Skill 定义的规则/约束引用
□ GateEngine 检查通过（lint rate ≥ 80%, test rate ≥ 70%）
□ 阶段产物（analysis.md / architecture.md 等）包含 Skill 相关的关键维度
□ FileRefBus 正确传递文件路径（无内容泄漏）
```

### 渐进式采用路径

```
Phase 1: ContextLoader 同时支持新旧加载路径 (dual-read)
         ↓
Phase 2: Agent 类迁移到新 buildPrompt()（删除旧模板引用）
         ↓
Phase 3: 删除旧代码（agent-prompt-template.js, code-review-agent.js 等）
```

---

## 9. Cross-cutting Concepts (横切关注点)

### 9.1 错误处理策略

```
层级化错误处理:

1. LLM 层错误 (Skill 消费失败)
   → ContextLoader 降级: 全量注入兜底 Skill
   → 记录到 DecisionTrail
   → 不阻断流程（LLM 仍然可以凭自身知识推理）

2. 门禁层错误 (GateEngine 检查失败)  
   → CRITICAL: 阻断流程，返回 fixInstruction
   → HIGH: 阻断流程，记录到 DecisionTrail
   → MED/LOW: 记录警告，不阻断

3. 文件层错误 (I/O 失败)
   → 重试 3 次
   → 仍然失败: CRITICAL 阻断

4. 网络层错误 (LLM API 超时)
   → 重试 2 次，指数退避
   → 仍然失败: 返回友好错误信息
```

### 9.2 日志策略

| 日志类型 | 存储位置 | 保留策略 |
|----------|----------|----------|
| 阶段执行日志 | `output/health/prod/workflow-trace.jsonl` | 滚动 20 条 |
| 决策审计日志 | DecisionTrail (JSONL) | 永久保留 |
| Skill 加载日志 | ContextLoader 内部计数器 | 最近 100 次 |
| 门禁检查日志 | GateEngine.reports (JSONL) | 滚动 50 条 |
| 错误日志 | `output/health/prod/error-log.jsonl` | 滚动 50 条 |

### 9.3 认证/授权

本系统在用户本地 IDE 中运行，不涉及网络认证。LLM API 调用由 IDE 环境管理。

### 9.4 配置管理

```
workflow.config.js (精简后)
├── skillSettings
│   ├── skillsDir: "skills/"           # Skill 文件目录
│   ├── maxSkillTokens: 3000           # 单阶段最大 Skill token
│   └── matchStrategy: "keyword+embedding"
├── gateSettings
│   ├── lintPassRate: 0.80
│   ├── testPassRate: 0.70
│   ├── maxCriticalCves: 0
│   └── maxFileLines: 900
└── runtimeSettings
    ├── maxDurationMs: 600000
    └── maxLlmCalls: 15
```

### 9.5 i18n

保持现有中文为主的设计。Skill 文件可以用中文编写（CodeBuddy 支持），技术术语保持 English。

---

## 10. NFR (非功能性需求)

| # | NFR | 目标值 | 测量方式 |
|---|-----|--------|----------|
| NFR-1 | **可维护性** | 新增审查规则: 修改 ≤1 个文件 | 模拟新增规则流程计时 |
| NFR-2 | **启动性能** | 初始化时间: ≤3s (原 ~5s) | `time node workflow/init-project.js` |
| NFR-3 | **上下文效率** | 每阶段 Skill 注入: ≤3000 tokens | TokenBudget 计数 |
| NFR-4 | **可回滚性** | 任意阶段迁移失败可独立回滚 | 3 Phase 独立 git tag |
| NFR-5 | **可靠性** | GateEngine 判定等价: 与旧门禁 100% 一致 | 历史失败案例回归 |
| NFR-6 | **安全性** | CVE 检查能力不变 | Benchmark 回归 |
| NFR-7 | **可扩展性** | 新增 Skill: 创建 1 个 .md 文件即可 | 无需修改任何 JS 代码 |

---

## 11. Risk Assessment (风险评估)

详细风险已在 ANALYSE 阶段输出（见 `output/analysis.md` 第七节）。架构层面补充三个风险：

| # | 风险 | 概率 | 影响 | 架构缓解 |
|---|------|------|------|----------|
| RA-1 | GateEngine 误判导致本该阻断的代码通过 | 低 | 高 | GateEngine 保留所有数值型检查，不做 LLM 推理；规则文件 `quality-gate-rules.md` 是 LLM 审查时的参考而非执行器 |
| RA-2 | ContextLoader 精简后 Skill 匹配遗漏 | 中 | 中 | 保留 keyword+embedding 双路匹配，降级时全量注入阶段 Skill |
| RA-3 | Skill 文件内容冲突（两个 Skill 给出矛盾建议） | 低 | 低 | Skill 依赖声明机制 (`dependencies: []`) 确保加载顺序，Rule > Best Practice 优先级 |

---

## 12. Open Questions

| # | 问题 | 提出阶段 | 影响 |
|---|------|----------|------|
| Q1 | embedding 匹配是否需要保留？还是纯 keyword 足够？ | ARCHITECT | 影响 ContextLoader 复杂度（有 embedding 需 ~500 行，无只需 ~200 行） |
| Q2 | `agent-prompt-template.js` 中的动态参数（如 stage-specific 的 token 计算）如何处理？ | ARCHITECT | 需要模板变量机制 (e.g. `{{stageName}}`) |
| Q3 | EvolutionLoop 的轻量调度器用什么触发机制？定时器还是手动触发？ | ARCHITECT | 影响是否保留 cron/interval 逻辑 |
| Q4 | 迁移后旧的 skill 管理模块（skill-scanner.js 等）是否需要保留向后兼容的 adapter？ | ARCHITECT | 如果外部有依赖，需要保留 adapter 过渡期 |

---

## 13. Tree of Thoughts (多方案对比)

### 方案 A: 激进技能化 (推荐)

删除所有可技能化模块，一次性迁移。

| 优点 | 缺点 |
|------|------|
| 最大幅度减少代码 | 高风险 |
| 一次性对齐业界标准 | 回滚需要整体回退 |
| 维护负担最低 | 团队适应成本高 |

### 方案 B: 渐进技能化 (推荐 + 安全)

三阶段迁移，每阶段独立验证。

| 优点 | 缺点 |
|------|------|
| 低风险，每阶段可独立回滚 | 总耗时更长（3-4周 vs 1-2周） |
| 团队逐步适应 | 中间态可能存在新旧混合 |
| 每阶段有验证数据支撑 | — |

### 方案 C: Adapter 模式

保留旧模块作为 adapter，新 Skill 作为 primary source。

| 优点 | 缺点 |
|------|------|
| 最大向后兼容 | adapter 本身也是代码负担 |
| 零风险切换 | 违背"减少代码"目标 |

### 决策

**选择方案 B (渐进技能化)**。理由：
1. 16 项技能化建议天然分三个优先级
2. 每阶段独立可验证，质量有保障
3. 如果 Phase 1 就出现问题，可以止损
4. 符合 "Fail Fast" 原则（高风险项放最后）

---

## 14. ADR Decisions (架构决策记录)

### ADR-001: 门禁统一为 GateEngine + Skill 规则

**Status**: Proposed
**Context**: 当前系统有 6 种独立门禁实现（QualityGate, GateController, AcceptanceGate, AnalysisQualityGate, PostCodeQualityGuard, RetryGate），共 ~5000 行代码。它们检查的内容可以分为两类：(a) 数值型阈值（lint pass rate, test pass rate, CVE count, file size）— 可确定性检查；(b) 规则型判断（安全审查清单、代码规范）— LLM 可消费。

**Decision**: 创建统一的 `GateEngine` (~200行) 负责所有数值型门禁的确定性检查。规则型判断移至 `skills/quality-gate-rules.md`，由 LLM 在审查阶段消费。

**Consequences**:
- 积极: 代码量减少 96%（5000行 → 200行），门禁规则透明可读
- 消极: GateEngine 需要与所有调用方重新集成测试
- 风险: 如果某个旧门禁的规则没有被正确迁移到 Skill 中，可能导致该规则失效 → 用历史失败案例回归缓解

### ADR-002: 通信机制统一为 FileRefBus

**Status**: Proposed
**Context**: 当前系统有三套独立的 Agent 间通信机制：agent-handoff-*.js (交接协议), agent-mailbox.js (邮箱), FileRefBus (文件路径总线)。三者功能重叠——都是在 Agent 间传递信息。

**Decision**: 统一为 FileRefBus（文件路径传递协议）。删除 agent-handoff-*.js 和 agent-mailbox.js。Handoff 的交接顺序逻辑移至 `skills/multi-agent-collab.md`，由 LLM 读取后自主协调。

**Consequences**:
- 积极: 通信机制从 3 套降为 1 套，消除 Agent 间通信的认知负担
- 消极: 交接顺序从代码强约束变为 LLM 自主协调，可能偶尔出现顺序错误
- 风险: LLM 可能跳过某个 Agent → `skills/multi-agent-collab.md` 中的 SOP 明确规定 Agent 序列值得

### ADR-003: Agent Prompt 模板技能化

**Status**: Proposed
**Context**: `agent-prompt-template.js` (56KB) 包含大量硬编码的 prompt 模板。每个 Agent 角色 (analyst, architect, planner, developer, tester) 都有独立的 prompt 构建逻辑。维护这些 JS 文件需要同时修改 JS 和 Persona Markdown。

**Decision**: 创建 5 个阶段 Skill（`skills/stage-analyse.md` 等），每个 Skill 包含该阶段的方法论、输出格式、约束规则。保留轻量的模板渲染器处理动态变量替换（如 `{{requirement}}`, `{{codeGraphContext}}`）。

**Consequences**:
- 积极: Prompt 逻辑从 JS 代码变为可读的 Markdown，维护成本降至零（修改一个 .md 即可）
- 消极: 动态模板变量需要渲染器支持，但逻辑简单（~50行）
- 风险: 模板变量替换失败 → 渲染器有 fallback 机制

### ADR-004: 经验/演化层精简化

**Status**: Proposed
**Context**: 当前 17+ 个模块处理"从历史学习"一个概念。这些模块可以分为：(a) 持久化存储（必须代码）, (b) 知识提炼方法（可技能化）, (c) 演化调度器（可轻量化）。

**Decision**: 保留 `ExperienceStore`（精简至 ~500 行，负责 CRUD + 语义搜索），删除 experience-distillation、experience-evolution、evolution-loop（61KB）等方法论模块。提炼方法移至 `skills/knowledge-distillation.md` 和 `skills/continuous-improvement.md`。

**Consequences**:
- 积极: 17+ 个模块降为 2 个 Skill + 1 个代码模块
- 消极: 自动演化循环变为手动/半自动 → 在 `skills/continuous-improvement.md` 中提供 SOP 指引
- 风险: 自动演化停止后知识库可能不更新 → 定期 review 机制（通过 scheduler-check）

---

## 15. Traceability Coverage (追溯覆盖)

### 15.1 需求→组件覆盖矩阵

| 需求/用户故事 | 架构组件 | 覆盖状态 |
|--------------|----------|----------|
| US-1: 架构师识别冗余 | 组件分解 (Section 4)、ADR决策 (Section 14) | ✅ |
| US-2: 维护者渐进迁移 | 数据流 (Section 5)、部署视图 (Section 8)、ADR-001~004 | ✅ |
| US-3: 质量工程师验证等价性 | GateEngine 接口 (Section 7.1)、NFR-5、Scenario Coverage | ✅ |
| AC-1: 审查规则等价 | skills/code-review.md + GateEngine | ✅ |
| AC-2: 初始化时间 30% | NFR-2、部署视图 | ✅ |
| AC-3: 门禁 PASS/FAIL 等价 | GateEngine + skills/quality-gate-rules.md | ✅ |
| AC-4: Token 减少 40% | 数据流 5.2、NFR-3 | ✅ |
| AC-5: 单文件修改 | 组件分解 4.2 | ✅ |
| AC-6: Benchmark 不下降 | NFR-5、Scenario Coverage | ✅ |
| AC-7: 历史失败覆盖 | Failure Model、Migration Safety Case | ✅ |
| AC-8: 迁移失败回滚 | 约束 C4、Migration Safety Case | ✅ |

---

## 16. Glossary

| 术语 | 定义 |
|------|------|
| **Skill** | 声明式知识包（Markdown 格式），包含规则、最佳实践、SOP，由 LLM 直接消费 |
| **Skillification** | 将运行时代码逻辑替换为声明式 Skill 的过程 |
| **GateEngine** | 统一数值门禁检查器 (~200行)，替代原有的 6 种门禁系统 |
| **FileRefBus** | 文件路径传递协议，Agent 间通信的唯一机制 |
| **DecisionTrail** | 审计日志，记录所有架构决策 |
| **ContextLoader** | 精简版上下文加载器 (~500行)，按需匹配和注入 Skill |
| **渐进式披露** | CodeBuddy 的 Skill 加载策略：不一次加载所有 Skill，只在匹配时注入相关的 |
| **声明式架构** | 以声明式知识（.md 文件）为主、轻量执行引擎为辅的架构模式 |
| **Stage Skill** | 与工作流阶段绑定的 Skill（如 stage-analyse.md） |
| **Domain Skill** | 跨阶段的领域知识 Skill（如 code-review.md） |
| **Flow Skill** | 描述多步骤协作流程的 Skill（如 multi-agent-collab.md） |

---

## Architecture Scorecard / 架构评分卡

| 维度 | 当前架构 (as-is) | 目标架构 (to-be) | 评分 |
|------|-----------------|-----------------|------|
| **简洁性** | 485 模块, ~28K行代码 | 250 模块, ~8K行代码 | 9/10 |
| **可理解性** | 规则分散在 JS 代码中 | 规则集中在 Markdown Skill | 9/10 |
| **可扩展性** | 新增规则需改 3+ 文件 | 新增规则 1 个 .md | 10/10 |
| **可测试性** | 门禁逻辑耦合在多个模块 | GateEngine 独立可测 | 8/10 |
| **性能** | 初始化 ~5s (全量加载) | 初始化 ~3s (按需加载) | 7/10 |
| **安全性** | 6 种门禁覆盖 | 1 个 GateEngine 覆盖全部数值门禁 | 8/10 |
| **可靠性** | 门禁逻辑代码执行 | 门禁逻辑代码执行 (不变) | 10/10 |
| **对齐业界** | 自研 Workflow 架构 | Skills 架构 (CodeBuddy/Superpowers) | 9/10 |

**总分: 70/80 (87.5%)** — 架构质量良好，主要失分在性能和可测试性（需后续优化）。

---

## Failure Model / 失败模型

### 场景 1: Skill 文件损坏或缺失
- **触发条件**: `skills/code-review.md` 被误删除
- **影响**: LLM 在没有审查规则的情况下进行代码审查
- **检测**: ContextLoader 在加载 Skill 时检查文件存在性和 frontmatter 完整性
- **恢复**: 降级到通用审查模式 + 日志告警；GateEngine 不受影响（数值门禁仍在）
- **严重度**: MEDIUM — 审查质量可能下降，但安全性不受影响

### 场景 2: GateEngine 误判
- **触发条件**: lint command 输出格式变化导致正则匹配失败
- **影响**: lint pass rate 检查返回 false（实际应该 true），阻断不应阻断的流程
- **检测**: GateEngine 每次运行记录 raw output + parsed result
- **恢复**: 管理员检查日志，手动 override 门禁（需 admin token）
- **严重度**: HIGH — 会阻断工作流，但有 bypass 机制

### 场景 3: LLM 选择性忽略 Skill 规则
- **触发条件**: LLM 上下文窗口过载，忽略部分 Skill 内容
- **影响**: 某个安全审查维度被跳过
- **检测**: 通过对比 LLM 输出与 Skill 检查清单，发现遗漏维度
- **恢复**: GateEngine 的数值门禁不受影响（确定性检查仍在）
- **严重度**: MEDIUM — GateEngine 提供安全网

### 场景 4: 三阶段迁移中阶段 1 引入回归
- **触发条件**: Phase 1 删除 skill 管理模块后，Skill 加载失败
- **影响**: 工作流无法启动
- **检测**: Phase 1 完成后的完整回归测试
- **恢复**: `git revert` 回退到迁移前 tag
- **严重度**: HIGH — 但可快速回滚

---

## Migration Safety Case / 迁移安全

### 安全迁移原则

1. **Git Tag 每阶段**: Phase 1 前打 `tag v1-pre-migration`，Phase 1 完成后打 `tag v2-phase1-done`
2. **独立验证**: 每阶段完成后运行完整 benchmark 和回归测试
3. **可独立回滚**: 每阶段的变更可独立 revert，不影响其他阶段
4. **GateEngine 最后迁移**: 安全网（数值门禁）始终在线

### 回滚计划

```
Phase 1 回滚: git reset --hard v1-pre-migration
Phase 2 回滚: git reset --hard v2-phase1-done (保留 Phase 1 变更)
Phase 3 回滚: git reset --hard v2-phase2-done (保留 Phase 1,2 变更)
```

### 验证检查点

| 阶段 | 检查项 | 通过标准 |
|------|--------|----------|
| Phase 1 后 | Skill 加载完整性 | 所有 47 个 Skill 可加载，frontmatter 有效 |
| Phase 1 后 | 工作流启动 | `/wf` 命令正常启动 ANALYSE→ARCHITECT→PLAN |
| Phase 2 后 | 门禁等价性 | 20+ 历史失败案例全部被 GateEngine 检测 |
| Phase 2 后 | 审查质量 | Benchmark 评分不下降 |
| Phase 3 后 | 端到端功能 | 全部 E2E 测试通过 |
| Phase 3 后 | 性能指标 | 初始化 ≤3s, token 注入 ≤3000 |

---

## Scenario Coverage / 场景覆盖

### 正常场景

| # | 场景 | 预期行为 | 覆盖组件 |
|---|------|----------|----------|
| S1 | 用户发起 `/wf` 代码任务 | ANALYSE→ARCHITECT→PLAN→CODE→TEST 完整执行 | Orchestrator + ContextLoader + GateEngine |
| S2 | 新增审查规则 | 修改 `skills/code-review.md`，下次审查自动生效 | ContextLoader SkillMatcher |
| S3 | 数值门禁触发 | lint pass rate 60% < 80% → GateEngine 阻断 | GateEngine |
| S4 | 多 Agent 协作 | FileRefBus 传递文件路径，LLM 读取 `multi-agent-collab.md` 自主协调 | FileRefBus + LLM |

### 边界场景

| # | 场景 | 预期行为 | 覆盖组件 |
|---|------|----------|----------|
| S5 | 空 Skill 目录 | ContextLoader 降级到基础 prompt | ContextLoader fallback |
| S6 | Skill 文件超大 (>10KB) | TokenBudget 截断，只注入首部 Rules 部分 | TokenBudget |
| S7 | 同时匹配 5+ Skill | 按匹配分数取 Top 3，总 token ≤ 3000 | SkillMatcher + TokenBudget |

### 异常场景

| # | 场景 | 预期行为 | 覆盖组件 |
|---|------|----------|----------|
| S8 | LLM API 超时 | 重试 2 次，失败后返回友好错误 | Orchestrator 错误处理 |
| S9 | 文件 I/O 失败 | 重试 3 次，失败后 CRITICAL 阻断 | StageExecutor 错误处理 |
| S10 | Skill 文件编码错误 (非 UTF-8) | 跳过该 Skill，日志告警 | ContextLoader 安全过滤 |

### 迁移特有场景

| # | 场景 | 预期行为 | 覆盖组件 |
|---|------|----------|----------|
| S11 | Phase 1 只删除 skill 管理模块 | 工作流正常运作，Skill 加载由新 ContextLoader 处理 | ContextLoader (精简版) |
| S12 | Phase 2 删除 socratic + 统一门禁 | GateEngine 判定与旧门禁一致 | GateEngine |
| S13 | Phase 3 删除经验/演化模块 | ExperienceStore 精简版正常 CRUD | ExperienceStore |

---

## 📊 架构总结

| 维度 | 数值 |
|------|------|
| ADR 决策 | 4 个（门禁统一、通信统一、Prompt 技能化、经验精简） |
| Skill 文件 | 47 个（32 保留 + 15 新增） |
| 保留代码模块 | ~250 个（从 485 减少 48%） |
| 代码行数 | ~28,000 → ~7,900（-72%） |
| 接口契约 | 4 个（GateEngine, ContextLoader, Skill 格式, FileRefBus） |
| 失败场景 | 4 个（Skill 损坏、门禁误判、LLM 忽略规则、迁移回归） |
| 场景覆盖 | 13 个（4 正常 + 3 边界 + 3 异常 + 3 迁移特有） |
| NFR | 7 个（可维护性、启动性能、上下文效率等） |
