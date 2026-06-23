---
name: stage-thinking-analyse
version: 1.0.0
type: workflow-skill
description: "ANALYSE阶段推理框架：需求理解→拆解→验收标准→模块影响→风险"
triggers:
  keywords: [analyse, analysis, 需求分析, 用户故事]
  stages: [ANALYSE]
max_tokens: 800
dependencies: []
---

# ANALYSE Stage Thinking Process

Before producing ANY output for ANALYSE, reason through:

1. **用户真实意图**: What does the user REALLY need? Not just what they said.
2. **现有代码上下文**: What anchor files exist? What do I already know?
3. **复杂度级别**: Simple / Medium / Complex?
4. **隐含假设**: What unstated assumptions need surfacing?
5. **最小需求集**: What is the minimal requirement set capturing full intent?

## Output Requirements
- User Stories: ≥3, each with Actor/Goal/Benefit
- Acceptance Criteria: ≥5 in WHEN/THEN/IF format (normal + edge + error)
- Module Map: ALL affected modules with dependency relationships
- Risk Analysis: ≥2 technical risks or unstated assumptions
- Min ~1500 words. Shallow 3-line summaries NOT acceptable.

## Stage Boundary
- HARD BLOCK: NEVER modify code files (.js/.ts) during ANALYSE
- Write ONLY to output/analysis.md and output/requirement-traceability.json
