## 🧠 Business Logic Analysis

> Generated: 2026-03-24
> Strategy: 🏠 IDE LSP (IDE-First)
> Symbols: 1774 | Call Edges: 116255

### 📊 Summary

| Category | Count | Description |
|----------|-------|-------------|
| 🚪 Entry Points | 10 | Functions that start business flows |
| 🔄 Business Flows | 10 | Call chains from entry points |
| 🏗️ Core Services | 7 | High referenced foundation/hub symbols |
| 🔧 Utilities | 50 | Reusable helper functions |
| 📊 Data Flows | 15 | Parameter passing patterns |

### 🚪 Entry Points (Business Flow Starters)

> These functions are likely entry points for business logic. They are called from outside and orchestrate internal flows.

- **getPurposeMapForFile** `[controllers]` → 53 calls | `workflow/scripts/batch-inject-purpose.js`:149
- **computeThinness** `[services]` → 53 calls | `workflow/scripts/batch-inject-purpose.js`:162
- **validateConfig** `[services]` → 50 calls | `workflow/init-project.js`:51
- **readLines** `[controllers]` → 20 calls | `workflow/tools/thin-tools.js`:143 – Reduces token cost compared to reading the full fi
- **createAgentContract** `[controllers]` → 18 calls | `workflow/core/types.js`:133
- **parseArgs** `[services]` → 18 calls | `workflow/gen-agents.js`:27
- **parseArgs** `[services]` → 18 calls | `workflow/gen-experiences.js`:43
- **parseArgs** `[services]` → 18 calls | `workflow/init-project.js`:36
- **getCurrentVersion** `[controllers]` → 8 calls | `workflow/core/manifest-migration.js`:126 – Returns the current manifest schema version.
- **listMigrations** `[controllers]` → 8 calls | `workflow/core/manifest-migration.js`:133 – Lists all available migrations for diagnostic purp

### 🔄 Business Flows (Call Chains)

> These are the main business logic flows traced from entry points.
> Multi-branch flows show alternative execution paths.

- **getCurrentVersion** `[controllers, depth 4 | 8 branches]`
  - Main: getCurrentVersion → risks → block → Orchestrator
  - Alt: Orchestrator → existing → high
  - Alt: Orchestrator → high → block
- **listMigrations** `[controllers, depth 4 | 8 branches]`
  - Main: listMigrations → risks → block → Orchestrator
  - Alt: Orchestrator → existing → high
  - Alt: Orchestrator → high → block
- **createAgentContract** `[controllers, depth 4 | 8 branches]`
  - Main: createAgentContract → entry → block → Orchestrator
  - Alt: Orchestrator → existing → high
  - Alt: Orchestrator → high → block
- **validateConfig** `[services, depth 6 | 10 branches]`
  - Main: validateConfig → existing → high → block → Orchestrator → block
  - Alt: Orchestrator → existing
  - Alt: Orchestrator → high
- **readLines** `[controllers, depth 4 | 7 branches]`
  - Main: readLines → high → block → Orchestrator
  - Alt: Orchestrator → existing → high
  - Alt: block → search
- **parseArgs** `[services, depth 6 | 9 branches]`
  - Main: parseArgs → ExperienceStore → existing → high → block → Orchestrator
  - Alt: block → search
  - Alt: block → blocks
- **parseArgs** `[services, depth 6 | 9 branches]`
  - Main: parseArgs → ExperienceStore → existing → high → block → Orchestrator
  - Alt: block → search
  - Alt: block → blocks
- **parseArgs** `[services, depth 6 | 9 branches]`
  - Main: parseArgs → ExperienceStore → existing → high → block → Orchestrator
  - Alt: block → search
  - Alt: block → blocks
- **getPurposeMapForFile** `[controllers, depth 6 | 10 branches]`
  - Main: getPurposeMapForFile → existing → high → block → Orchestrator → block
  - Alt: Orchestrator → existing
  - Alt: Orchestrator → high
- **computeThinness** `[services, depth 6 | 10 branches]`
  - Main: computeThinness → existing → high → block → Orchestrator → block
  - Alt: Orchestrator → existing
  - Alt: Orchestrator → high

### 🏗️ Core Services (Foundation & Hub)

> These symbols are widely referenced and form the foundation of the codebase. Changes to them have wide impact.

- **Orchestrator** `[hub, 718 refs]` | `workflow/index.js`:87
- **search** `[hub, 600 refs]` | `workflow/core/code-graph.js`:540 – Search symbols by name or keyword (case-insensitiv
- **CodeGraph** `[hub, 300 refs]` | `workflow/core/code-graph.js`:118
- **Observability** `[hub, 227 refs]` | `workflow/core/observability.js`:41
- **isolated** `[hub, 222 refs]` | `workflow/core/orchestrator-task.js`:919
- **primary** `[hub, 222 refs]` | `workflow/core/deep-audit-orchestrator.js`:1058
- **buildAgentPrompt** `[hub, 218 refs]` | `workflow/core/prompt-builder.js`:756 – Builds a complete, optimised prompt for a specific

### 🔧 Utility Functions (Reusable Helpers)

> These functions are widely used but have low outgoing calls. They are good candidates for reuse.

- **block** `[860 refs]` | `workflow/core/token-budget.js`:113
- **high** `[826 refs]` | `workflow/core/self-reflection-engine.js`:723
- **existing** `[810 refs]` | `workflow/core/experience-router.js`:127
- **entry** `[765 refs]` | `workflow/core/self-reflection-engine.js`:756 – Marks a reflection as fixed or deferred.
- **issues** `[628 refs]` | `workflow/core/mcp-adapter-helpers.js`:97
- **missing** `[546 refs]` | `workflow/commands/commands-doctor.js`:73
- **blocks** `[520 refs]` | `workflow/core/adapter-plugin-registry.js`:264
- **ExperienceStore** `[476 refs]` | `workflow/core/experience-store.js`:26
- **generate** `[475 refs]` | `workflow/core/test-case-generator.js`:41 – Generates test-cases.md from requirements + archit
- **main** `[443 refs]` | `workflow/gen-agents.js`:64
- ... and 40 more utilities

### 📊 Data Flow Patterns

> These patterns show how data flows through function calls via shared parameters.

- `getCurrentVersion → risks (common target: 325 refs)`
- `risks → block (common target: 860 refs)`
- `block → Orchestrator (common target: 718 refs)`
- `listMigrations → risks (common target: 325 refs)`
- `createAgentContract → entry (common target: 765 refs)`
- `entry → block (common target: 860 refs)`
- `validateConfig → existing (common target: 810 refs)`
- `existing → high (common target: 826 refs)`
- `high → block (common target: 860 refs)`
- `Orchestrator → block (common target: 860 refs)`
- ... and 5 more patterns

### 🏠 IDE-First Strategy Active

> This analysis was performed using IDE LSP capabilities for maximum accuracy.
> When exploring business logic, use IDE tools:
> - **Call Hierarchy**: Right-click → Call Hierarchy to see incoming/outgoing calls
> - **Find References**: Right-click → Find All References to see all usages
> - **Go to Definition**: F12 to jump to symbol definition
