---
name: project-conventions
version: 1.0.0
type: standards
domains: [general, conventions, project-setup]
dependencies: []
load_level: global
max_tokens: 600
triggers:
  keywords: [convention, naming, project structure, directory, commit, branch, file naming]
  roles: [developer, architect, coding-agent]
description: "Language-agnostic project conventions: naming, directory structure, git workflows, and cross-language standards"
---

# Skill: project-conventions

> **Version**: 1.0.0
> **Description**: Language-agnostic project conventions: naming, directory structure, git workflows, and cross-language standards. JS-specific rules migrated to `javascript-dev` skill.
> **Domains**: general, conventions, project-setup

---

## Cross-Language Conventions
<!-- PURPOSE: Language-agnostic conventions enforced across all projects regardless of tech stack. -->

1. **Single responsibility per file**: Each file should have one primary export / class / purpose
2. **Max line length: 120 characters**: Wrap longer lines. Exception: URLs, import paths, string literals
3. **No commented-out code**: Delete it; version control remembers. Reference commit hash if needed
4. **Consistent indentation**: 2 spaces for JS/YAML/JSON, 4 spaces for Python, tabs for Go
5. **Imports sorted alphabetically**: Group by: built-in �?external �?internal, with blank line between groups
6. **No wildcard imports**: Always import specific symbols (`import { foo }` not `import *`)
7. **Guard against null/undefined**: Validate inputs at trust boundaries; use optional chaining (`?.`) for deep access
8. **Log levels used correctly**: ERROR = needs human attention, WARN = self-recovered, INFO = business events, DEBUG = development only

## Naming Conventions
<!-- PURPOSE: Naming patterns for files, variables, functions, classes, constants, and database entities. Include examples for each pattern. -->

### Files and Directories
- **Modules**: `kebab-case.js` (e.g. `skill-evolution.js`, `prompt-builder.js`)
- **Test files**: `<module>.test.js` (e.g. `skill-evolution.test.js`)
- **Config files**: `kebab-case.json` or `kebab-case.yaml` (e.g. `adapter-config.json`)
- **Skill files**: `kebab-case.md` matching the skill name (e.g. `api-design.md`)
- **Script files**: `kebab-case.js` in `scripts/` (e.g. `batch-inject-purpose.js`)

### Code Symbols
| Category | Pattern | Example | Anti-Example |
|----------|---------|---------|-------------|
| Class | `PascalCase` | `SkillEvolutionEngine` | `skillEvolutionEngine` |
| Function/Method | `camelCase` | `registerSkill()` | `RegisterSkill()` |
| Private method | `_camelCase` | `_loadRegistry()` | `loadRegistryPrivate()` |
| Constant | `UPPER_SNAKE_CASE` | `MAX_INJECT_TOKENS` | `maxInjectTokens` |
| Boolean variable | `is/has/can/should` prefix | `isReady`, `hasError` | `ready`, `error` |
| Array variable | Plural noun | `skills`, `pendingTasks` | `skillList`, `taskArr` |
| Map/Dict variable | `<key>To<Value>` or `<noun>Map` | `idToName`, `skillMap` | `mapping`, `dict` |
| Event handler | `on<Event>` or `handle<Event>` | `onStageComplete` | `stageCompleteCallback` |
| Factory function | `create<Thing>` | `createAgent()` | `newAgent()`, `agentFactory()` |

### Skill Metadata
- **Frontmatter**: Always include YAML frontmatter with: `name`, `version`, `type`, `domains`, `triggers`, `description`
- **Version format**: Semantic versioning `MAJOR.MINOR.PATCH`
- **Domain values**: Lowercase, hyphen-separated (e.g. `api-design`, `error-handling`)

## Directory Structure
<!-- PURPOSE: Expected project layout rules. Describe where different types of files should live and why. -->

```
workflow/
├── core/          # Core engine modules (state machine, orchestrator, etc.)
�?                 # Rule: No external dependencies; only Node.js built-ins
├── agents/        # Agent implementations (analyst, architect, developer, etc.)
�?                 # Rule: One file per agent; agent must extend base Agent class
├── commands/      # CLI command handlers (registered in command-router)
�?                 # Rule: Thin wrappers; delegate logic to core/
├── hooks/         # Hook event handlers (pre-stage, post-stage, etc.)
�?                 # Rule: Side-effect only; must not alter stage output
├── tools/         # Tool adapters (thin-tools, thick-tools)
�?                 # Rule: Adapter pattern; each tool isolated behind interface
├── skills/        # Skill SOP markdown files (with YAML frontmatter)
�?                 # Rule: One file per skill; machine-readable frontmatter
├── docs/          # Architecture constraints, decision logs, specs
�?                 # Rule: Reference-only; not loaded into agent prompts
├── scripts/       # Utility scripts (batch ops, migrations, analysis)
�?                 # Rule: Standalone; runnable with `node scripts/<name>.js`
├── tests/         # Unit and integration tests
�?                 # Rule: Mirror core/ structure; one test file per module
└── output/        # Generated artifacts (requirement.md, architecture.md, etc.)
                   # Rule: Gitignored; ephemeral per-project
```

### Placement Rules
1. **New core logic** �?`core/` �?Must be required by orchestrator or agents
2. **New agent** �?`agents/` �?Must register in agent-registry
3. **New CLI command** �?`commands/` �?Must register in command-router
4. **New skill** �?`skills/` �?Must have valid YAML frontmatter
5. **New test** �?`tests/` �?Must be importable by `unit.test.js` runner
6. **Temporary/debug files** �?Never committed; add to `.gitignore`

## Commit Conventions
<!-- PURPOSE: Git commit message format, branch naming, PR title conventions. Include templates and examples. -->

### Commit Message Format

```
<type>(<scope>): <short description>

[optional body: what and why, not how]

[optional footer: Breaking Change, Issue references]
```

### Types
| Type | When to Use | Example |
|------|-------------|---------|
| `feat` | New feature or capability | `feat(planner): add upstream context injection` |
| `fix` | Bug fix | `fix(bus): correct sender role mapping for PLAN stage` |
| `refactor` | Code restructuring without behavior change | `refactor(prompt-builder): extract auto-sections into helper` |
| `docs` | Documentation only | `docs(skills): add PURPOSE comments to all sections` |
| `test` | Adding or updating tests | `test(skill-evolution): add enrichment prompt coverage` |
| `chore` | Tooling, build, CI changes | `chore(scripts): add batch-inject-purpose utility` |
| `perf` | Performance improvement | `perf(context-loader): cache skill file reads` |

### Rules
1. **Each commit must compile and pass tests independently** �?No "WIP" commits in main branch
2. **Subject line �?72 characters** �?Truncated in most UIs beyond this
3. **Use imperative mood** �?"Add feature" not "Added feature" or "Adds feature"
4. **Reference issue/task IDs in footer** �?e.g. `Closes #42` or `Refs T-3`
5. **Breaking changes require BREAKING CHANGE footer** �?e.g. `BREAKING CHANGE: removed deprecated API`
6. **Atomic commits** �?One logical change per commit; don't mix feat + refactor

### Branch Naming
- Feature: `feat/<short-description>` (e.g. `feat/planner-stage`)
- Fix: `fix/<issue-id>-<description>` (e.g. `fix/42-bus-routing`)
- Release: `release/v<version>` (e.g. `release/v2.0.0`)

## Rules
<!-- PURPOSE: Prescriptive constraints for project-wide conventions compliance. -->

1. **Every PR must pass linting with zero warnings** — Warnings are deferred errors. Configure CI to treat warnings as errors (`--max-warnings 0`). No exceptions for "legacy code" — fix it or suppress with an inline comment explaining why.

2. **All new files must follow the naming convention** — No exceptions. A file named `myHelper.js` (camelCase) in a `kebab-case.js` project causes confusion and breaks tooling assumptions. Enforce via pre-commit hook.

3. **Every module must have a corresponding test file** — If `core/skill-evolution.js` exists, `tests/skill-evolution.test.js` must exist. Coverage is secondary; test existence is the minimum bar.

4. **Environment-specific config must never be committed** — API keys, database passwords, secrets — all go in `.env` files (gitignored) or CI secrets. Use `.env.example` to document required variables without values.

5. **All error messages must be in English** — Comments and UI strings can follow project locale, but error messages (logs, exceptions, API errors) must be in English for consistent monitoring, alerting, and Googling.
## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for standards compliance. -->

1. **Phase 1: Setup** �?Clone the repo, run `npm install`, verify all linting passes with `npm run lint`. If linting fails on a fresh clone, fix the failing rules before starting any new work.

2. **Phase 2: Development** �?Follow naming conventions from this Skill. Run linter after every file save (configure IDE to lint on save). Commit messages follow the conventional commit format.

3. **Phase 3: Pre-commit** �?Before committing: (a) run `npm test` to ensure no regressions, (b) verify no `console.log` statements left in production code, (c) verify no TODO comments without owner and ticket reference.

4. **Phase 4: Code Review** �?Reviewer checks: naming, file placement, commit message format, test coverage, and standards compliance. Use this Skill's Checklist as the review guide.

## Checklist
<!-- PURPOSE: Verification checklist for standards compliance. -->

### Naming
- [ ] All new files follow `kebab-case.js` convention
- [ ] All new classes use `PascalCase`
- [ ] All new constants use `UPPER_SNAKE_CASE`
- [ ] Boolean variables use `is/has/can/should` prefix

### Code Quality
- [ ] No wildcard imports (always import specific symbols)
- [ ] Logs use correct level (ERROR = human attention, WARN = self-recovered, INFO = business, DEBUG = dev only)

### Project Structure
- [ ] New files placed in correct directory per Directory Structure rules
- [ ] New Skill files have valid YAML frontmatter
- [ ] Test file exists for every new module

### Git
- [ ] Commit message follows `<type>(<scope>): <description>` format
- [ ] Subject line �?72 characters
- [ ] No "WIP" or "fix typo" commits in PR (squash them)

## Best Practices
<!-- PURPOSE: Recommended patterns for maintaining project standards. -->

1. **Use EditorConfig + Prettier for formatting** �?Automated formatting eliminates style debates. Configure `.editorconfig` for cross-IDE consistency and Prettier for JS/TS/JSON/YAML. Run Prettier as a pre-commit hook.

2. **Adopt trunk-based development** �?Keep branches short-lived (< 2 days). Merge to main frequently. Long-lived feature branches accumulate merge conflicts and drift from main. Use feature flags for incomplete features.

3. **Version Skill files semantically** �?PATCH (1.0.x): typos, clarifications. MINOR (1.x.0): new entries in existing sections. MAJOR (x.0.0): new sections, structural changes, or rules that change behavior.

4. **Review standards quarterly** �?Standards that don't evolve become irrelevant. Every quarter, review this Skill: remove rules nobody follows, add rules for recurring issues, update examples to match current codebase.

## Anti-Patterns
<!-- PURPOSE: Common standards violations and their corrections. -->

1. **"We'll fix the naming later"** �?Technical debt in naming compounds. Every new file that follows the wrong convention makes the correct convention harder to enforce. �?`myComponent.JS` �?�?`my-component.js`. Fix naming before merging.

2. **Copy-paste commit messages** �?`fix: stuff`, `update`, `wip` provide zero information in `git log`. �?`fix stuff` �?�?`fix(bus): correct sender role mapping for PLAN stage`. Each commit message is documentation for future debuggers.

3. **Skipping tests "because it's a small change"** �?Small changes cause big regressions. A one-line config change can break the entire application. �?"too small to test" �?�?add a regression test for the specific fix.

4. **Inconsistent error handling patterns** �?Module A uses exceptions, module B uses error codes, module C uses Result types. Consumer code needs three different error handling strategies. �?Mixed patterns �?�?One pattern per module boundary, with adapters at boundaries.

## Gotchas
<!-- PURPOSE: Environment-specific traps related to standards. -->

1. **Windows vs Unix line endings** �?Git on Windows may convert LF to CRLF, breaking scripts with `#!/bin/bash` shebangs. Fix: configure `.gitattributes` with `* text=auto` and `*.sh text eol=lf`.

2. **Case-insensitive file systems (macOS/Windows)** �?Renaming `Foo.js` to `foo.js` may not register as a change in Git on case-insensitive systems. Use `git mv Foo.js foo.js` to force the rename.

3. **Node.js require resolution order** �?`require('config')` first checks `node_modules/config`, not `./config.js`. If you have a local file named the same as an npm package, use explicit relative path: `require('./config')`.

4. **JSON trailing commas** �?JSON spec does not allow trailing commas, but JavaScript objects do. `JSON.parse('{"a":1,}')` throws `SyntaxError`. Common when copy-pasting from JS code to JSON config files.

## Context Hints
<!-- PURPOSE: Background knowledge for standards decisions. -->

1. **Standards adoption follows an S-curve** �?New standards face resistance initially, then rapidly adopt once 30-40% of the team follows them. Focus energy on getting early adopters to demonstrate the value, not on forcing compliance.

2. **Linters enforce the 80%, culture enforces the 20%** �?Automated tools catch formatting and simple pattern violations. But deeper standards (meaningful names, appropriate abstractions, clear intent) require human judgment during code review.

3. **The "broken windows" theory applies to codebases** �?One file that violates naming conventions signals that conventions are optional. Maintain zero tolerance for violations in new code, even if legacy code has violations. Fix legacy violations opportunistically.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-17 | Initial creation with JS/Node conventions |
| v2.0.0 | 2026-03-19 | Major expansion: cross-language conventions (8), naming examples table, directory placement rules, commit type table, branch naming |
| v3.0.0 | 2026-03-19 | Skill-enrich-all: added 7 standard sections (Rules, SOP, Checklist, Best Practices, Anti-Patterns, Gotchas, Context Hints) |
| v1.0.0 | 2026-04-27 | Renamed from `standards`; removed JavaScript/Node.js specific coding rules (migrated to `javascript-dev` v1.2.0); refocused to language-agnostic project conventions (naming, directory structure, git workflows) |
