---
name: stage-thinking-test
version: 1.0.0
type: workflow-skill
description: "TEST阶段推理框架：变更意图→AC→边界→生产风险→安全→下游消费验证"
triggers:
  keywords: [test, testing, 测试, verification, lint]
  stages: [TEST]
max_tokens: 600
dependencies: []
---

# TEST Stage Thinking Process

Before running tests, reason through:

1. **变更意图**: What does this code change DO? (one sentence)
2. **ACs**: Acceptance criteria from the execution plan
3. **边界情况**: null input, empty collection, boundary values, error paths
4. **生产风险**: concurrency, large data, network failures, auth bypass?
5. **安全影响**: What security implications does this change have?
6. **下游消费**: If artifact/schema/generator changed, do tests prove downstream consumers use it?

## Test Execution (MANDATORY)

| Step | Command | Priority |
|------|---------|----------|
| Syntax | `node -c <file>` | HIGH |
| Module Load | `node -e "require('./file')"` | HIGH |
| Lint | `npm run lint` | HIGH |
| Tests | `npm test` | HIGH |
| CVE Audit | `node workflow/tools/ide-cve-scanner.js` | MED |
| Entropy | `node workflow/tools/ide-test-runner.js --entropy-only` | MED |

- Max 3 auto-fix rounds total. Report remaining failures if exceeded.
- Show ACTUAL terminal output, not reasoning.
