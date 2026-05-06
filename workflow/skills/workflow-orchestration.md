---
name: workflow-orchestration
version: 2.1.0
type: domain-skill
domains: [workflow, orchestration]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [workflow, orchestrat, agent, pipeline, stage]
  roles: [analyst, architect, planner, developer, tester, coding-agent]
description: "IDE /wf workflow orchestration SOP"
---
# Skill: IDE /wf Workflow Orchestration SOP

> **Type**: Workflow Skill
> **Version**: 2.1.0
> **Description**: Current IDE-mode `/wf` workflow SOP. This document describes the active stage chain used by `workflow/tools/ide-workflow-bridge.js`.

---

## Overview

Current IDE `/wf` runs the full sequential pipeline:

```text
ANALYSE -> ARCHITECT -> PLAN -> DEVELOP -> TEST -> REVIEW -> DEPLOY
```

`INIT` is an initialization activity (`/wf init` / `workflow/init-project.js`), not a normal stage in every `/wf` task. Older implementation/finalization labels should be interpreted through the current active stages: `DEVELOP` for implementation and `DEPLOY` plus `session-summary` for closure.

Every stage follows the same bridge pattern:

```text
workflow-stage --stage <STAGE>
  -> IDE tools perform the stage work
stage-complete --stage <STAGE>
```

Agents should communicate through file paths and digests, not raw large content blocks.

---

## Pre-conditions

- [ ] User provided a concrete `/wf` requirement.
- [ ] Workspace root is known and writable.
- [ ] `input-received` has logged the user request.
- [ ] `workflow-stage` has been called before any stage work.
- [ ] Context loading follows digest-first policy.

---

## Current Stages

| Stage | Actor Role | Main Artifact | Primary Consumer |
|---|---|---|---|
| `ANALYSE` | Analyst | `output/analysis.md` | `ARCHITECT`, `PLAN`, `DEVELOP` |
| `ARCHITECT` | Architect | `output/architecture.md` | `PLAN`, `DEVELOP`, `REVIEW` |
| `PLAN` | Planner | `output/execution-plan.md` | `DEVELOP`, `TEST`, `REVIEW` |
| `DEVELOP` | Developer | `output/code.diff` | `TEST`, `REVIEW` |
| `TEST` | Tester | `output/test-report.md` | `REVIEW`, `DEPLOY` |
| `REVIEW` | Reviewer | `output/review-output.md` | `DEPLOY` |
| `DEPLOY` | Delivery / Summary | `output/deploy-output.md` | Human, session summary, health reporting |

Each `stage-complete` may also produce or update:

```text
output/context-digests/<stage>.json
output/context-digests/index.json
output/workflow-progress.log
output/agent-self-reports.jsonl
```

---

## Stage SOP

### 1. ANALYSE

**Goal**: identify the real problem, affected locations, change scope, downstream consumers, and risks.

**Input**: user requirement, relevant digests, targeted source evidence.

**Output**: `output/analysis.md`.

Required sections:

```text
## 根因 / Root Cause
## 受影响位置
## 修改范围
## 下游消费影响
## 风险评估
```

ANALYSE must not design architecture or implement code.

### 2. ARCHITECT

**Goal**: design the smallest safe solution consistent with ANALYSE.

**Input**: `output/analysis.md` or its digest.

**Output**: `output/architecture.md`.

Required design coverage includes:

```text
Architecture Scorecard
Failure Model
Migration Safety Case
Scenario Coverage
Consumer Adoption Design
```

ARCHITECT must not implement code.

### 3. PLAN

**Goal**: convert architecture into ordered vertical-slice tasks.

**Input**: `output/analysis.md`, `output/architecture.md`, or their digests.

**Output**: `output/execution-plan.md`.

Each task should include ID, scope, acceptance criteria, files likely touched, and dependencies. If downstream consumers exist, PLAN must include consumer migration/adoption tasks and tests.

### 4. DEVELOP

**Goal**: implement the plan with minimal, focused changes.

**Input**: `output/execution-plan.md`, relevant source files, and upstream digests.

**Output**: `output/code.diff`.

DEVELOP should follow the plan. If implementation discovers a local plan gap, emit a clear plan-deviation marker instead of silently changing scope.

### 5. TEST

**Goal**: verify acceptance criteria, regression risk, and consumer adoption.

**Input**: `output/code.diff`, execution plan, relevant test files.

**Output**: `output/test-report.md`.

TEST must include real command output. If a broad suite has unrelated pre-existing failures, report them separately from targeted verification.

### 6. REVIEW

**Goal**: review whether the workflow output matches the requirement and whether risks are acceptable.

**Input**: test report, code diff, upstream digests.

**Output**: `output/review-output.md`.

REVIEW should not introduce new implementation scope. It records pass/fail, known issues, and follow-up recommendations.

### 7. DEPLOY

**Goal**: finalize delivery state, summarize operational behavior, and identify remaining follow-ups.

**Input**: review output, test report, deliverables.

**Output**: `output/deploy-output.md`.

DEPLOY does not imply external cloud deployment unless explicitly requested. For normal workflow tasks, it means local delivery/closure.

---

## Rules

1. **Full `/wf` pipeline** — `/wf` tasks run the full active sequence: `ANALYSE -> ARCHITECT -> PLAN -> DEVELOP -> TEST -> REVIEW -> DEPLOY`. Triage is advisory only.
2. **Bridge-first execution** — start each stage with `workflow-stage` and finish with `stage-complete`.
3. **File paths and digests over raw content** — pass artifact paths, digest summaries, and source refs instead of dumping large raw content.
4. **Context Digest First Rule** — reuse fresh relevant digests from `output/context-digests/` before reading full artifacts. Old relevant digest facts are reused, new relevant findings are appended by `stage-complete`, unrelated digests stay stored but are not injected, and full artifacts remain available through source refs when precise evidence is needed.
5. **Producer-Consumer Impact Rule** — when a task creates or changes an artifact, schema, generator output, loader/reader/cache, config, metadata, or shared capability, trace downstream consumers before implementation. ANALYSE identifies consumers; ARCHITECT defines adoption; PLAN adds migration/adoption tasks; TEST proves consumers actually use the output.
6. **Agent boundary rule** — ANALYSE does not design; ARCHITECT does not code; PLAN does not implement; DEVELOP follows the plan; TEST verifies; REVIEW evaluates; DEPLOY summarizes.
7. **No direct coding shortcut** — do not bypass ANALYSE/ARCHITECT/PLAN just because a task looks simple.
8. **No unrelated refactor** — keep changes scoped to the accepted plan.

---

## Checklist

### Pre-workflow

- [ ] `/wf` input has been logged by `input-received`.
- [ ] `workflow-stage` has started the current stage.
- [ ] Required upstream artifact or digest exists.
- [ ] Context loading used digest-first fallback rules.

### Per-stage

- [ ] Stage artifact exists and is readable.
- [ ] Stage summary is visible in chat and written to progress logs.
- [ ] `stage-complete` succeeded or the retry reason is recorded.
- [ ] Fresh relevant context digests are preferred over full artifact injection.
- [ ] Downstream consumers are identified when the stage changes a producer/output.

### Post-workflow

- [ ] `analysis.md`, `architecture.md`, `execution-plan.md`, `code.diff`, `test-report.md`, `review-output.md`, and `deploy-output.md` are present when applicable.
- [ ] `output/context-digests/index.json` is updated.
- [ ] Known unrelated failures are separated from regressions caused by this task.
- [ ] Completion summary lists modified files and acceptance criteria status.

---

## Best Practices

1. **Use digest-first context** — inject compact, fresh, relevant context first; read full artifacts only when the digest is missing, stale, insufficient, or precise evidence is required.
2. **Checkpoint aggressively** — each `stage-complete` records progress, digest, self-report, and trace data.
3. **Keep downstream adoption explicit** — for producer changes, require consumer analysis, consumer adoption design, consumer tasks, and consumer tests.
4. **Report real test output** — do not claim tests passed without command evidence.
5. **Keep stage summaries visible** — users should not need to open logs to know the current stage result.

---

## Anti-Patterns

1. **Direct implementation after `/wf`** — bypassing the stage chain creates unreviewed, untraceable work.
2. **Using stale full-artifact defaults** — injecting full artifacts when a fresh relevant digest is enough wastes tokens and can distract the agent.
3. **Producer-only implementation** — creating an output without updating or verifying consumers makes the feature effectively unused.
4. **Raw content handoff** — dumping large files between stages causes token blowups; use file refs and digests.
5. **Silent scope expansion** — adding unrelated refactors during DEVELOP makes TEST and REVIEW ambiguous.
6. **Ignoring known failures** — broad suite failures must be reported and classified, not hidden.

---

## Gotchas

1. **PowerShell quoting** — avoid complex inline `node -e` scripts when quoting is fragile; use small temporary scripts only when necessary and clean them up.
2. **Windows file locks** — atomic writes may fail if files are watched or open; retry or use IDE-native file tools.
3. **Digest is not the source of truth** — digest reduces injection size; full artifact/source refs remain the audit trail.
4. **Stage naming drift** — use `DEVELOP` for the current implementation stage and avoid reintroducing older implementation-stage labels.
5. **Completion is after DEPLOY** — describe active IDE workflow closure as `DEPLOY` plus `session-summary`.

---

## Context Hints

1. The active IDE pipeline is enforced by `workflow/tools/ide-workflow-bridge.js`.
2. `workflow-stage` and `stage-complete` are the bridge-enforced boundaries for each stage.
3. `output/context-digests/` is the lightweight cross-stage context layer.
4. Full artifacts remain available for audit and fallback.
5. If this document conflicts with bridge behavior, bridge behavior is the current source of truth and this document should be updated.

---

## Evolution History

- **v2.1.0** — Aligned SOP with current IDE `/wf` pipeline: `ANALYSE -> ARCHITECT -> PLAN -> DEVELOP -> TEST -> REVIEW -> DEPLOY`; removed legacy analysis artifact names, legacy implementation/final stage labels, skip-stage wording, and obsolete communication-log drift from the active path.
- **v2.0.0** — Added digest-first and producer-consumer impact rules.
