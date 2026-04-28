---
name: javascript-dev
version: 1.2.0
type: domain-skill
domains: [frontend, backend, javascript]
dependencies: []
load_level: task
max_tokens: 1200
triggers:
  keywords: [javascript, js, node, npm, typescript, ts, react, vue, express]
  roles: [developer]
description: "JavaScript development patterns"
---
# Skill: javascript-dev

> **Type**: Domain Skill
> **Version**: 1.2.0
> **Description**: JavaScript and Node.js development patterns
> **Domains**: frontend, backend, javascript

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

1. **Use `const` by default, `let` when rebinding is needed, never `var`** — `var` has function scope and hoisting, causing subtle bugs. `const` signals immutable bindings and catches accidental reassignment at compile time.

2. **Always use `===` for comparison** — `==` performs type coercion (`"0" == false` is `true`). Triple equals checks both type and value, eliminating an entire class of subtle bugs.

3. **Handle Promise rejections explicitly** — Every `.then()` chain must have a `.catch()`. Every `async` function call must be in `try/catch` or have `.catch()`. Unhandled rejections crash Node.js 15+ by default.

4. **Use TypeScript for any project over 500 lines** — TypeScript catches 15-20% of bugs at compile time that would otherwise reach production. The type system pays for itself on the first refactor.

5. **Never mutate function arguments** — Create new objects/arrays instead of modifying inputs. Mutations cause action-at-a-distance bugs that are extremely difficult to trace in async codebases.

6. **Use early returns and guard clauses** — Prefer returning early for error/edge cases over deeply nested if/else blocks. This reduces nesting depth and makes the happy path visually prominent:
   ```js
   // Wrong: nested pyramid
   function process(user) {
     if (user) {
       if (user.isActive) {
         return user.data;
       }
     }
     return null;
   }
   // Right: early return
   function process(user) {
     if (!user) return null;
     if (!user.isActive) return null;
     return user.data;
   }
   ```

7. **All public methods must have JSDoc with `@param` and `@returns`** — IDEs and documentation generators depend on this. Even internal helpers benefit from return type annotations for IDE inference.
   ```js
   /**
    * Calculate the discounted price.
    * @param {number} price - Original price in cents.
    * @param {number} discount - Discount percentage (0-100).
    * @returns {number} Final price in cents.
    */
   function calculateDiscount(price, discount) { ... }
   ```

8. **No magic numbers or strings** — Extract all numeric/string literals to named constants declared at module scope:
   ```js
   // Wrong
   if (status === 404) setTimeout(retry, 3000);
   // Right
   const STATUS_NOT_FOUND = 404;
   const RETRY_DELAY_MS = 3000;
   if (status === STATUS_NOT_FOUND) setTimeout(retry, RETRY_DELAY_MS);
   ```

9. **Prefer arrow functions for inline callbacks** — Arrow functions preserve lexical `this` and reduce visual noise for one-shot callbacks. Use regular `function` for named top-level definitions:
   ```js
   // Right: arrow for inline callback
   items.filter(item => item.isActive).map(item => item.name);
   // Right: function declaration for named export
   function validateInput(input) { ... }
   ```

10. **Use destructuring when accessing 2+ object properties** — Destructuring at the top of a function makes the data contract explicit:
    ```js
    // Wrong
    function createUser(config) {
      const name = config.name;
      const email = config.email;
    }
    // Right
    function createUser({ name, email }) { ... }
    ```

11. **Use template literals for multi-part string assembly** — Template literals (`backticks`) eliminate concatenation errors and support interpolation:
    ```js
    // Wrong
    const url = 'https://' + host + ':' + port + '/api/v' + version;
    // Right
    const url = `https://${host}:${port}/api/v${version}`;
    ```

12. **Never nest ternaries** — Single-level ternary is readable; nested ternaries must be refactored to if/else or early returns:
    ```js
    // Wrong: nested ternary
    const icon = isError ? (isCritical ? '🔴' : '⚠️') : '✅';
    // Right: early returns
    if (!isError) return '✅';
    if (isCritical) return '🔴';
    return '⚠️';
    ```

13. **Use atomic writes for crash-safe file writes** — Write to a temp file then rename. On crash, the target file remains intact:
    ```js
    const fs = require('fs');
    function writeFileAtomic(path, data) {
      const tmpPath = path + '.tmp.' + process.pid;
      fs.writeFileSync(tmpPath, data);
      fs.renameSync(tmpPath, path);
    }
    ```

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

1. **Node.js Project Setup**: `npm init` → Add TypeScript (`tsconfig.json` with `strict: true`) → ESLint + Prettier → Husky pre-commit hooks → Jest/Vitest for testing → CI pipeline.
2. **Error Handling Flow**: Define custom error classes extending `Error` → Throw domain errors in service layer → Catch at controller/middleware level → Map to HTTP responses → Log with context.
3. **Dependency Management**: Pin exact versions in `package-lock.json` → Use `npm audit` in CI → Renovate/Dependabot for automated updates → Review changelogs before major bumps.

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

- [ ] `"strict": true` in tsconfig.json (if TypeScript)
- [ ] All async functions have error handling (try/catch or .catch())
- [ ] No `any` types in TypeScript (use `unknown` + type guards)
- [ ] ESLint configured with `no-unused-vars`, `no-implicit-globals`
- [ ] `package-lock.json` committed to version control
- [ ] Node.js version pinned in `.nvmrc` or `package.json` `engines` field
- [ ] No `var` declarations anywhere (use `const` or `let`)
- [ ] No nested ternaries (single-level only)
- [ ] No magic numbers or strings (all extracted to named constants)
- [ ] All public functions have JSDoc with `@param` and `@returns`
- [ ] Promise rejections handled (`.catch()` or `try/catch`)

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

1. **Use `AbortController` for cancellable async operations** — Pass `AbortSignal` to `fetch`, timers, and streams. This prevents resource leaks when users navigate away or requests time out.

2. **Prefer `structuredClone()` for deep copy (Node 17+/modern browsers)** — `JSON.parse(JSON.stringify(obj))` fails on `Date`, `Map`, `Set`, `RegExp`, `undefined`, and circular refs. `structuredClone()` handles all of these correctly.

3. **Use `Promise.allSettled()` over `Promise.all()` for independent tasks** — `Promise.all()` short-circuits on first rejection, losing results from other resolved promises. `Promise.allSettled()` always returns all outcomes.

4. **Debounce user input, throttle scroll/resize** — Use `debounce` for search inputs (fire after user stops typing), `throttle` for scroll handlers (fire at most every N ms). This prevents performance degradation and API spam.

5. **Use `WeakMap`/`WeakRef` for caches tied to object lifecycle** — Regular `Map` caches prevent garbage collection. `WeakMap` automatically releases entries when the key object is GC'd, preventing memory leaks in long-running processes.

### [JS] test-fingerprint (csharp pattern)

**File**: `workflow/core/ast-parsers/test-fingerprint.js`
**Types**: UserService
**Key Functions**: `runTests()`

--- Distilled Knowledge ---
[Distilled from "[JS] feature-list (csharp pattern)" (EXP-1775016652830-0096-VTFFI, conversation)] **File**: `workflow/core/feature-list.js`
**Types**: FeatureList

[Distilled from "[JS] ide-provider (csharp pattern)" (EXP-1775016652830-0003-35NYO, conversation)] **File**: `generated/workflow/core/ide-provider.js`
**Key Functions**: `loadFromConfig()`, `detectCurrentIDE()`, `isIDE()`, `getSupportedIDEs()`

[Distilled from "[JS] commands-devtools-analysis (csharp pattern)" (EXP-1775016652830-0017-MIDTG, conversation)] **File**: `workflow/commands/commands-devtools-analysis.js`
**Key Functions**: `registerAnalysisCommands()`

[Distilled from "[JS] commands-devtools-infra (csharp pattern)" (EXP-1775016652830-0019-4J7V4, conversation)] **File**: `workflow/commands/commands-devtools-infra.js`
**Key Functions**: `registerInfraCommands()`

[Distilled from "[JS] commands-devtools-skills (csharp pattern)" (EXP-1775016652830-0020-8EZ8W, conversation)] **File**: `workflow/commands/commands-devtools-skills.js`
**Key Functions**: `registerSkillsCommands()`

[Distilled from "[JS] commands-devtools (csharp pattern)" (EXP-1775016652830-0021-YOIGK, conversation)] **File**: `workflow/commands/commands-devtools.js`
**Key Functions**: `registerDevToolsCommands()`

[Distilled from "[JS] commands-workflow (csharp pattern)" (EXP-1775016652830-0025-WY8L3, conversation)] **File**: `workflow/commands/commands-workflow.js`
**Key Functions**: `registerWorkflowCommands()`

[Distilled from "[JS] arch-knowledge-cache (csharp pattern)" (EXP-1775016652830-0031-XK7ZE, conversation)] **File**: `workflow/core/arch-knowledge-cache.js`
**Key Functions**: `loadCache()`, `rebuildCache()`, `getCapabilityIndex()`, `getDistilledSummary()`, `getTaskHistorySummary()`

[Distilled from "[JS] article-scout (csharp pattern)" (EXP-1775016652830-0033-XAE9K, conversation)] **File**: `workflow/core/article-scout.js`
**Types**: ArticleScout
**Key Functions**: `isArticleScoutStale()`

[Distilled from "[JS] ast-transform-engine.test (csharp pattern)" (EXP-1775016652830-0037-K1HH8, conversation)] **File**: `workflow/core/ast-transform-engine.test.js`
**Key Functions**: `processData()`, `simpleFunction()`, `operation1()`, `operation2()`, `operation3()`, `singleOperation()`, `runTests()`

[Distilled from "[JS] auto-deployer (csharp pattern)" (EXP-1775016652830-0038-108KP, conversation)] **File**: `workflow/core/auto-deployer.js`
**Types**: AutoDeployer

[Distilled from "[JS] code-graph-cache (csharp pattern)" (EXP-1775016652830-0045-AYA4T, conversation)] **File**: `workflow/core/code-graph-cache.js`
**Key Functions**: `setProcessCache()`

[Distilled from "[JS] code-graph (csharp pattern)" (EXP-1775016652830-0052-9CIUP, conversation)] **File**: `workflow/core/code-graph.js`
**Types**: CodeGraph

[Distilled from "[JS] context-loader (csharp pattern)" (EXP-1775016652830-0062-GM1HY, conversation)] **File**: `workflow/core/context-loader.js`
**Types**: ContextLoader

[Distilled from "[JS] dashboard-styles (csharp pattern)" (EXP-1775016652830-0066-84RXL, conversation)] **File**: `workflow/core/dashboard-styles.js`
**Key Functions**: `getDashboardCSS()`, `getDashboardJavaScript()`

[Distilled from "[JS] duplicate-detector (csharp pattern)" (EXP-1775016652830-0071-WF6EB, conversation)] **File**: `workflow/core/duplicate-detector.js`
**Types**: DuplicateDetector
**Key Functions**: `tokenize()`, `tokenIndexToLine()`, `tokenizeWithPositions()`, `generateKGrams()`, `computeLSHSignatures()`, `scanForDuplicates()`

[Distilled from "[JS] duplicate-pattern-detector (csharp pattern)" (EXP-1775016652830-0072-RZH0P, conversation)] **File**: `workflow/core/duplicate-pattern-detector.js`
**Types**: DuplicatePatternDetector

[Distilled from "[JS] effective-lines-counter (csharp pattern)" (EXP-1775016652830-0073-XJINF, conversation)] **File**: `workflow/core/effective-lines-counter.js`
**Key Functions**: `loadConfig()`, `countEffectiveLines()`, `analyzeFile()`, `getFileTiers()`, `getFileTier()`, `checkFileLimit()`

[Distilled from "[JS] effective-lines-counter.test (csharp pattern)" (EXP-1775016652830-0074-GGZO2, conversation)] **File**: `workflow/core/effective-lines-counter.test.js`
**Key Functions**: `test()`, `add()`, `foo()`, `bar()`, `foo()`

[Distilled from "[JS] entropy-gc (csharp pattern)" (EXP-1775016652830-0075-DW5NW, conversation)] **File**: `workflow/core/entropy-gc.js`
**Types**: EntropyGC

[Distilled from "[JS] ide-symbol-adapter.test (csharp pattern)" (EXP-1775016652830-0104-78RJY, conversation)] **File**: `workflow/core/ide-symbol-adapter.test.js`
**Key Functions**: `processUser()`, `standaloneFunc()`

[Distilled from "[JS] integration-agent-fusion.test (csharp pattern)" (EXP-1775016652830-0109-29QSR, conversation)] **File**: `workflow/core/integration-agent-fusion.test.js`
**Key Functions**: `test()`, `asyncTest()`

[Distilled from "[JS] integration-effective-lines.test (csharp pattern)" (EXP-1775016652830-0110-WR8NJ, conversation)] **File**: `workflow/core/integration-effective-lines.test.js`
**Key Functions**: `test()`

[Distilled from "[JS] integration-framework-fusion.test (csharp pattern)" (EXP-1775016652830-0111-PXZ99, conversation)] **File**: `workflow/core/integration-framework-fusion.test.js`
**Key Functions**: `test()`, `asyncTest()`, `sum()`

[Distilled from "[JS] integration-pipeline-flow.test (csharp pattern)" (EXP-1775016652830-0112-LNXL7, conversation)] **File**: `workflow/core/integration-pipeline-flow.test.js`
**Key Functions**: `test()`, `asyncTest()`

[Distilled from "[JS] issue-classifier (csharp pattern)" (EXP-1775016652830-0114-IJJNX, conversation)] **File**: `workflow/core/issue-classifier.js`
**Key Functions**: `classifyIssue()`, `generateSuggestedFix()`, `isAutoFixEligible()`, `separateByAction()`

[Distilled from "[JS] issue-pattern-collector (csharp pattern)" (EXP-1775016652830-0115-JRXZ8, conversation)] **File**: `workflow/core/issue-pattern-collector.js`
**Types**: IssuePatternCollector

[Distilled from "[JS] llm-router (csharp pattern)" (EXP-1775016652830-0117-D7PQ9, conversation)] **File**: `workflow/core/llm-router.js`
**Types**: LlmRouter

[Distilled from "[JS] logger (csharp pattern)" (EXP-1775016652830-0118-5WSYT, conversation)] **File**: `workflow/core/logger.js`
**Types**: Logger

[Distilled from "[JS] loop-guard (csharp pattern)" (EXP-1775016652830-0119-764RZ, conversation)] **File**: `workflow/core/loop-guard.js`
**Types**: LoopGuard

[Distilled from "[JS] lsp-profile-enhancer (csharp pattern)" (EXP-1775016652830-0120-31P65, conversation)] **File**: `workflow/core/lsp-profile-enhancer.js`
**Types**: LSPProfileEnhancer
**Key Functions**: `enhanceProfileWithLSP()`

[Distilled from "[JS] lsp-router (csharp pattern)" (EXP-1775016652830-0121-WE48A, conversation)] **File**: `workflow/core/lsp-router.js`
**Types**: LSPRouter
**Key Functions**: `getLSPRouter()`, `resetLSPRouter()`

[Distilled from "[JS] mape-engine (csharp pattern)" (EXP-1775016652830-0124-4AVXE, conversation)] **File**: `workflow/core/mape-engine.js`
**Types**: MAPEEngine

[Distilled from "[JS] mcp-server (csharp pattern)" (EXP-1775016652830-0128-IPMRS, conversation)] **File**: `workflow/core/mcp-server.js`
**Types**: MCPServer

> *Added in v1.0.1 | 2026-04-01 | Source: EXP-1775016652830-0034-POYBI*
### [JS] experience-health-mixin (csharp pattern)

**File**: `workflow/core/experience-health-mixin.js`
**Key Functions**: `getByLayer()`, `getLayerStats()`, `checkLayerHealth()`, `getByScope()`, `getScopeStats()`, `checkScopeHealth()`, `getStoragePaths()`, `getBySourceType()`, `getSourceTypeStats()`, `checkSourceTypeHealth()`

--- Distilled Knowledge ---
[Distilled from "[JS] experience-store (csharp pattern)" (EXP-1775038101254-0090-UCPTW, conversation)] **File**: `workflow/core/experience-store.js`
**Types**: ExperienceStore

[Distilled from "[JS] ide-experience-hook (csharp pattern)" (EXP-1775038101254-0100-V9J41, conversation)] **File**: `workflow/core/ide-experience-hook.js`
**Key Functions**: `detectSignalsFromText()`, `captureSimpleExperience()`, `runIdeExperienceHook()`

[Distilled from "[JS] experience-query-similarity (csharp pattern)" (EXP-1774859895570-0118-YW1NK, conversation)] **File**: `workflow/core/experience-query-similarity.js`
**Types**: ExperienceDeduplicator
**Key Functions**: `computeNGramFingerprint()`, `computeMinHash()`, `computeMinHashSimilarity()`, `computeJaccardSimilarity()`, `computeExperienceSimilarity()`

> *Added in v1.0.2 | 2026-04-02 | Source: EXP-1775038101254-0086-KBS9R*
## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

1. **Callback hell / Promise chain pyramid** — Deeply nested `.then()` chains or callbacks. Instead: use `async/await` for flat, readable sequential async code. Extract helper functions for complex parallel flows.

2. **`typeof null === 'object'` trap** — Checking `typeof x === 'object'` passes `null`. Instead: always check `x !== null && typeof x === 'object'` or use TypeScript type guards.

3. **Importing entire lodash** — `import _ from 'lodash'` bundles 70KB+ even if you use one function. Instead: import specific functions `import debounce from 'lodash/debounce'` or use native alternatives.

4. **for...in on arrays** — `for...in` iterates over all enumerable properties (including prototype), not just indices. Instead: use `for...of`, `.forEach()`, or indexed `for` loop for arrays.

5. **Floating-point math for money** — `0.1 + 0.2 !== 0.3` in JavaScript. Instead: use integer arithmetic in smallest unit (cents), or libraries like `decimal.js` / `dinero.js` for financial calculations.

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

1. **Node.js 22 LTS changes** — Node 22 ships with built-in `--watch` mode, native WebSocket support, and `require()` for ESM modules behind `--experimental-require-module`. The permission model (`--experimental-permission`) is now stable.

2. **ES2024 features** — `Array.groupBy()`, `Promise.withResolvers()`, `Object.groupBy()`, and `ArrayBuffer.prototype.resize()` are now standard. These replace many lodash utilities.

3. **ESM vs CJS migration** — Set `"type": "module"` in package.json for ESM. Use `.mjs` / `.cjs` extensions for mixed projects. Dynamic `import()` works in both modes. `__dirname` is not available in ESM — use `import.meta.dirname` (Node 21+).

4. **V8 hidden class deoptimization** — Adding properties to objects after creation (not in constructor) forces V8 to create new hidden classes, slowing property access 10x. Always initialize all properties in the constructor.

5. **`fetch()` in Node.js gotcha** — Node's built-in `fetch()` (Undici-based) does not follow redirects to different origins by default, and response body MUST be consumed or explicitly discarded, otherwise the connection leaks.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-14 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Rules, SOP, Checklist, Best Practices, Anti-Patterns, Context Hints |
| v1.0.1 | 2026-04-01 | High-frequency pattern (hitCount=8) – validated by ANALYSE stage success |
| v1.0.2 | 2026-04-02 | High-frequency pattern (hitCount=6) – validated by ANALYSE stage success |
| v1.2.0 | 2026-04-27 | Merged JS-specific coding conventions from `standards` skill: early returns, JSDoc requirements, magic number ban, arrow/destructuring/template literals, no nested ternaries, atomic writes. Standards skill refactored to pure project conventions. |