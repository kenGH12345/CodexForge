# CHANGELOG

All notable fixes and improvements to CODEX FORGE are recorded here.
Format: `[fix-id] File – Description`

---

## P0-NEW-1 fix: Text Pipeline → Semantic Pipeline (2026-03-16)
- **Root cause**: Agents exchanged pure Markdown files; downstream agents re-parsed
  natural language to extract structured knowledge (tech stack, decisions, modules),
  which was fragile and lossy. `StageContextStore.extractFromFile()` used regex
  heuristics; `FileRefBus` contract validation used keyword matching.
- **Fix**:
  - New `workflow/core/agent-output-schema.js`: defines JSON schemas for all 4 agent
    roles (ANALYST/ARCHITECT/DEVELOPER/TESTER), plus `extractJsonBlock()`,
    `validateJsonBlock()`, `buildJsonBlockInstruction()`, `extractKeyDecisions()`,
    `extractSummary()` utilities.
  - All 4 agents now inject `buildJsonBlockInstruction(role)` into their prompts,
    instructing the LLM to output a JSON metadata block before the Markdown narrative.
  - `StageContextStore.extractFromFile()` now tries `extractJsonBlock()` first; falls
    back to regex extraction only for legacy/plain Markdown files (backward compat).
  - `FileRefBus.validateAgentContract()` upgraded to two-tier validation:
    Tier 1 (JSON Schema) → Tier 2 (keyword heuristic fallback).
  - `parseResponse()` in each agent now validates the JSON block and warns if missing.

## P0-NEW-2 fix: Fix Agent conversation history (2026-03-16)
- **Root cause**: Each fix round was a stateless LLM call. The LLM had no memory of
  WHY previous fixes failed, leading to repeated mistakes and oscillation.
- **Fix** (`orchestrator-stages.js`):
  - `fixConversationHistory` array initialised before the fix loop.
  - Each round: push `{ role: 'user', content: fixPrompt }` before calling LLM;
    push `{ role: 'assistant', content: fixResponse }` after.
  - From round 2 onwards, `_rawLlmCall` receives the full history array (multi-turn).
  - `previousFixesBlock` replaced with a "Fix History" notice for rounds > 1.

## P0-NEW-3 fix: Dynamic re-planning after task completion (2026-03-16)
- **Root cause**: `runAuto()` decomposed tasks once at startup; the task graph was
  fixed for the entire execution. If a task's result revealed a gap, the system
  could not adapt.
- **Fix** (`index.js`):
  - New `_evaluateReplan(completedTask, result, agentId)` method: after each task
    completes, asks LLM to evaluate whether new tasks are needed.
  - Throttled: only runs when pending tasks remain; max 20 total tasks; 15s timeout.
  - Bounded: max 3 new tasks per re-plan; title dedup prevents duplicates.
  - Non-blocking: failures are caught and logged, never abort the workflow.
  - New tasks inserted into `TaskManager` with proper dependency links.

---


## 2026-03-16 – Karpathy Architecture Review Fixes (Round 4 – P2 级)

### [P2-A] `observability.js` + `index.js` – Token 计量增强
`recordLlmCall()` 只记录 prompt builder 的估算值，不记录 LLM 实际返回的 token 用量，无法做成本预算控制。
Fix:
- `Observability.recordActualTokens(role, actualTokens)` 新方法：回写最近一次 LLM 调用的实际 token 数
- `flush()` 区分 `totalTokensEst`（估算）和 `totalTokensActual`（实际），新增 `tokensByRole` 按角色分组
- `printDashboard()` 优先显示实际 token，无实际数据时降级为估算
- `index.js` `wrappedLlm`：从 LLM 响应对象提取 `usage.total_tokens`，调用 `recordActualTokens` 回写

### [P2-B] `orchestrator-helpers.js` + `orchestrator-stages.js` – Fix Agent 修复后验证
Fix Agent 修复代码后只检查"测试是否通过"，不检查 lint 错误或测试文件是否被篡改。
Fix:
- `_applyFileReplacements()` 返回值新增 `modifiedFiles` 字段（所有被修改的文件路径列表）
- `_runRealTestLoop()` 新增 `lintCommand` 参数；每次 fix 应用后：
  1. 若配置了 `lintCommand`，先跑 lint check（失败记录 medium 风险，不阻断）
  2. 检测 `modifiedFiles` 中是否有 `*.test.js` / `*.spec.ts` 等测试文件（警告 + medium 风险）
- 调用处传入 `this._config?.lintCommand`

### [P2-C] `socratic-engine.js` + `orchestrator-stages.js` – Socratic 非阻塞模式
`socratic.ask()` 阻塞 Agent 执行，30s 超时才自动选 option[0]，破坏 Agent 自主性。
Fix:
- `SocraticEngine.askAsync(question, defaultIndex, options)` 新方法：
  - 立即返回 `defaultIndex` 对应的选项（Agent 不等待）
  - 打印非阻塞通知，告知用户有 `overrideWindowMs`（默认 10s）的覆盖窗口
  - 若提供 `onOverride` 回调，后台 spawn readline 等待用户输入；用户覆盖时回调通知
  - 决策持久化到 `decisions.json`（审计追踪）
- `orchestrator-stages.js` 4 处 `socratic.ask()` 全部改为 `socratic.askAsync()`，各自设置合理的默认选项

### [P2-D] `file-ref-bus.js` – Agent 间合约验证
`bus.publish()` 只验证路径格式，不验证文件内容，ANALYST 输出空文件时 ARCHITECT 静默运行。
Fix:
- 新增 `AGENT_CONTRACTS` map：定义 architect/developer/tester 三个 Agent 的输入文件合约（requiredSections + minLength）
- 新增 `validateAgentContract(receiverRole, filePath)` 函数：检查文件内容是否满足合约
- `publish()` 在文件存在性验证后调用合约验证：违规时打印警告 + 记录到 `_contractViolations`（软警告，不抛出）
- 新增 `getContractViolations()` 方法：调用者可查询本次会话的所有合约违规

---



### [P1-A] `architecture-review-agent.js` + `code-review-agent.js` – 自我验证盲点修复
`_runReview()` 用同一个 LLM 做检测+修复+验证，对系统性盲点无效（LLM 不认为某类问题是风险，则三步都会漏掉）。
Fix:
- 新增 `buildAdversarialArchPrompt()` / `buildAdversarialCodePrompt()`：对抗性验证 prompt，专门质疑主验证的 PASS/N/A 结论
- `_runReview()` 改为两阶段：Phase 1（主验证）→ Phase 2（对抗验证，只重新评估 PASS/N/A 条目）
- 对抗验证 FAIL 覆盖主验证 PASS，finding 前缀 `[Adversarial]` 标记来源
- 构造函数新增 `adversarialLlmCall` 参数：默认复用 `llmCall`，调用者可传入不同 temperature/模型实现真正独立性

---



### [P0-A] `orchestrator-stages.js` → `rollback-coordinator.js` + `quality-gate.js` – Fat Orchestrator 拆分
`orchestrator-stages.js` 的每个 `_runXxx` 函数同时承担执行、判断、控制三层职责，回滚逻辑与业务逻辑混在一起。
Fix:
- 新建 `rollback-coordinator.js`：封装所有回滚清理操作（stateMachine.rollback + bus.clearDownstream + stageCtx.delete + cache invalidation），三处回滚点统一调用 `coordinator.rollback(fromStage, reason)`
- 新建 `quality-gate.js`：封装质量门决策逻辑（pass/rollback/escalate），`evaluate(reviewResult, stageName, rollbackCount)` 返回决策对象，`recordExperience()` 记录经验
- `orchestrator-stages.js` 三处质量门判断块替换为 `QualityGate.evaluate()` + `RollbackCoordinator.rollback()` 调用

### [P0-B/stageCtx] `stage-context-store.js` + `orchestrator-stages.js` – 回滚时 StageContextStore 条目未清理（残留问题）
`stateMachine.rollback()` 后 StageContextStore 中的旧条目未删除，re-run 阶段看到的是上一次失败尝试的决策。
Fix:
- `StageContextStore` 新增 `delete(stageName)` 方法
- 三处回滚点（现在统一由 `RollbackCoordinator` 处理）在回滚后调用 `stageCtx.delete(fromStage)`

### [P0-C] `orchestrator-helpers.js` + `orchestrator-stages.js` – Fix Agent "盲修"，字符串匹配失败导致 applied=0
Fix Agent 输出的 `[REPLACE_IN_FILE]` 块依赖字符串精确匹配，LLM 生成的 `find:` 文本与实际文件有细微差异时 `applied === 0`，修复静默失败。
Fix:
- `_applyFileReplacements` 新增 `[LINE_RANGE]` 块格式：`file` + `start_line` + `end_line` + `replace: |`，通过行号范围替换，免疫空格/缩进差异
- Fix Agent 源文件注入时添加行号（`padStart(4) + ' | '`），让 LLM 能准确填写 `start_line`/`end_line`
- Fix Agent prompt 更新：优先推荐 `[LINE_RANGE]` 格式，`[REPLACE_IN_FILE]` 降级为 fallback

---



### [P2-E] `orchestrator-stages.js` – `codeCtxMeta` declaration swallowed by comment (ReferenceError)
During a previous comment-cleanup pass, the `const codeCtxMeta = ...` declaration was appended to the
end of a comment line, making it part of the comment text. The next line `codeCtxMeta._codeRollbackCount`
would throw `ReferenceError: codeCtxMeta is not defined` at runtime whenever code review failed.
Fix: moved the declaration to its own line.

### [P0-B] `file-ref-bus.js` + `orchestrator-stages.js` – Rollback did not clear stale downstream Bus messages
`stateMachine.rollback()` only updated `manifest.json`. The `FileRefBus` queue was not cleared,
so after rolling back from CODE → ARCHITECT, the DEVELOPER slot still held the old `architecture.md`
path from the previous attempt. When `_runDeveloper` re-ran, it consumed the stale path.
Fix: added `FileRefBus.clearDownstream(senderRole)` method. All three rollback sites in
`orchestrator-stages.js` now call `bus.clearDownstream()` immediately after `stateMachine.rollback()`.

### [P1-C] `stage-context-store.js` + `orchestrator-stages.js` – Context truncation was insertion-order based
`StageContextStore.getAll()` iterated the Map in insertion order (ANALYSE → ARCHITECT → CODE → TEST).
When the token budget was exceeded, the most recently inserted (and most relevant) stages were truncated.
For the TEST stage, CODE context is the most important – but it was the last to be rendered and first to be cut.
Fix: added `priorityStages` parameter to `getAll()`. Each stage now passes its most relevant upstream
stages first: ARCHITECT passes `['ANALYSE']`, CODE passes `['ARCHITECT', 'ANALYSE']`,
TEST passes `['CODE', 'ARCHITECT', 'ANALYSE']`.

### [P1-A] `clarification-engine.js` – Self-correction used same LLM for detection, correction, and verification
After self-correction, the final signal check used the same `buildSemanticDetectionPrompt` that was used
during correction rounds. The LLM tended to confirm its own fixes ("I fixed it, so it must be fine"),
creating a self-validation loop with no independent oversight.
Fix: added `buildSemanticVerificationPrompt()` – an adversarial reviewer persona that is explicitly
more strict than the original reviewer. The final verification pass now uses this prompt via
`_detectSignals(text, stageLabel, { verificationMode: true })`, breaking the self-validation loop.

---



### Rollback & State Machine

**[Defect #1 / _runArchitect]** `_runArchitect` – Rollback to ANALYSE was never called.
Architecture review failure only recorded a risk and continued to CODE stage with a broken architecture.
Fix: when high-severity issues remain after all review rounds, roll back to ANALYSE so the analyst can re-clarify requirements. Capped at 1 rollback.

**[Defect #1 / _runDeveloper]** `_runDeveloper` – After rollback to ARCHITECT, `_runDeveloper` was called instead of `_runArchitect`.
The state machine was rolled back to ARCHITECT but execution skipped the architect entirely, making the rollback a no-op.
Fix: correctly call `_runArchitect` so the architect can revise the design before the developer retries.

**[Defect B]** `_runRealTestLoop` – `runner.run()` was not wrapped in try/catch.
`execSync` throws `ENOENT` when the test command doesn't exist, crashing the entire TEST stage.
Fix: catch the error, record it as a risk, and return gracefully.

**[Defect G]** `_runDeveloper` – Code review failure only recorded a risk and continued to TEST.
Asymmetric with architecture review (which rolls back to ANALYSE).
Fix: when high-severity code issues remain after all review rounds, roll back to ARCHITECT. Capped at 1 rollback.

**[Defect #4 / _runDeveloper]** `_runDeveloper` – Bus message for DEVELOPER was consumed twice during rollback.
A second `consume()` returns null, making `archInputPath` null and silently skipping the failure note and `bus.publish()`.
Fix: read the architecture output path directly from the output dir instead of re-consuming the bus.

**[T-4]** `_runTester` – Test report failure only recorded a risk; no rollback to CODE.
Asymmetric quality gate (arch review → rollback; code review → rollback; test report → nothing).
Fix: roll back to CODE when test report has high-severity issues. Capped at 1 rollback.

### Context Propagation

**[P1-1 / _runArchitect]** `_runArchitect` – ARCHITECT context was not stored in the rollback path.
The rollback branch returned early with a sentinel, skipping `stageCtx.set('ARCHITECT', ...)`.
Downstream stages (CODE, TEST) could not read ARCHITECT context via `stageCtx.getAll()`.
Fix: write a minimal ARCHITECT context entry before returning the sentinel.

**[P1-5 / _runDeveloper]** `_runDeveloper` – CODE context was not stored in the rollback path.
Same issue as P1-1: rollback branch returned early, skipping `stageCtx.set('CODE', ...)`.
Fix: write a minimal CODE context entry before returning.

**[P0-2 / _runDeveloper]** `_runDeveloper` – `__alreadyTransitioned` sentinel from `_runArchitect` was not propagated.
If `_runArchitect` triggered its own rollback and returned the sentinel, `_runStage` would try to use it as an artifact path for `transition()`, corrupting the state machine.
Fix: explicitly check and propagate the sentinel.

**[P0-1 / _runTester]** `_runTester` – Bus meta for test rollback retry was missing `reviewRounds`.
`_runDeveloper`'s `archMeta.reviewRounds > 0` check silently skipped because meta only had `{ testReportFailed, riskMsg, rollbackRetry }`.
Fix: add `reviewRounds: 1` and `failedItems: 1` to the bus meta.

**[P0-2 / _runTester]** `_runTester` – After developer re-runs, `_runTester` itself was not re-executed.
`return devRetry` returned the developer's output path directly to `_runStage`, which treated it as the TEST stage output and called `transition(TEST → next)`, completely skipping TEST stage re-execution.
Fix: call `_runDeveloper` first, publish its output to the TESTER bus, then recursively call `_runTester`.

### Rollback Counter

**[P2-2 / _runArchitect]** `_runArchitect` – Rollback counter stored on Orchestrator instance (`this[_archRollbackCount_${projectId}]`).
In task-based mode where one Orchestrator processes multiple projects sequentially, the counter accumulated across projects, triggering "rollback limit reached" immediately on the first rollback attempt of project B.
Fix: store the counter in `stageCtx.meta` (bound to the current workflow run) so it resets naturally when a new workflow run initialises a fresh `stageCtx`.

**[P2-2 / _runDeveloper]** `_runDeveloper` – Same cross-project counter accumulation issue as P2-2/_runArchitect.
Fix: store `_codeRollbackCount` in `stageCtx.meta`.

**[P2-2 / _runTester]** `_runTester` – Same cross-project counter accumulation issue.
Fix: store `_testRollbackCount` in `stageCtx.meta`.

**[P0-2 / _runTester (counter read)]** `_runTester` – `testRollbackCount` was read from both `stageCtx` and `_pendingTestMeta` (dual-source race).
`_pendingTestMeta` is a write-only carrier; reading it here could double-count the rollback counter.
Fix: only read `_testRollbackCount` from `stageCtx` (the authoritative source).

**[P0-2 / _runTester (stageCtx write)]** `_runTester` – Rollback path called `stageCtx.set('TEST', ...)` with an incomplete entry (no summary/keyDecisions/artifacts/risks).
When `_runTester` finished and called `stageCtx.set('TEST', ...)` at the bottom, it spread the incomplete entry, losing summary/keyDecisions.
Fix: use `_pendingTestMeta` to carry the rollback counter across the function boundary; merge it into the full entry at the bottom.

**[P0-1 / _runTester (pendingTestMeta clear)]** `_runTester` – `_pendingTestMeta` was not cleared before the recursive `_runTester` call.
In task-based mode, `_pendingTestMeta` persists on the instance across projects, causing the next project's TEST stage to start with a non-zero rollback counter.
Fix: null out `_pendingTestMeta` before the recursive call.

### Cache

**[P2-2 / cache]** `_runArchitect` / `_runDeveloper` – Investigation source cache was not cleared after rollback.
After rollback, `architecture.md` and `code.diff` are stale. The cache would serve old content to the re-run agents.
Fix: delete the relevant cache entries after each rollback.

### Auto-Fix Loop

**[P2-2 / fixRound]** `_runRealTestLoop` – Previous fix round responses were not injected into the Fix Agent prompt.
Fix Agent had no visibility into what previous rounds attempted, causing duplicate fixes and fix reversals.
Fix: read `code-fix-round{N}.txt` files for all completed rounds and include a truncated summary in the prompt.

**[P1-1 / fixRound]** `_runRealTestLoop` – `fixRound` was not decremented before `break` when no replacements were applied.
`failMsg` reported "after N rounds" when only N-1 rounds had real fix attempts.
Fix: decrement `fixRound` before breaking.

**[P1-2 / failureSummary]** `_runRealTestLoop` – `result.failureSummary` could be `undefined`.
`TestRunner` implementations may not always populate `failureSummary` when the test command crashes before producing structured output.
Fix: guard with `(result.failureSummary || [])`.

**[P1-2 / sourceFiles]** `_runRealTestLoop` – `result.failureSummary` used without guard in source file prioritisation.
Fix: use `result.output || (result.failureSummary || []).join('\n')`.

**[P0-1 / exitCode]** `_runRealTestLoop` – `rerunErr` catch used `result.exitCode` (stale from previous round) instead of `rerunErr.status`.
Fix: use `rerunErr.status ?? 1` as the exit code.

**[P1-4 / failureContext]** `_runRealTestLoop` – `failureContext` had no length cap.
Jest/pytest can produce extremely long stack traces (10000+ chars) that would cause the LLM call to fail entirely.
Fix: cap to 6000 chars, keeping the last 6000 (most recent failure details).

**[T-5]** `_runRealTestLoop` – `test-cases.md` was not updated after Fix Agent repaired code.
After Fix Agent modifies source files and tests pass, `test-cases.md` still showed pre-fix statuses (FAIL/BLOCKED).
Fix: re-annotate `test-cases.md` with post-fix PASS statuses.

### Misc

**[P2-3]** `_runTester` – `ExperienceStore.flushDirty()` was not called at end of workflow.
`markUsed()` uses a deferred write strategy; if the workflow ends normally without triggering another `_save()`, hitCount increments are silently lost.
Fix: call `flushDirty()` at the end of `_runTester` (the last stage).

**[P2-5]** `_runArchitect` – Low-severity architecture issues were silently ignored.
Even though they don't trigger a rollback, they should be recorded as risks so they appear in the manifest.
Fix: record them as `low` risks.

**[P2-1]** `_runTester` – `||` used instead of `??` for `manualPending` and `automatedTotal`.
`automatedTotal === 0` is a valid state (all cases are manual), but `||` would incorrectly trigger the fallback.
Fix: use `??`.

---

## clarification-engine.js

**[N38]** `SelfCorrectionEngine.correct` – Round counter was incremented before the LLM call failed.
After a failed LLM call, `round` reflected one more round than actually completed.
Fix: decrement `round` back after a failed LLM call.

**[N56]** `SelfCorrectionEngine.correct` – Final signal detection pass ran even after LLM failure.
Re-detecting signals on unchanged content would incorrectly escalate a transient LLM error into "needs human review".
Fix: skip the final signal detection pass when the loop exited due to LLM failure.

**[N24]** `SelfCorrectionEngine.correct` – Final `_detectSignals` after deep investigation was not wrapped in try/catch.
A failed LLM call here would falsely mark resolved issues as still present.
Fix: wrap in try/catch and fall back to regex.

**[P1-4 / buildSemanticDetectionPrompt]** `buildSemanticDetectionPrompt` – Large documents could exceed the LLM context window.
Fix: cap document at 6000 chars, keeping first 3000 + last 3000.

**[P1-4 / contentForFinalDetection]** `SelfCorrectionEngine.correct` – Final signal detection after deep investigation used stale content when post-investigation LLM call failed.
Fix: use `investigationResult.enrichedContent` as fallback when the post-investigation correction failed.

**[P1-5]** `SelfCorrectionEngine._deepInvestigate` – Search query was generic (`"${signal.type} ${stageLabel} solution best practice"`).
Returned unrelated best-practice articles instead of targeted results for the specific issue.
Fix: build a precise query from `signal.evidence` and `signal.instruction`.

**[P1-1 / P2-5]** `SelfCorrectionEngine._deepInvestigate` – `readSource` was called once per signal, producing N identical "Source Code Context" blocks in `findings`.
Fix: call `readSource` at most once per `_deepInvestigate` invocation; share the result across all signals.

**[P2-5 / risk filter]** `detectSignals` – Risk filter only checked the FIRST occurrence of the match keyword.
If the first occurrence was in a mitigated context, the filter returned false and skipped the signal entirely, even if later occurrences described genuine unmitigated risks.
Fix: scan ALL occurrences and return true if any is unmitigated.

---

## stage-context-store.js

**[Defect #9]** `StageContextStore` – Agents only received a file path via `FileRefBus`; no visibility into upstream decisions.
Fix: introduced `StageContextStore` for cross-stage semantic context propagation.

**[Improvement #3]** `StageContextStore.extractFromFile` – Only scanned the first 1200 chars of the file.
For long documents, the first 1200 chars are often just the title and table of contents.
Fix: scan the FULL document for heading+content pairs; pick the most informative paragraphs regardless of position.

**[P1-1]** `StageContextStore.extractFromFile` – Dead variable `headingSplitRegex` declared but never used.
Fix: removed.

**[P1-2]** `StageContextStore.extractFromFile` – Regex used `(?![\s\S])` as end-of-string anchor.
In Node.js, the last heading's body was never captured (the regex matched an empty string instead of consuming to end-of-document).
Fix: split the document on heading lines instead of using the regex.

**[P1-3]** `StageContextStore.getAll` – `totalChars` was computed from `lines.join('\n').length` once at the start, not tracking separator chars added per push.
Fix: use a running counter that adds `sectionText.length + 1` on each push.

**[Defect D]** `StageContextStore.getAll` – `lines.filter(l => l.startsWith('###')).length` always returned 0 because `sectionText` is pushed as a single multi-line string.
The truncation notice always showed `store.size` stages truncated instead of the actual remainder.
Fix: track rendered stages with a dedicated counter.

**[P1-4]** `StageContextStore._load` – Stale context from a previous workflow run on the same `OUTPUT_DIR` would cause the new workflow to see old decisions.
Fix: skip loading if the persisted data is older than 24 hours.

**[P2-3]** `StageContextStore._persist` – Synchronous `writeFileSync` on every `set()` call blocked the event loop in task-based mode.
Fix: debounce writes via `setImmediate`; only one write is scheduled per tick.

**[P2-4]** `StageContextStore._load` – Stale `stage-context.json` was never deleted, accumulating across multiple workflow runs.
Fix: delete the file when it is older than 24 hours.

**[P1-4 / exit handler]** `StageContextStore` – Debounced write could be lost if the process exited before `setImmediate` fired.
Fix: register a synchronous `process.on('exit')` handler to flush any pending write.

---

## test-case-executor.js

**[Defect #4]** `TestCaseExecutor` – `test-cases.md` was only "simulated" by the LLM; no real execution.
Fix: convert the JSON plan into a real executable test script and run it via the project's test framework.

**[T-1]** `TestCaseExecutor._generateJsTestScript` – All assertions were static constant checks that always passed (e.g. `expect('TC_LOGIN_001').toMatch(/^TC_/)`).
Fix: attempt to `require()` the project's main entry point; generate assertions that validate `test_data` shape and expected outcomes against loaded module exports.

**[T-2]** `TestCaseExecutor._mapResultsToCases` – Cases not mentioned in output were marked PASS when overall suite exit code was 0.
A case that never appeared in the output is always BLOCKED, regardless of the overall suite result.
Fix: always mark unexecuted cases as BLOCKED.

**[T-3 / JS]** `TestCaseExecutor._generateJsTestScript` – Module-level call injected `hasRealAssertions = true` as a string into the generated script.
`hasRealAssertions` is a variable in the generator function, not in the generated script. This caused `ReferenceError: hasRealAssertions is not defined` at runtime.
Fix: removed the `lines.push('hasRealAssertions = true')` injection.

**[T-3 / pytest]** `TestCaseExecutor._generatePytestScript` – All pytest assertions were `assert 'TC_XXX'.startswith('TC_')` which always passes.
Fix: attempt to import the project's main module; generate assertions based on `test_data` and `expected` fields.

**[T-3 / smoke]** `TestCaseExecutor._generateSmokeScript` – Smoke script always incremented PASS without any real check.
Fix: if `test_data` contains a `url`/`endpoint`, curl it and check the expected HTTP status code; if it contains a `command`, run it and check exit code.

**[P1-3]** `TestCaseExecutor._emptyReport` – `automatedTotal` and `manualPending` fields were absent from the empty report.
Callers that read `tcExecutionReport.automatedTotal` would get `undefined`.
Fix: add both fields with value `0`.

**[P1-4]** `TestCaseExecutor._mapResultsToCases` – Window matching used `output.indexOf(caseId)` (first occurrence only); window was too small (caseIdx-50 to caseIdx+300); "error" in test descriptions incorrectly triggered FAIL.
Fix: search ALL occurrences; expand window to caseIdx-100 to caseIdx+600; use precise failure patterns (`FAIL`, `✗`, `× `, `●`).

**[P2-2]** `TestCaseExecutor._mapResultsToCases` – `_executionOutput` was always sliced from the FIRST occurrence of `caseId`, even when the status was determined from a different (higher-scoring) occurrence.
Fix: use `bestIdx` (the occurrence that determined the status) for `_executionOutput`.

**[M-1]** `TestCaseExecutor._parseCasesFromMd` – Manual test cases were not detected; they were included in automated script generation.
Fix: detect manual cases via `automation_type: 'manual'`, `type: 'manual'`, or `[手动]`/`[manual]` markers; mark them `_isManual`.

**[M-2]** `TestCaseExecutor.execute` – Manual cases were not separated from automatable cases before script generation.
Fix: separate manual cases upfront; mark them `MANUAL_PENDING`; skip them from script generation.

**[M-3]** `TestCaseExecutor._annotateResults` – `MANUAL_PENDING` was not a distinct status from `BLOCKED`.
Fix: added `MANUAL_PENDING` status with a dedicated icon (🖐️).

**[M-4]** `TestCaseExecutor._buildReport` – Manual cases were counted in `blocked`, inflating the failure count.
Fix: count manual cases separately as `manualPending`; exclude them from `automatedTotal`.

**[M-5]** `TestCaseExecutor._buildReport` – Manual test checklist was not generated for TesterAgent guidance.
Fix: generate a manual verification checklist section in the execution report.
