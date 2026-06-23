---
name: stage-thinking-plan
version: 1.0.0
type: workflow-skill
description: "PLAN阶段推理框架：关键路径→高风险→并行→垂直切片→隐式依赖"
triggers:
  keywords: [plan, execution plan, 执行计划, 任务分解]
  stages: [PLAN]
max_tokens: 600
dependencies: []
---

# PLAN Stage Thinking Process

Before creating the execution plan, reason through:

1. **关键路径**: Which chain of dependent tasks determines minimum delivery time?
2. **最高风险任务**: Schedule early — fail fast, learn fast
3. **并行度**: How many tasks can run in parallel?
4. **最小垂直切片**: What is the minimal first phase delivering a testable vertical slice?
5. **隐式依赖**: Dependencies the architecture didn't call out?

## Output Requirements
- Each task: ID (T-N), description, acceptance criteria, files to touch, dependencies
- ≥1 Mermaid dependency graph
- Risk assessment for highest-risk task
- ≥3 tasks medium, ≥5 tasks high complexity

## Stage Boundary
- HARD BLOCK: NEVER modify code files during PLAN
- Write ONLY to output/execution-plan.md
