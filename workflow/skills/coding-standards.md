---
name: coding-standards
version: 1.1.0
type: domain-skill
domains: [quality, conventions, maintainability]
dependencies: [standards]
load_level: global
max_tokens: 1500
triggers:
  keywords: [coding standards, best practices, code style, naming, conventions, maintainability, readability]
  roles: [developer, architect, coding-agent]
description: "Universal coding standards and best practices applicable across all projects and languages"
---

# Skill: coding-standards

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: Universal coding standards and best practices applicable across all projects and languages
> **Domains**: quality, conventions, maintainability

---

## Rules

### R1: Readability First (MANDATORY)
- Code is read more often than written
- Clear, descriptive names for variables, functions, and types
- Self-documenting code preferred over comments explaining "what"
- Comments explain "why", not "what"

### R2: Simplicity Over Cleverness
- Simplest solution that solves the problem
- Avoid premature optimization
- Avoid over-engineering for hypothetical future requirements
- Easy to understand > clever/concise code

### R3: DRY Principle (Don't Repeat Yourself)
- Extract common logic into reusable functions/modules
- Create reusable components/abstractions
- Share utilities across the codebase
- Eliminate copy-paste programming

### R4: YAGNI Principle (You Aren't Gonna Need It)
- Don't build features before they're needed
- Avoid speculative generality
- Add complexity only when required by actual use cases
- Start simple, refactor when concrete needs emerge

### R5: Immutability Preferred
- Favor immutable data structures
- Avoid mutating state when possible
- Use copy-on-write patterns for updates
- Mutation should be explicit and justified

---

## SOP (Standard Operating Procedure)

### Phase 1: Before Writing Code
1. Understand the requirements and constraints
2. Consider the simplest possible solution
3. Identify potential reusable components from existing codebase
4. Plan variable/function naming upfront

### Phase 2: During Implementation
1. **Naming**: Follow `standards#Naming Conventions` for detailed patterns
   - Variable names answer "what" (e.g., `activeUserCount`, not `cnt`)
   - Function names use verb-noun pattern (e.g., `calculateTotal`, not `calc`)
   - See `standards` for: boolean prefixes, constant casing, file naming
2. **Structure**: Keep functions small and focused (single responsibility)
3. **Nesting**: Avoid deep nesting (max 3 levels); use early returns (see `standards#Early return`)
4. **Comments**: Add comments only for non-obvious "why"

### Phase 3: Self-Review
1. Read code as if seeing it for the first time
2. Check: Can I understand this without the author's context?
3. Eliminate magic numbers/strings (extract to named constants)
4. Remove dead code and commented-out blocks

### Phase 4: Refactor Opportunity
1. If a function exceeds 50 lines, extract helper functions
2. If similar logic appears 3+ times, create an abstraction
3. If a name requires a comment to explain it, rename it

---

## Checklist

### Naming & Readability
- [ ] All identifiers are descriptive and self-explanatory (see `standards#Naming Conventions` for patterns)
- [ ] Variable names are specific (not generic like `data`, `value`, `temp`)
- [ ] Function names describe what they do (verb for actions, noun for queries)
- [ ] Naming conventions verified against `standards` (constants, booleans, files)

### Code Structure
- [ ] Functions are small and focused (single responsibility)
- [ ] No deeply nested control flow (max 3 levels)
- [ ] Early returns used to reduce nesting
- [ ] No long parameter lists (use options object if >3 params)

### Maintainability
- [ ] No magic numbers or magic strings (see `standards#No magic numbers/strings`)
- [ ] No dead code or commented-out code blocks (see `standards#No commented-out code`)
- [ ] Comments explain "why", not "what"
- [ ] Complex logic has explanatory comments
- [ ] Edge cases are handled explicitly

### DRY Compliance
- [ ] No copy-pasted code (extract to shared utility)
- [ ] Common patterns are abstracted
- [ ] Configuration is centralized, not scattered

---

## Best Practices

### 1. Evidence-Based Naming
Every name should answer a question:
- Variable: "What does this represent?" → `pendingOrders` not `list`
- Function: "What does this do?" → `validateEmailFormat` not `check`
- Class/Module: "What is this?" → `UserAuthenticationService` not `Auth`

### 2. Progressive Complexity
Start with the simplest implementation that works:
1. **Phase 1**: Make it work (even if naive)
2. **Phase 2**: Make it right (refactor for clarity)
3. **Phase 3**: Make it fast (optimize only if needed)

### 3. Defensive Programming
- Validate inputs at function boundaries
- Fail fast with clear error messages
- Never assume external data is valid
- Explicitly handle error cases, not just happy paths

### 4. Code Review Mindset
Before submitting code, ask:
- "Will I understand this in 6 months?"
- "Could a junior developer maintain this?"
- "Is the intent immediately clear?"
- "What assumptions am I making?"

---

## Anti-Patterns

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Single-letter variables (except loop indices) | Descriptive names: `userCount` not `n` |
| Magic numbers: `if (retries > 3)` | Named constants: `if (retries > MAX_RETRIES)` |
| Deep nesting | Early returns / guard clauses |
| "Smart" one-liners | Clear, explicit multi-line code |
| Speculative generics | Concrete solution for actual use case |
| Comments stating the obvious | Comments explaining non-obvious intent |
| God functions (doing everything) | Single-responsibility functions |
| Premature abstraction | Copy-paste 3 times, then abstract |

---

## Context Hints

- **When doing code review**: Focus on naming and structure before micro-optimizations
- **When refactoring**: Preserve behavior first, improve structure second, optimize third
- **When adding features**: Prefer extending existing patterns over introducing new conventions
- **When in doubt**: Choose clarity over conciseness

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-26 | Initial creation based on ECC coding-standards, generalized for all tech stacks |
| v1.1.0 | 2026-03-26 | Optimized: removed overlapping naming conventions, now references `standards` for concrete patterns; focused on design principles (DRY/YAGNI/Immutability) |
