/**
 * Orchestrator Task Mixin
 *
 * Provides task-based execution methods for the Orchestrator class.
 * This module is mixed into Orchestrator.prototype via Object.assign.
 *
 * Refactored (ADR-41): Split into modular components for maintainability:
 * - orchestrator-task-validation.js: Validation and coherence checks
 * - orchestrator-task-strategies.js: Execution strategies and prompts
 *
 * @module workflow/core/orchestrator-task
 */

'use strict';

// Import refactored modules
const {
  extractSignificantWords,
  validateDecomposition,
  checkCrossTaskCoherence,
  checkRequirementCoverage,
  buildProgressBeacon,
} = require('./orchestrator-task-validation');

const {
  TASK_PROMPTS,
  STATUS_TRANSITIONS,
  isValidTransition,
  getValidNextStatuses,
  DEFAULT_RETRY_POLICY,
  isRetryableError,
  calculateBackoff,
  calculateTaskPriority,
  sortByPriority,
  calculateParallelism,
} = require('./orchestrator-task-strategies');

// ─── ADR-42: Output Truncation Detection & Auto-Continuation ─────────────────

/** Maximum number of auto-continuation attempts per LLM call */
const MAX_CONTINUATION_ATTEMPTS = 3;

/**
 * Detects whether an LLM response was truncated.
 * Uses two layers: API signal detection (L1) and heuristic detection (L2).
 *
 * @param {*} response - The raw LLM response (string or object)
 * @returns {boolean} True if the response appears truncated
 */
function isResponseTruncated(response) {
  // L1: API signal detection (most reliable)
  if (response && typeof response === 'object') {
    const stopReason = response.stop_reason || response.finish_reason
      || response.choices?.[0]?.finish_reason;
    if (stopReason === 'max_tokens' || stopReason === 'length') {
      return true;
    }
  }

  // L2: Heuristic detection (fallback when API signal unavailable)
  const text = typeof response === 'string' ? response : (response?.text || response?.content || '');
  if (typeof text !== 'string' || text.length < 100) return false;

  const trimmed = text.trimEnd();

  // Check for unclosed code blocks (odd number of ```)
  const codeBlockCount = (trimmed.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) return true;

  // Check for mid-sentence cutoff (no terminal punctuation)
  if (trimmed.length > 200 && !/[.!?。！？\n`\]\)\}>]$/.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Merges an original (truncated) response with a continuation response.
 * Handles both string and object response formats.
 *
 * @param {*} original - The original truncated response
 * @param {*} continuation - The continuation response
 * @returns {*} Merged response
 */
function mergeResponses(original, continuation) {
  const origText = typeof original === 'string' ? original : (original?.text || original?.content || String(original));
  const contText = typeof continuation === 'string' ? continuation : (continuation?.text || continuation?.content || String(continuation));

  const merged = origText + '\n' + contText;

  // If original was an object, return an object with merged text
  if (typeof original === 'object' && original !== null) {
    return { ...original, text: merged, _continuationCount: (original._continuationCount || 0) + 1 };
  }
  return merged;
}

// ─── Task-Based Execution Mixin ───────────────────────────────────────────────

const OrchestratorTaskMixin = {
  /**
   * Main entry for task-based mode.
   * Decomposes requirement into tasks, executes them in parallel/sequence.
   *
   * @this {Orchestrator} - Bound to Orchestrator instance
   * @param {string} rawRequirement - User's raw requirement
   * @param {object} options - Execution options
   * @returns {Promise<object>} Execution result
   */
  async runTaskBased(rawRequirement, options = {}) {
    const {
      maxWorkers = 3,
      maxRetries = 2,
      validateDecomposition: shouldValidate = true,
      dryRun = false,
    } = options;

    this._emit('task:start', { requirement: rawRequirement });

    // 1. Decompose requirement into tasks
    const decomposition = await this._decomposeRequirement(rawRequirement, options);
    if (!decomposition.success) {
      return {
        success: false,
        error: decomposition.error,
        phase: 'decomposition',
      };
    }

    const taskDefs = decomposition.tasks;

    // 2. Validate decomposition
    if (shouldValidate) {
      const validation = validateDecomposition(taskDefs, rawRequirement);
      if (validation.issues.length > 0) {
        this._emit('task:validation:failed', { issues: validation.issues });
        // Log but continue - allow override
        this.logger?.warn('Task decomposition validation issues:', validation.issues);
      }
      if (validation.warnings.length > 0) {
        this._emit('task:validation:warnings', { warnings: validation.warnings });
        this.logger?.warn('Task decomposition warnings:', validation.warnings);
      }
    }

    // 3. Initialize tasks in TaskManager
    await this.taskManager.initTasks(taskDefs);

    // 4. Execute tasks
    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        tasks: taskDefs,
        message: 'Dry run - no execution performed',
      };
    }

    const result = await this._executeTasksConcurrently({
      maxWorkers,
      maxRetries,
    });

    // 5. Check final coverage
    const coverage = checkRequirementCoverage(rawRequirement, result.completedTasks || []);

    return {
      success: result.success,
      tasks: result.tasks,
      completedTasks: result.completedTasks,
      coverage: coverage.coverage,
      gaps: coverage.gaps,
      metrics: result.metrics,
    };
  },

  /**
   * Decomposes requirement into task definitions via LLM.
   * @private
   */
  async _decomposeRequirement(rawRequirement, options = {}) {
    const systemPrompt = `You are a task decomposition expert. Break down the user's requirement into independent, executable tasks.

Output a JSON array of tasks. Each task should have:
- id: unique identifier (e.g., "task-1", "task-2")
- title: concise task title
- description: detailed task description
- deps: array of task IDs this depends on (empty if none)
- expectedOutput: what this task should produce
- complexity: "low", "medium", or "high"

Guidelines:
1. Tasks should be independent where possible
2. Each task should be completable in a single agent session
3. Dependencies should be minimal but accurate
4. Aim for 3-8 tasks total`;

    try {
      const response = await this.llm.chat({
        system: systemPrompt,
        user: `Decompose this requirement into tasks:\n\n${rawRequirement}`,
        responseFormat: 'json',
      });

      const tasks = JSON.parse(response);
      return { success: true, tasks: Array.isArray(tasks) ? tasks : [] };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Executes tasks concurrently respecting dependencies.
   * @private
   */
  async _executeTasksConcurrently(options = {}) {
    const { maxWorkers = 3, maxRetries = 2 } = options;
    const allTasks = this.taskManager.getAllTasks();
    const taskOutputs = new Map();
    const startTime = Date.now();

    this._emit('task:execution:start', { taskCount: allTasks.length });

    // Main execution loop
    let iteration = 0;
    const maxIterations = allTasks.length * 3; // Safety limit

    while (iteration < maxIterations) {
      iteration++;

      // Find ready tasks
      const readyTasks = this._findReadyTasks(allTasks, taskOutputs);

      if (readyTasks.length === 0) {
        // Check if all done
        const pending = allTasks.filter(t => t.status === 'pending' || t.status === 'running');
        if (pending.length === 0) break;

        // Deadlock detection
        const blocked = allTasks.filter(t => t.status === 'pending');
        if (blocked.length > 0) {
          this._emit('task:deadlock', { blocked: blocked.map(t => t.id) });
          this.logger?.error('Task execution deadlock detected', blocked.map(t => t.id));
          break;
        }

        // Wait for running tasks
        await this._sleep(1000);
        continue;
      }

      // Execute ready tasks (up to maxWorkers)
      const toExecute = readyTasks.slice(0, maxWorkers);
      await Promise.allSettled(toExecute.map(t => this._executeTask(t, { maxRetries, taskOutputs })));
    }

    const completedTasks = allTasks.filter(t => t.status === 'done');
    const failedTasks = allTasks.filter(t => t.status === 'failed' || t.status === 'exhausted');

    return {
      success: failedTasks.length === 0,
      tasks: allTasks,
      completedTasks: completedTasks.map(t => ({
        ...t,
        output: taskOutputs.get(t.id),
      })),
      metrics: {
        totalTasks: allTasks.length,
        completed: completedTasks.length,
        failed: failedTasks.length,
        executionMs: Date.now() - startTime,
      },
    };
  },

  /**
   * Finds tasks ready to execute (pending with all deps satisfied).
   * @private
   */
  _findReadyTasks(allTasks, taskOutputs) {
    return allTasks.filter(task => {
      if (task.status !== 'pending') return false;
      const deps = task.deps || [];
      return deps.every(depId => taskOutputs.has(depId));
    });
  },

  /**
   * Executes a single task.
   * @private
   */
  async _executeTask(task, options = {}) {
    const { maxRetries = 2, taskOutputs } = options;
    let attempt = 0;

    this.taskManager.updateTaskStatus(task.id, 'running');
    this._emit('task:running', { taskId: task.id });

    while (attempt <= maxRetries) {
      try {
        // Build task prompt with progress beacon
        const allTasks = this.taskManager.getAllTasks();
        const beacon = buildProgressBeacon(allTasks, task.id);

        const depsOutputs = (task.deps || [])
          .map(d => taskOutputs.get(d))
          .filter(Boolean);

        const prompt = this._buildTaskPrompt(task, depsOutputs, beacon);

        // Execute via LLM with ADR-42 auto-continuation
        let output = await this.llm.chat({
          system: this._getSystemPrompt(),
          user: prompt,
        });

        // ADR-42: Auto-continuation loop for truncated responses
        let continuationAttempts = 0;
        while (isResponseTruncated(output) && continuationAttempts < MAX_CONTINUATION_ATTEMPTS) {
          continuationAttempts++;
          const outputText = typeof output === 'string' ? output : (output?.text || output?.content || String(output));
          console.log(`[TaskExecutor] ⚠️  Response truncated for task ${task.id}, auto-continuing (${continuationAttempts}/${MAX_CONTINUATION_ATTEMPTS})`);
          this._emit('task:output:truncated', {
            taskId: task.id,
            attempt: continuationAttempts,
            outputLengthSoFar: outputText.length,
          });

          const continuationPrompt = [
            `Your previous response was truncated (cut off mid-output). Here is what you produced so far:`,
            ``,
            `---BEGIN TRUNCATED OUTPUT---`,
            outputText.slice(-2000), // Last 2000 chars for context
            `---END TRUNCATED OUTPUT---`,
            ``,
            `IMPORTANT: Continue EXACTLY from where you left off. Do NOT repeat content you already produced.`,
            `Do NOT add any preamble like "Sure, continuing from where I left off". Just continue the content directly.`,
          ].join('\n');

          try {
            const continuation = await this.llm.chat({
              system: this._getSystemPrompt(),
              user: continuationPrompt,
            });
            output = mergeResponses(output, continuation);
          } catch (contErr) {
            console.warn(`[TaskExecutor] ⚠️  Continuation attempt ${continuationAttempts} failed: ${contErr.message}. Using partial output.`);
            break;
          }
        }

        if (continuationAttempts > 0) {
          console.log(`[TaskExecutor] ✅ Auto-continuation complete for task ${task.id} after ${continuationAttempts} attempt(s).`);
        }

        taskOutputs.set(task.id, output);
        this.taskManager.updateTaskStatus(task.id, 'done');
        this._emit('task:done', { taskId: task.id, output });

        return { success: true, output };
      } catch (error) {
        attempt++;

        if (isRetryableError(error) && attempt <= maxRetries) {
          const backoff = calculateBackoff(attempt - 1);
          this._emit('task:retry', { taskId: task.id, attempt, backoff });
          await this._sleep(backoff);
          continue;
        }

        this.taskManager.updateTaskStatus(task.id, attempt > maxRetries ? 'exhausted' : 'failed');
        this._emit('task:failed', { taskId: task.id, error: error.message, attempt });
        return { success: false, error: error.message };
      }
    }
  },

  /**
   * Builds the prompt for a task execution.
   * @private
   */
  _buildTaskPrompt(task, depsOutputs, beacon) {
    const depsSection = depsOutputs.length > 0
      ? `## Dependencies Output\n\n${depsOutputs.map((o, i) => `### Dependency ${i + 1}\n\`\`\`\n${o}\n\`\`\``).join('\n\n')}`
      : '';

    return `${TASK_PROMPTS.taskAssignment(task, this.taskManager.getAllTasks(), {})}

${beacon}

${depsSection}

## Instructions
Complete the task described above. Output your work in a clear, structured format.
`;
  },

  /**
   * Gets the system prompt for task execution.
   * @private
   */
  _getSystemPrompt() {
    return `You are a specialized task execution agent. Your job is to complete the assigned task thoroughly and produce high-quality output.

Guidelines:
1. Focus only on your assigned task
2. Produce concrete, actionable output
3. If you need information not provided, make reasonable assumptions and note them
4. Format your output clearly using Markdown`;
  },

  /**
   * Helper: Sleep for specified milliseconds.
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  /**
   * Helper: Emit event (if event bus available).
   * @private
   */
  _emit(event, data) {
    if (this.eventBus?.emit) {
      this.eventBus.emit(event, data);
    }
  },
};

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Main mixin
  OrchestratorTaskMixin,

  // Re-export validation functions for direct use
  extractSignificantWords,
  validateDecomposition,
  checkCrossTaskCoherence,
  checkRequirementCoverage,
  buildProgressBeacon,

  // Re-export strategy functions
  TASK_PROMPTS,
  STATUS_TRANSITIONS,
  isValidTransition,
  getValidNextStatuses,
  DEFAULT_RETRY_POLICY,
  isRetryableError,
  calculateBackoff,
  calculateTaskPriority,
  sortByPriority,
  calculateParallelism,

  // ADR-42: Output truncation detection & auto-continuation
  isResponseTruncated,
  mergeResponses,
  MAX_CONTINUATION_ATTEMPTS,
};
