/**
 * Test Failure Experience Recorder – Enhanced pattern capture for test failures
 *
 * Problem: Test failures contain valuable debugging patterns, but the current
 * experience recording is too brief to be useful for future debugging.
 *
 * Solution: Enhance experience recording with:
 *   - Detailed failure patterns (error message, stack trace, file locations)
 *   - Root cause analysis (common failure modes)
 *   - Fix patterns (what worked to resolve the issue)
 *
 * Usage:
 *   const recorder = new TestFailureExperienceRecorder(experienceStore);
 *   recorder.recordFailure({ error, testFile, attempt, fixHistory });
 */

'use strict';

const { ExperienceType, ExperienceCategory } = require('./experience-types');

// ─── Test Failure Experience Recorder ────────────────────────────────────────

class TestFailureExperienceRecorder {
  /**
   * @param {object} experienceStore - ExperienceStore instance
   * @param {object} [options]
   * @param {boolean} [options.verbose] - Enable verbose logging
   */
  constructor(experienceStore, options = {}) {
    this._exp = experienceStore;
    this._verbose = options.verbose || false;
  }

  /**
   * Records a test failure experience with detailed pattern analysis.
   *
   * @param {object} params
   * @param {Error} params.error - The error object
   * @param {string} params.testFile - Test file path
   * @param {string} params.testCommand - Test command used
   * @param {number} params.attempt - Attempt number (auto-fix round)
   * @param {object[]} [params.fixHistory] - History of fix attempts
   * @param {string} [params.projectContext] - Project context (e.g., 'nodejs', 'python')
   */
  recordFailure({ error, testFile, testCommand, attempt, fixHistory = [], projectContext = '' }) {
    const now = new Date().toISOString();
    
    // Extract error pattern
    const errorPattern = this._extractErrorPattern(error);
    
    // Determine root cause category
    const rootCause = this._categorizeRootCause(error);
    
    // Build detailed content
    const content = this._buildContent({
      error,
      testFile,
      testCommand,
      attempt,
      fixHistory,
      errorPattern,
      rootCause,
    });
    
    // Record as negative experience (pitfall)
    const exp = this._exp.record({
      type: ExperienceType.NEGATIVE,
      category: ExperienceCategory.PITFALL,
      title: `Test Failure: ${errorPattern.type} in ${testFile}`,
      content,
      skill: 'test-failure-pattern',
      tags: [
        'test-failure',
        errorPattern.type.toLowerCase().replace(/\s+/g, '-'),
        rootCause.category,
        projectContext,
      ].filter(Boolean),
    });
    
    if (this._verbose) {
      console.log(`[TestFailureRecorder] 📝 Recorded test failure: ${errorPattern.type} (${rootCause.category})`);
    }
    
    return exp;
  }

  /**
   * Records a successful fix pattern after test failures.
   *
   * @param {object} params
   * @param {string} params.errorPattern - Error pattern that was fixed
   * @param {string} params.fixDescription - What fixed the issue
   * @param {string} params.testFile - Test file path
   * @param {number} params.attempts - Number of attempts needed
   */
  recordFix({ errorPattern, fixDescription, testFile, attempts }) {
    const content = [
      `## Error Pattern`,
      `${errorPattern}`,
      ``,
      `## Solution`,
      `${fixDescription}`,
      ``,
      `## Context`,
      `- **Test File:** ${testFile}`,
      `- **Attempts:** ${attempts}`,
      `- **Date:** ${new Date().toISOString()}`,
    ].join('\n');
    
    const exp = this._exp.record({
      type: ExperienceType.POSITIVE,
      category: ExperienceCategory.DEBUG_TECHNIQUE,
      title: `Fixed: ${errorPattern.slice(0, 50)}...`,
      content,
      skill: 'test-fix-pattern',
      tags: ['test-fix', 'debug-technique', 'auto-fix'],
    });
    
    if (this._verbose) {
      console.log(`[TestFailureRecorder] ✅ Recorded fix pattern: ${errorPattern.slice(0, 50)}...`);
    }
    
    return exp;
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  _extractErrorPattern(error) {
    const message = error.message || String(error);
    const stack = error.stack || '';
    
    // Common error patterns
    const patterns = {
      'AssertionError': /AssertionError|assert\.|expect\(/i,
      'TypeError': /TypeError|undefined is not|cannot read property/i,
      'ReferenceError': /ReferenceError|is not defined/i,
      'SyntaxError': /SyntaxError|Unexpected token/i,
      'Timeout': /timeout|timed out|Timeout/i,
      'ImportError': /Cannot find module|Module not found|ImportError/i,
      'NetworkError': /ECONNREFUSED|ENOTFOUND|network/i,
    };
    
    for (const [type, regex] of Object.entries(patterns)) {
      if (regex.test(message) || regex.test(stack)) {
        return {
          type,
          message: message.slice(0, 200),
          location: this._extractLocation(stack),
        };
      }
    }
    
    return {
      type: 'Unknown',
      message: message.slice(0, 200),
      location: this._extractLocation(stack),
    };
  }

  _extractLocation(stack) {
    if (!stack) return null;
    
    // Extract first file location from stack
    const match = stack.match(/at\s+.*?\((.+?):(\d+):(\d+)\)/);
    if (match) {
      return {
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
      };
    }
    
    return null;
  }

  _categorizeRootCause(error) {
    const message = error.message || String(error);
    
    // Common root causes
    if (/undefined|null|cannot read/i.test(message)) {
      return { category: 'null-reference', description: 'Null or undefined reference' };
    }
    if (/async|await|promise/i.test(message)) {
      return { category: 'async-issue', description: 'Async/await or promise handling' };
    }
    if (/type|typeerror|mismatch/i.test(message)) {
      return { category: 'type-mismatch', description: 'Type mismatch or type error' };
    }
    if (/import|require|module/i.test(message)) {
      return { category: 'import-issue', description: 'Module import or dependency issue' };
    }
    if (/assert|expect|should/i.test(message)) {
      return { category: 'assertion-failure', description: 'Test assertion failed' };
    }
    if (/timeout|timed out/i.test(message)) {
      return { category: 'timeout', description: 'Operation timed out' };
    }
    
    return { category: 'unknown', description: 'Unknown root cause' };
  }

  _buildContent({ error, testFile, testCommand, attempt, fixHistory, errorPattern, rootCause }) {
    const lines = [];
    
    lines.push(`## Error Pattern`);
    lines.push(`**Type:** ${errorPattern.type}`);
    lines.push(`**Message:** ${errorPattern.message}`);
    if (errorPattern.location) {
      lines.push(`**Location:** ${errorPattern.location.file}:${errorPattern.location.line}`);
    }
    lines.push(``);
    
    lines.push(`## Root Cause`);
    lines.push(`**Category:** ${rootCause.category}`);
    lines.push(`**Description:** ${rootCause.description}`);
    lines.push(``);
    
    lines.push(`## Context`);
    lines.push(`- **Test File:** ${testFile}`);
    lines.push(`- **Test Command:** ${testCommand}`);
    lines.push(`- **Attempt:** ${attempt}`);
    lines.push(`- **Date:** ${new Date().toISOString()}`);
    lines.push(``);
    
    if (fixHistory.length > 0) {
      lines.push(`## Fix Attempts`);
      for (let i = 0; i < fixHistory.length; i++) {
        lines.push(`${i + 1}. ${fixHistory[i].description || 'Unknown fix'}`);
      }
      lines.push(``);
    }
    
    lines.push(`## Stack Trace`);
    lines.push('```');
    lines.push((error.stack || 'No stack trace').slice(0, 500));
    lines.push('```');
    
    return lines.join('\n');
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  TestFailureExperienceRecorder,
};
