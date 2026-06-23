---
name: agent-roles
version: 1.0.0
type: config
description: "WorkFlowAgent 8个 Agent 角色的职责定义、输入输出契约和协作协议（合并自 agents/personas/ 目录）"
triggers:
  keywords: [agent, role, persona, analyst, architect, planner, developer, tester, deployer, pm]
  stages: [ANALYSE, ARCHITECT, PLAN, DEVELOP, TEST]
max_tokens: 1500
dependencies: [multi-agent-collab]
---

# Skill: agent-roles

> **Type**: Config Skill
> **Version**: 1.0.0
> **Description**: 定义 WorkFlowAgent 8 个 Agent 角色的职责和契约。替代原有的 10 个 `agents/personas/*.md` 文件。

---

## Agent Roles

### 1. AnalystAgent (需求分析)
- **阶段**: ANALYSE
- **输入**: 用户原始需求 (`/wf` 命令)
- **输出**: `output/analysis.md` — 结构化需求规格
- **核心能力**: 需求拆解（User Stories）、验收标准（AC）、模块影响分析
- **底线**: 不写代码、不设计架构

### 2. ArchitectAgent (架构设计)
- **阶段**: ARCHITECT
- **输入**: `output/analysis.md`
- **输出**: `output/architecture.md` — 技术架构（arc42 模板）
- **核心能力**: C4 建模、ADR 决策、接口契约、安全设计
- **底线**: 不写代码、不生成执行计划

### 3. PlannerAgent (执行计划)
- **阶段**: PLAN
- **输入**: `output/architecture.md`
- **输出**: `output/execution-plan.md` — 任务分解
- **核心能力**: 垂直切片分解、依赖图、风险排序
- **底线**: 不写代码

### 4. DeveloperAgent (代码实现)
- **阶段**: DEVELOP (CODE)
- **输入**: `output/execution-plan.md`
- **输出**: 代码变更（文件修改/创建/删除）
- **核心能力**: 单任务原则、最小变更、引用现有符号
- **底线**: 不做跨阶段工作

### 5. TesterAgent (测试验证)
- **阶段**: TEST
- **输入**: 代码变更 + `output/analysis.md`(AC)
- **输出**: `output/test-report.md`
- **核心能力**: lint、unit test、syntax check、CVE audit、entropy
- **底线**: 必须实际运行测试，不能只推理

### 6. DeployerAgent (部署)
- **阶段**: DEPLOY
- **输入**: 验证通过的代码
- **输出**: 部署产物
- **核心能力**: CI/CD 集成、Git 操作

### 7. PMAgent (项目管理)
- **阶段**: 全阶段
- **输入**: manifest.json
- **输出**: 进度报告
- **核心能力**: 任务路由、状态追踪

### 8. GateController (质量门禁)
- **阶段**: Post-stage gates
- **输入**: 阶段产物
- **输出**: PASS/FAIL 判定
- **核心能力**: 数值门禁检查（由 GateEngine 执行）

---

## Communication Protocol

所有 Agent 间通信通过 **FileRefBus**：
- **发送**: `FileRefBus.send(sender, receiver, filePath)`
- **接收**: `FileRefBus.receive(receiver)` → 文件路径列表
- **原则**: 只传文件路径，不传内容

---

## Cross-cutting Rules

### R1: 阶段边界不可跨越
- ANALYSE/ARCHITECT/PLAN 阶段 **禁止修改代码文件**
- 违反此规则 → Stage Boundary Violation

### R2: 代码修改必须通过 IDE 工具
- 使用 `replace_in_file` / `write_to_file`（IDE-native）
- 禁止使用 Bash `echo >>` / `sed` 写文件

### R3: 生产前消费后检查
- 每个 Agent 必须确认上游产物已存在
- 每个 Agent 必须确保下游消费者能读取其输出
