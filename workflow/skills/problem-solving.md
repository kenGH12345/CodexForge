---
name: problem-solving
version: 1.0.0
type: methodology
domains: [analysis, problem-solving, retrospective, decision-making]
dependencies: []
load_level: task
max_tokens: 1100
triggers:
  keywords: [problem, issue, root cause, solution, retrospective, debug, fix, resolve, 复盘, 根因, 方案, 问题, 解决, 修复]
  roles: [analyst, architect, developer, tester]
description: "Problem-solving methodology — define → scope → analyze → solve → execute → retrospect. Based on the 10-step framework."
---

# Skill: problem-solving

> **Version**: 1.0.0
> **Purpose**: Structured problem-solving for any stage of the workflow

## Core Principle

Never solve a problem you haven't defined. The cost of solving the wrong problem is always higher than the cost of defining the right one.

## Phase 1: Define & Scope (Steps 1-2)

Before touching any code or proposing any solution:

**Step 1 — Define the Problem**:
```
Current State:  [observable fact, not opinion]
Expected State: [measurable target]
Gap:            [delta = the real problem]
```

**Step 2 — Scope the Problem**:

| Dimension | Question | Answer |
|-----------|----------|--------|
| Boundary | Is this a local issue or systemic? | |
| Urgency | Must fix now, or can defer? | |
| Impact | Who/what is affected? | |
| Ownership | Who is responsible for the fix? | |

> Rule: Scope creep starts here. Lock the boundary before proceeding.

## Phase 2: Investigate (Steps 3-4)

**Step 3 — Collect Evidence** (facts only, no guesses):
- What happened? (observable events, logs, error messages)
- When did it start? (timeline)
- Who/what is affected? (blast radius)

**Step 4 — Root Cause: 5 Whys**:
```
Symptom → Why 1 → Why 2 → Why 3 → Why 4 → Why 5 (root cause)
```
- Stop when you reach something actionable
- If 5 Whys leads to org/process issues, document as constraint
- Never accept the first "what" as the real "why"

## Phase 3: Solve (Steps 5-7)

**Step 5 — Set Success Criteria** (before generating solutions):
- What state = "solved"? (specific, measurable)
- What is the deadline?
- How will you verify?

**Step 6 — Generate 3 Options** (minimum):

| Option | Description | Effort | Risk | Reversible? |
|--------|-------------|--------|------|-------------|
| A (optimal) | | | | |
| B (constrained) | | | | |
| C (fallback) | | | | |

**Step 7 — Evaluate & Decide**:
- Eliminate options that don't address the root cause
- Prefer reversible over irreversible changes
- Choose the simplest option that meets success criteria

## Phase 4: Execute & Learn (Steps 8-10)

**Step 8 — Execute**:
- One owner, one deadline, one clear action
- No "we'll try to..." — commit to a specific change

**Step 9 — Verify**:
- Did the change close the gap defined in Step 1?
- Run the success criteria from Step 5

**Step 10 — Retrospect (3-Layer)**:

| Layer | Question | Purpose |
|-------|----------|---------|
| **Prevention** | How did this problem arise? Can we prevent recurrence at the source? | Eliminate root cause |
| **Capability** | What did we learn? What pattern can we reuse? | Build institutional knowledge |
| **Efficiency** | What slowed us down? How do we solve this 2x faster next time? | Optimize the process |

## Anti-Patterns

- **Solution-first thinking**: Proposing fixes before defining the problem
- **Symptom treatment**: Fixing the error message instead of the root cause
- **Single-option trap**: Only one solution = no real decision
- **Scope inflation**: Adding "while we're at it" work that isn't part of the gap
- **Skipping retrospect**: Solving the same problem twice because lessons weren't captured

## Quick Reference

```
1. Define:   Current → Expected → Gap
2. Scope:    Boundary / Urgency / Impact
3. Evidence: Facts only, no guesses
4. 5 Whys:  Symptom → Root Cause
5. Criteria: What does "solved" look like?
6. Options:  A (optimal) / B (constrained) / C (fallback)
7. Decide:   Simplest option that closes the gap
8. Execute:  One owner, one deadline
9. Verify:   Did it close the gap?
10. Retro:   Prevention / Capability / Efficiency
```
