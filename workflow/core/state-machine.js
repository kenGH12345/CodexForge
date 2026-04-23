/**
 * Central state machine for the multi-agent workflow.
 *
 * Responsibilities:
 *  - Drive state transitions: INIT → ANALYSE → ARCHITECT → CODE → TEST → FINISHED
 *  - Persist every transition to manifest.json (checkpoint / resume)
 *  - Emit hook events at key lifecycle points
 *  - Enforce sequential state ordering
 *  - Protect manifest.json with optimistic locking (FileLockManager)
 *  - Prevent concurrent transitions via async mutex
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { WorkflowState, STATE_ORDER, createManifest, createHistoryEntry } = require('./types');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { fileLockManager } = require('./file-lock-manager');
const { migrateManifest, CURRENT_VERSION } = require('./manifest-migration');
const { FileStateStore } = require('./runtime/file-state-store');
const { SESSION_STATUS, STAGE_STATUS } = require('./runtime/types');

class StateMachine {
  /**
   * @param {string} projectId - Unique identifier for this workflow run
   * @param {Function} hookEmitter - async (event: string, payload: object) => void
   * @param {object} [opts]
   * @param {string[]} [opts.stateOrder] - P1-b: Custom state order. Defaults to the
   *   built-in STATE_ORDER (INIT → ANALYSE → ARCHITECT → CODE → TEST → FINISHED).
   *   When custom stages are registered via StageRegistry, pass
   *   buildStateOrder(stageRegistry.getOrder()) to include them in transition validation.
   */
  constructor(projectId, hookEmitter = async () => {}, opts = {}) {
    this.projectId = projectId;
    this.hookEmitter = hookEmitter;
    this.manifest = null;
    this._stateOrder = opts.stateOrder || STATE_ORDER;
    this._manifestPath = opts.manifestPath || PATHS.MANIFEST;

    this._transitionLock = null;
    this._lockWaitQueue = [];

    this._useRuntimeState = opts.useRuntimeState !== false;
    this._stateManager = opts.stateManager || null;
    this._sessionId = null;

    if (this._useRuntimeState && !this._stateManager) {
      this._stateManager = this._createDefaultStateManager();
      if (!this._stateManager) {
        this._useRuntimeState = false;
      }
    }
  }

  _createDefaultStateManager() {
    try {
      const runtimeDir = path.join(path.dirname(this._manifestPath), 'runtime');
      return new FileStateStore({ runtimeDir });
    } catch (err) {
      console.error(`[StateMachine] ⚠️ Failed to create FileStateStore, falling back to manifest: ${err.message}`);
      return null;
    }
  }

  // ─── Initialisation  }

  // ─── Initialisation ──────────────────────────────────────────────────────────

  /**
   * Initialise the state machine.
   * If manifest.json already exists, resumes from the last recorded state.
   * Otherwise creates a fresh manifest and starts from INIT.
   */
  async init() {
    if (this._useRuntimeState && this._stateManager) {
      try {
        const result = await this._initWithStateManager();
        return result;
      } catch (err) {
        console.error(`[StateMachine] ⚠️ StateManager init failed, falling back to manifest: ${err.message}`);
        this._useRuntimeState = false;
        this._stateManager = null;
      }
    }
    return this._initWithManifest();
  }

  async _initWithManifest() {
    if (fs.existsSync(this._manifestPath)) {
      this.manifest = this._readManifest();
      const restoredState = this.manifest.currentState;
      if (!restoredState || !this._stateOrder.includes(restoredState)) {
        console.warn(`[StateMachine] ⚠️  Invalid currentState "${restoredState}" in manifest. Resetting to ${WorkflowState.INIT}.`);
        this.manifest.currentState = WorkflowState.INIT;
        this._writeManifest();
      } else if (restoredState === WorkflowState.FINISHED) {
        console.log(`[StateMachine] Previous run completed (FINISHED). Resetting to ${WorkflowState.INIT} for new run.`);
        this.manifest = createManifest(this.projectId);
        this._writeManifest();
      } else {
        console.log(`[StateMachine] Resuming from state: ${this.manifest.currentState}`);
      }
    } else {
      this.manifest = createManifest(this.projectId);
      this._writeManifest();
      console.log(`[StateMachine] New workflow started. State: ${WorkflowState.INIT}`);
    }
    return this.manifest.currentState;
  }

  async _initWithStateManager() {
    let session = this._stateManager.loadSession(this.projectId);
    if (!session) {
      session = this._stateManager.createSession({
        requirement: '',
        requirementFingerprint: '',
        mode: 'orchestrator',
        initialStage: WorkflowState.INIT,
      });
      this._sessionId = session.sessionId;
      try {
        this._stateManager.beginStage({ sessionId: this._sessionId, stage: WorkflowState.INIT });
      } catch (err) {
        console.error(`[StateMachine] ⚠️ StateManager beginStage(INIT) error: ${err.message}`);
      }
      this.manifest = this._sessionToManifest(session);
      this._writeManifest();
      console.log(`[StateMachine] New workflow started via StateManager. State: ${WorkflowState.INIT}`);
    } else {
      this._sessionId = session.sessionId;
      const restoredState = session.currentStage;
      if (!restoredState || !this._stateOrder.includes(restoredState)) {
        console.warn(`[StateMachine] ⚠️  Invalid currentStage "${restoredState}" in session. Resetting to ${WorkflowState.INIT}.`);
        session.currentStage = WorkflowState.INIT;
        session.status = SESSION_STATUS.CREATED;
        this._stateManager.saveSession(session);
      } else if (restoredState === WorkflowState.FINISHED) {
        console.log(`[StateMachine] Previous run completed (FINISHED). Resetting to ${WorkflowState.INIT} for new run.`);
        session = this._stateManager.createSession({
          requirement: '',
          requirementFingerprint: '',
          mode: 'orchestrator',
          initialStage: WorkflowState.INIT,
        });
        this._sessionId = session.sessionId;
        try {
          this._stateManager.beginStage({ sessionId: this._sessionId, stage: WorkflowState.INIT });
        } catch (err) {
          console.error(`[StateMachine] ⚠️ StateManager beginStage(INIT) error on reset: ${err.message}`);
        }
      } else {
        console.log(`[StateMachine] Resuming from state: ${session.currentStage}`);
      }
      this.manifest = this._sessionToManifest(session);
      this._writeManifest();
    }
    return this.manifest.currentState;
  }

  // ─── State Queries ────────────────────────────────────────────────────────────

  /** Returns the current workflow state string */
  getState() {
    return this.manifest ? this.manifest.currentState : null;
  }

  /** Returns true if the workflow has completed all stages */
  isFinished() {
    return this.getState() === WorkflowState.FINISHED;
  }

  /**
   * Returns the next state after the current one, or null if already FINISHED.
   */
  getNextState() {
    const idx = this._stateOrder.indexOf(this.getState());
    if (idx === -1 || idx === this._stateOrder.length - 1) return null;
    return this._stateOrder[idx + 1];
  }

  /**
   * Returns the previous state before the current one, or null if already at INIT.
   */
  getPreviousState() {
    const idx = this._stateOrder.indexOf(this.getState());
    if (idx <= 0) return null;
    return this._stateOrder[idx - 1];
  }
  // ─── Transition ───────────────────────────────────────────────────────────────

  /**
   * Advances the state machine to the next state.
   *
   * @param {string|null} artifactPath - File path produced during the current stage
   * @param {string} [note]            - Optional human-readable note
   * @returns {string} The new current state
   * @throws {Error} If already in FINISHED state or transition is invalid
   */
  async transition(artifactPath = null, note = '') {
    await this._acquireTransitionLock('transition');
    try {
      return await this._transitionInner(artifactPath, note);
    } finally {
      this._releaseTransitionLock();
    }
  }

  /**
   * P1-1 fix: Lock-free inner implementation of transition().
   * Called by transition() (which holds the lock) and by transitionConditional()
   * (which also holds the lock). This avoids deadlocking on the non-reentrant mutex.
   *
   * @param {string|null} artifactPath
   * @param {string} note
   * @returns {Promise<string>} The new current state
   */
  async _transitionInner(artifactPath = null, note = '') {
    const fromState = this.getState();
    const toState = this.getNextState();

    if (!toState) {
      throw new Error(`[StateMachine] Cannot transition: already in terminal state "${fromState}"`);
    }

    const preconditionError = this._validatePrecondition(fromState, toState, artifactPath);
    if (preconditionError) {
      throw new Error(`[StateMachine] Precondition failed for ${fromState} → ${toState}: ${preconditionError}`);
    }

    await this.hookEmitter(HOOK_EVENTS.BEFORE_STATE_TRANSITION, { fromState, toState, artifactPath });

    if (this._useRuntimeState && this._stateManager && this._sessionId) {
      try {
        if (fromState) {
          this._stateManager.completeStage({ sessionId: this._sessionId, stage: fromState, outputRefs: artifactPath ? [{ path: artifactPath }] : [] });
        }
        this._stateManager.beginStage({ sessionId: this._sessionId, stage: toState });
      } catch (err) {
        console.error(`[StateMachine] ⚠️ StateManager stage lifecycle error: ${err.message}`);
      }
    }

    const entry = createHistoryEntry(fromState, toState, artifactPath, note);
    this.manifest.history.push(entry);
    this.manifest.currentState = toState;
    this.manifest.updatedAt = new Date().toISOString();

    if (artifactPath) {
      this._recordArtifact(toState, artifactPath);
    }

    this._writeManifest();

    console.log(`[StateMachine] Transition: ${fromState} → ${toState}${artifactPath ? ` (artifact: ${artifactPath})` : ''}`);

    await this.hookEmitter(HOOK_EVENTS.AFTER_STATE_TRANSITION, { fromState, toState, artifactPath, manifest: this.manifest });

    if (toState === WorkflowState.FINISHED) {
      await this.hookEmitter(HOOK_EVENTS.WORKFLOW_COMPLETE, { manifest: this.manifest });
    }

    return toState;
  }

  /**
   * Rolls back the state machine to the previous state.
   * Useful when a downstream stage discovers a fundamental issue that requires
   * re-running an earlier stage (e.g. architecture review fails → re-analyse).
   *
   * @param {string} [reason] - Human-readable reason for rollback
   * @returns {string} The state rolled back to
   * @throws {Error} If already at INIT state (cannot roll back further)
   */
  async rollback(reason = '') {
    await this._acquireTransitionLock('rollback');
    try {
      const fromState = this.getState();
      const toState = this.getPreviousState();

      if (!toState) {
        throw new Error(`[StateMachine] Cannot rollback: already at initial state "${fromState}"`);
      }

      console.warn(`[StateMachine] ⏪ Rollback: ${fromState} → ${toState}${reason ? ` (reason: ${reason})` : ''}`);

      await this.hookEmitter(HOOK_EVENTS.BEFORE_STATE_TRANSITION, { fromState, toState, rollback: true, reason });

      if (this._useRuntimeState && this._stateManager && this._sessionId) {
        try {
          this._stateManager.markRollback({ sessionId: this._sessionId, stage: fromState, rollbackInfo: { reason, fromState, toState } });
        } catch (err) {
          console.error(`[StateMachine] ⚠️ StateManager markRollback error: ${err.message}`);
        }
      }

      const entry = createHistoryEntry(fromState, toState, null, `[ROLLBACK] ${reason}`);
      this.manifest.history.push(entry);
      this.manifest.currentState = toState;
      this.manifest.updatedAt = new Date().toISOString();
      this.manifest.lastRollback = { fromState, toState, reason, timestamp: new Date().toISOString() };

      this._writeManifest();

      await this.hookEmitter(HOOK_EVENTS.AFTER_STATE_TRANSITION, { fromState, toState, rollback: true, manifest: this.manifest });

      return toState;
    } finally {
      this._releaseTransitionLock();
    }
  }

  /**
   * Jumps directly to a specific target state (forward or backward).
   * Use with caution – skipping stages may leave artifacts in an inconsistent state.
   *
   * @param {string} targetState - The WorkflowState to jump to
   * @param {string} [reason]    - Human-readable reason for the jump
   * @returns {string} The new current state
   * @throws {Error} If targetState is not a valid WorkflowState
   */
  async jumpTo(targetState, reason = '') {
    await this._acquireTransitionLock('jumpTo');
    try {
      return await this._jumpToInner(targetState, reason);
    } finally {
      this._releaseTransitionLock();
    }
  }

  /**
   * P1-1 fix: Lock-free inner implementation of jumpTo().
   * Called by jumpTo() (which holds the lock) and by transitionConditional()
   * (which also holds the lock). This avoids deadlocking on the non-reentrant mutex.
   *
   * @param {string} targetState
   * @param {string} reason
   * @returns {Promise<string>} The new current state
   */
  async _jumpToInner(targetState, reason = '') {
    if (!this._stateOrder.includes(targetState)) {
      throw new Error(`[StateMachine] Invalid target state: "${targetState}". Valid states: ${this._stateOrder.join(', ')}`);
    }

    const fromState = this.getState();
    if (fromState === targetState) {
      console.warn(`[StateMachine] jumpTo: already in state "${targetState}". No-op.`);
      return targetState;
    }

    const direction = this._stateOrder.indexOf(targetState) < this._stateOrder.indexOf(fromState) ? '⏪' : '⏩';
    console.warn(`[StateMachine] ${direction} Jump: ${fromState} → ${targetState}${reason ? ` (reason: ${reason})` : ''}`);

    await this.hookEmitter(HOOK_EVENTS.BEFORE_STATE_TRANSITION, { fromState, toState: targetState, jump: true, reason });

    if (this._useRuntimeState && this._stateManager && this._sessionId) {
      try {
        if (fromState && fromState !== WorkflowState.INIT) {
          this._stateManager.failStage({ sessionId: this._sessionId, stage: fromState, error: { name: 'JumpAbandon', message: `Jumped to ${targetState}: ${reason}` } });
        }
        this._stateManager.beginStage({ sessionId: this._sessionId, stage: targetState });
      } catch (err) {
        console.error(`[StateMachine] ⚠️ StateManager jump lifecycle error: ${err.message}`);
      }
    }

    const entry = createHistoryEntry(fromState, targetState, null, `[JUMP] ${reason}`);
    this.manifest.history.push(entry);
    this.manifest.currentState = targetState;
    this.manifest.updatedAt = new Date().toISOString();

    this._writeManifest();

    await this.hookEmitter(HOOK_EVENTS.AFTER_STATE_TRANSITION, { fromState, toState: targetState, jump: true, manifest: this.manifest });

    return targetState;
  }

  // ─── Parallel Sub-task Execution ─────────────────────────────────────────────

  /**
   * Defect B fix: Runs multiple independent sub-tasks in parallel within the
   * current state, without changing the linear state transition structure.
   *
   * Motivation: The current state machine is a strict serial pipeline
   * (INIT → ANALYSE → ARCHITECT → CODE → TEST → FINISHED). In practice, several
   * sub-tasks within a single stage are independent and can run concurrently:
   *
   *   ARCHITECT stage:
   *     CoverageChecker.check()  ──┐
   *                                ├── both read the same file, no data dependency
   *     ArchitectureReviewAgent  ──┘
   *
   *   CODE stage:
   *     TestCaseGenerator        ──┐
   *                                ├── both read the same artifact, no data dependency
   *     CodeReviewAgent          ──┘
   *
   * This method runs all tasks concurrently via Promise.allSettled(), collects
   * results, and returns them in the same order as the input tasks array.
   * It does NOT advance the state machine – state transitions remain the caller's
   * responsibility. This preserves the linear state invariant while eliminating
   * unnecessary serial wait time.
   *
   * Error handling: uses Promise.allSettled() (not Promise.all()) so a single
   * task failure does not cancel sibling tasks. Each result has:
   *   { status: 'fulfilled', value: T }  – task succeeded
   *   { status: 'rejected',  reason: E } – task failed; sibling results still available
   *
   * Usage example:
   *   const [coverageResult, archReviewResult] = await this.stateMachine.runParallel([
   *     { name: 'CoverageCheck', fn: () => coverageChecker.check(outputPath, requirementPath) },
   *     { name: 'ArchReview',    fn: () => archReviewer.review(outputPath, requirementPath) },
   *   ]);
   *   // coverageResult.status === 'fulfilled' → coverageResult.value
   *   // archReviewResult.status === 'rejected' → archReviewResult.reason
   *
   * @param {{ name: string, fn: () => Promise<any> }[]} tasks
   *   Array of named async tasks to run in parallel.
   *   - `name`: human-readable label for logging and error attribution
   *   - `fn`:   zero-argument async function returning the task result
   * @returns {Promise<PromiseSettledResult<any>[]>}
   *   Resolves when ALL tasks complete (fulfilled or rejected).
   *   Results are in the same order as the input tasks array.
   */
  async runParallel(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) return [];

    const state = this.getState();
    const names = tasks.map(t => t.name).join(', ');
    console.log(`[StateMachine] ⚡ Parallel execution in state ${state}: [${names}]`);

    const startMs = Date.now();
    const results = await Promise.allSettled(tasks.map(t => t.fn()));
    const elapsedMs = Date.now() - startMs;

    // Log outcome summary
    const summary = results.map((r, i) => {
      const label = tasks[i].name;
      return r.status === 'fulfilled'
        ? `✅ ${label}`
        : `❌ ${label} (${r.reason?.message ?? r.reason})`;
    }).join(', ');
    console.log(`[StateMachine] ⚡ Parallel complete in ${elapsedMs}ms: ${summary}`);

    return results;
  }

  /**
   * Convenience wrapper: runs tasks in parallel and throws if ANY task failed.
   * Use this when all tasks are required and a single failure should abort the stage.
   *
   * @param {{ name: string, fn: () => Promise<any> }[]} tasks
   * @returns {Promise<any[]>} Resolved values in input order
   * @throws {AggregateError} if one or more tasks failed
   */
  async runParallelStrict(tasks) {
    const results = await this.runParallel(tasks);
    const failures = results
      .map((r, i) => ({ ...r, name: tasks[i].name }))
      .filter(r => r.status === 'rejected');

    if (failures.length > 0) {
      const msgs = failures.map(f => `[${f.name}] ${f.reason?.message ?? f.reason}`).join('; ');
      throw new Error(`[StateMachine] runParallelStrict: ${failures.length} task(s) failed – ${msgs}`);
    }

    return results.map(r => r.value);
  }



  /**
   * Appends a risk entry to the manifest.
   *
   * @param {string} level   - 'low' | 'medium' | 'high'
   * @param {string} message - Human-readable risk description
   * @param {boolean} [flush=true] - Whether to write manifest to disk immediately.
   *   Pass false when recording multiple risks in a batch; call flushRisks() after.
   */
  recordRisk(level, message, flush = true) {
    this.manifest.risks.push({ severity: level, description: message, timestamp: new Date().toISOString() });
    // N61 fix: avoid a disk write on every recordRisk() call.
    // _runArchitect() may call recordRisk() many times in a row (once per riskNote
    // from coverage + arch review). Each call previously triggered a full atomic
    // write (serialize + rename). With flush=false, callers can batch multiple risks
    // and call flushRisks() once at the end for a single write.
    if (flush) this._writeManifest();
  }

  /**
   * Flushes any pending risk entries to disk.
   * Call this after a batch of recordRisk(level, msg, false) calls.
   */
  flushRisks() {
    this._writeManifest();
  }

  /**
   * Returns all recorded risks from the manifest.
   *
   * @returns {{ severity: string, description: string, timestamp: string }[]}
   */
  getRisks() {
    return this.manifest ? (this.manifest.risks || []) : [];
  }

  /**
   * P1-b: Updates the state order at runtime. Used when custom stages are registered
   * after construction (via Orchestrator.registerStage()).
   *
   * @param {string[]} newStateOrder - Full state order including INIT and FINISHED
   */
  setStateOrder(newStateOrder) {
    this._stateOrder = newStateOrder;
  }

  /**
   * P1-b: Returns the current state order.
   *
   * @returns {string[]}
   */
  getStateOrder() {
    return [...this._stateOrder];
  }

  // ─── Conditional Transitions (P2-D) ────────────────────────────────────────

  /**
   * P2-D: Registers a conditional transition rule for a given state.
   *
   * Inspired by LangGraph's `add_conditional_edges()`, this makes branching
   * logic visible at the state machine level instead of being scattered in
   * stage-*.js files as ad-hoc if/else logic.
   *
   * When `transitionConditional()` is called from a state that has registered
   * conditions, the condition function is evaluated and the state machine
   * transitions to the corresponding target state.
   *
   * @param {string} fromState - The state where the condition is evaluated
   * @param {object} rule
   * @param {string}   rule.name       - Human-readable rule name for logging
   * @param {Function} rule.condition   - (manifest, context) => string — returns a key from `targets`
   * @param {Object<string, string>} rule.targets - Map of condition result → target state
   *
   * @example
   *   stateMachine.addConditionalTransition('ARCHITECT', {
   *     name: 'ArchReviewResult',
   *     condition: (manifest, ctx) => ctx.archReviewPassed ? 'pass' : 'fail',
   *     targets: { pass: 'PLAN', fail: 'ANALYSE' },
   *   });
   */
  addConditionalTransition(fromState, rule) {
    if (!this._stateOrder.includes(fromState)) {
      throw new Error(`[StateMachine] addConditionalTransition: invalid fromState "${fromState}". Valid: ${this._stateOrder.join(', ')}`);
    }
    if (!rule || typeof rule.condition !== 'function' || !rule.targets) {
      throw new Error(`[StateMachine] addConditionalTransition: rule must have { name, condition: fn, targets: {} }`);
    }
    // Validate all target states
    for (const [key, target] of Object.entries(rule.targets)) {
      if (!this._stateOrder.includes(target)) {
        throw new Error(`[StateMachine] addConditionalTransition: target "${target}" for key "${key}" is not a valid state`);
      }
    }

    if (!this._conditionalRules) this._conditionalRules = new Map();
    if (!this._conditionalRules.has(fromState)) {
      this._conditionalRules.set(fromState, []);
    }
    this._conditionalRules.get(fromState).push(rule);
    console.log(`[StateMachine] 🔀 Registered conditional transition: ${fromState} → [${Object.entries(rule.targets).map(([k,v]) => `${k}:${v}`).join(', ')}] (rule: ${rule.name})`);
  }

  /**
   * P2-D: Evaluates conditional rules for the current state and transitions
   * to the determined target state.
   *
   * If no conditional rules are registered for the current state, falls back
   * to the standard `transition()` (next sequential state).
   *
   * @param {object} context - Arbitrary context passed to the condition function
   * @param {string|null} [artifactPath] - Artifact produced during current stage
   * @param {string} [note] - Optional note
   * @returns {string} The new current state
   */
  /**
   * P1-1 fix: transitionConditional now acquires the transition lock BEFORE
   * evaluating conditions, preventing two concurrent callers from both reading
   * the same fromState and triggering duplicate transitions.
   *
   * The lock is acquired once at the top and released in `finally`. Internal
   * transition/jump operations use _transitionInner/_jumpToInner (lock-free)
   * to avoid deadlocking on the non-reentrant mutex.
   */
  async transitionConditional(context = {}, artifactPath = null, note = '') {
    await this._acquireTransitionLock('transitionConditional');
    try {
      const fromState = this.getState();
      const rules = this._conditionalRules?.get(fromState);

      if (!rules || rules.length === 0) {
        // No conditional rules — use standard sequential transition (lock-free inner)
        return this._transitionInner(artifactPath, note);
      }

      // Evaluate rules in registration order; first match wins
      for (const rule of rules) {
        try {
          const result = rule.condition(this.manifest, context);
          if (result !== undefined && result !== null && rule.targets[result]) {
            const targetState = rule.targets[result];
            const isForward = this._stateOrder.indexOf(targetState) > this._stateOrder.indexOf(fromState);
            const condNote = `[CONDITIONAL:${rule.name}=${result}] ${note}`.trim();

            console.log(`[StateMachine] 🔀 Conditional transition: ${fromState} → ${targetState} (rule: ${rule.name}, result: ${result})`);

            if (isForward && targetState === this.getNextState()) {
              return this._transitionInner(artifactPath, condNote);
            } else {
              return this._jumpToInner(targetState, condNote);
            }
          }
        } catch (err) {
          console.warn(`[StateMachine] ⚠️  Conditional rule "${rule.name}" threw: ${err.message}. Trying next rule.`);
        }
      }

      // No rule matched — fall back to sequential transition
      console.log(`[StateMachine] 🔀 No conditional rule matched for ${fromState}. Falling back to sequential transition.`);
      return this._transitionInner(artifactPath, note);
    } finally {
      this._releaseTransitionLock();
    }
  }

  /**
   * P2-D: Returns all registered conditional transition rules.
   * Useful for visualization and debugging.
   *
   * @returns {Map<string, Array<{name: string, targets: Object}>>}
   */
  getConditionalRules() {
    return this._conditionalRules || new Map();
  }

  /**
   * P2-D: Checks if the current state has conditional rules registered.
   *
   * @returns {boolean}
   */
  hasConditionalTransition() {
    const rules = this._conditionalRules?.get(this.getState());
    return !!(rules && rules.length > 0);
  }

  // ─── Artifact Helpers ─────────────────────────────────────────────────────────

  /** Returns the artifacts map from the current manifest */
  getArtifacts() {
    return this.manifest ? this.manifest.artifacts : {};
  }

  // ─── Transition Mutex ─────────────────────────────────────────────────────────

  /**
   * Acquires the transition lock. If another transition is in progress, waits
   * for it to complete before proceeding. This prevents interleaved async
   * operations from corrupting the manifest state.
   *
   * P0-1 fix: Replaced busy-wait setTimeout(5ms) polling with a FIFO queue.
   * Old implementation had three problems:
   *   1. Non-atomic check-then-set: two callers could both pass the while-check
   *      and both set themselves as lock holder → concurrent manifest corruption.
   *   2. CPU-burning 5ms polling loop wasting cycles.
   *   3. No FIFO fairness guarantee.
   *
   * New implementation: if the lock is held, the caller's resolve callback is
   * enqueued. _releaseTransitionLock() dequeues the next waiter atomically
   * (synchronous shift + set), ensuring exactly one caller proceeds at a time.
   *
   * @param {string} caller - Name of the calling method (for diagnostics)
   */
  async _acquireTransitionLock(caller) {
    if (!this._transitionLock) {
      // Lock is free — acquire immediately (synchronous, no race window)
      this._transitionLock = caller;
      return;
    }
    // Lock is held — enqueue and wait
    console.warn(`[StateMachine] ⏳ ${caller}() waiting for in-flight ${this._transitionLock} to complete...`);
    await new Promise(resolve => {
      this._lockWaitQueue.push({ caller, resolve });
    });
    // When we reach here, _releaseTransitionLock() has already set
    // this._transitionLock = caller for us.
  }

  /**
   * Releases the transition lock.
   *
   * P0-1 fix: If waiters are queued, atomically hands the lock to the next
   * waiter (FIFO order) and resolves its promise. This is a synchronous
   * operation — no race window between release and next acquire.
   */
  _releaseTransitionLock() {
    if (this._lockWaitQueue.length > 0) {
      // Hand lock directly to the next waiter (atomic: shift + set + resolve)
      const next = this._lockWaitQueue.shift();
      this._transitionLock = next.caller;
      next.resolve();
    } else {
      this._transitionLock = null;
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * P1 fix: Validates preconditions before state transition.
   * Ensures required artifacts exist before advancing to the next stage.
   *
   * @param {string} fromState - Current state
   * @param {string} toState - Target state
   * @param {string|null} artifactPath - Artifact being recorded
   * @returns {string|null} Error message if precondition fails, null if OK
   */
  _validatePrecondition(fromState, toState, artifactPath) {
    // Define precondition rules for each transition
    const PRECONDITIONS = {
      [WorkflowState.ANALYSE]: {
        // INIT → ANALYSE: no precondition (first stage)
      },
      [WorkflowState.ARCHITECT]: {
        // ANALYSE → ARCHITECT: requirement.md should exist
        artifactKey: 'requirementMd',
        description: 'requirement.md from ANALYSE stage',
      },
      [WorkflowState.CODE]: {
        // ARCHITECT → CODE: architecture.md should exist
        artifactKey: 'architectureMd',
        description: 'architecture.md from ARCHITECT stage',
      },
      [WorkflowState.TEST]: {
        // CODE → TEST: code.diff should exist
        artifactKey: 'codeDiff',
        description: 'code.diff from CODE stage',
      },
      [WorkflowState.FINISHED]: {
        // TEST → FINISHED: test-report.md should exist
        artifactKey: 'testReportMd',
        description: 'test-report.md from TEST stage',
      },
    };

    const precondition = PRECONDITIONS[toState];
    if (!precondition || !precondition.artifactKey) {
      // No precondition for this transition
      return null;
    }

    // Check if the required artifact exists in manifest
    const artifacts = this.getArtifacts();
    const requiredArtifact = artifacts[precondition.artifactKey];

    if (!requiredArtifact) {
      // Artifact not recorded in manifest - check if current transition provides it
      if (artifactPath && fromState === this._getArtifactSourceState(precondition.artifactKey)) {
        // Current transition is providing the artifact, allow it
        return null;
      }
      return `Missing ${precondition.description}. Run the ${fromState} stage first.`;
    }

    // Check if the artifact file actually exists on disk
    if (!fs.existsSync(requiredArtifact)) {
      return `${precondition.description} was recorded but file not found: ${requiredArtifact}`;
    }

    return null;
  }

  /**
   * Maps artifact key to its source state.
   * @param {string} artifactKey
   * @returns {string|null}
   */
  _getArtifactSourceState(artifactKey) {
    const mapping = {
      requirementMd: WorkflowState.ANALYSE,
      architectureMd: WorkflowState.ARCHITECT,
      codeDiff: WorkflowState.CODE,
      testReportMd: WorkflowState.TEST,
    };
    return mapping[artifactKey] || null;
  }

  _readManifest() {
    const raw = fs.readFileSync(this._manifestPath, 'utf-8');
    let manifest = JSON.parse(raw);
    // P0 fix: Acquire optimistic lock version stamp on manifest read.
    // This enables verifyVersion() in _writeManifest() to detect if another
    // process or instance modified the file between our read and write.
    fileLockManager.acquireVersion(this._manifestPath, raw, `sm-${this.projectId}`);

    // P1-5 fix: Auto-migrate manifest if schema version is outdated.
    const manifestVersion = manifest.version || '1.0.0';
    if (manifestVersion !== CURRENT_VERSION) {
      const result = migrateManifest(manifest, {
        manifestPath: this._manifestPath,
        backup: true,
      });
      if (result.migrated) {
        manifest = result.manifest;
        console.log(`[StateMachine] 📦 Manifest migrated: ${result.fromVersion} → ${result.toVersion} (${result.appliedMigrations.join(', ')})`);
      }
    }

    return manifest;
  }

  _writeManifest() {
    const dir = path.dirname(this._manifestPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(this._manifestPath)) {
      const currentContent = fs.readFileSync(this._manifestPath, 'utf-8');
      const lockCheck = fileLockManager.verifyVersion(
        this._manifestPath, currentContent, `sm-${this.projectId}`
      );
      if (!lockCheck.valid) {
        console.warn(`[StateMachine] ⚠️ Manifest conflict detected: ${lockCheck.reason}. Proceeding with write (last-writer-wins).`);
      }
    }

    const newContent = JSON.stringify(this.manifest, null, 2);
    const tmpPath = this._manifestPath + '.tmp';
    fs.writeFileSync(tmpPath, newContent, 'utf-8');
    fs.renameSync(tmpPath, this._manifestPath);

    fileLockManager.releaseVersion(this._manifestPath, newContent, `sm-${this.projectId}`);

    if (this._useRuntimeState && this._stateManager && this._sessionId) {
      this._syncManifestToStateManager();
    }
  }

  /**
   * Maps a workflow state to its corresponding artifact key and stores the path.
   *
   * @param {string} state
   * @param {string} artifactPath
   */
  _recordArtifact(state, artifactPath) {
    const stateToKey = {
      [WorkflowState.ANALYSE]: 'requirementMd',
      [WorkflowState.ARCHITECT]: 'architectureMd',
      [WorkflowState.CODE]: 'codeDiff',
      [WorkflowState.TEST]: 'testReportMd',
    };
    const key = stateToKey[state];
    if (key) {
      this.manifest.artifacts[key] = artifactPath;
    }
  }

  _sessionToManifest(session) {
    const artifacts = {};
    if (session.stages) {
      for (const [stage, run] of Object.entries(session.stages)) {
        const key = { ANALYSE: 'requirementMd', ARCHITECT: 'architectureMd', CODE: 'codeDiff', TEST: 'testReportMd' }[stage];
        if (key && run.outputRefs && run.outputRefs.length > 0) {
          artifacts[key] = run.outputRefs[0].path || run.outputRefs[0];
        }
      }
    }
    const history = [];
    if (session.stages) {
      for (const [stage, run] of Object.entries(session.stages)) {
        if (run.startedAt) {
          history.push({ fromState: null, toState: stage, timestamp: run.startedAt, artifactPath: null, note: '' });
        }
      }
    }
    return {
      version: '1.0.0',
      projectId: this.projectId,
      currentState: session.currentStage || WorkflowState.INIT,
      createdAt: session.startedAt,
      updatedAt: session.updatedAt,
      history,
      artifacts: { requirementMd: null, architectureMd: null, codeDiff: null, executionPlanMd: null, testReportMd: null, ...artifacts },
      risks: [],
      meta: { sessionId: session.sessionId, runtimeMode: session.mode },
    };
  }

  _syncManifestToStateManager() {
    try {
      let session = this._stateManager.loadSession(this._sessionId);
      if (!session) return;
      session.currentStage = this.manifest.currentState;
      session.status = this.manifest.currentState === WorkflowState.FINISHED ? SESSION_STATUS.COMPLETED : SESSION_STATUS.RUNNING;
      session.updatedAt = this.manifest.updatedAt;
      this._stateManager.saveSession(session);
    } catch (err) {
      console.error(`[StateMachine] ⚠️ StateManager sync failed: ${err.message}`);
    }
  }
}

module.exports = { StateMachine };
