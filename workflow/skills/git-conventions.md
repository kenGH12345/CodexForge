---
name: git-conventions
version: 1.0.0
type: standards
domains: [git, version-control, commit]
dependencies: []
load_level: task
max_tokens: 600
triggers:
  keywords: [commit, git, changelog, version, semver, branch, merge, pull request, PR, MR]
  roles: [developer, reviewer]
description: "Git commit conventions based on Conventional Commits spec and Angular standards"
---

# Skill: git-conventions

> **Version**: 1.0.0
> **Purpose**: Standardize commit messages, branching, and versioning for the DEVELOP stage

## 1. Commit Message Format (Conventional Commits)

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

### Type (required)

| Type | When to use | Bumps |
|------|------------|-------|
| `feat` | New feature for the user | MINOR |
| `fix` | Bug fix for the user | PATCH |
| `docs` | Documentation only | — |
| `style` | Formatting, no logic change | — |
| `refactor` | Code change, no feature/fix | — |
| `perf` | Performance improvement | PATCH |
| `test` | Adding/fixing tests | — |
| `build` | Build system or dependencies | — |
| `ci` | CI configuration | — |
| `chore` | Maintenance tasks | — |
| `revert` | Reverts a previous commit | varies |

### Scope (optional but recommended)

Scope identifies the module/component affected:
- `feat(auth): add OAuth2 login flow`
- `fix(api): handle null response from upstream`
- `refactor(db): extract connection pool config`

### Subject rules

- Imperative mood: "add" not "added" or "adds"
- No period at end
- Max 50 characters (hard limit: 72)
- Lowercase first letter

### Body rules

- Wrap at 72 characters
- Explain **what** and **why**, not **how** (code shows how)
- Separate from subject with blank line

### Footer rules

- `BREAKING CHANGE: <description>` — triggers MAJOR version bump
- `Fixes #123` or `Closes #456` — links to issue tracker
- `Reviewed-by: Name` — attribution

## 2. Commit Granularity

**One logical change per commit**:

| ✅ Good | ❌ Bad |
|---------|--------|
| `fix(auth): validate token expiry` | `fix: various fixes` |
| `feat(api): add pagination to /users` | `feat: add features` |
| `refactor(db): extract query builder` | `update code` |

**Rules**:
- Each commit should compile and pass tests independently
- Never mix formatting changes with logic changes
- Never mix refactoring with feature additions

## 3. Semantic Versioning (SemVer)

Format: `MAJOR.MINOR.PATCH`

| Change type | Version bump | Example |
|------------|-------------|---------|
| Breaking API change | MAJOR (X.0.0) | Remove public function |
| New backward-compatible feature | MINOR (0.X.0) | Add new endpoint |
| Backward-compatible bug fix | PATCH (0.0.X) | Fix null check |

**Breaking change indicators**:
- Removing or renaming public API
- Changing function signature (required params)
- Changing return type or response schema
- Changing default behavior

## 4. Branch Naming

```
<type>/<ticket-id>-<short-description>
```

Examples:
- `feat/AUTH-123-oauth2-login`
- `fix/API-456-null-response`
- `refactor/DB-789-connection-pool`

## 5. Merge/Pull Request Conventions

- Title follows commit format: `feat(scope): description`
- Description includes: What, Why, How to test
- Link to related issues/tickets
- Self-review checklist completed before requesting review

## Anti-Patterns

- **"WIP" commits on main**: Use feature branches
- **"Fix typo" × 10**: Squash before merge
- **Mega-commits**: 500+ line changes in one commit
- **Meaningless messages**: "update", "fix", "changes", "asdf"
- **Mixing concerns**: Refactor + feature + style in one commit

## Checklist

- [ ] Commit type matches the actual change
- [ ] Scope identifies affected module
- [ ] Subject is imperative, ≤50 chars, lowercase
- [ ] Body explains why (if non-obvious)
- [ ] Breaking changes flagged in footer
- [ ] One logical change per commit
- [ ] All commits compile and pass tests independently
