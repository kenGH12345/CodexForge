# Workflow Optimization Patterns

> Universal optimization patterns distilled from WorkFlowAgent production usage.  
> Applicable to any multi-stage AI Agent workflow (not WorkFlowAgent-specific).
> Last updated: 2026-04-26

---

## Table of Contents

1. [Pattern Overview](#pattern-overview)
2. [Pattern 1: Dynamic Token Budget](#pattern-1-dynamic-token-budget)
3. [Pattern 2: Stage-Aware Budget Multipliers](#pattern-2-stage-aware-budget-multipliers)
4. [Pattern 3: Semantic Skill Routing](#pattern-3-semantic-skill-routing)
5. [Pattern 4: Session Context Cache](#pattern-4-session-context-cache)
6. [Pattern 5: Proactive Conversation Compaction](#pattern-5-proactive-conversation-compaction)
7. [Pattern 6: Feedback-Driven Prompt Evolution](#pattern-6-feedback-driven-prompt-evolution)
8. [Pattern 7: Lossless Structured Compression](#pattern-7-lossless-structured-compression)
9. [Quick Reference: Configuration Cheat Sheet](#quick-reference-configuration-cheat-sheet)

---

## Pattern Overview

| # | Pattern | Core Idea | Typical Token Saved | Setup Effort |
|---|---------|-----------|---------------------|--------------|
| 1 | Dynamic Token Budget | Adjust context injection based on task complexity | 20–50% | 1 config line |
| 2 | Stage-Aware Multipliers | Different stages need different amounts of context | 10–20% | 1 config section |
| 3 | Semantic Skill Routing | Use embeddings instead of keyword matching | 15–25% | 1 embedding provider |
| 4 | Session Context Cache | Avoid re-loading same context in one session | 30–40% | ~30 min dev |
| 5 | Proactive Compaction | Compress conversation history before it bloats | 15–30% | 2 config values |
| 6 | Feedback-Driven Prompt Evolution | A/B test prompts and auto-optimize | Quality↑↑ | 1 config flag |
| 7 | Lossless Structured Compression | Markdown → JSON for tables/lists | 30–60% | Compressor module |

---

## Pattern 1: Dynamic Token Budget

### Problem
Every task — whether "fix a typo" or "refactor the entire module" — receives the same
context window budget. Simple tasks waste tokens on oversized context; complex tasks lack
enough context to produce quality output.

### Solution
Link the context injection budget to a **task complexity score** (e.g. triage score,
estimated effort, or keyword density). Use ratios to scale the base budget up or down.

### Implementation

```javascript
// Pseudocode — adapt to your framework
function getDynamicBudget(triageScore, baseBudget = 2800) {
  if (triageScore <= 30)      return Math.floor(baseBudget * 0.5);   // 1400
  if (triageScore <= 70)      return baseBudget;                      // 2800
  return Math.floor(baseBudget * 1.5);                                // 4200
}
```

### Configuration Example

```javascript
// workflow.config.js
llm: {
  dynamicBudget: {
    enabled: true,
    defaultMaxInjectTokens: 2800,
    lowBudgetRatio: 0.5,     // simple tasks
    highBudgetRatio: 1.5,    // complex tasks
  },
}
```

### Expected Impact

| Task Complexity | Static Budget | Dynamic Budget | Token Δ |
|-----------------|---------------|----------------|---------|
| Low (typo fix)  | 2800          | 1400           | -50%    |
| Medium (feature)| 2800          | 2800           | 0%      |
| High (refactor) | 2800          | 4200           | +50% ↑↑ |

> **Badge**: 🟢 Zero code change — pure configuration

---

## Pattern 2: Stage-Aware Budget Multipliers

### Problem
Not all pipeline stages consume context equally. ANALYSE needs broad codebase context;
CODE needs focused file context; TEST needs minimal context. Using a flat budget
under-utilizes the budget in some stages and over-allocates in others.

### Solution
Assign per-stage multipliers to the global budget. Tighten (shrink) stages that need
less context; expand stages that need more.

### Default Multiplier Template

| Stage | Role | Recommended Multiplier | Rationale |
|-------|------|----------------------|-----------|
| ANALYSE | Understand the problem | 0.6 | Need breadth, not depth |
| ARCHITECT | Design the solution | 0.7 | Need pattern knowledge |
| PLAN | Break into tasks | 0.5 | Focused on current task |
| CODE | Implement | 1.0 | Full context for accuracy |
| TEST | Verify | 0.85 | Focused on test scenarios |

### Implementation

```javascript
const STAGE_MULTIPLIERS = {
  ANALYSE:  0.6,
  ARCHITECT: 0.7,
  PLAN:     0.5,
  CODE:     1.0,
  TEST:     0.85,
};

function getStageBudget(stage, globalBudgetChars = 60000) {
  return Math.floor(globalBudgetChars * (STAGE_MULTIPLIERS[stage] || 1.0));
}
```

> **Badge**: 🟢 Zero code change — expose as config

---

## Pattern 3: Semantic Skill Routing

### Problem
Keyword-based skill/context matching injects irrelevant skills (~15–20% mismatch rate),
wasting tokens and confusing the model with off-topic instructions.

### Solution
Use **embedding-based semantic similarity** to match tasks to skills. A skill and a task
with similar vector representations are genuinely related.

### Implementation

```javascript
// Pseudocode
async function rankSkillsByRelevance(taskText, skills, embeddingProvider) {
  const taskEmbedding = await embeddingProvider.embed(taskText);

  const scored = await Promise.all(skills.map(async skill => {
    const skillEmbedding = await getSkillEmbedding(skill); // cached
    const similarity = cosineSimilarity(taskEmbedding, skillEmbedding);
    return { skill, similarity };
  }));

  return scored
    .filter(s => s.similarity > 0.65)   // relevance threshold
    .sort((a, b) => b.similarity - a.similarity);
}
```

### Configuration Example

```javascript
embeddingService: {
  provider: 'openai',        // or 'local', 'cohere'
  model: 'text-embedding-3-small',
  cacheDir: '.workflow/embeddings',
  similarityThreshold: 0.65,
}
```

### Fallback Strategy
If embedding service is unavailable, gracefully degrade to **BM25 hybrid** (keyword + TF-IDF)
or pure keyword matching. Never block the pipeline on embedding availability.

> **Badge**: 🔵 Small code change — add embedding module + cache

---

## Pattern 4: Session Context Cache

### Problem
In a single session, multiple commands/context lookups re-load the same skills, ADRs,
and documents. Each reload burns identical tokens.

### Solution
Maintain a **session-level in-memory cache** for context blocks. Cache key = file path +
last-modified timestamp. On repeated lookup, return the cached block if unmodified.

### Implementation

```javascript
class SessionContextCache {
  constructor() {
    this.cache = new Map(); // key => { content, mtime }
  }

  async load(filePath) {
    const stats = await fs.promises.stat(filePath);
    const key = `${filePath}:${stats.mtimeMs}`;

    if (this.cache.has(key)) {
      return this.cache.get(key).content; // Cache hit — zero I/O
    }

    const content = await fs.promises.readFile(filePath, 'utf-8');
    this.cache.set(key, { content, mtime: stats.mtimeMs });
    return content;
  }

  clear() {
    this.cache.clear();
  }
}
```

### Expected Impact

| Scenario | Without Cache | With Cache | Token Saved |
|----------|--------------|------------|-------------|
| 3 skill lookups in one session | 3 × 500 = 1500 | 500 + 0 + 0 = 500 | -67% |
| 5 ADR references | 5 × 300 = 1500 | 300 + 0×4 = 300 | -80% |

> **Badge**: 🔵 Small code change — ~30 min to integrate

---

## Pattern 5: Proactive Conversation Compaction

### Problem
Long multi-stage pipelines accumulate message history. Each new LLM call sends the
entire history, causing token costs to grow super-linearly.

### Solution
**Proactively compress** conversation history when it crosses a threshold. Use a smaller
model (or the same model with a compression prompt) to generate a condensed summary,
then replace the full history with the summary + last N messages.

### Trigger Strategy

| Metric | Conservative | Balanced (Recommended) | Aggressive |
|--------|-------------|------------------------|------------|
| Message count | 15 | **8** | 5 |
| Character count | 80000 | **50000** | 30000 |
| Cooldown (min messages between compactions) | 5 | **3** | 2 |

### Compression Prompt Template

```
Summarize the following conversation for continuation. Preserve:
- All decisions and their rationales
- All file paths mentioned
- All requirements and acceptance criteria
- Any errors or warnings

Omit: greetings, acknowledgments, progress markers, redundant explanations.

Conversation:
{history}
```

### Expected Impact

| Pipeline Length | Without Compaction | With Compaction | Token Saved |
|-----------------|-------------------|-----------------|-------------|
| 5 stages × 4 msgs | ~20000 chars | ~8000 chars | -60% |
| 7 stages × 6 msgs | ~50000 chars | ~15000 chars | -70% |

> **Badge**: 🟢 Zero code change — adjust 2 config values

---

## Pattern 6: Feedback-Driven Prompt Evolution

### Problem
Prompts are written once and rarely improved. Sub-optimal prompts cause recurring failures
(missing tests, syntax errors, incomplete implementations) that the user repeatedly corrects.

### Solution
Capture Agent feedback (success/failure, user corrections, quality scores) and use it to
A/B test prompt variants. Promote variants with higher success rates.

### Lifecycle

```
┌─────────────┐   ┌──────────────┐   ┌─────────────┐   ┌──────────────┐
│   PROMPT A  │──→│  Run Task    │──→│ Score Result│──→│ Record to DB │
│  (baseline) │   │              │   │             │   │              │
└─────────────┘   └──────────────┘   └─────────────┘   └──────┬───────┘
                                                              │
┌─────────────┐   ┌──────────────┐   ┌─────────────┐         │
│   PROMPT B  │──→│  Run Task    │──→│ Score Result│─────────┤
│  (variant)  │   │              │   │             │         │
└─────────────┘   └──────────────┘   └─────────────┘         │
                                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  After N samples: compare success rates. If variant ≥ baseline + 15%│
│  → Promote variant to baseline. Otherwise, discard and try next.   │
└─────────────────────────────────────────────────────────────────────┘
```

### Minimum Sample Sizes

| Check | Minimum Samples |
|-------|----------------|
| Prompt variant comparison | 10 tasks per variant |
| Auto-apply confidence | 5 feedback records |
| Statistically significant improvement | 15% success-rate delta |

### Configuration

```javascript
promptAutoOptimization: {
  enabled: true,
  autoApply: true,              // auto-apply high-confidence optimizations
  minFeedbackForAnalysis: 5,    // wait for N samples before analyzing
  confidenceThreshold: 0.85,    // 85%+ confidence = auto-apply
}
```

> **Badge**: 🟢 Zero code change — enable via config

---

## Pattern 7: Lossless Structured Compression

### Problem
Agent outputs (module maps, task lists, API schemas) are often formatted as Markdown tables
or nested lists. These are verbose in raw form and consume disproportionate tokens when
included in subsequent prompts.

### Solution
**Compress structured output** into compact JSON representations, then decompress when
needed. This is lossless for machines but saves 30–60% of token volume.

### Example: Markdown Table → JSON

**Before** (Markdown):
```markdown
| Module | Files | Classes | Functions |
|--------|-------|---------|-----------|
| core   | 271   | 161     | 3315      |
| tools  | 16    | 4       | 321       |
```
→ ~120 tokens

**After** (JSON):
```json
{"core":[271,161,3315],"tools":[16,4,321]}
```
→ ~25 tokens (-79%)

### Decompression
```javascript
function decompressModuleMap(json) {
  const header = ['Module','Files','Classes','Functions'];
  const rows = Object.entries(JSON.parse(json))
    .map(([k,v]) => `| ${k} | ${v.join(' | ')} |`);
  return ['| ' + header.join(' | ') + ' |',
          '|' + header.map(()=>'---').join('|')+'|',
          ...rows].join('\n');
}
```

### Where to Apply

| Output Type | Compression Target | Typical Savings |
|-------------|-------------------|-----------------|
| Module maps | JSON object | -60% |
| Test case tables | JSON array | -50% |
| API endpoint lists | JSON array of tuples | -55% |
| Execution plans | Nested JSON | -40% |

> **Badge**: 🔵 Small code change — add compressor module

---

## Quick Reference: Configuration Cheat Sheet

### Minimal Config for Maximum Impact

```javascript
module.exports = {
  // ─── Pattern 1 + 2: Dynamic + Stage-Aware Budget ───
  llm: {
    dynamicBudget: {
      enabled: true,
      defaultMaxInjectTokens: 2800,
      lowBudgetRatio: 0.5,
      highBudgetRatio: 1.5,
    },
  },

  // ─── Pattern 3: Semantic Skill Routing ───
  embeddingService: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    cacheDir: '.workflow/embeddings',
  },

  // ─── Pattern 5: Proactive Compaction ───
  compaction: {
    triggerMessages: 8,      // lower = sooner compression
    triggerChars: 50000,
  },

  // ─── Pattern 6: Feedback-Driven Prompt Evolution ───
  promptAutoOptimization: {
    enabled: true,
    autoApply: true,
    minFeedbackForAnalysis: 5,
  },
};
```

### One-Line Activations

| Pattern | What to Change |
|---------|---------------|
| Dynamic Budget | Add `llm.dynamicBudget.enabled: true` |
| Stage Multipliers | Move `STAGE_MULTIPLIERS` from code to config |
| Semantic Routing | Set `embeddingService.provider` |
| Session Cache | Instantiate `SessionContextCache` at session start |
| Proactive Compaction | Lower `TRIGGER_MESSAGES` and `TRIGGER_CHARS` |
| Prompt Evolution | Set `promptAutoOptimization.autoApply: true` |
| Structured Compression | Call `compressMarkdownTable()` before storing output |

---

## Anti-Patterns to Avoid

| Anti-Pattern | Why It Hurts | What to Do Instead |
|-------------|-------------|-------------------|
| Same budget for all tasks | Wastes tokens on simple tasks, starves complex ones | Use Pattern 1: Dynamic Budget |
| Keyword-only skill matching | 15–20% irrelevant skill injection | Use Pattern 3: Semantic Routing |
| Never compressing history | Token cost grows super-linearly | Use Pattern 5: Proactive Compaction |
| Static prompts forever | Recurring failures never addressed | Use Pattern 6: Prompt Evolution |
| Raw Markdown in context | Tables/lists consume 2–3× tokens | Use Pattern 7: Structured Compression |
| Re-loading context per command | Identical tokens spent multiple times | Use Pattern 4: Session Cache |

---

## Measuring Impact

Track these metrics before and after applying each pattern:

| Metric | How to Measure | Target Improvement |
|--------|---------------|-------------------|
| Avg tokens per task | Sum prompt + completion tokens | -20% |
| Irrelevant skill rate | Manual audit of injected skills | <5% |
| History bloat ratio | History chars / initial prompt chars | <2× |
| Prompt effectiveness | Success rate per prompt variant | +15% |
| Context load time | Time to assemble context | -30% |

---

*End of guide. PRs and suggestions welcome.*
