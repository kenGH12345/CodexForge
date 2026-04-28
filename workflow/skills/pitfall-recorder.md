/**
 * @ SKILL: pitfall-recorder
 * @ Scope: UNIVERSAL
 * @ Description: Four-section pitfall recording methodology for any tech stack
 * @ Context: Works with `experience-record --four-section` CLI
 */

# Pitfall Recorder — 四段式技术坑点收录规范

> **Skill Scope**: Universal — works for any project, any tech stack.
> **Usage**: Pair with `--four-section` flag in `experience-record` CLI.
> **Purpose**: Standardize how pitfalls are captured and evolved into project skills.

---

## Rules

### R1: Always use four-section structure for NEGATIVE experiences
When recording a pitfall (`--type NEGATIVE --category pitfall`), always provide at least one of:
- `--phenomenon` — What went wrong (observable symptom)
- `--root-cause` — Why it happened (mechanism, not just surface reason)
- `--solution` — How to fix it (concrete, actionable steps)
- `--verification` — How to confirm the fix works (test, metric, or observable)

### R2: One pitfall per record
Do NOT bundle multiple unrelated issues into one record. Each record should describe ONE specific pitfall with clean boundaries.

### R3: Title must be searchable
Title should contain the key technology + symptom. Examples:
- ✅ "XLua: 泛型方法调用限制"
- ✅ "C# Struct: Unity 构造器陷阱"
- ❌ "又踩坑了" (too vague)
- ❌ "Lua问题" (too broad)

### R4: Category auto-defaults to 'pitfall' with --four-section
When `--four-section` is used, `category` automatically becomes `pitfall` unless explicitly overridden.

### R5: Verification must be falsifiable
The `--verification` field must describe a check that can actually fail — not just "it works now".

---

## SOP (Standard Operating Procedure)

### Step 1: Detect the pitfall
Symptoms: error message, unexpected behavior, performance degradation, silent data corruption.
Capture the EXACT error text or observable symptom.

### Step 2: Determine root cause
Ask "WHY" at least 3 times:
1. Why did the error occur? → surface reason
2. Why did that condition exist? → code-level reason
3. Why wasn't this caught earlier? → process/tooling gap

### Step 3: Find or design the solution
- Check if the framework/language has an official workaround
- Check if your project already has a helper/pattern for this
- If neither exists, design one and document it

### Step 4: Define verification criteria
Before marking the pitfall as "resolved", define how to verify:
- Unit test that reproduces the original failure
- Integration test covering the fix
- Manual test script
- Performance benchmark (if applicable)

### Step 5: Record via CLI
```bash
node workflow/tools/ide-workflow-bridge.js experience-record \
  --type NEGATIVE \
  --title "<Tech>: <Symptom>" \
  --four-section \
  --phenomenon "..." \
  --root-cause "..." \
  --solution "..." \
  --verification "..." \
  --skill "<relevant-skill>" \
  --tags "pitfall,<tech>,<area>"
```

### Step 6: Evolve into Skill
After 3+ related pitfall records exist, use `skill-llm-refiner` or manual edit to consolidate them into the project's skill file under `Anti-Patterns` or `Gotchas` section.

---

## Checklist

- [ ] Title contains technology name + symptom keyword
- [ ] At least 2 of the 4 sections are filled (phenomenon + one other)
- [ ] Root cause explains MECHANISM, not just "it's a bug"
- [ ] Solution contains concrete code snippet or exact steps
- [ ] Verification describes how to CONFIRM the fix, not just "test it"
- [ ] Skill tag matches the project's skill taxonomy
- [ ] Tags include "pitfall" plus technology and functional area

---

## Best Practices

### 1. Record immediately after fixing
Don't wait — memory decays. Record within 30 minutes of resolving the issue while context is hot.

### 2. Copy error text exactly
When `--phenomenon` includes an error message, paste the EXACT text (can be truncated to 500 chars). This makes the record searchable by the same error.

### 3. Cross-reference existing Skill entries
Before recording, search: `node workflow/tools/ide-workflow-bridge.js experience-search --keyword "<error text>"`. If similar pitfall exists, incrementally enrich it rather than creating a duplicate.

### 4. Use severity tags
Add severity tag: `--tags "pitfall,critical"` for production outages, `--tags "pitfall,warning"` for dev-time gotchas.

### 5. Link to code locations
If possible, include file path + line number in `--phenomenon` or `--solution`.

---

## Anti-Patterns

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Vague title like "bug" or "issue" | Title with tech + symptom: "Redis: 连接池耗尽导致超时" |
| Root cause = "代码写错了" | Root cause = "连接池未设置maxIdle，并发突增时连接数无上限" |
| Solution = "修复了" | Solution = "添加HikariCP配置: maxIdle=10, maxPoolSize=20" |
| Verification = "测试通过" | Verification = "并发100请求下响应时间<200ms，无连接超时" |
| Bundling 3 unrelated issues in one record | One record per pitfall, cross-reference with tags |
| Recording after 1 week | Record within 30 min while context is fresh |

---

## Context Hints

- **When hitting an error**: First search ExperienceStore — if similar pitfall exists, use its solution instead of debugging from scratch.
- **When writing a new feature**: Search `--category pitfall` in your skill area to proactively avoid known traps.
- **When reviewing code**: Check if the code touches any technology with recorded pitfalls. If yes, verify the code avoids the recorded anti-pattern.
- **When onboarding new team members**: Point them to the project's pitfall records in Skill/ExperienceStore as required reading.

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-04-26 | Initial creation — four-section pitfall recording methodology |
