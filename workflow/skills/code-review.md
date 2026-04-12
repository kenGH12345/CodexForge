---
name: code-review
version: 3.0.0
type: domain-skill
domains: [quality, review, security]
dependencies: []
load_level: task
max_tokens: 1500
triggers:
  keywords: [review, refactor, clean code, lint, quality, smell, audit, vulnerability, security]
  roles: [developer, architect, reviewer, coding-agent]
description: "Two-stage code review (RuleChecker + ReviewFilter), anti-hallucination rules, data flywheel, and security audit best practices. Inspired by BitsAI-CR (ByteDance)."
---
# Skill: code-review

> **Type**: Domain Skill
> **Version**: 3.0.0
> **Description**: Two-stage code review with anti-hallucination verification, inspired by BitsAI-CR (ByteDance, 75% accuracy at 12K+ weekly active developers)
> **Domains**: quality, review, security
> **Industry References**: BitsAI-CR (ByteDance), Google Code Review Best Practices, Qodo Review

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

### R1: Anti-Hallucination Constraints (MANDATORY)
Every finding MUST satisfy ALL of the following conditions:
1. **File path verified**: The reviewer MUST have actually read the file. Do NOT guess or fabricate file paths.
2. **Code evidence required**: Every FAIL finding must cite the exact code snippet or line number from the diff. No finding is valid without evidence.
3. **No phantom findings**: If you cannot locate the exact file, line, or code construct — do NOT report the finding. "I believe there might be..." is forbidden.
4. **No hallucinated fixes**: Fix instructions must reference real APIs, functions, or patterns that exist in the project. Do NOT invent APIs.

### R2: Confidence-Tiered Evidence Requirements
| Severity | Required Evidence |
|----------|-------------------|
| **critical** | Exact file:line, code snippet, full data-flow trace (source → transform → sink), and PoC exploit path |
| **high** | Exact file:line, code snippet, data-flow trace (at least source → sink) |
| **medium** | Exact file:line, code snippet |
| **low** | File reference and description |

### R3: Anti-Confirmation-Bias
- Do NOT anchor on the first issue found. Systematically evaluate ALL checklist dimensions.
- After completing the initial review pass, explicitly check: "Which dimensions did I NOT find issues in? Could I have missed something?"
- The adversarial pass exists to catch this. Trust the process.

### R4: Severity Accuracy
- CRITICAL: Exploitable vulnerability or data loss risk with confirmed attack path
- HIGH: Confirmed defect that will cause runtime failure or security weakness
- MEDIUM: Code quality issue that increases maintenance risk or has edge-case failure
- LOW: Style, readability, or minor improvement opportunity
- Never inflate severity. A missing comment is LOW, not MEDIUM.

### R5: Two-Stage Verification (BitsAI-CR Pattern)
Every review finding MUST pass through two stages:
1. **Stage 1 (RuleChecker)**: Generate finding based on checklist rules with code evidence
2. **Stage 2 (ReviewFilter)**: Self-verify the finding by asking:
   - "Is this finding actually correct, or did I misread the code?"
   - "Is this finding actionable, or is it noise?"
   - "Would a senior developer accept this feedback, or dismiss it?"
   - If ANY answer is negative → DISCARD the finding (do NOT include it in the report)

This two-stage approach reduces false positives from ~75% to ~25% (BitsAI-CR empirical data).

### R6: Dynamic Rule Blacklist
- Track which review rules consistently produce rejected/ignored findings
- If a rule's "outdated rate" (developer dismissal rate) exceeds 50% over 5+ reviews → blacklist it
- Blacklisted rules are skipped in Stage 1 to save token budget and reduce noise
- The blacklist is stored in experience and evolves over time (data flywheel)

---

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

### Phase 0: Context Assembly (BitsAI-CR: Tree-sitter Pattern)
Before reviewing, build the review context:
1. **Parse the diff** to identify changed code blocks (functions, classes, methods)
2. **Expand context**: For each changed function, also read:
   - The function's callers (who calls this?)
   - The function's callees (what does this call?)
   - The function's type definitions (interfaces, schemas)
3. **Identify review scope**: Changed lines + 10-line context window above/below
4. This prevents reviewing code in isolation (the #1 cause of false positives)

### Phase 1: RuleChecker — Structured Checklist Review
1. Read the entire diff/code before making any judgments
2. Evaluate each checklist item in order (SEC → ERR → PERF → STYLE → REQ → SYNTAX → EDGE → INTF → EXPORT → CONST)
3. For each item: PASS (with evidence), FAIL (with evidence + fix), or N/A (with brief reason)
4. Record which review dimensions were actually exercised
5. **Skip blacklisted rules** (R6) — check experience for rules with high dismissal rate

### Phase 2: ReviewFilter — Self-Verification (BitsAI-CR Pattern)
For EVERY finding from Phase 1:
1. Re-read the code context with fresh eyes
2. Ask the 3 verification questions from R5
3. **Discard** findings that fail verification (false positives)
4. **Upgrade** findings where verification reveals deeper issues
5. Record the filter decision: `KEEP`, `DISCARD`, `UPGRADE`
6. Target: ≤25% of Phase 1 findings should be discarded (if >50% are discarded, Phase 1 rules need tuning)

### Phase 3: Adversarial Second Opinion
1. All PASS/N/A items from Phase 1 are re-evaluated by a skeptical reviewer
2. Focus on: subtle bugs, missing edge cases, security oversights, optimistic assumptions
3. Any downgrade (PASS→FAIL) must include specific evidence the main reviewer missed
4. **New**: Also check for "silent correctness" — code that works but is fragile/unmaintainable

### Phase 4: Coverage Self-Check
1. After Phases 1-3, compute a Coverage Matrix across all security dimensions
2. If any dimension has 0 items evaluated (all N/A), flag as potential blind spot
3. Dimensions: Injection, AuthN/AuthZ, Secrets, Input Validation, Error Info Leak, Race Condition, Resource Exhaustion, Crypto, Dependency, Business Logic

### Phase 5: Attack Chain Analysis (for security-sensitive reviews)
1. After individual findings are identified, analyse: can 2+ findings be COMBINED into an end-to-end attack path?
2. Example: Input validation bypass (SEC-003 FAIL) + SQL injection (SEC-001 FAIL) = authenticated SQLi attack chain
3. Document each chain as: Entry Point → Vulnerability 1 → Vulnerability 2 → Impact

### Phase 6: Data Flywheel Feedback (BitsAI-CR Pattern)
After the review is complete:
1. **Record** which findings were accepted vs dismissed by the developer
2. **Update** rule effectiveness scores based on acceptance rate
3. **Evolve** the checklist: promote high-acceptance rules, demote low-acceptance rules
4. This creates a continuous improvement loop — the review quality improves with every cycle

### Phase 7: Self-Correction & Fix
1. All FAIL items are sent to the fix agent with severity context
2. Fix agent applies minimal, targeted changes
3. Re-review only the affected dimensions (not full re-review)

---

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

> The authoritative checklist is defined in `code-review-agent.js` (DEFAULT_CHECKLIST).
> This section provides supplementary guidance for each category.

### Security (SEC-001 to SEC-004)
- Always check: raw string concatenation in SQL/NoSQL queries, hardcoded secrets in source, unvalidated user input, missing auth checks
- For high-severity SEC findings: provide source→sink data-flow trace
- Consider attack chains: how can multiple SEC findings combine?

### Error Handling (ERR-001 to ERR-003)
- Every `await` must have error handling
- Empty catch blocks are never acceptable
- Error messages must not leak stack traces or internal paths to clients

### Performance (PERF-001 to PERF-003)
- N+1 queries: look for DB calls inside loops
- Memory leaks: look for event listeners added without cleanup
- Blocking calls: `fs.readFileSync` in async handlers is always a FAIL

### Code Style (STYLE-001 to STYLE-003)
- Dead code: commented-out blocks, unreachable branches
- Magic numbers: any literal that isn't self-explanatory needs a named constant
- Naming: single-letter vars (except `i`, `j`, `k` in loops) are FAIL

### Requirements (REQ-001 to REQ-002)
- Cross-check every acceptance criterion against the diff
- Flag any code that implements features NOT in requirements (scope creep)

### Syntax (SYNTAX-001 to SYNTAX-002)
- Broken JSDoc blocks are the #1 cause of cascading SyntaxErrors
- Always check for unclosed brackets, unterminated strings, mismatched template literals

### Edge Cases (EDGE-001 to EDGE-003)
- null/undefined guard: every function receiving external data
- Empty collections: `arr[0]` on empty array
- Numeric boundaries: 0, negative, MAX_SAFE_INTEGER

### Interface Contract (INTF-001 to INTF-002)
- Trace every property access on return values back to the producing function
- String comparisons: verify exact casing matches the constant definition

### Export Completeness (EXPORT-001 to EXPORT-002)
- Search for `require('./this-file')` across the codebase
- Check barrel files (index.js) for newly added exports

### Constant Consistency (CONST-001)
- If an enum/constant exists, all comparisons must use it (not raw strings)

---

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

### 1. Evidence-First Review
> "If you can't point to the exact line, you don't have a finding."
Every finding must be grounded in specific code. This prevents LLM hallucination and ensures actionable feedback.

### 2. Progressive Disclosure of Security Context
Only load language-specific security checklists when the tech stack is identified. For example:
- **Java**: Check for deserialization attacks (ObjectInputStream), JNDI injection, XXE in XML parsers
- **Python**: Check for pickle injection, eval() usage, template injection (Jinja2)
- **Go**: Check for goroutine leaks, unchecked error returns, race conditions
- **JavaScript/Node.js**: Check for prototype pollution, ReDoS, unsafe eval/Function constructor

### 3. Attack Chain Thinking
Individual vulnerabilities are often low-risk in isolation. The real danger is when they combine:
- Example: `SEC-003 (input validation bypass)` + `SEC-001 (SQL injection)` = **authenticated SQLi**
- Example: `ERR-003 (error info leak)` + `SEC-002 (exposed secrets)` = **credential harvesting**
Always ask: "If an attacker controls input X and exploits vulnerability Y, what's the maximum damage?"

### 4. Coverage-Driven Review
After the review, compute coverage: how many of the 10 security dimensions were actually tested?
- If a dimension shows 0 evaluated items, it's a blind spot, not proof of safety.
- Target: ≥80% dimension coverage for standard reviews, 100% for deep security audits.

### 5. Defect Chain Analysis (Beyond Security)
The "attack chain" pattern generalises to code quality:
- **Performance chain**: N+1 query + missing cache + large payload = cascading timeout
- **Reliability chain**: Missing error handling + silent failure + no monitoring = undetected outage
- **Maintenance chain**: Magic numbers + no comments + complex branching = unmaintainable code

### 6. Review Comment Quality (BitsAI-CR Insight)
A good review comment has 4 components:
1. **What**: The specific issue (with code reference)
2. **Why**: Why this is a problem (impact on correctness/security/performance)
3. **How**: Concrete fix suggestion (not vague "improve this")
4. **Severity**: Accurate severity level per R4

Bad: "This function is too complex"
Good: "Function `_decideChallengeTrigger` (line 142) has cyclomatic complexity 12 (threshold: 10). Extract the 3 independent condition blocks into helper methods to improve testability and reduce cognitive load. Severity: LOW."

### 7. Outdated Rate Tracking (BitsAI-CR Metric)
The "outdated rate" measures how often developers dismiss review comments:
- **Outdated rate < 20%**: Excellent — review comments are high-value
- **Outdated rate 20-40%**: Acceptable — some noise but mostly useful
- **Outdated rate > 40%**: Poor — too many false positives, tune rules
- Track per-rule outdated rates to identify which rules need improvement
- This is the single most important metric for review quality

---

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Report findings without file/line evidence | Every FAIL must cite exact location |
| Guess file paths that weren't in the diff | Only report on files actually reviewed |
| Inflate severity to seem thorough | Use the Severity Accuracy scale (R4) |
| Skip dimensions that "probably don't apply" | Systematically evaluate ALL dimensions |
| Report individual vulnerabilities without considering combinations | Analyse attack chains after individual findings |
| Accept "// TODO: add validation" as a PASS | TODOs for security items are always FAIL |
| Provide vague fix instructions ("improve error handling") | Give concrete fix: "Wrap line 42 `await fetch()` in try/catch and return 500 on failure" |
| Focus only on security, ignore code quality | Review ALL dimensions: SEC + ERR + PERF + STYLE + REQ + SYNTAX + EDGE |

---

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

- When the task includes keywords like "security", "audit", "vulnerability", "penetration", load the full attack-chain analysis phase
- When the task type is "bugfix", prioritise ERR and EDGE dimensions over SEC and STYLE
- When the project type is "frontend", deprioritise SQL injection checks but elevate XSS and CSRF checks
- When the diff is small (<50 lines), a quick review (1 round, no adversarial) is sufficient
- When the diff touches auth/payment/encryption code, always run deep review (max rounds + adversarial)

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-13 | Initial creation (empty shell) |
| v2.0.0 | 2026-03-18 | Full population: Rules (anti-hallucination, confidence tiers, anti-bias, severity), SOP (5 phases incl. coverage check + attack chain), Checklist guidance, Best Practices (evidence-first, progressive disclosure, attack chain thinking, coverage-driven, defect chain), Anti-Patterns, Context Hints. Inspired by code-audit Skill article analysis. |
| v3.0.0 | 2026-04-09 | Major upgrade: Added BitsAI-CR two-stage review (RuleChecker + ReviewFilter), R5 two-stage verification rule, R6 dynamic rule blacklist, Phase 0 context assembly, Phase 2 self-verification, Phase 6 data flywheel feedback, BP6 review comment quality, BP7 outdated rate tracking. Industry references: BitsAI-CR (ByteDance, 75% accuracy), Qodo Review. |
