---
name: lifecycle-commands
version: 1.0.0
type: workflow-skill
description: "Lifecycle bridge命令: contract-check/skill-discover/experience-transfer/task-history/arch-cache/execution-validate/prompt-optimize/session-score/scheduler-check"
triggers:
  keywords: [lifecycle, contract-check, skill-discover, experience-transfer, task-history, arch-cache, scheduler, session-score]
max_tokens: 800
dependencies: []
---

# Lifecycle Bridge Commands

## Session Start
```
node workflow/tools/ide-workflow-bridge.js task-history --action recall --project-root .
node workflow/tools/ide-workflow-bridge.js arch-cache --action summary --project-root .
node workflow/tools/ide-workflow-bridge.js scheduler-check --project-root .
node workflow/tools/ide-workflow-bridge.js contract-check --project-root .
node workflow/tools/ide-workflow-bridge.js experience-health --project-root .
```

## After /wf init
```
node workflow/tools/ide-workflow-bridge.js skill-discover --project-root .
node workflow/tools/ide-workflow-bridge.js arch-cache --action rebuild --project-root .
node workflow/tools/ide-workflow-bridge.js experience-transfer --action import --project-root .
```

## After Workflow
```
node workflow/tools/ide-workflow-bridge.js execution-validate --project-root .
node workflow/tools/ide-workflow-bridge.js session-score --project-root .
node workflow/tools/ide-workflow-bridge.js task-history --action record --goal "<summary>" --outcome success --project-root .
node workflow/tools/ide-workflow-bridge.js experience-transfer --action publish --project-root .
```

## Monthly
```
node workflow/tools/ide-workflow-bridge.js prompt-optimize --project-root .
node workflow/tools/ide-workflow-bridge.js skill-refine-check --project-root .
node workflow/tools/ide-workflow-bridge.js experience-evolve --project-root .
node workflow/tools/ide-workflow-bridge.js deep-audit --project-root .
```
