---
id: ADR-56
title: Production-First Principle (禁止孤岛模块)
status: Accepted
date: 2026-04-22
author: Andrej Karpathy (WorkFlowAgent)
supersedes: []
related: [ADR-37, ADR-55]
---

# ADR-56 — Production-First Principle

> **Decision**: Every feature, primitive, or infrastructure module MUST be
> wired into a real production call path within the same delivery window it
> lands, or it MUST NOT be merged.

## Context

In April 2026, while implementing P0 token-saving optimizations, we split work
into "Phase 1 (primitives)" and "Phase 2 (production integration)". Phase 1
shipped working code + 100% passing tests for both `ConversationCompactor`
and `getAdaptiveMultiplier`. For the full gap until Phase 2, these primitives
had **0% production reach** — they existed in the codebase but no real `/wf`
run ever called them. Theoretical savings during this gap: 0%.

Only when a user asked "are they actually saving tokens?" did we discover:

| Metric | Phase 1 end | Phase 2 end |
|--------|-------------|-------------|
| Require-reachable | ❌ No callers | ✅ 4 callers |
| Observability events | ❌ Zero | ✅ Per-call records |
| End-to-end test | ✅ Unit smoke only | ✅ Integration smoke |
| Real-run token savings | **0%** | 25-40% |

This is not unique. A codebase audit identified similar patterns: audit trails
with no readers, observability hooks with no dashboard, enrichment functions
imported only by their own tests.

## Problem

"Written but never called" code is **worse than no code**:
- Maintenance burden (lint, type checks, review time)
- Cognitive overhead (future developers wonder "why is this here?")
- False confidence ("we have compaction!" when compaction is never invoked)
- Drift risk (primitive and its assumed caller evolve independently → integration breaks silently)

The root cause is a **process gap**: we treated "code + tests pass" as "done",
but the real definition of done is "code runs in production and produces value".

## Decision

A module is considered **production-ready** if and only if ALL THREE criteria hold:

1. **Require-reachable** — `require(...)`'d by ≥1 non-test file outside its own folder
2. **Observability event present** — emits ≥1 event recorded in production trail
3. **End-to-end integration test** — a file in `tests/integration/` or `tests/e2e/` imports and exercises it

A module satisfying 0-2 of the above is an **Isolation Module** (孤岛模块).

Isolation Modules are **not allowed to merge** unless they declare an explicit
JSDoc exemption:

```js
/**
 * @production-exempt experimental — reason for exemption, target merge date
 */
```

Allowed exemption values: `experimental` (no deadline), `reserved` (≤30 days),
`test-helper` (forever; must live under `tests/`).

## Enforcement Mechanism (Defense in Depth)

Single-layer constraints have been empirically shown to be bypassed (see the
Comment Discipline P0 rule, which was still violated multiple times after
being written into `architecture-constraints.md`). We therefore require
**three concurrent layers**:

| Layer | Mechanism | Prevents |
|-------|-----------|----------|
| Documentation | `architecture-constraints.md` Production-First section + this ADR | "I didn't know the rule" |
| Machine Detection | `workflow/tools/production-readiness-scanner.js` + Bridge `production-readiness-check` command + weekly scheduler | "I forgot to check" |
| Persistent Memory | Agent memory record (ID: pending) | "The rule slipped my mind across sessions" |

### Scanner Signals (three concurrent checks)

| Signal | Heuristic |
|--------|-----------|
| R1: require orphan | Grep-search finds no `require('./module-name')` or `require('../...module-name')` outside the module's own folder, excluding `tests/` |
| R2: no observability | Grep-search within the module finds no calls to `observability.record*`, `console.error`, or `logger.info/warn/error` — OR the calls exist but nothing reads `output/observability-*.json` |
| R3: no integration test | Grep-search within `tests/integration/` and `tests/e2e/` finds no import of the module |

The scanner classifies as follows:

| Signals failed | Classification | Action |
|---------------|----------------|--------|
| 0 | ✅ Production-ready | OK |
| 1 | ⚠️ Weak integration | Report, fix in next delivery window |
| 2-3 | ❌ Isolation Module | MUST fix before next merge |

### Grace Period

Newly-merged modules (git log: first commit <7 days ago) get a one-week grace
period — scanner reports them as `pending-integration` rather than `isolation`.

## Consequences

### Positive

- No more "Phase 1 primitive sitting idle" anti-pattern
- Clear, mechanical definition of "done"
- Scanner output doubles as a living isolation-module inventory (supports refactor planning)
- Forces conscious exemption decisions (experimental vs reserved vs production)

### Negative (and mitigations)

| Risk | Mitigation |
|------|-----------|
| Scanner false positives (e.g. dynamic require) | Exemption tag + manual review in `output/isolation-modules-inventory.md` |
| Developers game the rule by writing a "fake" integration test | Reviewer responsibility; scanner can flag tests that only import without calling |
| Infrastructure modules have only lazy consumers → R2 fails | Observability event emission is required regardless of consumer — ensures data is at least collectable |

## Rejected Alternatives

| Alternative | Why Rejected |
|-------------|--------------|
| Block via pre-commit hook | Too aggressive for Phase 1 work; blocks legitimate WIP |
| Block via `/wf` workflow PLAN stage | Misaligned — planning happens before code exists |
| Rely on human code review only | Empirically insufficient (Comment Discipline precedent) |
| Strict 30-day cleanup deadline (Option C in original decision) | Too rigid; some legitimate cases (reserved APIs) need longer |

## Related Work

- **ADR-37** IDE-First Principle — similar "fail closed" structural constraint
- **ADR-55** 10-Dimensions Framework — this complements `DEPTH` and `EVIDENCE`
  dimensions by asking "is the evidence actually wired up?"
- **Comment Discipline P0** — served as the empirical case showing docs-only
  constraints get violated

## Metadata

- Supersedes: none
- Last reviewed: 2026-04-22
- Next review: 2026-07-22 (3 months after adoption)
