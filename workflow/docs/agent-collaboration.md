# AI Agent Collaboration Guidelines

> Rules for how AI agents should work on this project.
> Based on Harness Engineering principles (OpenAI, Feb 2026).

---

## Core Principle: Humans Steer, Agents Execute

- **Human role**: Define goals, constraints, acceptance criteria, handle exceptions
- **Agent role**: Implement, test, document within defined boundaries

---

## Session Start Protocol

Every session MUST begin in this order:

1. **Read AGENTS.md** — understand project context
2. **Read `docs/architecture-constraints.md`** — know the enforced rules *(also auto-injected)*
3. **Read `manifest.json`** — understand current workflow state
4. **Read `output/feature-list.json`** — find the highest-priority unfinished task
5. **Check git log** — `git log --oneline -10` to see recent changes

> **Auto-injected context**: `ContextLoader` automatically injects into every Agent prompt:
> - `docs/architecture-constraints.md` — always injected for developer/architect/tester roles
> - `docs/decision-log.md` — relevant ADR entries extracted by keyword matching
> - `skills/*.md` — matching skill files based on task keywords
>
> You do NOT need to manually read these files — they arrive in your context automatically.
> If you need a skill that wasn't injected, mention it explicitly in your task description.

---

## Knowledge Discovery Rules

> "Whether knowledge is discoverable by the Agent matters more than whether it exists."

- All decisions MUST be in `docs/decision-log.md`, NOT just in chat history
- All constraints MUST be in `docs/architecture-constraints.md`
- All acceptance criteria MUST be in `output/feature-list.json` per feature
- Slack messages, verbal agreements, and personal notes = invisible to Agent

---

## IDE Tool Usage Protocol (ADR-37)

> **Foundational principle**: IDE capabilities first, self-built as fallback.

When running inside an IDE (auto-detected by `core/ide-detection.js`), agents receive an
**IDE Tool Guidance** block in their prompt. Follow these rules:

### Search & Read Strategy
- **Semantic search** → Use `codebase_search` (IDE's vector/semantic search), NOT `Glob`
- **Exact text search** → Use `grep_search` (IDE's ripgrep engine), NOT `Grep`
- **Symbol lookup** → Use `view_code_item` (compiler-accurate via IDE LSP)
- **File reading** → Use `read_file` (real-time file content from IDE), NOT `Read`

> ⚠️ **CRITICAL**: `Read`, `Grep`, `Glob` are low-level Craft-mode Subagent tools.
> They appear in the agent frontmatter `tools:` field for compatibility, but you MUST
> prefer the IDE-native equivalents (`read_file`, `grep_search`, `codebase_search`, `list_dir`).
> Using `Read` instead of `read_file` causes unnecessary "执行工具: Read" overhead.

### File Writing Strategy (CRITICAL — prevents workflow hanging)
- **Create/Edit files** → Use `edit_file`, `replace_in_file`, `Write`, `MultiEdit` (IDE-native tools)
- **NEVER use Bash for file writes** — `echo >>`, `sed -i`, `cat >`, `tee`, `python -c "open(...).write(...)"` will cause the workflow to hang
- Bash is ONLY acceptable for: running test commands, `node workflow/init-project.js`, and other non-file-write operations

### When to Use Self-Built Context
Self-built context is **always injected** into your prompt for capabilities the IDE cannot provide:
- Hotspot analysis (CodeGraph) — which symbols change most frequently
- Module summary (CodeGraph) — high-level codebase overview
- Skill knowledge (ContextLoader) — domain-specific best practices
- Experience records (ExperienceStore) — lessons learned from past tasks
- Architecture decisions (ADR digest) — why things are the way they are

### Rule for Developers Adding New Modules
Before building any new code intelligence feature, **check the IDE Tool Guidance table** in
`AGENTS.md`. If the IDE already provides the capability, add it to the guidance table
as "preferred" and mark your implementation as "fallback".

---

## `/wf init` Command Protocol

When the user sends `/wf init` (with or without `--path <dir>`), you **MUST** execute the
initialisation script via terminal. Do NOT try to "manually" initialise the project by
reading files and generating a report yourself.

**Required action:**

```bash
# If --path is provided:
node workflow/init-project.js --path <dir>

# If no --path, use the current project root:
node workflow/init-project.js --path <current-project-root>
```

This script performs **all** initialisation steps automatically:
1. Auto-detects tech stack and generates `workflow.config.js` (if missing)
2. Runs ProjectProfiler (deep architecture analysis)
3. Builds AGENTS.md (global project context)
4. Generates experience store from source files
5. Registers built-in skills
6. **Builds code-graph** (symbol index + call relationships → `output/code-graph.json`)

**Rules:**
- You MUST run this command in the terminal, not simulate it
- Wait for the command to complete before responding
- Report the output summary to the user
- If the command fails, show the error output and suggest fixes

---

## `/wf <requirement>` Workflow Execution Protocol

When the user sends `/wf <some requirement text>` (NOT `init` or `analyze`), this is a **workflow trigger**.
You must execute the full multi-agent pipeline: ANALYSE → ARCHITECT → PLAN → CODE → TEST.

**Required behaviour:**
1. Begin response with `> 🔄 启用wf工作流`
2. Execute the pipeline via `orchestrator.run(requirement)`
3. Produce workflow artifacts (`requirement.md`, `architecture.md`, code diff, test report)
4. Report progress at each phase: "✅ Phase 1 done: ...", "🔍 Analyzing...", "📝 Writing..."

**Forbidden behaviour:**
- Do NOT just read code and provide verbal analysis — that is NOT a workflow
- Do NOT skip the pipeline and write code directly — each phase must run in order
- Do NOT treat `/wf <text>` as a chat question
- Do NOT run the Session Start Checklist when executing `/wf <requirement>` — go directly into the pipeline
- Do NOT use Bash/Terminal for file reading or code exploration — use IDE-native tools (read_file, codebase_search, grep_search)
- The ONLY acceptable Bash usage during `/wf <requirement>` is: running `node workflow/init-project.js` (if not yet initialized) and running test commands in the TEST stage

---

## ⚡ Bash/Terminal Safety Rules

When using Bash/Terminal in any mode, follow these rules to prevent hanging:

1. **Never start foreground servers** — commands like `npm run dev`, `python manage.py runserver` block forever
2. **Always add timeout** — for network commands, add `--max-time 10` or equivalent
3. **Prefer IDE tools over Bash** — use `read_file` instead of `cat`, `list_dir` instead of `ls`/`find`, `grep_search` instead of `grep`
4. **Never run interactive commands** — avoid anything that prompts for input
5. **Keep commands short** — if a command might take >30 seconds, warn the user first
6. **Verification MUST use IDE tools, NOT Bash** — when verifying file content (JSON validity,
   config correctness, file existence), ALWAYS use `read_file` to read the file and validate
   in-context. NEVER spawn a Bash command for verification. Bash verification commands can
   hang silently with no visible feedback to the user.
7. **Announce before Bash** — before ANY Bash tool call, output a brief message explaining
   what the command does and how long it should take (e.g. "Running tests, ~10s...").
   If the command hangs, the user can see what went wrong.
8. **One command per call** — never chain multiple commands with `&&` or `;` in a single
   Bash call. If one hangs, the user cannot tell which one.

---

## Task Execution Rules

1. **One task at a time** — never start a second task before the first is committed
2. **Verify before done** — every task needs a `verificationNote` describing how it was tested
3. **Fix broken environment first** — if tests fail at session start, fix before new work
4. **Constraint check** — before marking done, verify no architecture constraints are violated

---

## When to Create a New ADR

Create a new entry in `docs/decision-log.md` when:
- A file is split or merged
- A new dependency is added
- A UX flow is changed
- A naming convention is established
- A constraint is added or relaxed

---

## Functional Correctness Validation

Code quality (lint, architecture) is necessary but NOT sufficient.
A task is only done when the **user journey** it affects still works end-to-end.

For each task, identify which Journey (from the project's architecture.md) it affects,
and verify that journey still passes after the change.

---

## Output Format

Always begin response with: `> 🔄 启用wf工作流`

During work, output brief phase markers:
- `🔍 Analyzing...`
- `📝 Writing...`
- `✅ Phase N done: <summary>`
- `⚠️ Issue found: <description>`

---

## Long Task Protocol (ADR-41)

> When handling multi-step tasks (e.g. "analyse 10 modules and optimise each"),
> agents MUST follow this protocol to prevent "deep-dive amnesia" — the phenomenon
> where an agent forgets the global task list after diving into implementation details.

### Rules

1. **Before starting**: Create a structured task list and display it to the user.
   Format: numbered checklist with clear scope for each item.

2. **Progress Beacon (auto-injected)**: In automated workflow mode (`runTaskBased()`),
   the orchestrator automatically injects a `📍 Progress Beacon` block into every
   task's context. This block shows which tasks are done, which is current, and
   which remain. Agents do NOT need to manage this manually in workflow mode.

3. **Interactive mode progress tracking**: When working in `/wf` interactive dialogue
   mode (not automated workflow), agents MUST:
   - At the **start** of a multi-step request: output a numbered task list
   - After **each step completes**: output an updated progress summary
   - At the **end**: output a final completion summary with all items checked

4. **Scratchpad file (optional)**: For tasks with 5+ steps, agents SHOULD create
   `output/scratchpad.md` as an external working memory file. Update it after each
   step. Re-read it if context feels lost.

5. **Never skip the remaining list**: When completing one sub-task, always explicitly
   acknowledge how many tasks remain and what they are.

6. **Verify inline, not in batch**: After each Write/Edit operation, immediately verify
   the result using `read_file` (NOT Bash). Never defer verification to a batch step
   at the end — batch Bash verification is the #1 cause of task hanging. Example:
   - ✅ Write file A → `read_file` A → confirm OK → Write file B → `read_file` B → confirm OK
   - ❌ Write file A → Write file B → Write file C → Bash "verify all 3 files" → 💀 hangs

### Interactive Mode Progress Format

Agents MUST use this format for user-visible progress:

```
📍 Progress: 3/10 completed

✅ 1. User auth module — Done (extracted 3 helper functions)
✅ 2. Database schema — Done (normalised 2 tables)
✅ 3. API endpoints — Done (split into 4 route files)
🔄 4. Frontend routing — In Progress
⬜ 5. Payment integration
⬜ 6. Notification service
⬜ 7. Admin dashboard
⬜ 8. Search engine
⬜ 9. Analytics module
⬜ 10. Deployment config
```

### Key Decisions Carry-Forward

When a decision made in step N affects step M (M > N), agents MUST note it in the
progress output:

```
📌 Key Decisions (carry forward):
- Decision: Use Express Router groups (not Koa) — affects steps 4, 5, 7
- Risk: Steps 5 and 6 share dependency on event-bus.js — must coordinate
```

---

## User-Visible Progress Display Protocol

> Users must always be able to clearly see the current status of all tasks/steps.
> This is a UX contract, not just an internal mechanism.

### Rule 1: Phase Markers (Always Required)

Every workflow execution MUST output brief phase markers as work progresses:
- `🔍 Analyzing...` — starting analysis
- `📝 Writing...` — generating artifacts
- `✅ Phase N done: <summary>` — phase complete
- `⚠️ Issue found: <description>` — problem detected

### Rule 2: Multi-Step Progress Dashboard

For any request involving 3+ sub-tasks, agents MUST display a progress dashboard:

**On first response:**
```
📋 Task Plan (10 items identified):
⬜ 1. <task description>
⬜ 2. <task description>
...
⬜ 10. <task description>
```

**After each sub-task:**
```
📍 Progress: N/Total completed
✅ 1. <done task> — <brief result>
🔄 K. <current task> — In Progress
⬜ M. <pending task>
```

**On completion:**
```
🎉 All 10/10 tasks completed!
✅ 1. <task> — <result>
✅ 2. <task> — <result>
...
✅ 10. <task> — <result>

📌 Summary: <overall result summary>
```

### Rule 3: Automated Workflow Progress

When running `orchestrator.run()` or `runTaskBased()`, the system automatically:
1. Logs phase transitions to console (`[Orchestrator] ✅ Phase X done`)
2. Injects Progress Beacon into each Agent's context
3. Generates final summary with task completion stats

Users can monitor progress through:
- **Console output**: real-time phase markers and task completion logs
- **`output/feature-list.json`**: persistent feature acceptance tracking
- **Task Manager summary**: `taskManager.getSummary()` shows byStatus counts

### Rule 4: Error/Block Visibility

When a task fails or is blocked, agents MUST immediately surface this to the user:
```
❌ Task 5 (Payment integration) FAILED: Stripe API key not configured
⚠️ Task 6 (Notification) BLOCKED: depends on Task 5

📍 Progress: 4/10 completed, 1 failed, 1 blocked, 4 remaining
   Action needed: please provide Stripe API key to continue
```

---

## Agent Negotiation Protocol (ADR-40)

> When a downstream agent discovers that an upstream artifact is incompatible with its
> capabilities, the system supports structured negotiation instead of blind rollback.

### Problem

Without negotiation, the only recovery mechanism is `rollback()` — which throws away
the downstream agent's work and re-runs the upstream stage from scratch. This is wasteful
when the issue is a minor design choice that could be resolved via clarification.

### Protocol

```
┌──────────────┐     NEGOTIATE_REQUEST      ┌──────────────┐
│  Downstream   │ ─────────────────────────▶ │   Upstream    │
│  (e.g. CODE)  │                            │ (e.g. ARCH)   │
│               │ ◀───────────────────────── │               │
│               │    NEGOTIATE_RESPONSE       │               │
└──────────────┘                              └──────────────┘
```

1. **NEGOTIATE_REQUEST**: Downstream agent raises a structured concern via
   `hookEmitter(HOOK_EVENTS.NEGOTIATE_REQUEST, { from, to, concern, suggestion })`.

2. **Orchestrator Mediation**: The orchestrator evaluates the concern:
   - If the concern is within tolerance (minor naming / param change) → auto-approve
   - If the concern requires upstream re-work → trigger targeted rollback
   - If ambiguous → escalate to human review (Socratic decision)

3. **NEGOTIATE_RESPONSE**: The resolution is recorded in the negotiation log
   and the downstream agent adjusts its approach accordingly.

### Negotiation Concern Types

| Type | Example | Default Resolution |
|------|---------|-------------------|
| `interface_mismatch` | API signature in arch.md doesn't match implementation | Ask upstream to clarify |
| `tech_constraint` | Architecture specifies a lib not available in runtime | Auto-suggest alternative |
| `scope_overflow` | Task requires work outside agent's allowed boundaries | Escalate to human |
| `quality_threshold` | Test coverage too low for the quality gate | Negotiate threshold |

### Implementation

- `HOOK_EVENTS.NEGOTIATE_REQUEST` / `HOOK_EVENTS.NEGOTIATE_RESPONSE` events
- Negotiation log persisted to `output/negotiation-log.json`
- Max negotiation rounds per stage: 2 (prevent infinite loops)
- Falls back to rollback if negotiation fails after max rounds

---

## Anti-Truncation Protocol (ADR-42)

> Prevents output truncation during interactive `/wf` sessions and automated workflow
> execution. Output truncation is a **P0 production reliability issue** — if the agent's
> response is silently cut off, the user receives incomplete results with no indication
> of what was lost.

### Root Cause Analysis

Output truncation occurs at three independent layers:

| Layer | Cause | Signal |
|-------|-------|--------|
| **L1: max_output_tokens** | Model's per-response output token limit (e.g. 32K/64K) | `stop_reason = "max_tokens"` |
| **L2: Context Window** | `input + output` exceeds model context window; as conversation grows, output budget shrinks | Longer conversations truncate more often |
| **L3: Platform/IDE** | IDE or streaming layer imposes its own timeout or size limit | Random truncation, no API signal |

### Prevention Rules (Interactive `/wf` Mode)

When operating in interactive `/wf` dialogue mode, agents MUST follow these rules:

#### Rule 1: Context Budget Awareness

After **5+ conversation turns**, assume context pressure is HIGH. Proactively:
- Use **concise output format** (bullet points, not detailed tables)
- Split multi-item analysis into **batches of 3–5 items per turn**
- Offer `"Shall I continue with the next batch?"` checkpoints

#### Rule 2: Chunked Output Pattern

For any analysis covering **5+ items** (modules, files, features, etc.):
1. **First turn**: Output a **summary table** (1 line per item) + detailed analysis of the **top 3**
2. **Ask user** which items to expand next
3. **Never** attempt to output all detailed analyses in a single turn

Example:
```
| # | Module | Verdict | Reason (1-line) |
|---|--------|---------|-----------------|
| 1 | auth   | ✅ Keep  | Core, well-tested |
| 2 | cache  | ❌ Remove | Dead code, 0 refs |
| ... | ... | ... | ... |

Detailed analysis for top 3 below. Say "continue 4-6" for the next batch.
```

#### Rule 3: Self-Monitoring Checkpoint

If the agent's output is getting long (estimated **>2000 words** or **>30 lines of table**),
it MUST stop and checkpoint:

```
📍 I've covered items 1–5 so far. Shall I continue with items 6–10?
```

#### Rule 4: Prefer Depth-on-Demand over Breadth-First

Instead of outputting everything at once:
- ✅ Output a concise overview, then let the user drill into specific items
- ❌ Output a massive detailed report covering all items in one response

### Detection (Automated Workflow Mode)

In automated workflow mode (`orchestrator.run()` / `runTaskBased()`), the system
detects output truncation via two mechanisms:

#### Mechanism 1: API Signal Detection

After every LLM call, check the response's `stop_reason` / `finish_reason`:
- `"end_turn"` or `"stop"` → Normal completion ✅
- `"max_tokens"` or `"length"` → **Truncated** ⚠️

#### Mechanism 2: Heuristic Detection

If the API signal is unavailable (e.g. response is a plain string), apply heuristics:
- Response ends mid-sentence (no terminal punctuation: `.!?。！？`)
- Response ends with an unclosed code block (odd number of `` ``` ``)
- Response is suspiciously short for the task complexity

### Recovery: Auto-Continuation (Automated Mode)

When truncation is detected in automated mode, the system automatically:

1. **Log** the truncation event (Observability + SelfReflection)
2. **Retry** with a continuation prompt: _"Your previous response was truncated. Continue from where you left off."_
3. **Merge** the continuation with the original response
4. **Limit** to 3 continuation attempts (prevent infinite loops)

### Implementation

- `HOOK_EVENTS.OUTPUT_TRUNCATED` — emitted when truncation is detected
- `wrappedLlm()` in `index.js` — checks `stop_reason` after every LLM call
- `_executeTask()` in `orchestrator-task.js` — auto-continuation loop
- Truncation events recorded in Observability for cross-session pattern detection
