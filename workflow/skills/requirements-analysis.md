---
name: requirements-analysis
version: 1.0.0
type: methodology
domains: [analysis, requirements, elicitation]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [requirement, analysis, user story, acceptance criteria, prioritize, scope, elicit, stakeholder, MoSCoW, 5 whys]
  roles: [analyst]
description: "Requirements analysis methodology skill — 5 Whys, user story mapping, MoSCoW, INVEST, acceptance criteria"
---

# Skill: requirements-analysis

> **Version**: 1.0.0
> **Purpose**: Systematic requirements elicitation and analysis for the ANALYSE stage

## Core Principle

Requirements are hypotheses, not facts. Every requirement must be traceable to a user need, testable via acceptance criteria, and prioritized by business value — not by who shouted loudest.

## 1. Root Cause Elicitation: 5 Whys Method

When a user states a requirement, drill down to the real need:

```
Problem: "We need a caching layer"
Why 1: "The API is slow" → Why 2: "DB queries take 2s" →
Why 3: "No index on user_id" → Why 4: "Schema was auto-generated" →
Why 5: "No DB review in pipeline"
Root cause: Missing DB schema review step, not missing cache.
```

**Rules**:
- Never accept the first "what" as the real "why"
- Stop when you reach an actionable root cause (something you can fix)
- If 5 Whys leads to organizational issues, document as constraint, not requirement

## 2. Requirement Quality: INVEST Criteria

Every user story / requirement MUST pass INVEST:

| Criterion | Check | Fail Example |
|-----------|-------|-------------|
| **I**ndependent | Can be delivered without other stories | "After login is done..." |
| **N**egotiable | Not a contract; solution is flexible | "Use Redis for caching" |
| **V**aluable | Delivers user/business value | "Refactor utils module" |
| **E**stimable | Team can estimate effort | "Make it scalable" |
| **S**mall | Fits in one iteration | "Build entire auth system" |
| **T**estable | Has clear pass/fail criteria | "Improve UX" |

**Action**: Flag any requirement failing ≥2 INVEST criteria for rewrite.

## 3. Prioritization: MoSCoW Method

Classify every requirement into exactly one category:

- **Must have**: System is unusable without it. Failure = project failure.
- **Should have**: Important but workaround exists. Delay = pain, not failure.
- **Could have**: Nice-to-have. Include only if time/budget allows.
- **Won't have (this time)**: Explicitly out of scope. Document for future.

**Rules**:
- Must-haves should be ≤60% of total effort (leave buffer)
- Every "Must" needs a justification: what breaks without it?
- "Won't have" is not rejection — it's deferred with rationale

## 4. Acceptance Criteria: Given-When-Then

Every requirement MUST have at least one acceptance criterion in GWT format:

```
Given [precondition/context]
When  [action/trigger]
Then  [expected outcome, measurable]
```

**Quality checks**:
- Each criterion tests ONE behavior (not compound)
- "Then" must be observable/measurable (not "system works correctly")
- Include at least one negative/edge case per requirement
- Include performance criteria where relevant (e.g., "Then response < 200ms")

## 5. Scope Boundary Analysis

For every requirement, explicitly define:

- **In scope**: What this requirement covers
- **Out of scope**: What it explicitly does NOT cover
- **Assumptions**: What must be true for this to work
- **Dependencies**: What must exist before this can start
- **Risks**: What could prevent delivery

## 6. Fishbone Decomposition (for complex requirements)

When a requirement is too large or vague, decompose using categories:

```
                    ┌─ People: Who uses it? Who maintains it?
                    ├─ Process: What workflow does it fit into?
Requirement ────────├─ Technology: What systems are involved?
                    ├─ Data: What data flows in/out?
                    ├─ Integration: What external systems connect?
                    └─ Constraints: What limits exist (perf, security, compliance)?
```

## Anti-Patterns

- **Solution masquerading as requirement**: "Use WebSocket" → real need is "real-time updates"
- **Gold plating**: Adding features nobody asked for
- **Anchoring**: First requirement mentioned gets highest priority regardless of value
- **Scope creep via ambiguity**: Vague requirements expand during development
- **Missing negative requirements**: Only specifying what system should do, not what it must NOT do

## Checklist (ANALYSE stage exit criteria)

- [ ] Every requirement traced to user need (not implementation preference)
- [ ] INVEST criteria checked; failures flagged and rewritten
- [ ] MoSCoW priority assigned with justification
- [ ] At least 1 GWT acceptance criterion per requirement
- [ ] Scope boundaries (in/out/assumptions/dependencies/risks) documented
- [ ] Negative/edge cases identified for each Must-have
- [ ] No solution-as-requirement anti-pattern present
