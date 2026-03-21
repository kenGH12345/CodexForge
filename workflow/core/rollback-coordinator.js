'use strict';

const crypto = require('crypto');
const { AgentRole, WorkflowState } = require('./types');

/**
 * RollbackCoordinator – Unified rollback cleanup for all stages.
 *
 * Problem it solves (P0-A / P0-B):
 *   Previously, rollback cleanup was scattered across three separate try-blocks
 *   in orchestrator-stages.js (lines ~250, ~450, ~755). Each block independently
 *   called bus.clearDownstream(), stageCtx.delete(), and cache invalidation.
 *   This made it easy to miss a cleanup step and caused the "fake rollback" bug
 *   where the state machine rolled back but Bus messages and StageContext entries
 *   remained stale.
 *
 * This class centralises ALL rollback side-effects into a single place:
 *   1. stateMachine.rollback()  – update manifest.json
 *   2. bus.clearDownstream()    – invalidate stale Bus queue entries
 *   3. stageCtx.delete()        – invalidate stale cross-stage context
 *   4. cache invalidation       – clear investigation source cache
 *
 * Usage:
 *   const coordinator = new RollbackCoordinator(this);
 *   await coordinator.rollback('ARCHITECT', reason);
 *
 * see CHANGELOG: P0-A, P0-B/stageCtx
 */
class RollbackCoordinator {
  /**
   * @param {object} orchestrator - The Orchestrator instance (provides stateMachine, bus, stageCtx, etc.)
   */
  constructor(orchestrator) {
    this._orch = orchestrator;
    // Defect C fix: subtask result cache for fine-grained rollback.
    // When a stage has multiple subtasks (e.g. ARCHITECT = CoverageCheck + ArchReview),
    // a failure in one subtask shouldn't invalidate the other's cached result.
    // This map stores: stageKey → Map<subtaskName, { result, timestamp }>
    if (!orchestrator._subtaskCache) {
      orchestrator._subtaskCache = new Map();
    }

    // P0-1: Restore persisted subtask cache from manifest.meta on construction.
    // This enables crash recovery: if the process dies after CoverageCheck but
    // before ArchReview, the CoverageCheck result is preserved in manifest.json
    // and restored here, so only ArchReview needs to re-run.
    this._restoreSubtaskCacheFromManifest();
  }

  /**
   * Performs a full coordinated rollback for the given stage.
   *
   * Cleans up in this order:
   *   1. stateMachine.rollback(reason)
   *   2. bus.clearDownstream(senderRole)  – the role whose output is now stale
   *   3. stageCtx.delete(staleStage)      – the stage whose context is now stale
   *   4. cache.delete(keys)               – investigation source cache entries
   *
   * @param {string}   fromStage  - The stage that failed and is rolling back (e.g. 'ARCHITECT')
   * @param {string}   reason     - Human-readable rollback reason (stored in manifest)
   * @returns {Promise<void>}
   */
  async rollback(fromStage, reason) {
    const orch = this._orch;

    // 1. State machine rollback (updates manifest.json)
    await orch.stateMachine.rollback(reason);

    // 2. Bus cleanup: clear messages published by the stage UPSTREAM of fromStage,
    //    because those messages are now stale (the upstream stage will re-run).
    const busSenderRole = ROLLBACK_BUS_SENDER[fromStage];
    if (busSenderRole && orch.bus) {
      const cleared = orch.bus.clearDownstream(busSenderRole);
      if (cleared > 0) {
        console.log(`[RollbackCoordinator] 🧹 Cleared ${cleared} stale Bus message(s) from ${busSenderRole} (${fromStage} rollback)`);
      }
    }

    // 3. StageContext cleanup: delete the stale context entry for fromStage.
    //    The re-run will deposit a fresh entry after it completes.
    if (orch.stageCtx) {
      const deleted = orch.stageCtx.delete(fromStage);
      if (deleted) {
        console.log(`[RollbackCoordinator] 🧹 Deleted stale StageContext entry: ${fromStage}`);
      }
    }

    // 4. Investigation source cache cleanup
    const cacheKeys = ROLLBACK_CACHE_KEYS[fromStage] || [];
    if (orch._investigationSourceCacheMap && cacheKeys.length > 0) {
      for (const key of cacheKeys) {
        orch._investigationSourceCacheMap.delete(key);
      }
      console.log(`[RollbackCoordinator] 🧹 Cleared ${cacheKeys.length} cache key(s) for ${fromStage} rollback`);
    }

    console.log(`[RollbackCoordinator] ⏪ Rollback complete: ${fromStage} → ${ROLLBACK_TARGET[fromStage] || 'previous stage'}`);

    // R5-3 audit: invalidate subtask cache on full-stage rollback.
    // Without this, a subsequent analyseRollbackStrategy() call may return
    // SUBTASK_RETRY using stale cached results from the failed run.
    this.invalidateSubtaskCache(fromStage);
  }

  // ── Defect C fix: Fine-grained subtask-level rollback ───────────────────────

  /**
   * Analyses the failure context and determines if a full-stage rollback is
   * necessary or if only specific subtasks need re-running.
   *
   * The key insight: most stage failures originate from a SINGLE subtask
   * (e.g. ArchReview fails but CoverageCheck succeeded). Re-running the
   * entire upstream stage wastes the successful subtask's LLM call.
   *
   * This method returns a RollbackStrategy that the caller can use to:
   *   - Skip subtasks whose cached results are still valid
   *   - Only re-run the failed subtask(s)
   *   - Fall back to full-stage rollback if the failure is systemic
   *
   * Strategy decision logic:
   *   1. If failedSubtask is specified AND a valid cached result exists for
   *      the OTHER subtasks → SUBTASK_RETRY (only re-run the failed one)
   *   2. If the failure reason contains systemic indicators (timeout, OOM,
   *      "all items failed") → FULL_STAGE_ROLLBACK
   *   3. Default → FULL_STAGE_ROLLBACK (safe fallback)
   *
   * @param {string}   fromStage      - The stage that failed (e.g. 'ARCHITECT')
   * @param {string}   reason         - Human-readable failure reason
   * @param {string}   [failedSubtask]- The specific subtask that failed (e.g. 'ArchReview')
   * @returns {RollbackStrategy}
   */
  analyseRollbackStrategy(fromStage, reason, failedSubtask = null) {
    const orch = this._orch;
    const stageSubtasks = STAGE_SUBTASKS[fromStage];

    // If the stage has no registered subtasks, full rollback is the only option
    if (!stageSubtasks || stageSubtasks.length === 0) {
      return { type: 'FULL_STAGE_ROLLBACK', reason: 'Stage has no subtask decomposition.' };
    }

    // Check for systemic failure indicators that invalidate ALL subtask results
    const SYSTEMIC_PATTERNS = /timeout|ETIMEDOUT|ECONNRESET|OOM|out of memory|all items? failed|rate.?limit|quota/i;
    if (SYSTEMIC_PATTERNS.test(reason)) {
      return { type: 'FULL_STAGE_ROLLBACK', reason: `Systemic failure detected: ${reason.slice(0, 100)}` };
    }

    // If no specific failed subtask is identified, full rollback
    if (!failedSubtask) {
      return { type: 'FULL_STAGE_ROLLBACK', reason: 'No specific failed subtask identified.' };
    }

    // Check if we have cached results for the non-failed subtasks
    const stageCache = orch._subtaskCache.get(fromStage);
    if (!stageCache) {
      return { type: 'FULL_STAGE_ROLLBACK', reason: 'No subtask cache available for this stage.' };
    }

    // Validate that cached results are not stale (max 10 minutes)
    const MAX_CACHE_AGE_MS = 10 * 60 * 1000;
    const now = Date.now();
    const validCached = new Map();
    for (const [name, entry] of stageCache) {
      if (name !== failedSubtask && (now - entry.timestamp) < MAX_CACHE_AGE_MS) {
        validCached.set(name, entry.result);
      }
    }

    // We need at least one valid cached subtask result for partial retry to be useful
    if (validCached.size === 0) {
      return { type: 'FULL_STAGE_ROLLBACK', reason: 'No valid cached subtask results available.' };
    }

    const subtasksToRerun = stageSubtasks.filter(s => s !== failedSubtask || !validCached.has(s));
    console.log(
      `[RollbackCoordinator] 🎯 Subtask analysis for ${fromStage}: ` +
      `rerun=[${subtasksToRerun.join(', ')}], cached=[${[...validCached.keys()].join(', ')}]`
    );

    return {
      type: 'SUBTASK_RETRY',
      failedSubtask,
      subtasksToRerun: subtasksToRerun.filter(s => !validCached.has(s)),
      cachedResults: validCached,
      reason: `Only ${failedSubtask} failed; ${validCached.size} subtask(s) have valid cached results.`,
    };
  }

  /**
   * Caches the result of a successful subtask execution.
   * Called by orchestrator-stages.js after each subtask completes successfully.
   *
   * P0-1: Now also persists to manifest.meta.subtaskCache for crash recovery.
   * Previously, cache was in-memory only and lost on process crash.
   *
   * @param {string} stageName   - e.g. 'ARCHITECT'
   * @param {string} subtaskName - e.g. 'CoverageCheck', 'ArchReview'
   * @param {*}      result      - The subtask's return value
   */
  cacheSubtaskResult(stageName, subtaskName, result) {
    const orch = this._orch;
    if (!orch._subtaskCache.has(stageName)) {
      orch._subtaskCache.set(stageName, new Map());
    }
    orch._subtaskCache.get(stageName).set(subtaskName, {
      result,
      timestamp: Date.now(),
    });

    // P0-1: Persist to manifest.meta.subtaskCache for crash recovery.
    // Uses a serialisable format (plain objects instead of Maps).
    this._persistSubtaskCacheToManifest();
  }

  /**
   * Invalidates all cached subtask results for a stage.
   * Called during full-stage rollback to prevent stale cache usage.
   *
   * @param {string} stageName
   */
  invalidateSubtaskCache(stageName) {
    const orch = this._orch;
    if (orch._subtaskCache.has(stageName)) {
      orch._subtaskCache.delete(stageName);
      console.log(`[RollbackCoordinator] 🧹 Invalidated subtask cache for ${stageName}`);
    }
    // P0-1: Also clear from persistent manifest
    this._persistSubtaskCacheToManifest();
  }

  // ── P0-1: Subtask Cache Persistence (Temporal-inspired) ───────────────────
  // Reference: Temporal.io checkpoints every Activity completion to durable storage.
  // We mirror this by persisting subtask results to manifest.meta.subtaskCache,
  // enabling crash recovery without re-running successful subtasks.

  /**
   * Persists the in-memory subtask cache to manifest.meta.subtaskCache.
   * Called after every cacheSubtaskResult() and invalidateSubtaskCache().
   * @private
   */
  _persistSubtaskCacheToManifest() {
    const orch = this._orch;
    if (!orch.stateMachine || !orch.stateMachine.manifest) return;

    const serialised = {};
    for (const [stageName, subtasks] of orch._subtaskCache) {
      serialised[stageName] = {};
      for (const [subtaskName, entry] of subtasks) {
        // Only persist serialisable results (strings, objects, arrays, numbers).
        // Functions, Buffers, and circular refs are skipped.
        try {
          JSON.stringify(entry.result);
          serialised[stageName][subtaskName] = {
            result: entry.result,
            timestamp: entry.timestamp,
          };
        } catch (_) {
          // Non-serialisable result — keep in-memory only
          console.warn(`[RollbackCoordinator] ⚠️ Subtask result for ${stageName}/${subtaskName} is not serialisable; skipping persistence.`);
        }
      }
    }

    if (!orch.stateMachine.manifest.meta) {
      orch.stateMachine.manifest.meta = {};
    }
    orch.stateMachine.manifest.meta.subtaskCache = serialised;

    // Write manifest to disk (uses atomic write internally)
    try {
      orch.stateMachine._writeManifest();
    } catch (writeErr) {
      console.warn(`[RollbackCoordinator] ⚠️ Failed to persist subtask cache to manifest: ${writeErr.message}`);
    }
  }

  /**
   * Restores the in-memory subtask cache from manifest.meta.subtaskCache.
   * Called during RollbackCoordinator construction (on workflow resume).
   * @private
   */
  _restoreSubtaskCacheFromManifest() {
    const orch = this._orch;
    if (!orch.stateMachine || !orch.stateMachine.manifest) return;

    const persisted = orch.stateMachine.manifest.meta?.subtaskCache;
    if (!persisted || typeof persisted !== 'object') return;

    const MAX_CACHE_AGE_MS = 10 * 60 * 1000; // 10 minutes — same as analyseRollbackStrategy
    const now = Date.now();
    let restoredCount = 0;

    for (const [stageName, subtasks] of Object.entries(persisted)) {
      if (!subtasks || typeof subtasks !== 'object') continue;
      for (const [subtaskName, entry] of Object.entries(subtasks)) {
        if (!entry || !entry.timestamp) continue;
        // Skip stale entries (older than MAX_CACHE_AGE_MS)
        if ((now - entry.timestamp) >= MAX_CACHE_AGE_MS) continue;

        if (!orch._subtaskCache.has(stageName)) {
          orch._subtaskCache.set(stageName, new Map());
        }
        orch._subtaskCache.get(stageName).set(subtaskName, {
          result: entry.result,
          timestamp: entry.timestamp,
        });
        restoredCount++;
      }
    }

    if (restoredCount > 0) {
      console.log(`[RollbackCoordinator] 🔄 Restored ${restoredCount} subtask cache entry(ies) from manifest (crash recovery).`);
    }
  }
}

// ── Configuration tables ──────────────────────────────────────────────────────

/**
 * @typedef {object} RollbackStrategy
 * @property {'FULL_STAGE_ROLLBACK'|'SUBTASK_RETRY'} type - Rollback granularity
 * @property {string}   reason          - Human-readable explanation of the strategy choice
 * @property {string}   [failedSubtask] - Which subtask failed (SUBTASK_RETRY only)
 * @property {string[]} [subtasksToRerun]- Subtasks that need re-running (SUBTASK_RETRY only)
 * @property {Map<string, *>} [cachedResults] - Valid cached results for reuse (SUBTASK_RETRY only)
 */

/**
 * Defect C fix: Maps each stage to its decomposed subtask names.
 * When a stage has multiple independent subtasks, only the failed subtask needs
 * re-running (if a cached result exists for the others).
 *
 * ARCHITECT: CoverageCheck + ArchReview (already run in parallel via runParallel)
 * CODE:      CodeGeneration + CodeReview
 * TEST:      TestCaseGen + TestExecution + TestReportReview
 *
 * ANALYSE is not included because it's a single-subtask stage (RequirementClarifier
 * + AnalystAgent are sequential and tightly coupled – no meaningful partial retry).
 */
const STAGE_SUBTASKS = {
  [WorkflowState.ARCHITECT]: ['CoverageCheck', 'ArchReview'],
  [WorkflowState.CODE]:      ['CodeGeneration', 'CodeReview'],
  [WorkflowState.TEST]:      ['TestCaseGen', 'TestExecution', 'TestReportReview'],
};

/**
 * Maps the failing stage to the Bus sender role whose messages are now stale.
 * When ARCHITECT fails, ANALYST's output is stale (ARCHITECT will re-consume it).
 * When CODE fails, PLANNER's output is stale (DEVELOPER will re-consume it via PLAN→CODE chain).
 * When TEST fails, DEVELOPER's output is stale (TESTER will re-consume it).
 */
const ROLLBACK_BUS_SENDER = {
  [WorkflowState.ARCHITECT]: AgentRole.ANALYST,
  [WorkflowState.CODE]:      AgentRole.PLANNER,
  [WorkflowState.TEST]:      AgentRole.DEVELOPER,
};

/**
 * Maps the failing stage to the human-readable rollback target (for logging).
 */
const ROLLBACK_TARGET = {
  [WorkflowState.ARCHITECT]: WorkflowState.ANALYSE,
  [WorkflowState.CODE]:      WorkflowState.PLAN,
  [WorkflowState.TEST]:      WorkflowState.CODE,
};

/**
 * Maps the failing stage to the investigation source cache keys to invalidate.
 */
const ROLLBACK_CACHE_KEYS = {
  [WorkflowState.ARCHITECT]: ['Architecture', WorkflowState.ARCHITECT],
  [WorkflowState.CODE]:      ['Architecture', 'Plan', 'Code', WorkflowState.ARCHITECT, WorkflowState.PLAN, WorkflowState.CODE],
  [WorkflowState.TEST]:      ['Code', WorkflowState.CODE, 'TestReport'],
};

// ═══════════════════════════════════════════════════════════════════════════════
// P1-1: IdempotencyJournal — Prevent duplicate LLM calls on retry
// ═══════════════════════════════════════════════════════════════════════════════
//
// Reference: Restate's idempotency key pattern — each operation gets a unique
// key derived from its inputs. On retry, if the same key already has a result
// stored, the cached result is returned instead of re-executing the operation.
//
// In our context: when a stage fails mid-way and _runStage() retries, LLM calls
// that already completed successfully can be served from the journal instead of
// making a new (expensive) API call that may return a different result.
//
// Key generation: sha256(stageName + subtaskName + promptHash_first_500_chars)
// Storage: manifest.meta.idempotencyJournal (persisted to disk)

class IdempotencyJournal {
  /**
   * @param {object} orchestrator - The Orchestrator instance
   */
  constructor(orchestrator) {
    this._orch = orchestrator;
    // In-memory journal: Map<idempotencyKey, { result, timestamp, stage, subtask }>
    this._journal = new Map();
    this._restoreFromManifest();
  }

  /**
   * Generates an idempotency key for an LLM operation.
   * @param {string} stage    - Stage name (e.g. 'ARCHITECT')
   * @param {string} subtask  - Subtask name (e.g. 'ArchReview')
   * @param {string} promptFragment - First ~500 chars of the prompt (for uniqueness)
   * @returns {string} SHA-256 hex digest
   */
  static generateKey(stage, subtask, promptFragment = '') {
    const input = `${stage}::${subtask}::${(promptFragment || '').slice(0, 500)}`;
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
  }

  /**
   * Checks if a result already exists for the given idempotency key.
   * @param {string} key - Idempotency key from generateKey()
   * @returns {{ hit: boolean, result?: *, age?: number }}
   */
  lookup(key) {
    const entry = this._journal.get(key);
    if (!entry) return { hit: false };

    // Entries older than 15 minutes are considered stale
    const MAX_AGE_MS = 15 * 60 * 1000;
    const age = Date.now() - entry.timestamp;
    if (age >= MAX_AGE_MS) {
      this._journal.delete(key);
      return { hit: false };
    }

    return { hit: true, result: entry.result, age };
  }

  /**
   * Records a successful operation result for future idempotent retries.
   * @param {string} key     - Idempotency key
   * @param {*}      result  - The operation's return value
   * @param {{ stage?: string, subtask?: string }} [meta] - Optional metadata
   */
  record(key, result, meta = {}) {
    this._journal.set(key, {
      result,
      timestamp: Date.now(),
      stage: meta.stage || '',
      subtask: meta.subtask || '',
    });
    this._persistToManifest();
  }

  /**
   * Invalidates all journal entries for a given stage (on full rollback).
   * @param {string} stage
   */
  invalidateStage(stage) {
    let cleared = 0;
    for (const [key, entry] of this._journal) {
      if (entry.stage === stage) {
        this._journal.delete(key);
        cleared++;
      }
    }
    if (cleared > 0) {
      console.log(`[IdempotencyJournal] 🧹 Invalidated ${cleared} journal entry(ies) for stage ${stage}`);
      this._persistToManifest();
    }
  }

  /** @returns {number} Number of active journal entries */
  get size() { return this._journal.size; }

  /**
   * Persists the journal to manifest.meta.idempotencyJournal.
   * @private
   */
  _persistToManifest() {
    const orch = this._orch;
    if (!orch.stateMachine || !orch.stateMachine.manifest) return;

    const serialised = {};
    for (const [key, entry] of this._journal) {
      try {
        JSON.stringify(entry.result);
        serialised[key] = entry;
      } catch (_) { /* skip non-serialisable */ }
    }

    if (!orch.stateMachine.manifest.meta) orch.stateMachine.manifest.meta = {};
    orch.stateMachine.manifest.meta.idempotencyJournal = serialised;

    try {
      orch.stateMachine._writeManifest();
    } catch (err) {
      console.warn(`[IdempotencyJournal] ⚠️ Failed to persist: ${err.message}`);
    }
  }

  /**
   * Restores journal from manifest.meta.idempotencyJournal on construction.
   * @private
   */
  _restoreFromManifest() {
    const orch = this._orch;
    if (!orch.stateMachine || !orch.stateMachine.manifest) return;

    const persisted = orch.stateMachine.manifest.meta?.idempotencyJournal;
    if (!persisted || typeof persisted !== 'object') return;

    const MAX_AGE_MS = 15 * 60 * 1000;
    const now = Date.now();
    let restoredCount = 0;

    for (const [key, entry] of Object.entries(persisted)) {
      if (!entry || !entry.timestamp) continue;
      if ((now - entry.timestamp) >= MAX_AGE_MS) continue;
      this._journal.set(key, entry);
      restoredCount++;
    }

    if (restoredCount > 0) {
      console.log(`[IdempotencyJournal] 🔄 Restored ${restoredCount} journal entry(ies) from manifest.`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// P1-2: SagaContext — Register-Before-Execute Compensation Pattern
// ═══════════════════════════════════════════════════════════════════════════════
//
// Reference: Temporal Saga pattern — "register compensation BEFORE executing the
// operation, so if the operation fails or the process crashes, the compensation
// is already recorded and can be executed during recovery."
//
// Usage:
//   const saga = new SagaContext('ARCHITECT');
//   saga.addCompensation('publish-artifact', () => bus.clearDownstream('architect'));
//   await bus.publishArtifact('architect', result);
//
//   saga.addCompensation('set-stageCtx', () => stageCtx.delete('ARCHITECT'));
//   stageCtx.set('ARCHITECT', data);
//
//   // On failure:
//   await saga.compensate(); // Executes compensations in LIFO order

class SagaContext {
  /**
   * @param {string} stageName - The stage this saga belongs to (for logging)
   */
  constructor(stageName) {
    this._stage = stageName;
    // Stack of compensations: { label, fn, registeredAt }
    this._compensations = [];
    this._compensated = false;
  }

  /**
   * Registers a compensation function BEFORE executing the associated operation.
   * Compensations are executed in LIFO (reverse) order during compensate().
   *
   * @param {string}   label - Human-readable label (e.g. 'clear-bus-architect')
   * @param {Function} fn    - Compensation function (sync or async). Must be idempotent.
   */
  addCompensation(label, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError(`[SagaContext:${this._stage}] Compensation must be a function, got ${typeof fn}`);
    }
    this._compensations.push({
      label,
      fn,
      registeredAt: Date.now(),
    });
  }

  /**
   * Executes all registered compensations in LIFO (reverse) order.
   * Each compensation is executed independently — a failure in one does not
   * prevent the execution of subsequent compensations.
   *
   * @returns {{ executed: number, failed: number, errors: Array<{ label: string, error: Error }> }}
   */
  async compensate() {
    if (this._compensated) {
      console.warn(`[SagaContext:${this._stage}] ⚠️ compensate() called twice — skipping (idempotent guard).`);
      return { executed: 0, failed: 0, errors: [] };
    }
    this._compensated = true;

    const reversed = [...this._compensations].reverse();
    let executed = 0;
    let failed = 0;
    const errors = [];

    console.log(`[SagaContext:${this._stage}] ⏪ Executing ${reversed.length} compensation(s) in LIFO order...`);

    for (const comp of reversed) {
      try {
        await comp.fn();
        executed++;
        console.log(`[SagaContext:${this._stage}]   ✅ ${comp.label}`);
      } catch (err) {
        failed++;
        errors.push({ label: comp.label, error: err });
        console.error(`[SagaContext:${this._stage}]   ❌ ${comp.label}: ${err.message}`);
        // Continue executing remaining compensations (fault isolation)
      }
    }

    console.log(`[SagaContext:${this._stage}] ⏪ Compensation complete: ${executed} succeeded, ${failed} failed.`);
    return { executed, failed, errors };
  }

  /** @returns {number} Number of registered compensations */
  get size() { return this._compensations.length; }

  /** @returns {boolean} Whether compensate() has been called */
  get isCompensated() { return this._compensated; }

  /** @returns {string[]} Labels of all registered compensations (in registration order) */
  get labels() { return this._compensations.map(c => c.label); }

  /**
   * Resets the saga for reuse (e.g. on retry after partial failure).
   * Clears all compensations and resets the compensated flag.
   */
  reset() {
    this._compensations = [];
    this._compensated = false;
  }
}

module.exports = { RollbackCoordinator, STAGE_SUBTASKS, IdempotencyJournal, SagaContext };
