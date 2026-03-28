/**
 * Orchestrator Task Strategies
 *
 * Task execution strategies, retry policies, and prompt templates.
 * Extracted from orchestrator-task.js for maintainability.
 *
 * @module workflow/core/orchestrator-task-strategies
 */

'use strict';

// ─── Task Prompt Templates ────────────────────────────────────────────────────

const TASK_PROMPTS = {
  /**
   * Header template for task-based mode
   */
  header: (context) => `# 🚀 Workflow Agent – Task-Based Mode

You are in **Task-Based Mode** (WORKFLOW_TASK). The Orchestrator has decomposed the user's request into independent tasks that can run in parallel or in dependency order.

## Your Role
Execute your assigned task(s) and produce the required outputs. Work autonomously and report results.

## Task Context
- **Workflow ID**: ${context.workflowId || 'unknown'}
- **Mode**: Parallel Execution
- **Phase**: Task Execution
`,

  /**
   * Task assignment template
   */
  taskAssignment: (task, allTasks, context) => {
    const statusOverview = allTasks
      .filter(t => t.status === 'done')
      .map(t => `  - ✅ ${t.id}: ${(t.title || '').slice(0, 50)}`)
      .join('\n');

    const depsInfo = (task.deps || [])
      .map(d => {
        const depTask = allTasks.find(t => t.id === d);
        return depTask ? `  - ${depTask.status === 'done' ? '✅' : '🔄'} ${d}: ${(depTask.title || '').slice(0, 40)}` : null;
      })
      .filter(Boolean)
      .join('\n');

    return `## 📋 Your Assigned Task

**Task ID**: \`${task.id}\`
**Title**: ${task.title || 'Untitled'}
**Description**: ${task.description || 'No description provided'}

### Dependencies
${(task.deps || []).length > 0 ? depsInfo : 'None – this task has no dependencies.'}

### Completed Tasks (for reference)
${statusOverview || 'No tasks completed yet.'}

### Expected Output
${task.expectedOutput || 'Produce the deliverables described in the task description.'}

${task.notes ? `### Notes\n${task.notes}` : ''}
`;
  },

  /**
   * Progress beacon for mid-task awareness
   */
  progressBeacon: (allTasks, currentTaskId) => {
    const done = allTasks.filter(t => t.status === 'done').length;
    const total = allTasks.length;
    return `## 📍 Progress Beacon (${done}/${total} done)

${allTasks.map(t => {
  const icon = t.id === currentTaskId ? '🔄' : (t.status === 'done' ? '✅' : '⬜');
  return `${icon} ${t.id}: ${(t.title || '').slice(0, 50)}`;
}).join('\n')}

> ⚠️ You are executing **${currentTaskId}**. After this, **${total - done - 1}** tasks remain.`;
  },
};

// ─── Task Status Transitions ──────────────────────────────────────────────────

const STATUS_TRANSITIONS = {
  pending:   ['running', 'blocked', 'failed'],
  running:   ['done', 'failed', 'exhausted', 'interrupted'],
  blocked:   ['pending', 'failed'],
  failed:    ['pending', 'running'], // Allow retry
  exhausted: [], // Terminal state
  done:      [],  // Terminal state
  interrupted: ['pending', 'running'],
};

/**
 * Validates if a status transition is allowed.
 * @param {string} from - Current status
 * @param {string} to - Target status
 * @returns {boolean}
 */
function isValidTransition(from, to) {
  const allowed = STATUS_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Gets next valid statuses for a given current status.
 * @param {string} current - Current status
 * @returns {string[]}
 */
function getValidNextStatuses(current) {
  return STATUS_TRANSITIONS[current] || [];
}

// ─── Retry Policy ─────────────────────────────────────────────────────────────

const DEFAULT_RETRY_POLICY = {
  maxRetries: 2,
  backoffMs: 2000,
  backoffMultiplier: 2,
  enableModelFallback: true,  // P3: Enable automatic model downgrade
  retryableErrors: [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'rate_limit_exceeded',
    'context_length_exceeded',
    'overloaded',
  ],
};

/**
 * Determines if an error is retryable.
 * @param {Error} error - The error to check
 * @param {object} policy - Retry policy configuration
 * @returns {boolean}
 */
function isRetryableError(error, policy = DEFAULT_RETRY_POLICY) {
  if (!error) return false;

  const errorMessage = (error.message || '').toLowerCase();
  const errorCode = error.code || error.name || '';

  return policy.retryableErrors.some(retryable =>
    errorMessage.includes(retryable.toLowerCase()) ||
    errorCode === retryable
  );
}

/**
 * Calculates backoff delay for retry attempt.
 * @param {number} attempt - Current attempt number (0-based)
 * @param {object} policy - Retry policy configuration
 * @returns {number} Delay in milliseconds
 */
function calculateBackoff(attempt, policy = DEFAULT_RETRY_POLICY) {
  const base = policy.backoffMs || 2000;
  const multiplier = policy.backoffMultiplier || 2;
  return base * Math.pow(multiplier, attempt);
}

// ─── Model Fallback Strategy ───────────────────────────────────────────────────

// P3: Model tier fallback chain (strong → default → fast → emergency)
const TIER_FALLBACK_CHAIN = {
  strong: 'default',
  'default': 'fast',
  fast: 'emergency',
  emergency: null,  // End of chain
};

// P3: Errors that trigger immediate tier downgrade (skip retry)
const IMMEDIATE_FALLBACK_ERRORS = [
  'rate_limit_exceeded',
  'context_length_exceeded',
  'model_not_found',
  'invalid_api_key',
  'quota_exceeded',
];

// P3: Errors that allow retry with same tier before fallback
const RETRY_THEN_FALLBACK_ERRORS = [
  'overloaded',
  'timeout',
  'ECONNRESET',
  'ETIMEDOUT',
];

/**
 * P3: Determines the fallback action for a failed LLM call.
 *
 * This complements RunGuard's budget-based tier downgrade by providing
 * error-triggered automatic model fallback.
 *
 * @param {Error} error - The error from failed call
 * @param {string} currentTier - Current tier (strong/default/fast/emergency)
 * @param {number} retryAttempt - Current retry attempt (0-based)
 * @returns {object} Action decision
 */
function determineFallbackAction(error, currentTier, retryAttempt = 0) {
  const errorMessage = (error?.message || '').toLowerCase();
  const errorCode = (error?.code || '').toLowerCase();

  // Check for immediate fallback errors
  const isImmediateFallback = IMMEDIATE_FALLBACK_ERRORS.some(e =>
    errorMessage.includes(e) || errorCode === e
  );

  if (isImmediateFallback) {
    const fallbackTier = TIER_FALLBACK_CHAIN[currentTier];
    return {
      action: 'fallback_immediate',
      reason: `Critical error requires immediate tier switch: ${error.message || errorCode}`,
      currentTier,
      fallbackTier,
      shouldRetry: false,
    };
  }

  // Check for retry-then-fallback errors
  const isRetryable = RETRY_THEN_FALLBACK_ERRORS.some(e =>
    errorMessage.includes(e) || errorCode === e
  );

  if (isRetryable && retryAttempt < 1) {
    return {
      action: 'retry_same_tier',
      reason: `Temporary error, allowing retry: ${error.message || errorCode}`,
      currentTier,
      fallbackTier: null,
      shouldRetry: true,
      retryDelay: calculateBackoff(retryAttempt),
    };
  }

  if (isRetryable && retryAttempt >= 1) {
    // Exceeded retry attempts, fallback
    const fallbackTier = TIER_FALLBACK_CHAIN[currentTier];
    return {
      action: 'fallback_after_retry',
      reason: `Retry limit reached (${retryAttempt}), switching tier`,
      currentTier,
      fallbackTier,
      shouldRetry: false,
    };
  }

  // Unknown error - allow one retry then fallback
  if (retryAttempt < 1) {
    return {
      action: 'retry_unknown',
      reason: `Unknown error, allowing one retry: ${error.message || errorCode}`,
      currentTier,
      fallbackTier: null,
      shouldRetry: true,
      retryDelay: calculateBackoff(retryAttempt),
    };
  }

  // Final fallback
  const fallbackTier = TIER_FALLBACK_CHAIN[currentTier];
  return {
    action: 'fallback_final',
    reason: `All retries exhausted for error: ${error.message || errorCode}`,
    currentTier,
    fallbackTier,
    shouldRetry: false,
  };
}

/**
 * P3: Determines the appropriate tier for a task based on multiple signals.
 *
 * Combines:
 *   - Task complexity (from estimateTaskComplexity)
 *   - Budget status (from RunGuard)
 *   - Historical success rate (from ModelHealth)
 *   - Retry attempt count
 *
 * @param {string} baseTier - Base tier from complexity assessment
 * @param {object} context - Decision context
 * @param {number} context.budgetRemaining - Budget percentage remaining (0-100)
 * @param {number} context.retryAttempt - Current retry count
 * @param {object} context.taskHistory - Historical task metadata
 * @returns {string} Recommended tier
 */
function determineOptimalTier(baseTier, context = {}) {
  const { budgetRemaining = 100, retryAttempt = 0, modelHealth = null } = context;

  let tier = baseTier;
  const reasons = [];

  // Signal 1: Budget-based downgrade (complements RunGuard)
  if (budgetRemaining < 15) {
    // Emergency tier - critical budget
    tier = 'emergency';
    reasons.push(`critical_budget (${budgetRemaining}%)`);
  } else if (budgetRemaining < 40 && tier !== 'fast') {
    // Downgrade one level for budget conservation
    tier = TIER_FALLBACK_CHAIN[tier] || tier;
    reasons.push(`low_budget (${budgetRemaining}%)`);
  }

  // Signal 2: Retry-based downgrade
  if (retryAttempt >= 2) {
    const nextTier = TIER_FALLBACK_CHAIN[tier];
    if (nextTier) {
      tier = nextTier;
      reasons.push(`retry_exhausted (${retryAttempt})`);
    }
  }

  // Signal 3: Model health-based downgrade (if health data available)
  if (modelHealth && modelHealth.status === 'unhealthy') {
    const nextTier = TIER_FALLBACK_CHAIN[tier];
    if (nextTier) {
      tier = nextTier;
      reasons.push(`model_unhealthy (${modelHealth.modelId})`);
    }
  }

  return {
    tier,
    reasons,
    originalTier: baseTier,
  };
}

/**
 * P3: Create an enhanced retry executor with tier fallback.
 *
 * @param {object} config
 * @param {Function} config.executeLLM - LLM execution function (tier, prompt) => result
 * @param {Function} [config.onTierSwitch] - Callback when tier switches
 * @returns {Function} Executor function
 */
function createTieredRetryExecutor(config) {
  const { executeLLM, onTierSwitch = null } = config;

  return async function executeWithFallback(task) {
    const { role, prompt, baseTier, budgetRemaining } = task;
    let currentTier = baseTier;
    let retryAttempt = 0;

    while (true) {
      try {
        // Attempt execution with current tier
        const result = await executeLLM(currentTier, prompt);

        return {
          success: true,
          result,
          tier: currentTier,
          attempts: retryAttempt + 1,
        };
      } catch (error) {
        // Determine fallback action
        const action = determineFallbackAction(error, currentTier, retryAttempt);

        console.log(`[TieredExecutor] ⚠️ ${role} failed with ${currentTier}: ${action.action}`);
        console.log(`[TieredExecutor]    Reason: ${action.reason}`);

        if (!action.shouldRetry && action.fallbackTier) {
          // Switch tier
          console.log(`[TieredExecutor] 🔄 Switching from ${currentTier} to ${action.fallbackTier}`);

          if (onTierSwitch) {
            onTierSwitch({
              role,
              fromTier: currentTier,
              toTier: action.fallbackTier,
              reason: action.reason,
            });
          }

          currentTier = action.fallbackTier;
          retryAttempt = 0;  // Reset retry count for new tier
        } else if (!action.shouldRetry && !action.fallbackTier) {
          // Out of fallback options
          throw new Error(`Execution failed in all tiers. Last error: ${error.message}`);
        } else {
          // Retry with same tier
          retryAttempt++;

          if (action.retryDelay) {
            console.log(`[TieredExecutor] ⏳ Waiting ${action.retryDelay}ms before retry...`);
            await delay(action.retryDelay);
          }
        }
      }
    }
  };
}

/**
 * Utility: Delay for ms.
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Task Priority Scoring ────────────────────────────────────────────────────

/**
 * Calculates task priority score for execution ordering.
 * Higher score = higher priority.
 *
 * Factors:
 * - Number of dependents (more dependents = higher priority)
 * - Whether it's on the critical path
 * - Task complexity estimate
 *
 * @param {object} task - Task object
 * @param {Array} allTasks - All tasks for dependency analysis
 * @returns {number} Priority score
 */
function calculateTaskPriority(task, allTasks) {
  let score = 0;

  // Count dependents (tasks that depend on this one)
  const dependents = allTasks.filter(t => (t.deps || []).includes(task.id));
  score += dependents.length * 10;

  // Bonus for being on critical path (no outgoing dependencies but has incoming)
  const hasIncoming = (task.deps || []).length > 0;
  const isOnCriticalPath = hasIncoming && dependents.length === 0;
  if (isOnCriticalPath) score += 5;

  // Penalty for high complexity
  const complexity = task.complexity || 'medium';
  if (complexity === 'high') score -= 3;
  if (complexity === 'low') score += 2;

  return score;
}

/**
 * Sorts tasks by priority for execution.
 * @param {Array} tasks - Tasks to sort
 * @param {Array} allTasks - All tasks for context
 * @returns {Array} Sorted tasks
 */
function sortByPriority(tasks, allTasks) {
  return [...tasks].sort((a, b) => {
    const priorityDiff = calculateTaskPriority(b, allTasks) - calculateTaskPriority(a, allTasks);
    if (priorityDiff !== 0) return priorityDiff;
    // Tie-breaker: alphabetical by ID
    return (a.id || '').localeCompare(b.id || '');
  });
}

// ─── Parallelism Calculator ───────────────────────────────────────────────────

/**
 * Calculates optimal parallelism level based on task graph.
 *
 * @param {Array} tasks - All tasks
 * @param {number} maxWorkers - Maximum allowed workers
 * @returns {object} { recommended: number, readyTasks: string[], criticalPath: number }
 */
function calculateParallelism(tasks, maxWorkers = 4) {
  if (!tasks || tasks.length === 0) {
    return { recommended: 0, readyTasks: [], criticalPath: 0 };
  }

  // Find tasks ready to run (all deps satisfied)
  const taskStatus = new Map(tasks.map(t => [t.id, t.status]));
  const readyTasks = tasks.filter(t => {
    if (t.status !== 'pending') return false;
    const deps = t.deps || [];
    return deps.every(d => taskStatus.get(d) === 'done');
  });

  // Calculate critical path length
  const idSet = new Set(tasks.map(t => t.id));
  const depth = new Map();

  function getDepth(taskId, visited = new Set()) {
    if (depth.has(taskId)) return depth.get(taskId);
    if (visited.has(taskId)) return 0; // Cycle protection

    visited.add(taskId);
    const task = tasks.find(t => t.id === taskId);
    if (!task) return 0;

    const depDepths = (task.deps || [])
      .filter(d => idSet.has(d))
      .map(d => getDepth(d, visited));

    const d = depDepths.length > 0 ? Math.max(...depDepths) + 1 : 0;
    depth.set(taskId, d);
    return d;
  }

  for (const t of tasks) {
    getDepth(t.id);
  }

  const criticalPath = Math.max(...Array.from(depth.values()), 0);

  // Recommended parallelism: min(maxWorkers, readyTasks, totalTasks/criticalPath)
  const theoreticalParallelism = tasks.length / Math.max(criticalPath, 1);
  const recommended = Math.min(
    maxWorkers,
    readyTasks.length,
    Math.ceil(theoreticalParallelism)
  );

  return {
    recommended: Math.max(1, recommended),
    readyTasks: readyTasks.map(t => t.id),
    criticalPath,
  };
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Prompts
  TASK_PROMPTS,

  // Status management
  STATUS_TRANSITIONS,
  isValidTransition,
  getValidNextStatuses,

  // Retry policy
  DEFAULT_RETRY_POLICY,
  isRetryableError,
  calculateBackoff,

  // Priority
  calculateTaskPriority,
  sortByPriority,

  // Parallelism
  calculateParallelism,

  // P3: Model fallback strategies
  TIER_FALLBACK_CHAIN,
  IMMEDIATE_FALLBACK_ERRORS,
  RETRY_THEN_FALLBACK_ERRORS,
  determineFallbackAction,
  determineOptimalTier,
  createTieredRetryExecutor,
};
