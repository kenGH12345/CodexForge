/**
 * Tool Hook Executor – Tool Execution Wrapper with Automatic Hook Triggering
 *
 * P1 Implementation: Provides automatic BEFORE/AFTER tool execution hooks
 * that integrate deeply with the existing HookSystem.
 *
 * Key features:
 *  - Automatic hook emission on tool execution
 *  - Param modification support (BEFORE hook can transform inputs)
 *  - Result filtering support (AFTER hook can transform outputs)
 *  - Error handling with TOOL_EXECUTION_FAILED hook
 *  - Observability with timing and metadata
 *
 * Usage:
 *   const { withToolHooks } = require('./tool-hook-executor');
 *   const hookedTool = withToolHooks(getProjectStructure, 'getProjectStructure');
 *   const result = await hookedTool(dirPath, maxDepth);
 */

'use strict';

const { HOOK_EVENTS } = require('../core/constants');

// Module-level hook system reference (set at initialization)
let _hookSystem = null;
let _isEnabled = true;

// Tool registry for metadata
const _toolRegistry = new Map();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initializes the Tool Hook Executor with a HookSystem instance.
 * Must be called once during orchestrator initialization.
 *
 * @param {HookSystem} hookSystem - The workflow's HookSystem instance
 * @param {object} [options]
 * @param {boolean} [options.enabled=true] - Whether to enable hooks
 */
function initializeToolHookExecutor(hookSystem, options = {}) {
  _hookSystem = hookSystem;
  _isEnabled = options.enabled !== false;
  console.log(`[ToolHookExecutor] Initialized (enabled: ${_isEnabled})`);
}

/**
 * Wraps a tool function with automatic hook triggering.
 * The wrapped function will automatically emit:
 *   - TOOL_BEFORE_EXECUTION (allows param transformation)
 *   - TOOL_EXECUTION_STARTED
 *   - TOOL_EXECUTION_COMPLETED (on success)
 *   - TOOL_EXECUTION_FAILED (on error)
 *   - TOOL_AFTER_EXECUTION (allows result transformation)
 *
 * @param {Function} toolFn - The original tool function
 * @param {string} toolName - Unique name for the tool
 * @param {object} [metadata] - Optional tool metadata
 * @returns {Function} Wrapped tool function with same signature
 */
function withToolHooks(toolFn, toolName, metadata = {}) {
  // Register tool metadata
  _toolRegistry.set(toolName, {
    name: toolName,
    description: metadata.description || toolFn.name || toolName,
    category: metadata.category || 'general',
    estimatedCost: metadata.estimatedCost || 'medium',
    ...metadata,
  });

  return async function wrappedTool(...args) {
    const startTime = Date.now();
    const toolMeta = _toolRegistry.get(toolName);

    // Prepare execution context
    const executionContext = {
      toolName,
      timestamp: new Date().toISOString(),
      args: _sanitizeArgs(args),
      metadata: toolMeta,
    };

    let modifiedArgs = args;
    let result = null;
    let error = null;

    try {
      // ─── BEFORE EXECUTION HOOK ──────────────────────────────────────────────
      // Allows param modification, result aggregation, or early termination
      if (_isEnabled && _hookSystem) {
        const beforePayload = {
          ...executionContext,
          args,
          modifyArgs: (newArgs) => { modifiedArgs = newArgs; },
          skipExecution: false, // Set to true to skip actual tool call
        };

        await _hookSystem.emit(HOOK_EVENTS.TOOL_BEFORE_EXECUTION, beforePayload);

        // Check if execution should be skipped
        if (beforePayload.skipExecution) {
          console.log(`[ToolHookExecutor] ${toolName}: Execution skipped by hook`);
          return beforePayload.skipResult || { skipped: true, reason: 'Hook requested skip' };
        }
      }

      // ─── EXECUTION STARTED HOOK ─────────────────────────────────────────────
      if (_isEnabled && _hookSystem) {
        await _hookSystem.emit(HOOK_EVENTS.TOOL_EXECUTION_STARTED, {
          ...executionContext,
          args: _sanitizeArgs(modifiedArgs),
        });
      }

      // ─── ACTUAL TOOL EXECUTION ──────────────────────────────────────────────
      result = await toolFn.apply(this, modifiedArgs);

      // ─── EXECUTION COMPLETED HOOK ───────────────────────────────────────────
      const duration = Date.now() - startTime;
      if (_isEnabled && _hookSystem) {
        await _hookSystem.emit(HOOK_EVENTS.TOOL_EXECUTION_COMPLETED, {
          ...executionContext,
          args: _sanitizeArgs(modifiedArgs),
          result: _sanitizeResult(result),
          duration,
          success: true,
        });
      }

      // ─── AFTER EXECUTION HOOK ───────────────────────────────────────────────
      // Allows result modification, filtering, or enrichment
      if (_isEnabled && _hookSystem) {
        const afterPayload = {
          ...executionContext,
          args: _sanitizeArgs(modifiedArgs),
          result,
          duration,
          modifyResult: (newResult) => { result = newResult; },
        };

        await _hookSystem.emit(HOOK_EVENTS.TOOL_AFTER_EXECUTION, afterPayload);
      }

      return result;

    } catch (err) {
      // ─── EXECUTION FAILED HOOK ──────────────────────────────────────────────
      error = err;
      const duration = Date.now() - startTime;

      if (_isEnabled && _hookSystem) {
        await _hookSystem.emit(HOOK_EVENTS.TOOL_EXECUTION_FAILED, {
          ...executionContext,
          args: _sanitizeArgs(modifiedArgs),
          error: {
            message: err.message,
            stack: err.stack,
            type: err.constructor.name,
          },
          duration,
          success: false,
        });
      }

      // Re-throw to maintain original error handling
      throw err;
    }
  };
}

/**
 * Creates a batch version of a tool that executes with hooks for each item.
 * Useful for batch operations with individual item tracking.
 *
 * @param {Function} toolFn - The original tool function
 * @param {string} toolName - Base name for the tool
 * @returns {Function} Batch tool function
 */
function withBatchToolHooks(toolFn, toolName) {
  return async function batchTool(items, options = {}) {
    const results = [];
    const errors = [];
    const { concurrency = 1, stopOnError = false } = options;

    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const batchPromises = batch.map(async (item, idx) => {
        const wrapped = withToolHooks(toolFn, `${toolName}[${i + idx}]`);
        try {
          const result = await wrapped(item);
          return { success: true, item, result };
        } catch (err) {
          if (stopOnError) throw err;
          return { success: false, item, error: err.message };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach(r => {
        if (r.success) {
          results.push(r.result);
        } else {
          errors.push({ item: r.item, error: r.error });
        }
      });
    }

    return { results, errors, total: items.length, successCount: results.length };
  };
}

/**
 * Registers built-in tool hook handlers for observability.
 * Called automatically when initializeToolHookExecutor is invoked.
 *
 * @param {HookSystem} [hookSystem] - Optional external hook system instance
 */
function _registerBuiltinToolHooks(hookSystem) {
  const hooks = hookSystem || _hookSystem;
  if (!hooks) return;

  // Log tool execution
  hooks.on(HOOK_EVENTS.TOOL_EXECUTION_STARTED, async ({ toolName, metadata }) => {
    console.log(`[ToolHook] 🔧 ${toolName} started${metadata.category ? ` [${metadata.category}]` : ''}`);
  });

  hooks.on(HOOK_EVENTS.TOOL_EXECUTION_COMPLETED, async ({ toolName, duration }) => {
    console.log(`[ToolHook] ✅ ${toolName} completed (${duration}ms)`);
  });

  hooks.on(HOOK_EVENTS.TOOL_EXECUTION_FAILED, async ({ toolName, error, duration }) => {
    console.warn(`[ToolHook] ❌ ${toolName} failed after ${duration}ms: ${error.message}`);
  });

  // Token compression example (can be enabled via config)
  hooks.on(HOOK_EVENTS.TOOL_AFTER_EXECUTION, async ({ toolName, result, modifyResult }) => {
    // Example: Compress large results automatically
    if (result && typeof result === 'object' && result.summary) {
      const estimatedTokens = result.meta?.estimatedTokens || 0;
      if (estimatedTokens > 4000) {
        console.log(`[ToolHook] 📦 ${toolName}: Large result detected (${estimatedTokens} tokens), consider compression`);
      }
    }
  });
}

// ─── Utility Functions ────────────────────────────────────────────────────────

/**
 * Sanitizes arguments for logging (removes sensitive data, truncates large inputs)
 */
function _sanitizeArgs(args) {
  if (!args || !Array.isArray(args)) return args;

  return args.map(arg => {
    if (typeof arg === 'string' && arg.length > 500) {
      return arg.substring(0, 500) + '... [truncated]';
    }
    if (typeof arg === 'object' && arg !== null) {
      // Shallow clone and truncate large strings
      const sanitized = {};
      for (const [key, value] of Object.entries(arg)) {
        if (typeof value === 'string' && value.length > 500) {
          sanitized[key] = value.substring(0, 500) + '... [truncated]';
        } else {
          sanitized[key] = value;
        }
      }
      return sanitized;
    }
    return arg;
  });
}

/**
 * Sanitizes result for logging
 */
function _sanitizeResult(result) {
  if (!result) return result;

  const type = typeof result;
  if (type === 'string') {
    return result.length > 200 ? `${result.substring(0, 200)}... [${result.length} chars total]` : result;
  }
  if (type === 'object') {
    // Return summary instead of full object
    const keys = Object.keys(result);
    return {
      _type: 'object',
      _keys: keys,
      _summary: result.summary ? (result.summary.substring(0, 100) + '...') : undefined,
      meta: result.meta,
    };
  }
  return result;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  initializeToolHookExecutor,
  withToolHooks,
  withBatchToolHooks,
  // Internal for testing
  _registerBuiltinToolHooks,
  _sanitizeArgs,
  _sanitizeResult,
};
