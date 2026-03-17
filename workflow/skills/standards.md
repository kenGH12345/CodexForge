---
name: standards
version: 1.0.0
type: standards
domains: [general, quality, conventions]
dependencies: []
load_level: global
max_tokens: 600
triggers:
  keywords: [standard, convention, naming, style, format, lint]
  roles: [developer, architect, coding-agent]
description: "Project-wide coding standards, naming conventions, and directory structure rules"
---

# Skill: standards

> **Version**: 1.0.0
> **Description**: Project-wide coding standards, naming conventions, and directory structure rules
> **Domains**: general, quality, conventions

---

## Coding Standards

### JavaScript / Node.js Conventions

1. **Strict mode**: Always use `'use strict';` at the top of each module
2. **Const over let**: Prefer `const` for variables that are not reassigned
3. **Early return**: Use early returns to reduce nesting depth
4. **Error handling**: Always handle errors in async functions with try/catch
5. **Atomic writes**: Use tmp-file + rename pattern for crash-safe file writes
6. **JSDoc**: All public methods must have JSDoc comments with @param and @returns

## Naming Conventions

### Files and Directories
- **Modules**: `kebab-case.js` (e.g. `skill-evolution.js`)
- **Classes**: `PascalCase` (e.g. `SkillEvolutionEngine`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g. `MAX_INJECT_TOKENS`)
- **Functions/Methods**: `camelCase` (e.g. `registerSkill`)
- **Private methods**: Prefix with `_` (e.g. `_loadRegistry`)

### Skill Files
- **Filename**: `kebab-case.md` matching the skill name
- **Frontmatter**: Always include YAML frontmatter with metadata

## Directory Structure

```
workflow/
├── core/          # Core engine modules (state machine, orchestrator, etc.)
├── agents/        # Agent implementations (analyst, architect, developer, etc.)
├── commands/      # CLI command handlers
├── hooks/         # Hook event handlers
├── tools/         # Tool adapters (thin-tools, thick-tools)
├── skills/        # Skill SOP markdown files (with YAML frontmatter)
├── docs/          # Architecture constraints, decision logs
└── output/        # Generated artifacts (requirement.md, architecture.md, etc.)
```

## Commit Conventions

- Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- Each commit should compile and pass tests independently
- Reference issue/task IDs when applicable

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-17 | Initial creation with JS/Node conventions |
