---
name: stage-thinking-code
version: 1.0.0
type: workflow-skill
description: "CODE/DEVELOP阶段推理框架：任务ID→AC→触及文件→可复用符号→风险→最小变更"
triggers:
  keywords: [code, develop, implement, 编码, 实现]
  stages: [CODE, DEVELOP]
max_tokens: 600
dependencies: []
---

# CODE Stage Thinking Process

Before writing a single line of code, reason through:

1. **Task T-N**: Which task am I implementing?
2. **Acceptance Criteria**: List them explicitly
3. **触及文件**: What existing code will I touch?
4. **可复用符号**: Reusable symbols in Code Graph I should use instead of writing new ones?
5. **潜在问题**: Edge cases, error paths, resource leaks?
6. **最小变更**: What is the MINIMAL change satisfying the acceptance criteria?

## Output Requirements
- Single-Task Principle: Complete ONE task at a time
- Reuse Check: Check CodeGraph hotspots & reusable symbols before writing
- Each change must compile and pass tests independently
- After each file: `📝 Modified: <path>`
- When done: `✅ CODE done: <N files modified>`

## Rules
- Sub-Agent for research (code-explorer), main agent only writes code
- Batch independent reads, max 3 fix rounds for failures
- IDE-native tools ONLY for file edits (replace_in_file, write_to_file)
