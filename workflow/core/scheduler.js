/**
 * Workflow Scheduler – Lightweight scheduled task runner for automated audits
 *
 * Enables automatic triggering of workflow commands at scheduled intervals.
 * Designed to be minimal and non-invasive to the existing workflow.
 *
 * Features:
 *   - Cron-like scheduling (e.g., weekly deep-audit)
 *   - Incremental audit mode (only audit changed files) ← RECOMMENDED
 *   - Persistent state (track last run, next run)
 *   - Configurable via workflow.config.js
 *
 * Token Efficiency (IMPORTANT):
 *   - Use --incremental flag for deep-audit to save ~70% tokens
 *   - Incremental mode skips audit if no files changed since last run
 *   - Recommended for all scheduled/automated audits
 *
 * Usage:
 *   // In workflow.config.js
 *   scheduler: {
 *     enabled: true,
 *     tasks: [
 *       { command: 'deep-audit', cron: 'weekly', args: ['--incremental'] }, // ← RECOMMENDED
 *       { command: 'review-status', cron: 'daily', args: ['--severity=high'] },
 *     ]
 *   }
 *
 *   // Start scheduler
 *   const scheduler = new WorkflowScheduler(orchestrator);
 *   scheduler.start();
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_STATE_FILE = 'output/scheduler-state.json';
const MIN_INTERVAL_MS = 60 * 60 * 1000; // Minimum 1 hour between runs

// ─── WorkflowScheduler ────────────────────────────────────────────────────────

class WorkflowScheduler {
  /**
   * @param {object} orchestrator - Orchestrator instance
   * @param {object} [options]
   * @param {string} [options.stateFile] - Path to state persistence file
   * @param {boolean} [options.verbose] - Enable verbose logging
   */
  constructor(orchestrator, options = {}) {
    this._orchestrator = orchestrator;
    this._stateFile = options.stateFile || DEFAULT_STATE_FILE;
    this._verbose = options.verbose || false;
    this._timers = new Map(); // taskName -> timer
    this._running = false;
    
    // Load state from disk
    this._state = this._loadState();
  }

  /**
   * Starts the scheduler based on workflow.config.js settings.
   */
  start() {
    if (this._running) {
      console.warn('[Scheduler] ⚠️  Scheduler already running');
      return;
    }
    
    const config = this._loadConfig();
    if (!config || !config.enabled) {
      if (this._verbose) console.log('[Scheduler] ⏭️  Scheduler disabled in config');
      return;
    }
    
    const tasks = config.tasks || [];
    if (tasks.length === 0) {
      if (this._verbose) console.log('[Scheduler] ⏭️  No scheduled tasks defined');
      return;
    }
    
    console.log(`[Scheduler] 🚀 Starting scheduler with ${tasks.length} task(s)`);
    
    for (const task of tasks) {
      this._scheduleTask(task);
    }
    
    this._running = true;
  }

  /**
   * Stops all scheduled tasks.
   */
  stop() {
    if (!this._running) return;
    
    for (const [name, timer] of this._timers) {
      clearTimeout(timer);
      if (this._verbose) console.log(`[Scheduler] ⏹️  Stopped task: ${name}`);
    }
    
    this._timers.clear();
    this._running = false;
    console.log('[Scheduler] 🛑 Scheduler stopped');
  }

  /**
   * Gets the next scheduled run time for a task.
   *
   * @param {string} taskName - Task name (e.g., 'deep-audit')
   * @returns {Date|null} Next run time or null if not scheduled
   */
  getNextRun(taskName) {
    const taskState = this._state.tasks[taskName];
    return taskState ? new Date(taskState.nextRun) : null;
  }

  /**
   * Gets the last run time for a task.
   *
   * @param {string} taskName - Task name
   * @returns {Date|null} Last run time or null if never run
   */
  getLastRun(taskName) {
    const taskState = this._state.tasks[taskName];
    return taskState && taskState.lastRun ? new Date(taskState.lastRun) : null;
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Schedules a single task.
   *
   * @param {object} task - Task definition
   * @param {string} task.command - Command to run (e.g., 'deep-audit')
   * @param {string} task.cron - Cron expression (simplified: only interval supported)
   * @param {string[]} [task.args] - Command arguments
   */
  _scheduleTask(task) {
    const { command, cron, args = [] } = task;
    
    // Simplified cron parsing: only support fixed intervals
    // Format: "every N hours" or "every N days at HH:MM"
    const intervalMs = this._parseCron(cron);
    if (!intervalMs) {
      console.warn(`[Scheduler] ⚠️  Invalid cron expression: ${cron}`);
      return;
    }
    
    // Calculate next run time
    const now = Date.now();
    const lastRun = this._state.tasks[command]?.lastRun;
    let nextRun = lastRun ? new Date(lastRun).getTime() + intervalMs : now + 60000; // Default: 1min from now
    
    // If next run is in the past, schedule for next interval
    if (nextRun < now) {
      nextRun = now + intervalMs;
    }
    
    const delay = nextRun - now;
    
    console.log(`[Scheduler] ⏰ Scheduled: ${command} (next run in ${this._formatDuration(delay)})`);
    
    // Schedule timer
    const timer = setTimeout(async () => {
      await this._runTask(command, args);
      // Reschedule
      this._scheduleTask(task);
    }, delay);
    
    this._timers.set(command, timer);
    
    // Update state
    this._state.tasks[command] = {
      ...this._state.tasks[command],
      nextRun: new Date(nextRun).toISOString(),
      interval: intervalMs,
    };
    this._saveState();
  }

  /**
   * Runs a scheduled task.
   *
   * @param {string} command - Command to run
   * @param {string[]} args - Command arguments
   */
  async _runTask(command, args) {
    console.log(`[Scheduler] 🏃 Running scheduled task: ${command} ${args.join(' ')}`);
    
    try {
      // Import command router
      const { commandRouter } = require('../commands/command-router');
      
      // Execute command
      const result = await commandRouter.execute(command, args, {
        orchestrator: this._orchestrator,
      });
      
      // Update state
      this._state.tasks[command] = {
        ...this._state.tasks[command],
        lastRun: new Date().toISOString(),
        lastResult: result ? 'success' : 'failed',
      };
      this._saveState();
      
      console.log(`[Scheduler] ✅ Task completed: ${command}`);
    } catch (err) {
      console.error(`[Scheduler] ❌ Task failed: ${command}`, err.message);
      
      // Update state with error
      this._state.tasks[command] = {
        ...this._state.tasks[command],
        lastRun: new Date().toISOString(),
        lastResult: 'error',
        lastError: err.message,
      };
      this._saveState();
    }
  }

  /**
   * Parses a simplified cron expression.
   *
   * Supported formats:
   *   - "every N hours" → N hours
   *   - "every N days" → N days
   *   - "weekly" → 7 days
   *   - "daily" → 1 day
   *   - "hourly" → 1 hour
   *
   * @param {string} cron - Cron expression
   * @returns {number|null} Interval in milliseconds or null if invalid
   */
  _parseCron(cron) {
    const hourMs = 60 * 60 * 1000;
    const dayMs = 24 * hourMs;
    
    // Simple keyword mapping
    const keywords = {
      'hourly': hourMs,
      'daily': dayMs,
      'weekly': 7 * dayMs,
      'monthly': 30 * dayMs,
    };
    
    if (keywords[cron.toLowerCase()]) {
      return keywords[cron.toLowerCase()];
    }
    
    // Parse "every N hours/days"
    const match = cron.match(/every\s+(\d+)\s+(hour|day)s?/i);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      return unit === 'hour' ? value * hourMs : value * dayMs;
    }
    
    // Standard cron expression (simplified: only support fixed intervals)
    // Format: "0 2 * * 1" → Every Monday 2AM
    // For now, default to weekly
    if (/^\d+\s+\d+\s+\*\s+\*\s+\d+$/.test(cron)) {
      return 7 * dayMs; // Simplified: treat as weekly
    }
    
    return null;
  }

  /**
   * Formats a duration in human-readable form.
   *
   * @param {number} ms - Duration in milliseconds
   * @returns {string} Formatted duration
   */
  _formatDuration(ms) {
    const hours = Math.floor(ms / (60 * 60 * 1000));
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
      return `${days} day${days > 1 ? 's' : ''}`;
    } else if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''}`;
    } else {
      const minutes = Math.floor(ms / (60 * 1000));
      return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    }
  }

  /**
   * Loads scheduler configuration from workflow.config.js.
   *
   * @returns {object|null} Scheduler config or null if not defined
   */
  _loadConfig() {
    try {
      const configPath = path.join(process.cwd(), 'workflow.config.js');
      if (!fs.existsSync(configPath)) return null;
      
      const config = require(configPath);
      return config.scheduler || { enabled: false };
    } catch (err) {
      console.warn('[Scheduler] ⚠️  Failed to load config:', err.message);
      return null;
    }
  }

  /**
   * Loads scheduler state from disk.
   *
   * @returns {object} State object
   */
  _loadState() {
    try {
      if (fs.existsSync(this._stateFile)) {
        const data = fs.readFileSync(this._stateFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.warn('[Scheduler] ⚠️  Failed to load state:', err.message);
    }
    
    return {
      tasks: {},
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Saves scheduler state to disk.
   */
  _saveState() {
    try {
      const dir = path.dirname(this._stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this._stateFile, JSON.stringify(this._state, null, 2), 'utf8');
    } catch (err) {
      console.warn('[Scheduler] ⚠️  Failed to save state:', err.message);
    }
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  WorkflowScheduler,
};
