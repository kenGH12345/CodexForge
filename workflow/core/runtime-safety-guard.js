/**
 * Runtime Safety Guard – Command and file-write interception
 *
 * Intercepts dangerous operations before execution.
 * Mirrors KnowledgeSafetyGuard's rule-engine pattern but for runtime commands.
 *
 * Usage:
 *   const guard = new RuntimeSafetyGuard({ mode: 'warn' });
 *   const result = guard.checkCommand('rm -rf /');
 *   // result = { allowed: false, mode: 'block', ruleId: 'RM_DANGEROUS', reason: '...', saferAlternative: '...' }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_SAFETY_RULES, RULES_VERSION } = require('./runtime-safety-policy');

class RuntimeSafetyGuard {
  /**
   * @param {object} [options]
   * @param {string}  [options.mode='warn'] - 'audit' | 'warn' | 'block'
   * @param {Array}   [options.rules] - Custom rules (overrides defaults)
   * @param {Array}   [options.allowlist] - Commands that bypass all checks
   * @param {string}  [options.eventsLogPath] - Path for safety events JSONL
   * @param {string}  [options.projectRoot] - Project root for file boundary checks
   * @param {boolean} [options.useConfig=true] - Load config from workflow.config.js
   */
  constructor(options = {}) {
    const {
      mode = 'warn',
      rules = null,
      allowlist = [],
      eventsLogPath = 'output/runtime-safety-events.jsonl',
      projectRoot = process.cwd(),
      useConfig = true,
    } = options;

    this._mode = mode;
    this._allowlist = this._normalizeAllowlist(allowlist);
    this._projectRoot = path.resolve(projectRoot);
    this._eventsLogPath = path.isAbsolute(eventsLogPath)
      ? eventsLogPath
      : path.join(this._projectRoot, eventsLogPath);
    this._stats = { totalChecks: 0, blocked: 0, warned: 0, allowed: 0 };
    this._rules = this._resolveRules(rules, useConfig);
  }

  /**
   * Normalize allowlist entries: trim whitespace for matching.
   */
  _normalizeAllowlist(allowlist) {
    if (!Array.isArray(allowlist)) return [];
    return allowlist.map(e => (typeof e === 'string' ? e.trim() : ''));
  }

  /**
   * Resolve effective rules: custom > config > defaults
   */
  _resolveRules(customRules, useConfig) {
    if (customRules && Array.isArray(customRules)) {
      return this._compileRules(customRules);
    }
    if (useConfig) {
      try {
        const { getConfig } = require('./config-loader');
        const config = getConfig();
        const cfgRules = config?.runtimeSafety?.customRules;
        if (Array.isArray(cfgRules) && cfgRules.length > 0) {
          return this._compileRules(cfgRules);
        }
        // Use config category toggles to filter default rules
        const cfg = config?.runtimeSafety || {};
        const filtered = DEFAULT_SAFETY_RULES.filter(r => {
          if (r.category === 'filesystem' && cfg.blockDangerousRm === false) return false;
          if (r.category === 'git' && cfg.blockDestructiveGit === false) return false;
          if (r.category === 'database' && cfg.blockDatabaseDrop === false) return false;
          if (r.category === 'publish' && cfg.blockPublishCommands === false) return false;
          if (r.category === 'k8s' && cfg.blockK8sDelete === false) return false;
          return true;
        });
        return this._compileRules(filtered);
      } catch (_) {
        // Config loader unavailable
      }
    }
    return this._compileRules(DEFAULT_SAFETY_RULES);
  }

  /**
   * Compile string patterns into RegExp objects.
   */
  _compileRules(rules) {
    const compiled = [];
    for (const rule of rules) {
      try {
        const regex = new RegExp(rule.pattern, 'i');
        compiled.push({ ...rule, regex });
      } catch (err) {
        console.warn(`[RuntimeSafetyGuard] Invalid rule pattern "${rule.id}": ${err.message}`);
      }
    }
    return compiled;
  }

  /**
   * Check if a command is in the allowlist.
   */
  _isAllowlisted(command) {
    if (!command || typeof command !== 'string') return false;
    const trimmed = command.trim();
    return this._allowlist.some(entry => entry.length > 0 && trimmed.startsWith(entry));
  }

  /**
   * Check a command string against all rules.
   * @param {string} command - The command to check
   * @param {object} [context] - Additional context for logging
   * @returns {{ allowed: boolean, mode: string, ruleId: string|null, reason: string, saferAlternative: string|null }}
   */
  checkCommand(command, context = {}) {
    this._stats.totalChecks++;

    if (!command || typeof command !== 'string') {
      this._stats.allowed++;
      return { allowed: true, mode: 'allow', ruleId: null, reason: 'Empty or invalid command', saferAlternative: null };
    }

    // Check allowlist first
    if (this._isAllowlisted(command)) {
      this._stats.allowed++;
      return { allowed: true, mode: 'allow', ruleId: null, reason: 'Allowlisted command', saferAlternative: null };
    }

    // Check against all compiled rules
    for (const rule of this._rules) {
      if (rule.regex.test(command)) {
        const effectiveMode = this._getEffectiveMode(rule.severity);
        const result = {
          allowed: effectiveMode !== 'block',
          mode: effectiveMode,
          ruleId: rule.id,
          reason: rule.message,
          saferAlternative: rule.saferAlternative || null,
        };

        // Record event
        this._recordEvent({
          ruleId: rule.id,
          severity: rule.severity,
          command,
          mode: effectiveMode,
          reason: rule.message,
          context,
        });

        if (effectiveMode === 'block') {
          this._stats.blocked++;
        } else {
          this._stats.warned++;
        }

        return result;
      }
    }

    // No rule matched — allow
    this._stats.allowed++;
    return { allowed: true, mode: 'allow', ruleId: null, reason: 'No rule matched', saferAlternative: null };
  }

  /**
   * Check if a file write operation is within project boundaries.
   * @param {string} filePath - Target file path
   * @param {string} [operation='write'] - Operation type
   * @returns {{ allowed: boolean, mode: string, ruleId: string|null, reason: string, saferAlternative: string|null }}
   */
  checkFileWrite(filePath, operation = 'write') {
    this._stats.totalChecks++;

    if (!filePath || typeof filePath !== 'string') {
      this._stats.allowed++;
      return { allowed: true, mode: 'allow', ruleId: null, reason: 'Empty path', saferAlternative: null };
    }

    const resolved = path.resolve(filePath);

    // Protected directories — never allow writes
    const protectedDirs = ['/etc', '/usr', '/bin', '/sbin', '/System', '/Library', 'C:\\Windows', 'C:\\Program Files'];
    for (const dir of protectedDirs) {
      if (resolved.startsWith(dir)) {
        this._stats.blocked++;
        const result = {
          allowed: false,
          mode: 'block',
          ruleId: 'PROTECTED_DIR_WRITE',
          reason: `Write to protected directory: ${dir}`,
          saferAlternative: 'Write within project directory only',
        };
        this._recordEvent({
          ruleId: 'PROTECTED_DIR_WRITE',
          severity: 'critical',
          command: `${operation} ${filePath}`,
          mode: 'block',
          reason: result.reason,
          context: { operation, filePath: resolved },
        });
        return result;
      }
    }

    this._stats.allowed++;
    return { allowed: true, mode: 'allow', ruleId: null, reason: 'Within boundaries', saferAlternative: null };
  }

  /**
   * Determine effective mode based on severity and configured mode.
   */
  _getEffectiveMode(severity) {
    if (this._mode === 'audit') return 'audit';
    if (this._mode === 'block') return 'block';
    // warn mode: critical severity becomes block
    if (this._mode === 'warn' && severity === 'critical') return 'block';
    return 'warn';
  }

  /**
   * Record a safety event to JSONL log.
   * P0 Gap #4: When mode==='block', also open a FixSession so subsequent
   * Agent attempts get anti-loop protection and the resolution is captured
   * as a fix experience.
   */
  _recordEvent(event) {
    const entry = {
      timestamp: new Date().toISOString(),
      ruleId: event.ruleId,
      severity: event.severity,
      command: event.command,
      mode: event.mode,
      reason: event.reason,
      context: event.context || {},
    };

    try {
      const dir = path.dirname(this._eventsLogPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this._eventsLogPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      console.warn(`[RuntimeSafetyGuard] Failed to record event: ${err.message}`);
    }

    // P0 Gap #4: Auto-open FixSession for blocked operations.
    // Best-effort: never fail the safety check even if FixEngine errors.
    if (event.mode === 'block') {
      try {
        const { getConfig } = require('./config-loader');
        const cfg = getConfig?.()?.fixSession;
        if (cfg && cfg.enabled && cfg.autoOpenOnBlock !== false) {
          const { FixExperienceEngine } = require('./fix-experience-engine');
          const engine = new FixExperienceEngine({ projectRoot: this._projectRoot });
          const { session, isNew } = engine.createOrGetSession({
            problem: `RuntimeSafetyGuard blocked: ${event.reason}`,
            errorMsg: `Command: ${event.command}`,
            errorType: 'runtime',
            taskId: event.context?.taskId || null,
          });
          if (isNew) {
            console.log(`[RuntimeSafetyGuard] 🔧 FixSession opened: ${session.id} (ruleId=${event.ruleId})`);
          }
        }
      } catch (fixErr) {
        console.warn(`[RuntimeSafetyGuard] ⚠️ FixSession open skipped (non-fatal): ${fixErr.message}`);
      }
    }
  }

  /**
   * Get aggregate statistics.
   * @returns {{ totalChecks: number, blocked: number, warned: number, allowed: number }}
   */
  getStats() {
    return { ...this._stats };
  }
}

module.exports = {
  RuntimeSafetyGuard,
  RULES_VERSION,
};
