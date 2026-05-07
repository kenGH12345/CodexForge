---
name: domain-constraint-template
version: 1.0.0
layer: DOMAIN
triggers:
  - domain constraint
  - constraint template
  - domain rules
  - project conventions
roles:
  - architect
  - planner
  - developer
---

# Domain Constraint Template

> **Usage**: Copy this template to `<projectRoot>/.workflow/skills/` and customize
> for your project's domain rules and conventions. Do NOT edit this template directly.

## Rules

<!-- Replace with your domain-specific hard rules. Each rule must be verifiable. -->

1. [RULE_1]: [Description] — Violation severity: P0/P1/P2
2. [RULE_2]: [Description] — Violation severity: P0/P1/P2

## Anti-Patterns

<!-- List patterns that must be avoided in this domain. -->

- ❌ [ANTI_PATTERN_1]: [Why it's wrong and what to do instead]

## Gotchas

<!-- Non-obvious pitfalls specific to this domain. -->

- ⚠️ [GOTCHA_1]: [Root cause and mitigation]

## Best Practices

<!-- Recommended approaches proven effective in this domain. -->

- ✅ [PRACTICE_1]: [When and why to apply]

## Context Hints

<!-- Keywords that trigger this skill during ContextLoader matching. -->

- [KEYWORD_1]
- [KEYWORD_2]

## SOP

<!-- Step-by-step procedure for applying domain constraints. -->

1. [STEP_1]
2. [STEP_2]
3. [STEP_3]

## Checklist

- [ ] All domain rules referenced in code review
- [ ] Anti-patterns absent from new code
- [ ] Gotchas addressed in test plan
