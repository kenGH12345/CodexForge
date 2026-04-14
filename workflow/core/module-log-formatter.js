/**
 * ModuleLogFormatter - Unified formatting and writing for module-level logs
 * 
 * This module provides a bridge between existing data collectors
 * (IntrospectionCollector, Observability) and the visible workflow-progress.log.
 * 
 * Design decisions (ARCHITECTURE.md):
 * - D-1: Bridge pattern - zero intrusion to existing callers
 * - D-2: Unified ModuleLogEntry schema - consistent output across modes
 * - D-3: Log level control at write layer - efficient filtering
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * ModuleLogEntry Schema (ARCHITECTURE.md)
 * @typedef {Object} ModuleLogEntry
 * @property {string} ts - Local timestamp (e.g., "2026-04-13 14:25:00")
 * @property {string} module - Module identifier (Experience|CodeGraph|Skill|Evolution|MAPE|Regression|Observability)
 * @property {string} level - Log level (INFO|WARN|DETAIL)
 * @property {string} action - Event action (e.g., "experience_searched")
 * @property {string} summary - Human-readable summary
 * @property {Object} [data] - Structured data (for DETAIL level)
 * @property {string} [sessionId] - Associated session ID
 * @property {string} [stage] - Associated stage
 */

class ModuleLogFormatter {
  /**
   * Default configuration (used when workflow.config.js is missing or malformed)
   */
  static get DEFAULT_CONFIG() {
    return {
      enabled: true,
      defaultLevel: 'INFO',
      moduleOverrides: {},
      maxEntriesPerSession: 200
    };
  }

  /**
   * Format a ModuleLogEntry into a human-readable log line.
   * Output format: [timestamp] [MODULE:xxx] [LEVEL] action | key=value
   * 
   * @param {ModuleLogEntry} entry - The log entry to format
   * @returns {string} Formatted log line
   */
  static format(entry) {
    if (!entry || typeof entry !== 'object') {
      return '';
    }

    const { ts, module, level, action, summary, data } = entry;
    
    // Build the base line: [ts] [MODULE:module] [LEVEL] action
    const parts = [];
    
    if (ts) {
      parts.push(`[${ts}]`);
    }
    
    if (module) {
      parts.push(`[MODULE:${module}]`);
    }
    
    if (level) {
      parts.push(`[${level}]`);
    }
    
    if (action) {
      parts.push(action);
    }
    
    // Add summary
    if (summary) {
      parts.push('|', summary);
    }
    
    // Add data as key=value pairs (for DETAIL level)
    if (data && typeof data === 'object' && Object.keys(data).length > 0) {
      const dataParts = Object.entries(data)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      parts.push('|', dataParts);
    }
    
    return parts.join(' ');
  }

  /**
   * Format a ModuleLogEntry as JSON (for Orchestrator mode).
   * 
   * @param {ModuleLogEntry} entry - The log entry to format
   * @returns {string} JSON string
   */
  static formatAsJson(entry) {
    if (!entry || typeof entry !== 'object') {
      return '{}';
    }
    return JSON.stringify(entry);
  }

  /**
   * Format and write a ModuleLogEntry to workflow-progress.log.
   * Respects log level configuration and handles errors gracefully.
   * 
   * @param {string} projectRoot - Project root directory
   * @param {ModuleLogEntry} entry - The log entry to write
   * @param {Object} [options] - Write options
   * @param {string} [options.mode='ide'] - 'ide' for human-readable, 'json' for JSON format
   */
  static formatAndWrite(projectRoot, entry, options = {}) {
    const { mode = 'ide' } = options;
    
    // Check if logging is enabled
    const config = ModuleLogFormatter._loadConfig(projectRoot);
    if (!config.enabled) {
      return;
    }
    
    // Check log level
    if (!ModuleLogFormatter.shouldLog(entry, config)) {
      return;
    }
    
    try {
      const outputDir = path.join(projectRoot, 'output');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      const logPath = path.join(outputDir, 'workflow-progress.log');
      
      // Add timestamp if not provided
      if (!entry.ts) {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        entry.ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      }
      
      // Format based on mode
      const formattedLine = mode === 'json' 
        ? ModuleLogFormatter.formatAsJson(entry)
        : ModuleLogFormatter.format(entry);
      
      if (formattedLine) {
        fs.appendFileSync(logPath, formattedLine + '\n', 'utf8');
      }
    } catch (err) {
      // Silent failure - don't break the main workflow
      console.error(`[ModuleLogFormatter] Failed to write progress log: ${err.message}`);
    }
  }

  /**
   * Check if a log entry should be written based on configuration.
   * 
   * @param {ModuleLogEntry} entry - The log entry to check
   * @param {Object} [config] - Configuration object (loaded from workflow.config.js)
   * @returns {boolean} True if the entry should be logged
   */
  static shouldLog(entry, config) {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    
    // Use default config if not provided
    if (!config) {
      config = ModuleLogFormatter.DEFAULT_CONFIG;
    }
    
    const { level, module } = entry;
    
    // Get effective level for this module
    let effectiveLevel = config.defaultLevel || 'INFO';
    
    // Check module-specific overrides
    if (module && config.moduleOverrides && config.moduleOverrides[module]) {
      effectiveLevel = config.moduleOverrides[module];
    }
    
    // Level hierarchy: DETAIL > INFO > WARN
    const levelPriority = { 'DETAIL': 3, 'INFO': 2, 'WARN': 1 };
    
    const entryLevel = levelPriority[level] || 2;
    const thresholdLevel = levelPriority[effectiveLevel] || 2;
    
    // Log if entry level >= threshold (WARN >= INFO means WARN is logged when threshold is INFO)
    // Actually, WARN should always be logged, INFO logged when threshold is INFO or DETAIL
    // Correct logic: log if entry level priority <= threshold (WARN=1, INFO=2, DETAIL=3)
    // WARN(1) should be logged when threshold is INFO(2): 1 <= 2 → true
    // INFO(2) should be logged when threshold is INFO(2): 2 <= 2 → true
    // DETAIL(3) should NOT be logged when threshold is INFO(2): 3 <= 2 → false
    return entryLevel <= thresholdLevel;
  }

  /**
   * Load configuration from workflow.config.js.
   * Returns default config if file is missing or malformed.
   * 
   * @param {string} projectRoot - Project root directory
   * @returns {Object} Configuration object
   */
  static _loadConfig(projectRoot) {
    try {
      const configPath = path.join(projectRoot, 'workflow.config.js');
      
      if (!fs.existsSync(configPath)) {
        return ModuleLogFormatter.DEFAULT_CONFIG;
      }
      
      // Clear require cache to get fresh config
      delete require.cache[require.resolve(configPath)];
      const config = require(configPath);
      
      if (!config || !config.moduleLog) {
        return ModuleLogFormatter.DEFAULT_CONFIG;
      }
      
      // Merge with defaults
      return {
        ...ModuleLogFormatter.DEFAULT_CONFIG,
        ...config.moduleLog
      };
    } catch (err) {
      // Graceful degradation on config error
      console.error(`[ModuleLogFormatter] Config load failed, using defaults: ${err.message}`);
      return ModuleLogFormatter.DEFAULT_CONFIG;
    }
  }
}

module.exports = ModuleLogFormatter;
