# Deep Audit Report

> Generated: 2026-03-25T02:09:38.398Z
> Duration: 0.1s
> Total findings: 11 (Critical: 0 | High: 0 | Medium: 10 | Low: 1 | Info: 0)

---

## 🔀 logic-consistency (9)

- **[medium]** Circular require detected: context-budget-manager.js ↔ context-budget-manager.js: Circular dependencies can cause initialization order issues.
  > 💡 Refactor to break the cycle. Consider using dependency injection or lazy loading.
- **[medium]** Circular require detected: experience-store.js ↔ experience-store.js: Circular dependencies can cause initialization order issues.
  > 💡 Refactor to break the cycle. Consider using dependency injection or lazy loading.
- **[medium]** Circular require detected: file-scanner.js ↔ file-scanner.js: Circular dependencies can cause initialization order issues.
  > 💡 Refactor to break the cycle. Consider using dependency injection or lazy loading.
- **[medium]** Circular require detected: ide-experience-hook.js ↔ ide-experience-hook.js: Circular dependencies can cause initialization order issues.
  > 💡 Refactor to break the cycle. Consider using dependency injection or lazy loading.
- **[medium]** Circular require detected: logger.js ↔ logger.js: Circular dependencies can cause initialization order issues.
  > 💡 Refactor to break the cycle. Consider using dependency injection or lazy loading.
- **[medium]** Circular require detected: orchestrator-stages.js ↔ orchestrator-stages.js: Circular dependencies can cause initialization order issues.
  > 💡 Refactor to break the cycle. Consider using dependency injection or lazy loading.
- **[medium]** Circular require detected: skill-enrichment.js ↔ web-search-helpers.js: Circular dependencies can cause initialization order issues.
  > 💡 Refactor to break the cycle. Consider using dependency injection or lazy loading.
- **[medium]** Circular require detected: web-search-helpers.js ↔ skill-enrichment.js: Circular dependencies can cause initialization order issues.
  > 💡 Refactor to break the cycle. Consider using dependency injection or lazy loading.
- **[low]** 86 completely silent catch blocks: Silent catch blocks (empty or comment-only) may hide important errors.
  > 💡 Audit silent catch blocks. Ensure at minimum a console.warn for non-trivial operations.

## ⚙️ config-consistency (1)

- **[medium]** File exceeds effective line limit: index.js: index.js has 659 effective lines (total: 1162, comments: 405, ratio: 34.85%).
  > 💡 Split into smaller modules. Extract helpers or sub-components.

## 📋 functional-completeness (1)

- **[medium]** 1/26 skills have thin content (< 40% section fill-rate): Hollow skills: [spec-template].
  > 💡 Run `/skill-enrich <name>` for each hollow skill, or batch enrich all.
