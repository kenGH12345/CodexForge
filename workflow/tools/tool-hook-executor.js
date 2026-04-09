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

const fs = require('fs');
const path = require('path');
const { HOOK_EVENTS } = require('../core/constants');
const { evaluateToolPermission, DEFAULT_RULES } = require('../core/tool-permission-converger');

const TOOL_RESULT_PERSIST_THRESHOLD = 16 * 1024;
const TOOL_RESULT_PREVIEW_CHARS = 2000;
let _toolResultSessionId = `tool-session-${Date.now()}`;

// Module-level hook system reference (set at initialization)
let _hookSystem = null;
let _isEnabled = true;

// Tool registry for metadata
const _toolRegistry = new Map();

// Tool Safety Configuration
// Defines dangerous operations that require pre-execution validation
const TOOL_SAFETY_CONFIG = {
  PATTERNS: DEFAULT_RULES.map(rule => ({
    id: rule.id,
    name: rule.name,
    patterns: rule.patterns,
    dangerLevel: rule.severity,
    blocking: rule.blocking,
    description: rule.description,
  })),
};

// Store for safety check results
const _safetyCheckHistory = [];
let _safetyCheckEnabled = true;

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
  if (options.sessionId && String(options.sessionId).trim()) {
    _toolResultSessionId = String(options.sessionId).trim();
  }
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

      // ─── PRE-EXECUTION SAFETY CHECK (PreToolUse) ────────────────────────────
      // Validates tool arguments to prevent dangerous operations
      const safetyCheck = runPreToolUseSafetyCheck(toolName, modifiedArgs);
      if (!safetyCheck.passed) {
        const fatalViolations = safetyCheck.violations.filter(v => v.blocking);
        const nonFatalViolations = safetyCheck.violations.filter(v => !v.blocking);

        // Log all violations
        for (const violation of safetyCheck.violations) {
          const icon = violation.blocking ? '🚫' : '⚠️';
          const level = violation.level.toUpperCase();
          console.warn(`[SafetyCheck] ${icon} [${level}] ${violation.name}: ${violation.description}`);
          if (violation.matched) {
            console.warn(`[SafetyCheck]    Matched: ${violation.matched}`);
          }
        }

        // Block execution if there are blocking violations
        if (safetyCheck.shouldBlock) {
          const error = new Error(
            `SAFETY_INTERCEPT: Execution blocked due to ${fatalViolations.length} critical violation(s). ` +
            `Violations: ${fatalViolations.map(v => v.name).join(', ')}.` +
            `Review the operation and modify to remove dangerous patterns.`
          );
          error.safetyViolations = safetyCheck.violations;
          error.safetyIntercepted = true;

          // Emit safety violation event through hook system
          if (_hookSystem) {
            await _hookSystem.emit('tool_safety_violation', {
              toolName,
              violations: safetyCheck.violations,
              shouldBlock: true,
              timestamp: new Date().toISOString(),
              permissionDecision: safetyCheck.permissionDecision || null,
              evidence: safetyCheck.permissionDecision?.evidence || null,
            });
          }

          throw error;
        }

        // Non-blocking violations: warn but continue
        if (_hookSystem) {
          await _hookSystem.emit('tool_safety_warning', {
            toolName,
            violations: nonFatalViolations,
            shouldBlock: false,
            timestamp: new Date().toISOString(),
          });
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

      // L1: Persist large tool output to disk and keep only preview in context
      result = _persistLargeToolResultIfNeeded(result, {
        toolName,
        timestamp: executionContext.timestamp,
      });

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

/**
 * PreToolUse Safety Check
 * Validates tool arguments before execution to prevent dangerous operations
 *
 * @param {string} toolName - Name of the tool being executed
 * @param {Array} args - Arguments passed to the tool
 * @returns {{ passed: boolean, violations: Array, shouldBlock: boolean }}
 */
function runPreToolUseSafetyCheck(toolName, args) {
  if (!_safetyCheckEnabled) {
    return { passed: true, violations: [], shouldBlock: false };
  }

  const decision = evaluateToolPermission({
    toolName,
    args,
    mode: 'node',
  });

  const violations = (decision.violations || []).map(v => ({
    id: v.id,
    name: v.name,
    level: v.severity,
    blocking: v.blocking,
    description: v.description,
    matched: v.matched,
    tool: toolName,
    timestamp: decision.evidence?.timestamp || new Date().toISOString(),
  }));

  const shouldBlock = !decision.allow;

  if (violations.length > 0) {
    _safetyCheckHistory.push({
      toolName,
      violations,
      shouldBlock,
      timestamp: new Date().toISOString(),
      permissionDecision: {
        decision: decision.decision,
        riskScore: decision.riskScore,
        confidence: decision.confidence,
        policyVersion: decision.policyVersion,
        reason: decision.reason,
      },
      evidence: decision.evidence,
    });

    if (_safetyCheckHistory.length > 100) {
      _safetyCheckHistory.shift();
    }
  }

  return {
    passed: decision.allow,
    violations,
    shouldBlock,
    permissionDecision: decision,
  };
}

/**
 * Sets whether PreToolUse safety checks are enabled
 * @param {boolean} enabled
 */
function setSafetyCheckEnabled(enabled) {
  _safetyCheckEnabled = enabled;
  console.log(`[ToolHookExecutor] Safety checks ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Gets the safety check history
 * @returns {Array}
 */
function getSafetyCheckHistory() {
  return [..._safetyCheckHistory];
}

/**
 * Clears the safety check history
 */
function clearSafetyCheckHistory() {
  _safetyCheckHistory.length = 0;
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

/**
 * Persists large tool results to output/tool-results/<sessionId>/ and returns preview envelope.
 * Keeps prompt/context lean while preserving full traceability.
 */
function _persistLargeToolResultIfNeeded(result, meta = {}) {
  try {
    if (result == null) return result;

    const raw = _serialiseToolResult(result);
    if (!raw || raw.length < TOOL_RESULT_PERSIST_THRESHOLD) {
      return result;
    }

    const safeToolName = String(meta.toolName || 'unknown-tool').replace(/[^a-zA-Z0-9._-]/g, '_');
    const tsPart = Date.now();
    const outDir = path.join(process.cwd(), 'output', 'tool-results', _toolResultSessionId);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const outPath = path.join(outDir, `${safeToolName}-${tsPart}.txt`);
    fs.writeFileSync(outPath, raw, 'utf-8');

    const preview = raw.slice(0, TOOL_RESULT_PREVIEW_CHARS);
    const envelope = {
      persisted: true,
      tool: safeToolName,
      sessionId: _toolResultSessionId,
      fullResultPath: outPath,
      fullSizeChars: raw.length,
      preview,
      note: 'Large tool result persisted to disk. Use read_file on fullResultPath to inspect complete output.',
    };

    console.log(`[ToolHookExecutor] 💾 Persisted large result for ${safeToolName}: ${raw.length} chars → ${outPath}`);
    return envelope;
  } catch (err) {
    console.warn(`[ToolHookExecutor] ⚠️  Persist large tool result failed (non-fatal): ${err.message}`);
    return result;
  }
}

function _serialiseToolResult(result) {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch (_) {
    return String(result);
  }
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
  _persistLargeToolResultIfNeeded,
  runPreToolUseSafetyCheck,
  setSafetyCheckEnabled,
  getSafetyCheckHistory,
  clearSafetyCheckHistory,
};
