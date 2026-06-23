---
name: bridge-reference
version: 1.0.0
type: workflow-skill
description: "IDE Bridge 完整命令参考: build-agent-prompt/context/experience/quality/session等"
triggers:
  keywords: [bridge, build-agent-prompt, experience-search, quality-check, quality-gate, rollback-check]
max_tokens: 600
dependencies: []
---

# IDE Bridge Optional Commands

Only use when needed; do NOT inject their full docs by default.

| Need | Command |
|---|---|
| Role prompt / contract | `build-agent-prompt` |
| Digest-first context sections | `context` |
| Experience lookup | `experience-search`, `experience-context` |
| Quality and rollback checks | `quality-check`, `quality-gate`, `rollback-check` |
| Session lifecycle | `task-history`, `session-score`, `execution-validate`, `experience-transfer` |
| Maintenance | `scheduler-check`, `experience-health`, `contract-check`, `deep-audit`, `mape-analysis`, `regression-check`, `skill-refine-check` |

## Core Commands (always used)
```bash
node workflow/tools/ide-workflow-bridge.js input-received --user-input "<msg>" --input-type "requirement" --decision "走完整工作流" --project-root .
node workflow/tools/ide-workflow-bridge.js workflow-stage --stage <STAGE> --requirement "<req>" --project-root . --stage-input "<ctx>"
node workflow/tools/ide-workflow-bridge.js stage-complete --stage <STAGE> --project-root . --summary "<summary>" --stage-output "<artifact>"
```
