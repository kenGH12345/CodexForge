'use strict';

const fs   = require('fs');
const path = require('path');
const { extractJsonBlock, extractKeyDecisions, extractSummary } = require('./agent-output-schema');

/**
 * StageContextStore – Cross-stage semantic context propagation.
 *
 * Problem it solves (Defect #9 – "Cross-stage Context missing"):
 *   Previously, agents only received a file path via FileRefBus.
 *   The meta object carried only numeric counters (reviewRounds, failedItems).
 *   Downstream agents had NO visibility into upstream decisions:
 *     - What tech stack did the architect choose?
 *     - Which modules did the developer change?
 *     - What risks did the analyst flag?
 *
 * This module provides a lightweight key-value store where each stage
 * deposits a structured summary of its key decisions. Downstream stages
 * read the accumulated summaries and inject them into their Agent prompts.
 *
 * Design principles:
 *   - Summaries are SHORT (≤600 chars each) to avoid token bloat
 *   - Summaries are STRUCTURED (key decisions, not raw content)
 *   - The store is IN-MEMORY per workflow run (no persistence needed)
 *   - Optionally persisted to output/stage-context.json for debugging
 */
class StageContextStore {
  constructor(opts = {}) {
    /** @type {Map<string, StageContext>} stageName → context */
    this._store = new Map();
    this._outputDir = opts.outputDir || null;
    this._verbose   = opts.verbose   ?? false;
    this._persistPending = false;

    // P2-2 fix (Ghemawat): LRU eviction to control memory growth.
    // In long-running service mode or task-based workflows with many stages,
    // the store can grow unboundedly. These limits trigger LRU eviction.
    //   maxEntries:   max number of stage context entries (default 20)
    //   maxTotalChars: max total characters across all summaries (default 50_000)
    // When either limit is exceeded, the least-recently-accessed entry is evicted.
    this._maxEntries    = opts.maxEntries    ?? 20;
    this._maxTotalChars = opts.maxTotalChars ?? 50_000;
    /** @type {Map<string, number>} stageName → last access timestamp (for LRU) */
    this._accessOrder = new Map();

    // T-1 (G5-A+): Explicit scratchpad namespace separate from stage context.
    // Agents use setScratch/getScratch to pass arbitrary k/v across stages without
    // going through the stage-summary pipeline. Entries carry TTL + scope metadata.
    /** @type {Map<string, ScratchEntry>} */
    this._scratchpad = new Map();
    /** @type {Map<string, number>} key → last access ts (LRU for scratchpad) */
    this._scratchAccessOrder = new Map();
    // Capacity derived from T-0 model capability when available; falls back
    // to explicit opt. Medium tier (8K maxInject / 4) ≈ 2K scratchpad budget.
    this._scratchMaxEntries    = opts.scratchMaxEntries    ?? 50;
    this._scratchMaxTotalChars = opts.scratchMaxTotalChars ?? _resolveScratchBudget();

    // Auto-load persisted context on construction so workflow resumption
    // (e.g. after a crash mid-CODE stage) can see ANALYSE + ARCHITECT summaries.
    if (this._outputDir) {
      this._load();
    }

    // Flush pending debounced write on process exit. see CHANGELOG: P1-4/exit-handler
    if (this._outputDir) {
      this._exitHandler = () => {
        if (!this._persistPending && this._scratchpad.size === 0) return;
        try {
          const data = {};
          for (const [k, v] of this._store) data[k] = v;
          if (this._requirementFingerprint) {
            data._meta = { requirementFingerprint: this._requirementFingerprint };
          }
          if (this._scratchpad.size > 0) {
            const scratchOut = {};
            for (const [k, v] of this._scratchpad) scratchOut[k] = v;
            data._scratchpad = scratchOut;
          }
          const outPath = require('path').join(this._outputDir, 'stage-context.json');
          const tmpPath = outPath + '.tmp';
          require('fs').writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
          require('fs').renameSync(tmpPath, outPath);
        } catch { /* best-effort – cannot throw in exit handler */ }
      };
      process.on('exit', this._exitHandler);
    }
  }

  /**
   * Forces an immediate synchronous flush of all in-memory state to disk.
   * Needed for short-lived CLI invocations (bridge commands) that exit before
   * the debounced setImmediate write fires. Safe to call repeatedly; no-op if
   * there's nothing to persist and no outputDir configured.
   */
  flush() {
    if (!this._outputDir) return false;
    try {
      const data = {};
      for (const [k, v] of this._store) data[k] = v;
      if (this._requirementFingerprint) {
        data._meta = { requirementFingerprint: this._requirementFingerprint };
      }
      if (this._scratchpad.size > 0) {
        const scratchOut = {};
        for (const [k, v] of this._scratchpad) scratchOut[k] = v;
        data._scratchpad = scratchOut;
      }
      const outPath = path.join(this._outputDir, 'stage-context.json');
      const tmpPath = outPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, outPath);
      this._persistPending = false;
      return true;
    } catch (err) {
      if (this._verbose) console.error(`[StageContextStore] flush failed: ${err.message}`);
      return false;
    }
  }

  // ─── Write ────────────────────────────────────────────────────────────────

  /**
   * Records the context summary for a completed stage.
   *
   * @param {string} stageName  - e.g. 'ANALYSE', 'ARCHITECT', 'CODE', 'TEST'
   * @param {object} context
   * @param {string}   context.summary            - Short human-readable summary (≤600 chars)
   * @param {string[]} [context.keyDecisions]      - Bullet list of key decisions made
   * @param {string[]} [context.artifacts]         - Output file paths produced
   * @param {string[]} [context.risks]             - Risk notes recorded in this stage
   * @param {object}   [context.meta]              - Arbitrary structured metadata
   * @param {object[]} [context.correctionHistory] - Defect E fix: structured self-correction
   *   history. Each entry: { round: number, issuesFixed: string[], source?: string }.
   *   Populated from SelfCorrectionEngine.correct().history or ReviewAgent.review().history.
   *   Downstream agents read this to understand what was corrected in upstream stages,
   *   preventing them from re-introducing issues that were already fixed.
   */
  set(stageName, context) {
    // P0-FIX: Validate inputs to prevent downstream consumers from receiving
    // malformed data. Without this guard, passing null/undefined/string would
    // cause silent failures or cryptic "Cannot read property" errors in
    // downstream stages that call get() and destructure the result.
    if (!stageName || typeof stageName !== 'string') {
      throw new Error(
        `[StageContextStore.set] Invalid stageName: expected non-empty string, got ${typeof stageName} (${JSON.stringify(stageName)})`
      );
    }
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new Error(
        `[StageContextStore.set] Invalid context for stage "${stageName}": expected plain object, got ${Array.isArray(context) ? 'Array' : typeof context}`
      );
    }

    // Validate field types when present (defensive, not exhaustive)
    if (context.keyDecisions != null && !Array.isArray(context.keyDecisions)) {
      console.warn(
        `[StageContextStore] ⚠️  stage "${stageName}": keyDecisions should be an array, got ${typeof context.keyDecisions}. Coercing to [].`
      );
    }
    if (context.artifacts != null && !Array.isArray(context.artifacts)) {
      console.warn(
        `[StageContextStore] ⚠️  stage "${stageName}": artifacts should be an array, got ${typeof context.artifacts}. Coercing to [].`
      );
    }
    if (context.risks != null && !Array.isArray(context.risks)) {
      console.warn(
        `[StageContextStore] ⚠️  stage "${stageName}": risks should be an array, got ${typeof context.risks}. Coercing to [].`
      );
    }

    const entry = {
      stageName,
      summary:           (typeof context.summary === 'string' ? context.summary : '').slice(0, 600),
      keyDecisions:      Array.isArray(context.keyDecisions)      ? context.keyDecisions       : [],
      artifacts:         Array.isArray(context.artifacts)         ? context.artifacts          : [],
      risks:             Array.isArray(context.risks)             ? context.risks              : [],
      correctionHistory: Array.isArray(context.correctionHistory) ? context.correctionHistory  : [],
      meta:              (context.meta && typeof context.meta === 'object' && !Array.isArray(context.meta)) ? context.meta : {},
      timestamp:         new Date().toISOString(),
    };
    this._store.set(stageName, entry);
    this._accessOrder.set(stageName, Date.now());

    // P2-2: LRU eviction check after every write
    this._evictIfNeeded();

    if (this._verbose) {
      console.log(`[StageContextStore] Stored context for stage: ${stageName} (${entry.summary.length} chars)`);
    }

    // Persist to disk for debugging (non-blocking, best-effort)
    if (this._outputDir) {
      this._persist();
    }
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  /**
   * Returns the context for a specific stage, or null if not found.
   * @param {string} stageName
   * @returns {StageContext|null}
   */
  get(stageName) {
    const entry = this._store.get(stageName) || null;
    // P2-2: Update access timestamp for LRU tracking
    if (entry) {
      this._accessOrder.set(stageName, Date.now());
    }
    return entry;
  }

  /**
   * Removes the context entry for a specific stage.
   * Called during rollback to invalidate stale upstream context so that
   * re-run agents cannot see decisions from the failed attempt.
   *
   * Example: rolling back CODE → ARCHITECT should delete the ARCHITECT entry
   * so _runDeveloper re-runs with a fresh architecture context, not the old one.
   *
   * @param {string} stageName
   * @returns {boolean} true if the entry existed and was removed
   */
  delete(stageName) {
    const existed = this._store.has(stageName);
    if (existed) {
      this._store.delete(stageName);
      this._accessOrder.delete(stageName);
      if (this._verbose) {
        console.log(`[StageContextStore] Deleted stale context for stage: ${stageName} (rollback invalidation)`);
      }
      if (this._outputDir) {
        this._persist();
      }
    }
    return existed;
  }

  /**
   * Returns all stored stage contexts as a formatted Markdown block.
   * Intended for injection into downstream Agent prompts.
   *
   * @param {string[]} [excludeStages]    - Stage names to exclude (e.g. current stage)
   * @param {number}   [maxChars=2000]    - Total CHARACTER budget for the output.
   *   ⚠️  Note: this is measured in characters, not tokens. For English text, divide
   *   by ~4 to get approximate token count. For CJK text, divide by ~2.
   *   Callers should set this value considering the token budget they want to allocate:
   *   e.g. for a 500-token budget, pass maxChars=2000 (English) or maxChars=1000 (Chinese).
   * @param {string[]} [priorityStages]   - Stages to render first (most relevant to current stage).
   *   If provided, these stages are rendered before others, ensuring the most relevant
   *   upstream context is never truncated by the token budget.
   *   Example: TEST stage passes ['CODE', 'ARCHITECT'] so code context comes first.
   * @returns {string} Markdown-formatted context block, or '' if empty
   */
  getAll(excludeStages = [], maxChars = 2000, priorityStages = []) {
    if (this._store.size === 0) return '';

    const lines = [
      `## 🔗 Cross-Stage Context (from upstream stages)`,
      `> The following summaries capture key decisions made in earlier stages.`,
      `> Use this context to ensure consistency and avoid contradicting upstream decisions.`,
      ``,
    ];

    // Track totalChars as running sum (including separators) to avoid exceeding maxChars. see CHANGELOG: P1-3
    let totalChars = lines.join('\n').length;
    // Dedicated counter for rendered stages (filter-based approach always returned 0). see CHANGELOG: Defect D
    let renderedStageCount = 0;

    // Sort store entries by relevance: priorityStages first, then remaining in insertion order.
    // This ensures the most relevant upstream context (e.g. CODE for TEST stage) is never
    // truncated by the token budget. see CHANGELOG: P1-C
    const allEntries = [...this._store.entries()].filter(([name]) => !excludeStages.includes(name));
    const priorityEntries = priorityStages
      .map(name => allEntries.find(([n]) => n === name))
      .filter(Boolean);
    const remainingEntries = allEntries.filter(([name]) => !priorityStages.includes(name));
    const orderedEntries = [...priorityEntries, ...remainingEntries];

    for (const [stageName, ctx] of orderedEntries) {

      const sectionLines = [`### ${stageName} Stage`];

      if (ctx.summary) {
        sectionLines.push(ctx.summary);
      }

      if (ctx.keyDecisions && ctx.keyDecisions.length > 0) {
        sectionLines.push(`**Key Decisions:**`);
        ctx.keyDecisions.slice(0, 5).forEach(d => sectionLines.push(`- ${d}`));
      }

      if (ctx.risks && ctx.risks.length > 0) {
        sectionLines.push(`**Risks Flagged:**`);
        ctx.risks.slice(0, 3).forEach(r => sectionLines.push(`- ⚠️ ${r}`));
      }

      // Defect E fix: render correction history so downstream agents know what was
      // fixed in upstream stages. This prevents re-introducing already-corrected issues.
      // Example: if ARCHITECT fixed a "single point of failure" in round 2, CODE stage
      // DeveloperAgent will see this and avoid re-introducing the same pattern.
      if (ctx.correctionHistory && ctx.correctionHistory.length > 0) {
        sectionLines.push(`**Self-Corrections Made (${ctx.correctionHistory.length} round(s)):**`);
        ctx.correctionHistory.forEach(h => {
          const sourceTag = h.source ? ` [${h.source}]` : '';
          const issues = (h.issuesFixed || []).slice(0, 3);
          if (issues.length > 0) {
            sectionLines.push(`- Round ${h.round}${sourceTag}: fixed – ${issues.join('; ')}`);
          } else {
            sectionLines.push(`- Round ${h.round}${sourceTag}: corrections applied`);
          }
        });
      }

      if (ctx.artifacts && ctx.artifacts.length > 0) {
        sectionLines.push(`**Artifacts:** ${ctx.artifacts.map(a => `\`${path.basename(a)}\``).join(', ')}`);
      }

      sectionLines.push('');
      const sectionText = sectionLines.join('\n');

      if (totalChars + sectionText.length + 1 > maxChars) {
        // Budget exceeded – add a truncation notice and stop
        const remaining = orderedEntries.length - renderedStageCount;
        lines.push(`_... (${remaining} more stage(s) truncated due to token budget)_`);
        break;
      }

      lines.push(sectionText);
      // +1 accounts for the '\n' separator that lines.join('\n') inserts between elements
      totalChars += sectionText.length + 1;
      renderedStageCount++;
    }

    const result = lines.join('\n');
    return result.length > 50 ? result : ''; // Don't return near-empty blocks
  }

  /**
   * Returns a compact single-line summary of all stages for logging.
   * @returns {string}
   */
  getLogLine() {
    if (this._store.size === 0) return '(no upstream context)';
    return [...this._store.keys()].map(s => {
      const ctx = this._store.get(s);
      return `${s}(${ctx.keyDecisions?.length ?? 0} decisions, ${ctx.risks?.length ?? 0} risks)`;
    }).join(' → ');
  }

  // ─── Dynamic Context Selection (Defect D fix) ────────────────────────────

  /**
   * Defect D fix: Dynamically selects the most relevant upstream context for the
   * current stage, instead of requiring callers to manually specify priorityStages[].
   *
   * **Why this matters**: getAll() with manual priorityStages is a "hope the caller
   * knows best" strategy. But the caller (buildArchitectUpstreamCtx etc.) hardcodes
   * priority based on stage ordering, not based on WHAT the downstream agent actually
   * needs. When ARCHITECT rolls back after a CODE failure, the failure context from
   * CODE should be prioritised, but the hardcoded priority ['ANALYSE'] can't express this.
   *
   * **How it works**:
   *   1. Auto-infer priority from `currentStage` (immediate upstream first)
   *   2. Boost stages whose context contains keywords matching `taskHints`
   *   3. Boost stages that have correction history (corrections = learned knowledge)
   *   4. Demote stages whose context is empty/minimal (no key decisions)
   *   5. Apply budget allocation proportional to relevance score
   *
   * @param {string}   currentStage    - e.g. 'ARCHITECT', 'CODE', 'TEST'
   * @param {object}   [options]
   * @param {string}   [options.taskHints]   - Free-text description of the current task
   *   (e.g. failure context from rollback). Keywords in this string boost matching stages.
   * @param {number}   [options.maxChars=2000] - Total character budget
   * @param {string[]} [options.excludeStages] - Stages to exclude (e.g. current stage)
   * @returns {string} Markdown-formatted context block
   */
  getRelevant(currentStage, { taskHints = '', maxChars = 2000, excludeStages = [] } = {}) {
    if (this._store.size === 0) return '';

    // Auto-exclude the current stage (agent shouldn't see its own in-progress context)
    const exclusions = new Set([...excludeStages, currentStage]);

    // Collect all candidate stages with relevance scores
    const candidates = [];
    for (const [stageName, ctx] of this._store) {
      if (exclusions.has(stageName)) continue;

      let score = 0;

      // ── Factor 1: Stage proximity (immediate upstream gets highest score) ──
      const proximity = _stageProximity(stageName, currentStage);
      score += proximity * 30; // 0-30 points

      // ── Factor 2: Correction history (learned knowledge is high-value) ──
      if (ctx.correctionHistory && ctx.correctionHistory.length > 0) {
        score += 20; // Correction history = the agent FIXED something = important context
      }

      // ── Factor 3: Risk notes (stages with risks need downstream attention) ──
      if (ctx.risks && ctx.risks.length > 0) {
        score += Math.min(ctx.risks.length * 5, 15); // 0-15 points
      }

      // ── Factor 4: Key decisions richness ──
      if (ctx.keyDecisions && ctx.keyDecisions.length > 0) {
        score += Math.min(ctx.keyDecisions.length * 3, 15); // 0-15 points
      } else {
        score -= 10; // Demote stages with no key decisions (minimal content)
      }

      // ── Factor 5: Keyword overlap with taskHints (failure context matching) ──
      if (taskHints && taskHints.length > 5) {
        const hintWords = _extractKeywords(taskHints);
        const contextText = [
          ctx.summary || '',
          ...(ctx.keyDecisions || []),
          ...(ctx.risks || []),
        ].join(' ').toLowerCase();

        let matches = 0;
        for (const word of hintWords) {
          if (contextText.includes(word)) matches++;
        }
        const overlapRatio = hintWords.length > 0 ? matches / hintWords.length : 0;
        score += Math.round(overlapRatio * 20); // 0-20 points
      }

      candidates.push({ stageName, ctx, score: Math.max(0, score) });
    }

    // Sort by relevance score (highest first)
    candidates.sort((a, b) => b.score - a.score);

    if (this._verbose) {
      const scoreLog = candidates.map(c => `${c.stageName}(${c.score})`).join(', ');
      console.log(`[StageContextStore] 🎯 Relevance scores for ${currentStage}: ${scoreLog}`);
    }

    // Delegate to getAll() with dynamically computed priority order
    const dynamicPriority = candidates.map(c => c.stageName);
    return this.getAll([...exclusions], maxChars, dynamicPriority);
  }

  // ─── LRU Eviction (P2-2, Ghemawat) ────────────────────────────────────────

  /**
   * Evicts least-recently-used entries if the store exceeds size or memory limits.
   * Called after every set() operation.
   *
   * Eviction strategy:
   *   1. If entry count > maxEntries → evict LRU until within limit
   *   2. If total summary chars > maxTotalChars → evict LRU until within limit
   *   3. Never evicts the most recently written entry (the one that triggered eviction)
   */
  _evictIfNeeded() {
    let evicted = 0;

    // Sort by access time (oldest first) for LRU ordering
    const getLruOrder = () => {
      return [...this._accessOrder.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([name]) => name);
    };

    // Check entry count limit
    while (this._store.size > this._maxEntries) {
      const lru = getLruOrder();
      if (lru.length === 0) break;
      const victim = lru[0];
      this._store.delete(victim);
      this._accessOrder.delete(victim);
      evicted++;
    }

    // Check total chars limit
    while (this._getTotalChars() > this._maxTotalChars && this._store.size > 1) {
      const lru = getLruOrder();
      if (lru.length === 0) break;
      const victim = lru[0];
      this._store.delete(victim);
      this._accessOrder.delete(victim);
      evicted++;
    }

    if (evicted > 0 && this._verbose) {
      console.log(`[StageContextStore] 🗑️ LRU evicted ${evicted} entry/entries (store: ${this._store.size} entries, ${this._getTotalChars()} chars)`);
    }
  }

  /**
   * Calculates total character count across all stored summaries and key decisions.
   * Used for memory budget enforcement.
   * @returns {number}
   */
  _getTotalChars() {
    let total = 0;
    for (const [, ctx] of this._store) {
      total += (ctx.summary || '').length;
      if (ctx.keyDecisions) {
        for (const d of ctx.keyDecisions) total += d.length;
      }
      if (ctx.risks) {
        for (const r of ctx.risks) total += (typeof r === 'string' ? r.length : 0);
      }
    }
    return total;
  }

  /**
   * Returns LRU stats for diagnostics.
   * @returns {{ entries: number, totalChars: number, maxEntries: number, maxTotalChars: number }}
   */
  getLruStats() {
    return {
      entries: this._store.size,
      totalChars: this._getTotalChars(),
      maxEntries: this._maxEntries,
      maxTotalChars: this._maxTotalChars,
    };
  }

  // ─── Scratchpad API (T-1 / G5-A+) ─────────────────────────────────────────

  /**
   * Stores an explicit scratchpad entry addressable by key (not by stage name).
   * Scope determines lifetime: 'session' (default) survives until workflow end;
   * 'nextStage' is readable only by the immediately-following stage then auto-purged;
   * a number (ms since epoch) is an absolute expiry timestamp.
   *
   * @param {string} key
   * @param {string|object} value - string or JSON-serialisable object
   * @param {object} [opts]
   * @param {('session'|'nextStage')} [opts.scope='session']
   * @param {number} [opts.ttlMs] - explicit TTL; overrides scope if provided
   * @param {string} [opts.fromStage] - origin stage name, for trace/audit
   * @param {string[]} [opts.tags] - optional labels for filtering
   * @returns {boolean} true if stored, false if rejected (oversize or bad key)
   */
  setScratch(key, value, opts = {}) {
    if (!key || typeof key !== 'string' || key.length > 120) return false;
    const serialised = typeof value === 'string' ? value : _safeJson(value);
    if (serialised == null) return false;
    if (serialised.length > 8000) return false; // single-entry hard cap

    const scope = opts.scope === 'nextStage' ? 'nextStage' : 'session';
    const now = Date.now();
    const expiresAt = typeof opts.ttlMs === 'number' && opts.ttlMs > 0
      ? now + opts.ttlMs
      : (scope === 'nextStage' ? null : null);

    const entry = {
      key,
      value: serialised,
      valueKind: typeof value === 'string' ? 'string' : 'json',
      scope,
      expiresAt,
      fromStage: opts.fromStage || null,
      tags: Array.isArray(opts.tags) ? opts.tags.filter(t => typeof t === 'string').slice(0, 8) : [],
      createdAt: now,
    };
    this._scratchpad.set(key, entry);
    this._scratchAccessOrder.set(key, now);
    this._evictScratchIfNeeded();

    if (this._verbose) {
      console.error(`[StageContextStore] scratch SET ${key} scope=${scope} size=${serialised.length}`);
    }
    if (this._outputDir) this._persist();
    return true;
  }

  /**
   * Reads a scratchpad entry. Returns null if missing or expired.
   * For scope='nextStage' entries, caller must pass currentStage so the store can
   * enforce the one-stage visibility window (entry visible only while currentStage
   * != fromStage; auto-purged after first cross-stage read).
   *
   * @param {string} key
   * @param {object} [opts]
   * @param {string} [opts.currentStage] - needed for nextStage-scoped entries
   * @returns {{value:any,scope:string,fromStage:string|null,tags:string[]}|null}
   */
  getScratch(key, opts = {}) {
    const entry = this._scratchpad.get(key);
    if (!entry) return null;

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this._scratchpad.delete(key);
      this._scratchAccessOrder.delete(key);
      return null;
    }

    if (entry.scope === 'nextStage' && opts.currentStage && entry.fromStage
        && opts.currentStage !== entry.fromStage) {
      // first cross-stage read: consume + purge
      const consumed = this._materialiseScratch(entry);
      this._scratchpad.delete(key);
      this._scratchAccessOrder.delete(key);
      if (this._outputDir) this._persist();
      return consumed;
    }

    this._scratchAccessOrder.set(key, Date.now());
    return this._materialiseScratch(entry);
  }

  /**
   * Deletes a scratchpad entry. Returns true if it existed.
   */
  deleteScratch(key) {
    const existed = this._scratchpad.has(key);
    if (existed) {
      this._scratchpad.delete(key);
      this._scratchAccessOrder.delete(key);
      if (this._outputDir) this._persist();
    }
    return existed;
  }

  /**
   * Lists scratchpad entries. Expired items are purged lazily during iteration.
   *
   * @param {object} [opts]
   * @param {string} [opts.scope] - filter by scope
   * @param {string} [opts.tag]   - filter by tag membership
   * @param {string} [opts.fromStage]
   * @returns {Array<{key:string,scope:string,fromStage:string|null,tags:string[],size:number,createdAt:number}>}
   */
  listScratch(opts = {}) {
    const now = Date.now();
    const out = [];
    for (const [k, e] of this._scratchpad) {
      if (e.expiresAt && now > e.expiresAt) {
        this._scratchpad.delete(k);
        this._scratchAccessOrder.delete(k);
        continue;
      }
      if (opts.scope && e.scope !== opts.scope) continue;
      if (opts.fromStage && e.fromStage !== opts.fromStage) continue;
      if (opts.tag && !(e.tags || []).includes(opts.tag)) continue;
      out.push({
        key: k,
        scope: e.scope,
        fromStage: e.fromStage,
        tags: e.tags || [],
        size: (e.value || '').length,
        createdAt: e.createdAt,
      });
    }
    return out;
  }

  /**
   * Returns scratchpad totals for diagnostics / trace events.
   */
  getScratchStats() {
    let totalChars = 0;
    for (const [, e] of this._scratchpad) totalChars += (e.value || '').length;
    return {
      entries: this._scratchpad.size,
      totalChars,
      maxEntries: this._scratchMaxEntries,
      maxTotalChars: this._scratchMaxTotalChars,
    };
  }

  _materialiseScratch(entry) {
    let value = entry.value;
    if (entry.valueKind === 'json') {
      try { value = JSON.parse(entry.value); } catch { /* fall through: expose raw string */ }
    }
    return {
      value,
      scope: entry.scope,
      fromStage: entry.fromStage,
      tags: entry.tags || [],
      createdAt: entry.createdAt,
    };
  }

  _evictScratchIfNeeded() {
    const getLru = () => [...this._scratchAccessOrder.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([k]) => k);

    while (this._scratchpad.size > this._scratchMaxEntries) {
      const victim = getLru()[0];
      if (!victim) break;
      this._scratchpad.delete(victim);
      this._scratchAccessOrder.delete(victim);
    }

    while (this._getScratchTotalChars() > this._scratchMaxTotalChars && this._scratchpad.size > 1) {
      const victim = getLru()[0];
      if (!victim) break;
      this._scratchpad.delete(victim);
      this._scratchAccessOrder.delete(victim);
    }
  }

  _getScratchTotalChars() {
    let total = 0;
    for (const [, e] of this._scratchpad) total += (e.value || '').length;
    return total;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  // Scan full document for heading+content pairs; pick most informative paragraphs. see CHANGELOG: Improvement #3, P1-1, P1-2, P0-NEW-1
  static async extractFromFile(filePath, stageName, cheapLlmCall = null) {
    if (!fs.existsSync(filePath)) {
      return { summary: `${stageName} output not found.`, keyDecisions: [], jsonBlock: null };
    }

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return { summary: `Could not read ${stageName} output.`, keyDecisions: [], jsonBlock: null };
    }

    // ── P0-NEW-1 fix: Try structured JSON block first ─────────────────────────
    // Agent output files now embed a JSON metadata block at the top of the file.
    // If present, extract keyDecisions and summary directly from structured data,
    // bypassing the fragile regex-based heuristic extraction below.
    // Falls back to regex extraction if no valid JSON block is found (backward compat).
    const jsonBlock = extractJsonBlock(content);
    if (jsonBlock) {
      const structuredDecisions = extractKeyDecisions(jsonBlock);
      const structuredSummary   = extractSummary(jsonBlock, stageName);
      if (structuredDecisions.length > 0 || structuredSummary !== `${stageName} stage completed.`) {
        console.log(`[StageContextStore] ✅ Structured JSON block found for ${stageName}: ${structuredDecisions.length} decision(s).`);
        return { summary: structuredSummary, keyDecisions: structuredDecisions, jsonBlock };
      }
    }

    // ── LLM-enhanced fallback: semantic extraction via cheap LLM ──────────────
    // When cheapLlmCall is available and JSON block extraction failed, use LLM
    // to extract summary + keyDecisions from the raw Markdown content.
    // This produces ~85% accuracy vs ~40% for the regex heuristic below.
    // Falls back to regex heuristic if LLM fails or is unavailable.
    if (cheapLlmCall) {
      try {
        const truncated = content.slice(0, 4000); // Bound input tokens
        const prompt = [
          `Extract a structured summary from the following ${stageName} stage output.`,
          `Return ONLY a JSON object with exactly these fields:`,
          `  - "summary": A concise 1-2 sentence summary of the stage output (max 500 chars).`,
          `  - "keyDecisions": An array of up to 6 key decisions/choices made (each max 150 chars).`,
          `Focus on: technology choices, architectural patterns, design decisions, trade-offs.`,
          `If the text is in Chinese, extract in Chinese.`,
          `Example: {"summary":"Designed microservice architecture with event-driven communication","keyDecisions":["Use gRPC for inter-service communication","Adopt CQRS pattern for read/write separation"]}`,
          ``,
          `--- ${stageName} OUTPUT ---`,
          truncated,
          `--- END ---`,
        ].join('\n');

        const response = await cheapLlmCall(prompt);
        if (response) {
          const cleaned = String(response).replace(/```json\s*/g, '').replace(/```/g, '').trim();
          const match = cleaned.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            const llmSummary = typeof parsed.summary === 'string' && parsed.summary.length > 10
              ? parsed.summary.slice(0, 500)
              : null;
            const llmDecisions = Array.isArray(parsed.keyDecisions)
              ? parsed.keyDecisions
                  .filter(d => typeof d === 'string' && d.length > 5)
                  .slice(0, 6)
                  .map(d => d.slice(0, 150))
              : [];

            if (llmSummary || llmDecisions.length > 0) {
              console.log(`[StageContextStore] 🤖 LLM extracted ${llmDecisions.length} decision(s) for ${stageName} (regex fallback bypassed).`);
              return {
                summary: llmSummary || `${stageName} stage completed.`,
                keyDecisions: llmDecisions,
                jsonBlock: null,
              };
            }
          }
        }
      } catch (err) {
        console.warn(`[StageContextStore] ⚠️ LLM extraction failed for ${stageName} (falling back to regex): ${err.message}`);
      }
    }

    // ── Fallback: regex-based heuristic extraction (for legacy/plain Markdown files) ──
    // Scan the FULL document (not just first 1200 chars) so decisions buried in
    // the middle or end of long architecture/requirements docs are captured.
    // Priority: headings that contain decision-signal keywords are ranked first.
    //
    // P2-NEW-5 fix: added Chinese keyword variants so that Chinese-language LLM
    // outputs (e.g. "## 技术栈", "## 架构设计", "## 决策") are correctly recognised
    // as decision-signal headings. Previously only English keywords were matched,
    // causing keyDecisions to be empty for Chinese projects, which meant downstream
    // agents saw no key decisions from upstream stages.
    const DECISION_KEYWORDS = /tech|stack|architect|design|decision|approach|pattern|module|component|api|database|framework|language|choice|select|use|adopt|implement|技术栈|架构|设计|决策|模块|组件|框架|语言|数据库|接口|方案|选型|实现|采用/i;

    const keyDecisions = [];
    const allDecisions = []; // { priority: number, text: string }

    // Split on headings (avoids (?![\s\S]) end-of-string anchor issue). see CHANGELOG: P1-2
    const sections = content.split(/(?=^#{2,3}\s)/m).filter(s => s.trim().length > 0);
    for (const section of sections) {
      const firstNewline = section.indexOf('\n');
      if (firstNewline === -1) continue;
      const headingLine = section.slice(0, firstNewline).trim();
      const body = section.slice(firstNewline + 1);

      // Strip the leading ## / ### markers
      const headingMatch = headingLine.match(/^#{2,3}\s+(.+)$/);
      if (!headingMatch) continue;
      const heading = headingMatch[1].trim();

      const bodyText = body
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 10 && !l.startsWith('```') && !l.startsWith('|') && !l.startsWith('#'))
        .slice(0, 2)
        .join(' ');

      if (bodyText.length > 15) {
        const text = `${heading}: ${bodyText.slice(0, 150)}`;
        const priority = DECISION_KEYWORDS.test(heading) ? 0 : 1;
        allDecisions.push({ priority, text });
      } else if (heading.length > 3) {
        const priority = DECISION_KEYWORDS.test(heading) ? 1 : 2;
        allDecisions.push({ priority, text: heading });
      }
    }

    // Sort by priority (decision-signal headings first), then take top 6
    allDecisions.sort((a, b) => a.priority - b.priority);
    for (const d of allDecisions.slice(0, 6)) {
      keyDecisions.push(d.text);
    }

    // ── Summary: find the most informative paragraph in the document ──────────
    // P2-NEW-5: reuse the same bilingual DECISION_KEYWORDS for paragraph scoring
    const paragraphs = content
      .split(/\n{2,}/)
      .map(p => p.replace(/^#+\s+/, '').trim())
      .filter(p => p.length > 40 && !p.startsWith('```') && !p.startsWith('|') && !p.startsWith('-'));

    let bestParagraph = paragraphs[0] || '';
    let bestScore = 0;
    for (const p of paragraphs) {
      const keywordMatches = (p.match(DECISION_KEYWORDS) || []).length;
      const score = Math.min(p.length, 300) + keywordMatches * 20;
      if (score > bestScore) {
        bestScore = score;
        bestParagraph = p;
      }
    }

    const summary = bestParagraph
      ? bestParagraph.slice(0, 500).replace(/\n/g, ' ')
      : `${stageName} stage completed.`;

    return { summary, keyDecisions, jsonBlock: null };
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  /**
   * Sets the current requirement fingerprint so it gets persisted alongside
   * the stage context data. This enables requirement-change detection on the
   * next _load() call — if the fingerprint differs, the context is stale.
   * @param {string} fingerprint - The normalized keyword fingerprint of the current requirement
   */
  setRequirementFingerprint(fingerprint) {
    this._requirementFingerprint = fingerprint || '';
  }

  _persist() {
    // Debounce writes via setImmediate to avoid blocking event loop. see CHANGELOG: P2-3
    if (this._persistPending) return;
    this._persistPending = true;
    setImmediate(() => {
      this._persistPending = false;
      try {
        const data = {};
        for (const [k, v] of this._store) data[k] = v;
        // Include _meta block with requirement fingerprint for requirement-change detection.
        // On next _load(), if the fingerprint doesn't match the current requirement,
        // the stale context is discarded.
        if (this._requirementFingerprint) {
          data._meta = { requirementFingerprint: this._requirementFingerprint };
        }
        // T-1: persist scratchpad alongside stage data under a reserved key.
        if (this._scratchpad.size > 0) {
          const scratchOut = {};
          for (const [k, v] of this._scratchpad) scratchOut[k] = v;
          data._scratchpad = scratchOut;
        }
        const outPath = path.join(this._outputDir, 'stage-context.json');
        // Atomic write: write to .tmp first, then rename over the target.
        // This prevents a corrupt stage-context.json if the process crashes mid-write.
        // Consistent with StateMachine._writeManifest() and ExperienceStore._save().
        const tmpPath = outPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmpPath, outPath);
      } catch { /* non-fatal */ }
    });
  }

  /**
   * Loads persisted stage context from stage-context.json.
   * Called automatically on construction to support workflow resumption:
   * if the workflow crashed mid-CODE stage, the ANALYSE + ARCHITECT contexts
   * are restored so downstream agents still see the full upstream history.
   *
   * Only loads entries that are NOT already in the in-memory store
   * (in-memory always wins over persisted data).
   *
   * P1-4 fix: skip loading if the persisted data is older than MAX_RESUME_AGE_MS
   * (default 24 hours). Stale context from a previous workflow run on the same
   * OUTPUT_DIR would cause the new workflow to see old decisions, leading to
   * inconsistent agent outputs (e.g. architect sees old ANALYSE context).
   *
   * P2-4 fix: if the persisted data is stale (older than MAX_RESUME_AGE_MS),
   * delete the file so it doesn't accumulate across multiple workflow runs.
   * This prevents stage-context.json from growing unboundedly in long-lived
   * OUTPUT_DIR directories.
   */
  _load() {
    // Skip loading if data is older than 24h (stale from previous run); delete stale file. see CHANGELOG: P1-4, P2-4
    const MAX_RESUME_AGE_MS = 24 * 60 * 60 * 1000;

    try {
      const outPath = path.join(this._outputDir, 'stage-context.json');
      if (!fs.existsSync(outPath)) return;
      const raw = fs.readFileSync(outPath, 'utf-8');
      const data = JSON.parse(raw);

      // ── Requirement-change guard ──
      // If the workflow-status.json shows a different requirement fingerprint
      // than what's stored in this stage-context.json, the context is from a
      // previous requirement and MUST NOT be loaded. This prevents a new
      // workflow from inheriting decisions made for a different problem.
      if (data._meta?.requirementFingerprint) {
        const statusPath = path.join(this._outputDir, 'workflow-status.json');
        if (fs.existsSync(statusPath)) {
          try {
            const statusData = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
            const currentFp = statusData?.activeWorkflow?.requirementFingerprint || '';
            if (currentFp && currentFp !== data._meta.requirementFingerprint) {
              if (this._verbose) {
                console.log(`[StageContextStore] 🔄 Requirement changed — skipping stale context (stored fp=${data._meta.requirementFingerprint.slice(0, 40)}, current fp=${currentFp.slice(0, 40)})`);
              }
              try { fs.unlinkSync(outPath); } catch { /* non-fatal */ }
              return;
            }
          } catch { /* non-fatal: status file unreadable, proceed with normal loading */ }
        }
      }

      // P1-4 / P2-4 fix: check the age of the persisted data.
      // Use the most recent timestamp across all stored entries as the "file age".
      // If ALL entries are older than MAX_RESUME_AGE_MS, the file is stale.
      // T-1 fix: scratchpad entries have createdAt (ms) — include them so
      // pure-scratchpad files (no stage summaries yet) aren't incorrectly treated
      // as "infinitely old" and deleted.
      const now = Date.now();
      const timestamps = Object.entries(data)
        .filter(([k]) => k !== '_meta' && k !== '_scratchpad')
        .map(([, entry]) => entry && entry.timestamp ? new Date(entry.timestamp).getTime() : 0)
        .filter(t => t > 0);
      if (data._scratchpad && typeof data._scratchpad === 'object') {
        for (const e of Object.values(data._scratchpad)) {
          if (e && typeof e.createdAt === 'number' && e.createdAt > 0) timestamps.push(e.createdAt);
        }
      }
      const mostRecentTs = timestamps.length > 0 ? Math.max(...timestamps) : 0;
      const ageMs = mostRecentTs > 0 ? now - mostRecentTs : Infinity;

      if (ageMs > MAX_RESUME_AGE_MS) {
        // Stale data: delete the file to prevent unbounded growth (P2-4)
        // and skip loading to prevent cross-run context contamination (P1-4).
        try {
          fs.unlinkSync(outPath);
          if (this._verbose) {
            console.log(`[StageContextStore] Deleted stale stage-context.json (age: ${Math.round(ageMs / 3600000)}h > 24h limit). Starting fresh.`);
          }
        } catch { /* non-fatal – file may have been deleted by another process */ }
        return;
      }

      let loaded = 0;
      for (const [stageName, entry] of Object.entries(data)) {
        if (stageName === '_meta' || stageName === '_scratchpad') continue;
        if (!this._store.has(stageName)) {
          this._store.set(stageName, entry);
          loaded++;
        }
      }
      // T-1: restore scratchpad entries; skip already-expired ones.
      if (data._scratchpad && typeof data._scratchpad === 'object') {
        const now = Date.now();
        for (const [k, e] of Object.entries(data._scratchpad)) {
          if (!e || typeof e !== 'object') continue;
          if (e.expiresAt && now > e.expiresAt) continue;
          if (!this._scratchpad.has(k)) {
            this._scratchpad.set(k, e);
            this._scratchAccessOrder.set(k, now);
          }
        }
      }
      if (loaded > 0 && this._verbose) {
        console.log(`[StageContextStore] Restored ${loaded} stage context(s) from stage-context.json (workflow resumption, age: ${Math.round(ageMs / 60000)}min).`);
      }
    } catch { /* non-fatal – missing or corrupt file is fine */ }
  }
}

module.exports = { StageContextStore, requirementFingerprint };

/**
 * Computes a normalized keyword fingerprint for a requirement text.
 * Two requirements with the same core keywords produce the same fingerprint,
 * even if the phrasing or word order differs.
 * Used by both IDE Bridge and Node Orchestrator for requirement-change detection.
 *
 * @param {string} text - The raw requirement text
 * @returns {string} Sorted unique keyword fingerprint
 */
function requirementFingerprint(text) {
  if (!text || typeof text !== 'string') return '';
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'to', 'of', 'in',
    'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'between', 'out', 'off',
    'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there',
    'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
    'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own',
    'same', 'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and',
    'or', 'if', 'while', 'about', 'up', 'it', 'its', 'i', 'me', 'my',
    'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'de', 'le', 'la', 'les', 'un', 'une', 'des', 'du', 'et',
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都',
    '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会',
    '着', '没有', '看', '好', '自己', '这', '他', '她', '它', '们',
    '把', '被', '让', '给', '对', '而', '但', '如果', '因为', '所以',
    '还', '又', '吗', '吧', '呢', '啊', '嗯', '什么', '怎么', '哪',
    '那个', '这个', '那个', '那些', '这些', '可以', '需要', '应该',
    '已经', '正在', '将', '能', '得', '地', '所', '之', '与', '其',
    '中', '等', '即', '则', '或', '且', '以', '于', '为', '从',
    '及', '该', '此', '某', '每', '各', '任', '何', '多', '少',
  ]);
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  return [...new Set(words)].sort().join(' ');
}

// ─── Module-level helpers (Defect D fix) ──────────────────────────────────────

const { WorkflowState, STATE_ORDER } = require('./types');

/**
 * T-1: derives scratchpad total-char budget from T-0 shared decision signals.
 * Medium tier (default) → 2000 chars; large → 6000 chars; small → 700 chars.
 * Falls back to 2000 if the decision-signals module is unavailable, keeping
 * this helper safe during bootstrap/circular-require edge cases.
 */
function _resolveScratchBudget() {
  try {
    const { getModelCapability } = require('./context-decision-signals');
    const cap = getModelCapability();
    if (cap && typeof cap.maxInject === 'number' && cap.maxInject > 0) {
      return Math.max(700, Math.floor(cap.maxInject / 4));
    }
  } catch { /* decision signals not yet available */ }
  return 2000;
}

/**
 * T-1: safe JSON serialisation that returns null instead of throwing on circular
 * references or non-serialisable values. Keeps setScratch robust against caller bugs.
 */
function _safeJson(value) {
  try {
    const out = JSON.stringify(value);
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Defect D fix: Computes proximity between two stages in the pipeline.
 * Returns a normalised score [0, 1] where 1 = immediate upstream, 0 = distant.
 *
 * P2-a: Uses WorkflowState enum instead of string literals.
 *
 * P1-3 fix: Replaced hardcoded 4-stage ORDER map with STATE_ORDER-based lookup.
 * The original implementation only mapped ANALYSE/ARCHITECT/CODE/TEST, causing
 * PLAN and any custom stages registered via StageRegistry to always receive the
 * fallback 0.3 score — making the relevance algorithm blind to their position.
 *
 * Now uses the canonical STATE_ORDER (which includes PLAN and is extensible via
 * buildStateOrder()) to compute true positional distance.
 *
 * @param {string} sourceStageName  - The upstream stage
 * @param {string} targetStageName  - The current stage
 * @returns {number} 0-1 proximity score
 */
function _stageProximity(sourceStageName, targetStageName) {
  // Exclude INIT and FINISHED — they are bookend states, not real stages
  const srcIdx = STATE_ORDER.indexOf(sourceStageName);
  const tgtIdx = STATE_ORDER.indexOf(targetStageName);

  if (srcIdx === -1 || tgtIdx === -1) return 0.3; // unknown stage → moderate score
  if (srcIdx >= tgtIdx) return 0.1; // downstream or same stage → low score

  const distance = tgtIdx - srcIdx;
  // Immediate upstream (distance=1) → 1.0
  // Two steps back (distance=2) → 0.5
  // Three steps back (distance=3) → 0.33
  return 1.0 / distance;
}

/**
 * Defect D fix: Extracts meaningful keywords from free-text for relevance matching.
 * D4 optimisation: delegates to the shared extractKeywords from experience-store.js
 * which has a more refined stopword list and a technical short-word whitelist
 * (API, JWT, SQL, etc.). This eliminates the duplicate keyword extraction logic
 * that previously existed in both StageContextStore and ExperienceStore.
 *
 * Falls back to a local implementation if experience-store is not available
 * (e.g. in unit tests that only import stage-context-store.js).
 *
 * @param {string} text
 * @returns {string[]} Lowercase keywords
 */
function _extractKeywords(text) {
  try {
    const { extractKeywords } = require('./experience-store');
    return extractKeywords(text, 30);
  } catch {
    // Fallback: local extraction (for isolated testing or circular dependency edge cases)
    return _extractKeywordsFallback(text);
  }
}

/**
 * Fallback keyword extraction used when experience-store is not available.
 * @param {string} text
 * @returns {string[]}
 */
function _extractKeywordsFallback(text) {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must',
    'and', 'or', 'but', 'not', 'no', 'nor', 'so', 'yet', 'for',
    'in', 'on', 'at', 'to', 'of', 'by', 'from', 'with', 'as', 'into',
    'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
    'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any',
    'after', 'before', 'during', 'about', 'above', 'below', 'between',
    'through', 'under', 'over', 'again', 'further', 'then', 'once',
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
    '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 30);
}
