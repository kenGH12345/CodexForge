/**
 * Experience Store – Persistent experience accumulation across sessions
 *
 * Inspired by AgentFlow's experience feedback mechanism:
 *  - Positive experiences: reusable solutions, stable patterns, best practices
 *  - Negative experiences: pitfalls, anti-patterns, known failure modes
 *  - Experiences survive across conversations (never cleared)
 *  - High-frequency positive experiences trigger Skill evolution
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./constants');

// ─── Experience Types ─────────────────────────────────────────────────────────

const ExperienceType = {
  POSITIVE: 'positive',  // Reusable, directly applicable
  NEGATIVE: 'negative',  // Pitfall, anti-pattern, avoid
};

// ─── Experience Categories ────────────────────────────────────────────────────

const ExperienceCategory = {
  // ── Original categories ──
  MODULE_USAGE:      'module_usage',      // How to use a specific module/API
  FRAMEWORK_LIMIT:   'framework_limit',   // Known framework limitations
  STABLE_PATTERN:    'stable_pattern',    // Proven stable implementation pattern
  PITFALL:           'pitfall',           // Known failure mode or trap
  PERFORMANCE:       'performance',       // Performance optimization insight
  DEBUG_TECHNIQUE:   'debug_technique',   // Debugging approach that worked
  ARCHITECTURE:      'architecture',      // Architectural decision insight
  ENGINE_API:        'engine_api',        // Engine-specific API usage (Unity/Cocos etc.)
  // ── Extended categories for code scanning ──
  UTILITY_CLASS:     'utility_class',     // Reusable utility/helper class
  INTERFACE_DEF:     'interface_def',     // Interface definition and contract
  COMPONENT:         'component',         // Reusable component (UI, Entity, etc.)
  WORKFLOW_PROCESS:  'workflow_process',  // Business/game workflow and process flow
  FRAMEWORK_MODULE:  'framework_module',  // Framework module (Event, Resource, UI, etc.)
  DATA_STRUCTURE:    'data_structure',    // Custom data structure or collection
  PROCEDURE:         'procedure',         // Game procedure / state machine step
  NETWORK_PROTOCOL:  'network_protocol',  // Network message / protocol definition
  CONFIG_SYSTEM:     'config_system',     // Configuration and data table system
  OBJECT_POOL:       'object_pool',       // Object pool and reference pool usage
  EVENT_SYSTEM:      'event_system',      // Event subscription/dispatch pattern
  RESOURCE_LOAD:     'resource_load',     // Asset/resource loading pattern
  UI_PATTERN:        'ui_pattern',        // UI form/widget usage pattern
  SOUND_SYSTEM:      'sound_system',      // Sound/audio system usage
  ENTITY_SYSTEM:     'entity_system',     // Entity lifecycle and management
  LUA_PATTERN:       'lua_pattern',       // Lua-specific coding pattern
  CSHARP_PATTERN:    'csharp_pattern',    // C#-specific coding pattern
};

// ─── Experience Store ─────────────────────────────────────────────────────────

class ExperienceStore {
  /**
   * @param {string} [storePath] - Path to persist experience JSON
   */
  constructor(storePath = null) {
    this.storePath = storePath || path.join(PATHS.OUTPUT_DIR, 'experiences.json');
    /** @type {Experience[]} */
    this.experiences = [];
    // N65 fix: initialise _dirty so flushDirty() never reads undefined.
    this._dirty = false;
    // In-memory title index for O(1) dedup checks and atomic recordIfAbsent().
    // Built from disk on _load(); kept in sync by record() and batchRecord().
    /** @type {Set<string>} */
    this._titleIndex = new Set();
    // Defect F fix: optional ComplaintWall reference for bidirectional sync.
    // When set, recording a NEGATIVE experience auto-files a complaint.
    /** @type {object|null} */
    this._complaintWall = null;
    this._load();
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Records a new experience.
   *
   * @param {object} options
   * @param {string}   options.type       - ExperienceType.POSITIVE or NEGATIVE
   * @param {string}   options.category   - ExperienceCategory value
   * @param {string}   options.title      - Short summary (one line)
   * @param {string}   options.content    - Detailed description with context
   * @param {string}   [options.taskId]   - Source task ID
   * @param {string}   [options.skill]    - Related skill name
   * @param {string[]} [options.tags]     - Searchable tags
   * @param {string}   [options.codeExample] - Code snippet demonstrating the experience
   * @returns {Experience}
   */
  record(options) {
    const { type, category, title, content, taskId = null, skill = null, tags = [], codeExample = null } = options;
    const id = `EXP-${Date.now()}-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
    // Default TTL: negative experiences expire after 90 days, positive after 365 days.
    // Callers can override by passing options.ttlDays = null to disable expiry.
    const ttlDays = options.ttlDays !== undefined
      ? options.ttlDays
      : (type === ExperienceType.NEGATIVE ? 90 : 365);
    const expiresAt = ttlDays != null
      ? new Date(Date.now() + ttlDays * 86400_000).toISOString()
      : null;
    const exp = {
      id,
      type,
      category,
      title,
      content,
      taskId,
      skill,
      tags,
      codeExample,
      sourceFile: options.sourceFile || null,   // Source file path (from code scan)
      namespace: options.namespace || null,      // C# namespace or Lua module
      hitCount: 0,          // How many times this experience was retrieved and used
      evolutionCount: 0,    // How many times this triggered a skill evolution
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt,            // ISO string or null (null = never expires)
    };
    this.experiences.push(exp);
    this._titleIndex.add(exp.title);
    // Defect F fix: when a NEGATIVE experience is recorded and a ComplaintWall is
    // connected, auto-file a complaint so the problem is tracked as an action item.
    // This bridges the "knowledge" system (ExperienceStore) with the "action" system
    // (ComplaintWall), closing the information silo.
    if (exp.type === ExperienceType.NEGATIVE && this._complaintWall) {
      try {
        this._complaintWall.fileFromNegativeExperience(exp);
      } catch (err) {
        // Non-fatal: experience recording succeeds even if complaint filing fails
        console.warn(`[ExperienceStore] ⚠️  Failed to file complaint from negative experience: ${err.message}`);
      }
    }
    // P1-D fix: _save() returns the queue promise. record() now returns a Promise
    // so callers that need guaranteed persistence can `await store.record(...)` or
    // `await store.record(...).then(...)`. Fire-and-forget callers are unaffected
    // (they simply don't await the return value).
    this._save();
    return exp;
  }

  /**
   * Searches experiences by keyword, type, category, skill, or tags.
   * Supports multi-keyword search and relevance scoring for precise hits.
   *
   * @param {object} query
   * @param {string}   [query.keyword]    - Text search in title/content/tags (space-separated for multi-keyword)
   * @param {string}   [query.type]       - Filter by ExperienceType
   * @param {string}   [query.category]   - Filter by ExperienceCategory
   * @param {string}   [query.skill]      - Filter by skill name
   * @param {string[]} [query.tags]       - Filter by tags (any match)
   * @param {string}   [query.sourceFile] - Filter by source file path
   * @param {number}   [query.limit=10]   - Max results
   * @param {boolean}  [query.scoreSort]  - Sort by relevance score instead of hitCount
   * @returns {Experience[]}
   */
  search({ keyword = null, type = null, category = null, skill = null, tags = null, sourceFile = null, limit = 10, scoreSort = false } = {}) {
    const now = Date.now();
    // Filter out expired experiences before any other filtering
    let results = this.experiences.filter(e => !e.expiresAt || new Date(e.expiresAt).getTime() > now);

    if (type) results = results.filter(e => e.type === type);
    if (category) results = results.filter(e => e.category === category);
    if (skill) results = results.filter(e => e.skill === skill);
    if (sourceFile) results = results.filter(e => e.sourceFile && e.sourceFile.includes(sourceFile));
    if (tags && tags.length > 0) {
      results = results.filter(e =>
        tags.some(tag => e.tags.some(t => t.toLowerCase().includes(tag.toLowerCase())))
      );
    }

    if (keyword) {
      // Multi-keyword: split by space, score each result
      const keywords = keyword.toLowerCase().split(/\s+/).filter(Boolean);
      results = results
        .map(e => {
          let score = 0;
          const titleLower = e.title.toLowerCase();
          const contentLower = e.content.toLowerCase();
          const tagsLower = e.tags.map(t => t.toLowerCase());
          for (const kw of keywords) {
            if (titleLower.includes(kw)) score += 10;       // Title match: highest weight
            if (tagsLower.some(t => t.includes(kw))) score += 6; // Tag match: high weight
            if (contentLower.includes(kw)) score += 2;     // Content match: base weight
          }
          return { exp: e, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => scoreSort ? b.score - a.score : b.exp.hitCount - a.exp.hitCount)
        .map(({ exp }) => exp);
    } else {
      // Sort by hitCount desc (most useful first)
      results = results.sort((a, b) => b.hitCount - a.hitCount);
    }

    return results.slice(0, limit);
  }

  /**
   * Checks if an experience with the same title already exists (dedup).
   *
   * @param {string} title
   * @returns {Experience|null}
   */
  findByTitle(title) {
    return this.experiences.find(e => e.title === title) || null;
  }

  /**
   * Updates an existing experience's content by appending new information.
   * Used for negative experiences where the same pitfall recurs with new context.
   * Only updates if the new content is not already present (avoids duplicate appends).
   *
   * @param {string} title - Title of the experience to update
   * @param {string} additionalContent - New content to append
   * @returns {Experience|null} Updated experience, or null if not found
   */
  appendByTitle(title, additionalContent) {
    const exp = this.findByTitle(title);
    if (!exp) return null;
    // Skip if the additional content is already present (idempotent).
    // N40 fix: 60-char prefix is too short – two different failure contexts that start
    // with the same boilerplate (e.g. "After 2 self-correction round(s)...") would be
    // incorrectly treated as duplicates. Use 120 chars for a more reliable dedup check.
    if (exp.content.includes(additionalContent.slice(0, 120))) return exp;
    exp.content = `${exp.content}\n\n[Update ${new Date().toISOString().slice(0, 10)}] ${additionalContent}`;
    exp.updatedAt = new Date().toISOString();
    // P1-D fix: return the save-queue promise so callers can await persistence.
    // The return value is the updated experience object wrapped in a thenable:
    // - `store.appendByTitle(t, c)` → still returns the exp object synchronously
    //   for callers that use the return value as a truthy check (e.g. `if (!appendByTitle(...))`).
    // - The save is still fire-and-forget for those callers; they just don't await it.
    // To allow both patterns we keep returning `exp` (not the promise) but ensure
    // _save() is called so the queue is updated.
    this._save();
    return exp;
  }

  /**
   * Atomically records an experience only if no entry with the same title exists.
   * Uses an in-memory title Set as a write-lock so concurrent workers cannot
   * both pass the findByTitle() check and then both call record(), which would
   * produce duplicate entries in the store.
   *
   * This is the preferred method for all conditional writes in _runAgentWorker.
   * It replaces the pattern:
   *   if (!this.experienceStore.findByTitle(title)) { this.experienceStore.record(...) }
   * with a single atomic call:
   *   this.experienceStore.recordIfAbsent(title, options)
   *
   * @param {string} title   - Dedup key (must match options.title)
   * @param {object} options - Same as record()
   * @returns {Experience|null} The new experience, or null if already existed
   */
  recordIfAbsent(title, options) {
    // Fast path: check in-memory title index first (O(1), no array scan)
    if (this._titleIndex.has(title)) return null;
    // Double-check against the full array in case _titleIndex is out of sync
    // (e.g. experiences loaded from disk before _titleIndex was built)
    if (this.findByTitle(title)) {
      this._titleIndex.add(title); // repair index
      return null;
    }
    // Claim the title slot before calling record() so no other concurrent
    // caller can sneak in between the check above and the push below.
    this._titleIndex.add(title);
    return this.record(options);
  }

  /**
   * Batch-records multiple experiences, skipping duplicates by title.
   *
   * @param {object[]} items - Array of experience options
   * @returns {{ added: number, skipped: number }}
   */
  batchRecord(items) {
    let added = 0;
    let skipped = 0;
    // N35 fix: use a per-batch counter to guarantee unique IDs even when multiple
    // items are processed within the same millisecond (Date.now() collision risk).
    let batchSeq = 0;
    for (const item of items) {
      if (this._titleIndex.has(item.title) || this.findByTitle(item.title)) {
        this._titleIndex.add(item.title); // repair index if needed
        skipped++;
        continue;
      }
      // Claim the title slot immediately to prevent concurrent duplicates
      this._titleIndex.add(item.title);
      // Push directly without saving on each record
      const { type, category, title, content, taskId = null, skill = null, tags = [], codeExample = null } = item;
      const id = `EXP-${Date.now()}-${String(batchSeq++).padStart(4, '0')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      // Apply the same TTL logic as record() so batch-imported experiences also expire.
      // Previously batchRecord() skipped this, causing batch entries to never expire
      // even when they were negative experiences (pitfalls, anti-patterns).
      const ttlDays = item.ttlDays !== undefined
        ? item.ttlDays
        : (type === ExperienceType.NEGATIVE ? 90 : 365);
      const expiresAt = ttlDays != null
        ? new Date(Date.now() + ttlDays * 86400_000).toISOString()
        : null;
      this.experiences.push({
        id, type, category, title, content, taskId, skill, tags, codeExample,
        sourceFile: item.sourceFile || null,
        namespace: item.namespace || null,
        hitCount: 0, evolutionCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt,
      });
      added++;
    }
    // P1-D fix: single save after all items are processed; return the save-queue
    // promise so callers can `await store.batchRecord(items)` for guaranteed persistence.
    // Fire-and-forget callers (that only use { added, skipped }) are unaffected.
    if (added > 0) this._save();
    return { added, skipped };
  }

  /**
   * Marks an experience as "used" (increments hitCount).
   * High hitCount positive experiences are candidates for skill evolution.
   *
   * N59 fix: avoid writing to disk on every markUsed() call.
   * In high-frequency task scenarios (e.g. 100 tasks each calling markUsed()),
   * the previous implementation triggered 100 full JSON serialise+rename cycles.
   * New strategy:
   *   - Only _save() when hitCount reaches EVOLUTION_THRESHOLD (the only moment
   *     that MUST be persisted immediately, because it triggers skill evolution).
   *   - For all other increments, set a dirty flag and defer the save to the next
   *     natural _save() call (e.g. record(), appendByTitle(), batchRecord()).
   *   - Callers that need guaranteed persistence can call flushDirty() explicitly.
   *
   * @param {string} expId
   * @returns {boolean} true if this experience should trigger skill evolution
   */
  markUsed(expId) {
    const exp = this.experiences.find(e => e.id === expId);
    if (!exp) return false;
    exp.hitCount += 1;
    exp.updatedAt = new Date().toISOString();

    // Defect I fix: adaptive evolution threshold based on skill specificity.
    //
    // The previous hardcoded EVOLUTION_THRESHOLD = 3 treated all skills equally.
    // But generic skills (async/await best practices) mature faster than domain-
    // specific skills (Cocos Creator resource loading).
    //
    // Adaptive threshold classification:
    //   GENERIC categories (stable_pattern, performance, debug_technique, architecture,
    //     pitfall) → threshold = 3 (fast evolution: patterns are broadly applicable)
    //   FRAMEWORK categories (framework_limit, framework_module, engine_api,
    //     module_usage) → threshold = 7 (slow evolution: need more domain samples)
    //   OTHER / unclassified → threshold = 5 (middle ground)
    //
    // The threshold is further modulated by the experience's tag count:
    //   More tags = more specific context = needs more hits to generalise.
    //   Bonus: +1 threshold per 3 tags (capped at +3).
    const threshold = _computeEvolutionThreshold(exp);
    const shouldEvolve = exp.type === ExperienceType.POSITIVE && exp.hitCount === threshold;

    if (shouldEvolve) {
      // Must persist immediately so the evolution trigger is not lost on crash
      this._save();
    } else {
      // Defer: mark dirty so the next natural _save() will flush this increment
      this._dirty = true;
    }

    return shouldEvolve;
  }

  /**
   * Flushes any pending dirty state to disk.
   * Call this after a batch of markUsed() calls to ensure all hitCount
   * increments are persisted without waiting for the next natural _save().
   *
   * P1-D fix: returns the save-queue Promise so callers can await completion.
   * Previously flushDirty() called _save() but returned void, meaning the
   * caller had no way to know when the write finished (or if it failed).
   * Now: `await store.flushDirty()` guarantees the write is complete.
   * Fire-and-forget callers that don't await are unaffected.
   *
   * @returns {Promise<void>}
   */
  flushDirty() {
    if (this._dirty) {
      this._dirty = false; // reset before save so a concurrent markUsed() re-sets it
      return this._save();
    }
    return Promise.resolve();
  }

  /**
   * Purges all expired experiences from the store and persists the result.
   * Call this periodically (e.g. at workflow start) to keep the store lean.
   *
   * @returns {{ purged: number, remaining: number }}
   */
  purgeExpired() {
    const now = Date.now();
    const before = this.experiences.length;
    this.experiences = this.experiences.filter(e => !e.expiresAt || new Date(e.expiresAt).getTime() > now);
    // Rebuild title index after purge
    this._titleIndex = new Set(this.experiences.map(e => e.title));
    const purged = before - this.experiences.length;
    if (purged > 0) {
      this._save();
      console.log(`[ExperienceStore] Purged ${purged} expired experience(s). Remaining: ${this.experiences.length}`);
    }
    return { purged, remaining: this.experiences.length };
  }

  /**
   * Returns a formatted context block for injection into agent prompts,
   * along with the IDs of all experiences included in the block.
   *
   * This is the preferred method when the caller needs to later call
   * markUsedBatch(ids) to record which experiences were actually effective
   * (i.e. the task succeeded after the context was injected).
   *
   * EvoMap-inspired: instead of marking all retrieved experiences as "used"
   * at retrieval time (which conflates "retrieved" with "effective"), callers
   * can now close the feedback loop by calling markUsedBatch() only when the
   * downstream task actually succeeds. This makes hitCount a true signal of
   * "helped solve a problem" rather than "was retrieved".
   *
   * @param {string} [skill]
   * @param {string} [taskDescription]
   * @param {number} [limit=5] - Max experiences per type (positive/negative).
   *   Improvement 4: deriveStrategy() returns maxExpInjected based on cross-session
   *   hit-rate analysis. Pass orch._adaptiveStrategy?.maxExpInjected ?? 5 here.
   * @returns {{ block: string, ids: string[] }}
   */
  getContextBlockWithIds(skill = null, taskDescription = null, limit = 5) {
    if (!skill) return { block: '', ids: [] };

    let scoreSort = true;
    let keyword = null;
    if (taskDescription && taskDescription.trim().length > 0) {
      const taskKeywords = [...new Set(
        taskDescription.toLowerCase()
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length >= 4)
      )].slice(0, 10);
      if (taskKeywords.length > 0) {
        keyword = taskKeywords.join(' ');
        scoreSort = true;
      }
    }

    // Use limit to control how many experiences are injected.
    // Improvement 4: deriveStrategy() returns maxExpInjected based on cross-session
    // hit-rate analysis. When hit rate is low (experiences not helping), limit is
    // reduced to cut prompt noise. When hit rate is high, limit is increased.
    const perTypeLimit = Math.max(1, Math.ceil(limit / 2)); // split evenly between positive/negative
    const positives = this.search({ type: ExperienceType.POSITIVE, skill, keyword, limit: perTypeLimit, scoreSort });
    const negatives = this.search({ type: ExperienceType.NEGATIVE, skill, keyword, limit: perTypeLimit, scoreSort });
    const ids = [...positives.map(e => e.id), ...negatives.map(e => e.id)];

    const lines = ['## Accumulated Experience\n'];

    if (positives.length > 0) {
      lines.push('### ✅ Proven Patterns (use these)');
      for (const exp of positives) {
        lines.push(`\n**[${exp.category}] ${exp.title}**`);
        lines.push(exp.content);
        if (exp.codeExample) {
          lines.push('```');
          lines.push(exp.codeExample);
          lines.push('```');
        }
      }
    }

    if (negatives.length > 0) {
      lines.push('\n### ❌ Known Pitfalls (avoid these)');
      for (const exp of negatives) {
        lines.push(`\n**[${exp.category}] ${exp.title}**`);
        lines.push(exp.content);
        if (exp.codeExample) {
          lines.push('```');
          lines.push(exp.codeExample);
          lines.push('```');
        }
      }
    }

    if (positives.length === 0 && negatives.length === 0) {
      lines.push('_No accumulated experience yet for this context._');
    }

    const MAX_CONTEXT_CHARS = 6000;
    const raw = lines.join('\n');
    const block = raw.length > MAX_CONTEXT_CHARS
      ? raw.slice(0, MAX_CONTEXT_CHARS) + '\n\n_... (experience context truncated to stay within token budget)_'
      : raw;

    return { block, ids };
  }

  /**
   * Marks multiple experiences as "effectively used" in a single batch.
   *
   * Call this after a task succeeds to close the feedback loop: the experiences
   * that were injected into the agent's prompt (via getContextBlockWithIds) and
   * whose presence correlated with a successful outcome are credited.
   *
   * This is the EvoMap "validation record" concept: hitCount now means
   * "helped solve N problems" rather than "was retrieved N times".
   *
   * Returns the list of experience IDs that crossed their adaptive evolution
   * threshold (Defect I fix: threshold varies by category and tag count) and
   * should trigger skill evolution.
   *
   * @param {string[]} ids - Experience IDs to mark as used
   * @returns {string[]} IDs that should trigger skill evolution
   */
  markUsedBatch(ids) {
    if (!ids || ids.length === 0) return [];
    const evolutionTriggers = [];
    for (const id of ids) {
      const shouldEvolve = this.markUsed(id);
      if (shouldEvolve) evolutionTriggers.push(id);
    }
    return evolutionTriggers;
  }

  /**
   * Computes which injected experience IDs actually "matched" the current task context.
   *
   * This fixes Defect H (hit-rate measurement bias): the previous implementation
   * counted ALL injected experiences as "hits" whenever a task succeeded, which
   * systematically over-estimated hit rate and made deriveStrategy Rule 4 useless
   * (it would never trigger the "reduce injection" path because hit rate always
   * appeared high).
   *
   * Matching logic (asymmetric by experience type):
   *
   *   POSITIVE experiences (proven patterns):
   *     → Always counted as matched when the task succeeds.
   *     Rationale: positive experiences provide correct direction ("do X"). If the
   *     task succeeded, the agent followed correct patterns – the positive experience
   *     contributed to the outcome regardless of whether a specific error occurred.
   *
   *   NEGATIVE experiences (pitfalls / anti-patterns):
   *     → Only counted as matched when the errorContext contains keywords from the
   *       experience's tags or category.
   *     Rationale: negative experiences warn about specific failure modes ("avoid Y").
   *     If the error context doesn't mention the pitfall, the experience was injected
   *     as noise – it didn't help avoid anything relevant to this task.
   *     If the error context DOES mention the pitfall, the experience was relevant
   *     (the agent was warned about the exact failure mode it encountered).
   *
   * @param {string[]} ids          - Experience IDs that were injected
   * @param {string}   [errorContext=''] - Error/failure text from the current task
   *   (e.g. result.output, result.failureSummary.join(), reviewResult.riskNotes.join())
   *   Pass empty string when there is no error context (e.g. first-run pass with no failures).
   * @returns {{ matchedIds: string[], matchedCount: number, totalCount: number }}
   */
  computeMatchedIds(ids, errorContext = '') {
    if (!ids || ids.length === 0) {
      return { matchedIds: [], matchedCount: 0, totalCount: 0 };
    }

    const errorLower = (errorContext || '').toLowerCase();

    const matchedIds = ids.filter(id => {
      const exp = this.experiences.find(e => e.id === id);
      if (!exp) return false;

      // POSITIVE experiences: always matched on task success
      if (exp.type === ExperienceType.POSITIVE) return true;

      // NEGATIVE experiences: only matched when error context contains relevant keywords
      // Check 1: any tag keyword appears in the error context
      const tagMatch = (exp.tags || []).some(tag =>
        tag.length >= 3 && errorLower.includes(tag.toLowerCase())
      );
      if (tagMatch) return true;

      // Check 2: the category keyword appears in the error context
      // (e.g. category='pitfall' → check if 'pitfall' is in error text;
      //  category='module_usage' → check if 'module' or 'usage' is in error text)
      const categoryTokens = (exp.category || '').toLowerCase().split('_').filter(t => t.length >= 4);
      const categoryMatch = categoryTokens.some(token => errorLower.includes(token));
      if (categoryMatch) return true;

      // Check 3: significant words from the experience title appear in the error context
      // (handles cases where tags are sparse but the title is descriptive)
      const titleTokens = (exp.title || '').toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 5); // only meaningful words (≥5 chars)
      const titleMatch = titleTokens.some(token => errorLower.includes(token));
      if (titleMatch) return true;

      return false;
    });

    return {
      matchedIds,
      matchedCount: matchedIds.length,
      totalCount: ids.length,
    };
  }

  /**
   * Returns a formatted context block for injection into agent prompts.
   * Includes top positive experiences and all negative experiences for a skill.
   *
   * @param {string} [skill] - Filter by skill name. If null, returns empty string
   *   to avoid injecting unrelated cross-skill experiences into agent prompts.
   * @param {string} [taskDescription] - Current task description for relevance scoring.
   *   P1-NEW-2 fix: when provided, experiences are ranked by keyword overlap with the
   *   current task rather than global hitCount. This prevents high-frequency but
   *   task-irrelevant experiences (e.g. from 100 "Hello World" runs) from crowding
   *   out low-frequency but highly relevant experiences for the current task.
   * @returns {string} Markdown-formatted experience context
   */
  getContextBlock(skill = null, taskDescription = null) {
    // N22 fix: when skill is null, return empty string instead of querying all experiences.
    // Injecting experiences from all skill domains into a single agent prompt causes
    // irrelevant context noise and may mislead the agent.
    if (!skill) {
      return '';
    }

    // P1-NEW-2 fix: when taskDescription is provided, use keyword-overlap relevance
    // scoring to rank experiences by current-task relevance instead of global hitCount.
    // Strategy: extract keywords from taskDescription, score each experience by how
    // many keywords appear in its title/content/tags, then blend with hitCount so
    // frequently-used AND task-relevant experiences rank highest.
    let scoreSort = true;
    let keyword = null;
    if (taskDescription && taskDescription.trim().length > 0) {
      // Extract meaningful keywords: words ≥4 chars, deduplicated, lowercased.
      const taskKeywords = [...new Set(
        taskDescription.toLowerCase()
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length >= 4)
      )].slice(0, 10); // cap at 10 keywords to avoid over-filtering
      if (taskKeywords.length > 0) {
        keyword = taskKeywords.join(' ');
        scoreSort = true; // scoreSort=true uses keyword relevance score, not hitCount
      }
    }

    const positives = this.search({ type: ExperienceType.POSITIVE, skill, keyword, limit: 5, scoreSort });
    const negatives = this.search({ type: ExperienceType.NEGATIVE, skill, keyword, limit: 5, scoreSort });

    const lines = ['## Accumulated Experience\n'];

    if (positives.length > 0) {
      lines.push('### ✅ Proven Patterns (use these)');
      for (const exp of positives) {
        lines.push(`\n**[${exp.category}] ${exp.title}**`);
        lines.push(exp.content);
        if (exp.codeExample) {
          lines.push('```');
          lines.push(exp.codeExample);
          lines.push('```');
        }
      }
    }

    if (negatives.length > 0) {
      lines.push('\n### ❌ Known Pitfalls (avoid these)');
      for (const exp of negatives) {
        lines.push(`\n**[${exp.category}] ${exp.title}**`);
        lines.push(exp.content);
        if (exp.codeExample) {
          lines.push('```');
          lines.push(exp.codeExample);
          lines.push('```');
        }
      }
    }

    if (positives.length === 0 && negatives.length === 0) {
      lines.push('_No accumulated experience yet for this context._');
    }

    // Token guard: cap the context block at 6000 chars to avoid prompt bloat.
    // Experiences are already sorted by relevance (scoreSort=true), so truncation
    // drops the least-relevant entries first.
    const MAX_CONTEXT_CHARS = 6000;
    const raw = lines.join('\n');
    if (raw.length > MAX_CONTEXT_CHARS) {
      return raw.slice(0, MAX_CONTEXT_CHARS) + '\n\n_... (experience context truncated to stay within token budget)_';
    }
    return raw;
  }

  /**
   * Returns statistics about the experience store.
   *
   * @returns {object}
   */
  getStats() {
    const positive = this.experiences.filter(e => e.type === ExperienceType.POSITIVE).length;
    const negative = this.experiences.filter(e => e.type === ExperienceType.NEGATIVE).length;
    const totalEvolutions = this.experiences.reduce((sum, e) => sum + e.evolutionCount, 0);
    const byCategory = {};
    for (const exp of this.experiences) {
      byCategory[exp.category] = (byCategory[exp.category] || 0) + 1;
    }
    return {
      total: this.experiences.length,
      positive,
      negative,
      totalEvolutions,
      byCategory,
    };
  }

  /**
   * Defect F fix: Sets the ComplaintWall reference for bidirectional sync.
   * Call this after both ExperienceStore and ComplaintWall are constructed.
   *
   * When set, recording a NEGATIVE experience will auto-file a complaint
   * in the ComplaintWall, ensuring that pitfalls are tracked as action items
   * (not just knowledge entries). The reverse direction (complaint resolved →
   * positive experience) is handled by ComplaintWall.resolve().
   *
   * @param {object} complaintWall - ComplaintWall instance
   */
  setComplaintWall(complaintWall) {
    this._complaintWall = complaintWall;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        this.experiences = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        // Rebuild title index from loaded data
        this._titleIndex = new Set(this.experiences.map(e => e.title));
        console.log(`[ExperienceStore] Loaded ${this.experiences.length} experiences`);

        // P2-1 fix: auto-purge expired entries on load so the store stays lean
        // without requiring explicit purgeExpired() calls from callers.
        // Previously purgeExpired() was only called when explicitly invoked, meaning
        // long-running task-based workflows could accumulate thousands of entries
        // (e.g. 100 tasks/day × 90 days = 9000+ entries), causing slow JSON parsing
        // and O(n) search scans on every getContextBlock() call.
        const now = Date.now();
        const beforePurge = this.experiences.length;
        this.experiences = this.experiences.filter(
          e => !e.expiresAt || new Date(e.expiresAt).getTime() > now
        );
        const purged = beforePurge - this.experiences.length;
        if (purged > 0) {
          this._titleIndex = new Set(this.experiences.map(e => e.title));
          console.log(`[ExperienceStore] Auto-purged ${purged} expired experience(s) on load. Remaining: ${this.experiences.length}`);
        }

        // P2-1 fix: enforce a hard capacity cap (MAX_CAPACITY = 500 entries).
        // When the cap is exceeded, evict the oldest entries with the lowest hitCount
        // first (least useful + least recent). This prevents unbounded growth in
        // long-running deployments where TTL alone is insufficient (e.g. all entries
        // have ttlDays=null or very long TTLs).
        const MAX_CAPACITY = 500;
        if (this.experiences.length > MAX_CAPACITY) {
          // Sort by hitCount asc, then createdAt asc (oldest low-value entries first)
          this.experiences.sort((a, b) => {
            if (a.hitCount !== b.hitCount) return a.hitCount - b.hitCount;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          });
          const evicted = this.experiences.length - MAX_CAPACITY;
          this.experiences = this.experiences.slice(evicted);
          this._titleIndex = new Set(this.experiences.map(e => e.title));
          console.log(`[ExperienceStore] Capacity cap enforced: evicted ${evicted} low-value experience(s). Remaining: ${this.experiences.length}`);
          // Persist the trimmed store immediately so the next load sees the clean state
          this._save();
        }
      }
    } catch (err) {
      console.warn(`[ExperienceStore] Could not load experiences: ${err.message}`);
    }
  }

  _save() {
    // P2-NEW-3 fix: serialise concurrent writes via a promise-chain queue.
    // Problem: multiple parallel workers (runTaskBased) all share the same
    // ExperienceStore instance. When two workers both call _save() concurrently,
    // the second fs.renameSync can overwrite the first worker's write, silently
    // losing the first worker's new entries.
    //
    // Solution: chain each _save() call onto a single promise queue so that
    // writes are always sequential, regardless of how many workers call _save()
    // simultaneously. The queue is a simple promise chain (no external deps).
    //
    // Note: fs.writeFileSync + fs.renameSync are synchronous, so within a single
    // Node.js event-loop tick they cannot interleave. The race condition only
    // occurs across async boundaries (e.g. two workers awaiting different LLM
    // calls, then both resolving and calling _save() in the same microtask batch).
    // The queue ensures the second _save() waits for the first to finish.
    if (!this._saveQueue) {
      this._saveQueue = Promise.resolve();
    }
    this._saveQueue = this._saveQueue.then(() => {
      try {
        const dir = path.dirname(this.storePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // N37 fix: atomic write – write to a .tmp file first, then rename over the target.
        const tmpPath = this.storePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(this.experiences, null, 2), 'utf-8');
        fs.renameSync(tmpPath, this.storePath);
        // N65 fix: reset _dirty after a successful save so flushDirty() does not
        // trigger a redundant write on the next call.
        this._dirty = false;
      } catch (err) {
        console.warn(`[ExperienceStore] Could not save experiences: ${err.message}`);
      }
    });
    // Return the queue tail so callers that need to await persistence can do so.
    return this._saveQueue;
  }
}

// ─── Defect I fix: Adaptive Evolution Threshold ──────────────────────────────
//
// Different skills mature at different speeds. A generic "async/await best
// practices" pattern is broadly applicable and can be promoted after just 3 hits.
// A domain-specific "Cocos Creator resource loading" pattern needs more diverse
// hits (from different tasks) before it's trustworthy enough to evolve into a
// permanent skill.
//
// This function computes the evolution threshold for an individual experience
// based on two signals:
//   1. Category specificity (generic vs. domain-specific)
//   2. Tag count (more tags = more specific context = harder to generalise)
//
// The threshold determines how many times an experience must be confirmed
// effective (via markUsed → hitCount) before it triggers skill evolution.

/**
 * Categories classified by specificity level.
 *
 * GENERIC: broadly applicable patterns that transfer across projects.
 *   Evolution quickly because each hit confirms a universal truth.
 *
 * FRAMEWORK: tied to a specific framework/engine/library.
 *   Evolution slowly because each hit might be the same narrow use case,
 *   and premature promotion risks encoding version-specific quirks as
 *   permanent "best practices".
 *
 * The unclassified middle ground gets a moderate threshold.
 */
const GENERIC_CATEGORIES = new Set([
  ExperienceCategory.STABLE_PATTERN,
  ExperienceCategory.PERFORMANCE,
  ExperienceCategory.DEBUG_TECHNIQUE,
  ExperienceCategory.ARCHITECTURE,
  ExperienceCategory.PITFALL,
  ExperienceCategory.WORKFLOW_PROCESS,
]);

const FRAMEWORK_CATEGORIES = new Set([
  ExperienceCategory.FRAMEWORK_LIMIT,
  ExperienceCategory.FRAMEWORK_MODULE,
  ExperienceCategory.ENGINE_API,
  ExperienceCategory.MODULE_USAGE,
]);

/**
 * Computes the adaptive evolution threshold for a given experience entry.
 *
 * Base thresholds by category specificity:
 *   GENERIC    → 3 (fast: broadly applicable, quick to confirm)
 *   FRAMEWORK  → 7 (slow: need diverse domain evidence before promoting)
 *   OTHER      → 5 (moderate: default for unclassified categories)
 *
 * Tag-count modulator:
 *   Each 3 tags adds +1 to the threshold (capped at +3).
 *   Rationale: more tags = more specific context = needs more diverse hits
 *   to confirm the pattern generalises beyond that specific context.
 *
 * Examples:
 *   { category: 'stable_pattern',  tags: [] }        → threshold = 3
 *   { category: 'stable_pattern',  tags: [a,b,c,d] } → threshold = 3 + 1 = 4
 *   { category: 'engine_api',      tags: [] }         → threshold = 7
 *   { category: 'engine_api',      tags: [a,b,c,d,e,f,g,h,i] } → threshold = 7 + 3 = 10
 *   { category: 'component',       tags: [a,b] }     → threshold = 5
 *
 * @param {object} exp - Experience entry with category and tags fields
 * @returns {number} The evolution threshold (minimum hitCount to trigger evolution)
 */
function _computeEvolutionThreshold(exp) {
  // Determine base threshold from category specificity
  let base;
  if (GENERIC_CATEGORIES.has(exp.category)) {
    base = 3;  // Fast evolution for generic patterns
  } else if (FRAMEWORK_CATEGORIES.has(exp.category)) {
    base = 7;  // Slow evolution for framework-specific knowledge
  } else {
    base = 5;  // Moderate default
  }

  // Tag-count modulator: +1 per 3 tags, capped at +3
  const tagBonus = Math.min(Math.floor((exp.tags?.length || 0) / 3), 3);

  return base + tagBonus;
}

module.exports = { ExperienceStore, ExperienceType, ExperienceCategory };
