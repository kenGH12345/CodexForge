---
name: stage-thinking-architect
version: 1.0.0
type: workflow-skill
description: "ARCHITECT阶段推理框架：质量属性→约束→最简架构→复用→风险"
triggers:
  keywords: [architect, architecture, arc42, 架构设计, C4]
  stages: [ARCHITECT]
max_tokens: 800
dependencies: []
---

# ARCHITECT Stage Thinking Process

Before designing architecture, reason through:

1. **核心质量属性**: latency, availability, consistency, security, maintainability?
2. **硬约束**: team size, timeline, existing infrastructure?
3. **最简可行架构**: What is the simplest architecture that could possibly work?
4. **可复用模块**: What existing modules/patterns can be reused?
5. **Top 3 技术风险**: How does the architecture mitigate each?

## Output Requirements
- 16-section arc42 alignment (C4 Context → Glossary)
- ≥2 Mermaid diagrams (Context + Component/Sequence)
- ≥2 full ADR records (Status/Context/Decision/Consequences)
- Self-Review Checklist + Adversarial Review before presenting
- Min ~2000 words

## Stage Boundary
- HARD BLOCK: NEVER modify code files during ARCHITECT
- Write ONLY to output/architecture.md
