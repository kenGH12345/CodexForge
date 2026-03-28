/**
 * Write-Around Review Pattern – Zero-Trust Edit Validation
 *
 * PROBLEM: When AI Agent uses edit_file/replace_in_file directly,
 * all review mechanisms (CodeReviewAgent, QualityGate, SelfCorrection)
 * are bypassed because they are bound to the workflow pipeline.
 *
 * SOLUTION: Lightweight pre/post-edit hooks that trigger fast validation
 * without blocking the edit operation. Unlike full CodeReviewAgent,
 * this runs in <500ms and focuses on critical issues only.
 *
 * Design Principles:
 *   - Non-blocking: Review runs async, doesn't block edit
 *   - Token-efficient: Uses regex-based detection first, LLM only for high-risk
 *   - Fail-open: If review fails, log warning but don't block
 *   - Graduated response: WARN → BLOCK (only for critical security issues)
 *
 * Integration Points:
 *   1. Pre-edit hook: validateBeforeEdit() - check for obvious issues
 *   2. Post-edit hook: reviewAfterEdit() - comprehensive scan
 *
 * @module workflow/core/write-around-review
 */

'use strict';

const { detectSignals } = require('./clarification-engine');

// ─── Review Dimension Priorities ─────────────────────────────────────────────

/**
 * Quick Review focuses on 5 dimensions (vs 10 in full CodeReviewAgent):
 *   1. SECURITY    - Injection, secrets, auth bypass
 *   2. DUPLICATION - Copy-paste code, near-duplicates
 *   3. COMPLEXITY  - Function length, nesting depth
 *   4. BREAKING    - Breaking changes to public APIs
 *   5. CONSISTENCY - Naming, style drift from project patterns
 */
const QUICK_REVIEW_DIMENSIONS = {
  SECURITY:    { weight: 10, blockers: ['sql_injection', 'hardcoded_secret', 'auth_bypass'] },
  DUPLICATION: { weight: 7,  blockers: ['exact_duplicate', 'near_duplicate'] },
  COMPLEXITY:  { weight: 5,  blockers: ['function_too_long', 'deep_nesting'] },
  BREAKING:    { weight: 8,  blockers: ['breaking_api_change', 'removed_export'] },
  CONSISTENCY: { weight: 3,  blockers: [] },
};

// ─── Security Patterns (Regex-based, fast) ───────────────────────────────────

const SECURITY_PATTERNS = [
  {
    id: 'SEC-INJ-001',
    name: 'SQL Injection Risk',
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE)\s+[\s\S]*?(?:\+\s*\w+|\$\{|\$\()/gi,
    severity: 'high',
    hint: 'Use parameterized queries instead of string concatenation',
  },
  {
    id: 'SEC-SECRET-001',
    name: 'Hardcoded Secret',
    pattern: /(?:password|secret|api[_-]?key|token)\s*[=:]\s*['"][^'"]{8,}['"]/gi,
    severity: 'high',
    hint: 'Move secrets to environment variables or secure storage',
  },
  {
    id: 'SEC-AUTH-001',
    name: 'Auth Bypass Risk',
    pattern: /(?:bypass|skip|disable).*\bauth\b|\bauth\b.*(?:bypass|skip|disable)|bypassAuth|skipAuth|disableAuth/gi,
    severity: 'critical',
    hint: 'Authentication bypass detected – this is a security risk',
  },
  {
    id: 'SEC-EVAL-001',
    name: 'eval() Usage',
    pattern: /\beval\s*\(/g,
    severity: 'high',
    hint: 'eval() is dangerous – use JSON.parse or safer alternatives',
  },
];

// ─── Duplication Detection ──────────────────────────────────────────────────

/**
 * Detects duplicate code patterns within a file.
 * Simple line-based detection – not as sophisticated as CPD but fast.
 */
function detectDuplication(content, threshold = 6) {
  const lines = content.split('\n');
  const lineMap = new Map(); // line -> [lineNumbers]
  const duplicates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length < 10 || line.startsWith('//') || line.startsWith('*')) continue;

    if (!lineMap.has(line)) {
      lineMap.set(line, []);
    }
    lineMap.get(line).push(i + 1);
  }

  // Find lines appearing more than once
  for (const [line, lineNumbers] of lineMap) {
    if (lineNumbers.length >= threshold) {
      duplicates.push({
        type: 'duplicate_lines',
        lineNumbers,
        sample: line.slice(0, 60),
        count: lineNumbers.length,
      });
    }
  }

  return duplicates;
}

// ─── Complexity Detection ───────────────────────────────────────────────────

/**
 * Estimates function complexity based on heuristics.
 * Fast alternative to full cyclomatic complexity calculation.
 */
function estimateComplexity(content) {
  const issues = [];

  // Check for long functions (heuristic: more than 50 lines)
  const functionMatches = content.matchAll(/(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|=>\s*{)/gi);
  for (const match of functionMatches) {
    const startPos = match.index;
    let braceCount = 0;
    let lineCount = 0;
    let inFunction = false;

    for (let i = startPos; i < content.length; i++) {
      if (content[i] === '{') {
        braceCount++;
        inFunction = true;
      } else if (content[i] === '}') {
        braceCount--;
        if (inFunction && braceCount === 0) break;
      } else if (content[i] === '\n' && inFunction) {
        lineCount++;
      }
    }

    if (lineCount > 50) {
      issues.push({
        type: 'function_too_long',
        name: match[0].slice(0, 40),
        lines: lineCount,
        severity: 'medium',
      });
    }
  }

  // Check for deep nesting
  const lines = content.split('\n');
  let maxIndent = 0;
  for (const line of lines) {
    const indent = line.search(/\S/);
    if (indent > maxIndent) maxIndent = indent;
  }
  if (maxIndent > 24) { // 6 levels of 4-space indent
    issues.push({
      type: 'deep_nesting',
      maxIndent,
      severity: 'medium',
    });
  }

  return issues;
}

// ─── API Breaking Change Detection ───────────────────────────────────────────

/**
 * Detects potential breaking changes in public APIs.
 * Uses simple heuristics – not as comprehensive as semantic versioning tools.
 */
function detectBreakingChanges(oldContent, newContent) {
  const breaking = [];

  // Detect removed exports
  const oldExports = new Set();
  const newExports = new Set();

  const exportPattern = /(?:export\s+(?:const|function|class|async\s+function)\s+(\w+)|module\.exports\s*=\s*{([^}]+)})/gi;

  let match;
  while ((match = exportPattern.exec(oldContent)) !== null) {
    if (match[1]) oldExports.add(match[1]);
    if (match[2]) match[2].split(',').forEach(s => oldExports.add(s.trim().split(':')[0].trim()));
  }

  exportPattern.lastIndex = 0;
  while ((match = exportPattern.exec(newContent)) !== null) {
    if (match[1]) newExports.add(match[1]);
    if (match[2]) match[2].split(',').forEach(s => newExports.add(s.trim().split(':')[0].trim()));
  }

  // Find removed exports
  for (const exp of oldExports) {
    if (!newExports.has(exp)) {
      breaking.push({
        type: 'removed_export',
        name: exp,
        severity: 'high',
        hint: `Export '${exp}' was removed – this is a breaking change`,
      });
    }
  }

  // Detect changed function signatures (simplified)
  const oldFuncSigs = new Map();
  const funcSigPattern = /(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\))/gi;

  while ((match = funcSigPattern.exec(oldContent)) !== null) {
    const name = match[1] || match[2];
    if (name) {
      const sigStart = match.index;
      const sigEnd = oldContent.indexOf(')', sigStart) + 1;
      oldFuncSigs.set(name, oldContent.slice(sigStart, sigEnd));
    }
  }

  funcSigPattern.lastIndex = 0;
  while ((match = funcSigPattern.exec(newContent)) !== null) {
    const name = match[1] || match[2];
    if (name && oldFuncSigs.has(name)) {
      const sigStart = match.index;
      const sigEnd = newContent.indexOf(')', sigStart) + 1;
      const newSig = newContent.slice(sigStart, sigEnd);
      const oldSig = oldFuncSigs.get(name);

      if (oldSig !== newSig) {
        breaking.push({
          type: 'changed_signature',
          name,
          oldSig: oldSig.slice(0, 80),
          newSig: newSig.slice(0, 80),
          severity: 'medium',
        });
      }
    }
  }

  return breaking;
}

// ─── Main Export: Quick Review Function ─────────────────────────────────────

/**
 * Performs a quick review of code changes.
 * Returns immediately with findings – does not use LLM by default.
 *
 * @param {object} options
 * @param {string} options.filePath - Path to the file being edited
 * @param {string} options.newContent - New content after edit
 * @param {string} [options.oldContent] - Original content before edit (optional)
 * @param {boolean} [options.useLlm=false] - Enable semantic detection (slower but more accurate)
 * @param {Function} [options.llmCall] - LLM call function (required if useLlm=true)
 * @returns {Promise<{ passed: boolean, findings: object[], recommendation: string, blocked: boolean }>}
 */
async function quickReview(options) {
  const { filePath, newContent, oldContent, useLlm = false, llmCall } = options;

  const findings = [];
  const startTime = Date.now();

  // ── 1. Security Scan (Regex-based, always runs) ──
  for (const pattern of SECURITY_PATTERNS) {
    const matches = [...newContent.matchAll(pattern.pattern)];
    if (matches.length > 0) {
      findings.push({
        dimension: 'SECURITY',
        id: pattern.id,
        name: pattern.name,
        severity: pattern.severity,
        count: matches.length,
        hint: pattern.hint,
        locations: matches.slice(0, 3).map(m => {
          const lineNum = newContent.slice(0, m.index).split('\n').length;
          return { line: lineNum, text: m[0].slice(0, 50) };
        }),
      });
    }
  }

  // ── 2. Duplication Scan ──
  const duplicates = detectDuplication(newContent);
  if (duplicates.length > 0) {
    findings.push({
      dimension: 'DUPLICATION',
      severity: 'medium',
      count: duplicates.length,
      details: duplicates.slice(0, 5),
    });
  }

  // ── 3. Complexity Scan ──
  const complexityIssues = estimateComplexity(newContent);
  if (complexityIssues.length > 0) {
    findings.push({
      dimension: 'COMPLEXITY',
      severity: 'medium',
      count: complexityIssues.length,
      details: complexityIssues,
    });
  }

  // ── 4. Breaking Change Detection (if oldContent provided) ──
  if (oldContent) {
    const breakingChanges = detectBreakingChanges(oldContent, newContent);
    if (breakingChanges.length > 0) {
      findings.push({
        dimension: 'BREAKING',
        severity: 'high',
        count: breakingChanges.length,
        details: breakingChanges,
      });
    }
  }

  // ── 5. Self-Correction Signals (optional, uses LLM) ──
  if (useLlm && llmCall) {
    try {
      const signals = detectSignals(newContent);
      if (signals.length > 0) {
        findings.push({
          dimension: 'SEMANTIC',
          severity: signals[0].severity,
          count: signals.length,
          details: signals.slice(0, 5),
        });
      }
    } catch (err) {
      console.warn(`[WriteAroundReview] Signal detection failed: ${err.message}`);
    }
  }

  // ── Determine Verdict ──
  const criticalFindings = findings.filter(f => f.severity === 'critical');
  const highFindings = findings.filter(f => f.severity === 'high');
  const blocked = criticalFindings.length > 0;
  const passed = findings.length === 0 || (!blocked && highFindings.length === 0);

  const elapsed = Date.now() - startTime;

  let recommendation = '✅ No issues detected';
  if (blocked) {
    recommendation = `🚫 BLOCKED: ${criticalFindings.length} critical issue(s) found`;
  } else if (highFindings.length > 0) {
    recommendation = `⚠️ WARNING: ${highFindings.length} high-severity issue(s) found – review recommended`;
  } else if (findings.length > 0) {
    recommendation = `ℹ️ INFO: ${findings.length} minor issue(s) found`;
  }

  return {
    passed,
    blocked,
    findings,
    recommendation,
    elapsed,
    summary: {
      total: findings.length,
      critical: criticalFindings.length,
      high: highFindings.length,
      medium: findings.filter(f => f.severity === 'medium').length,
      low: findings.filter(f => f.severity === 'low').length,
    },
  };
}

// ─── Pre-Edit Validation Hook ───────────────────────────────────────────────

/**
 * Validates content before edit is applied.
 * Focuses on catching issues early.
 *
 * @param {object} options
 * @param {string} options.filePath - File being edited
 * @param {string} options.newContent - Content to be written
 * @param {string} [options.oldContent] - Current file content
 * @returns {Promise<{ shouldProceed: boolean, warnings: string[], errors: string[] }>}
 */
async function validateBeforeEdit(options) {
  const { filePath, newContent, oldContent } = options;

  const warnings = [];
  const errors = [];

  // Quick security scan
  for (const pattern of SECURITY_PATTERNS) {
    if (pattern.severity === 'critical' && pattern.pattern.test(newContent)) {
      errors.push(`${pattern.name}: ${pattern.hint}`);
    } else if (pattern.pattern.test(newContent)) {
      warnings.push(`${pattern.name}: ${pattern.hint}`);
    }
  }

  // Check for obvious breaking changes
  if (oldContent) {
    const breaking = detectBreakingChanges(oldContent, newContent);
    for (const b of breaking) {
      if (b.severity === 'high') {
        warnings.push(`Potential breaking change: ${b.hint || b.name}`);
      }
    }
  }

  return {
    shouldProceed: errors.length === 0,
    warnings,
    errors,
  };
}

// ─── Post-Edit Review Hook ──────────────────────────────────────────────────

/**
 * Comprehensive review after edit is applied.
 * Runs asynchronously – does not block the edit.
 *
 * @param {object} options
 * @param {string} options.filePath - File that was edited
 * @param {string} options.newContent - Content that was written
 * @param {string} [options.oldContent] - Content before edit
 * @param {object} [options.hooks] - Hook system for emitting events
 * @param {Function} [options.llmCall] - LLM call function for semantic detection
 * @param {object} [options.logger] - Logger instance
 * @returns {Promise<void>}
 */
async function reviewAfterEdit(options) {
  const { filePath, newContent, oldContent, hooks, llmCall, logger, useIncremental = true, impactRadius = 1 } = options;

  const log = (msg) => {
    if (logger) {
      logger.info('WriteAroundReview', msg);
    }
    console.log(`[WriteAroundReview] ${msg}`);
  };

  try {
    log(`🔍 Starting post-edit review for: ${filePath}`);

    // Use incremental review if oldContent is available (for edits, not new files)
    let result;
    if (useIncremental && oldContent) {
      log(`📊 Using incremental review (impact radius: ${impactRadius})`);
      const { incrementalReview } = require('./incremental-review');
      
      // Calculate scope and get filtered content
      const incResult = await incrementalReview({
        filePath,
        newContent,
        oldContent,
        impactRadius,
        language: filePath.split('.').pop(),
      });
      
      log(`📉 Token reduction: ${incResult.scope?.reductionRatio || 'N/A'}%`);
      
      // Run quickReview on filtered content
      result = await quickReview({
        filePath,
        newContent: incResult.filteredContent || newContent,
        oldContent: null,
        useLlm: !!llmCall,
        llmCall,
      });
      
      // Add scope info to result
      result.scope = incResult.scope;
      result.reviewFunctions = incResult.reviewFunctions;
      result.diffSummary = incResult.diffSummary;
    } else {
      log(`📄 Using full file review`);
      result = await quickReview({
        filePath,
        newContent,
        oldContent,
        useLlm: !!llmCall,
        llmCall,
      });
    }

    log(`✅ Review complete in ${result.elapsed}ms: ${result.recommendation}`);

    // Emit event if hooks are available
    if (hooks && typeof hooks.emit === 'function') {
      await hooks.emit('write_around_review_complete', {
        filePath,
        result,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }

    // If blocked, emit critical event
    if (result.blocked && hooks && typeof hooks.emit === 'function') {
      await hooks.emit('write_around_review_blocked', {
        filePath,
        findings: result.findings.filter(f => f.severity === 'critical'),
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }

    return result;
  } catch (err) {
    log(`❌ Review failed: ${err.message}`);
    // Don't throw – post-edit review is best-effort
    return {
      passed: true,
      blocked: false,
      findings: [],
      recommendation: '⚠️ Review failed – manual inspection recommended',
      error: err.message,
    };
  }
}

// ─── Integration Helper ─────────────────────────────────────────────────────

/**
 * Wraps an edit operation with write-around review.
 * Use this to add review to any edit function.
 *
 * @example
 * const reviewedEdit = withWriteAroundReview(fs.writeFileSync);
 * await reviewedEdit('/path/to/file.js', newContent);
 *
 * @param {Function} editFn - Original edit function
 * @param {object} options - Review options
 * @returns {Function} Wrapped function with review
 */
function withWriteAroundReview(editFn, options = {}) {
  return async function reviewedEdit(filePath, newContent, ...args) {
    const { hooks, llmCall, logger, skipReview = false } = options;

    // Read old content if needed
    let oldContent;
    try {
      const fs = require('fs');
      if (fs.existsSync(filePath)) {
        oldContent = fs.readFileSync(filePath, 'utf-8');
      }
    } catch (err) {
      // File doesn't exist or can't be read – that's OK
    }

    // Pre-edit validation
    if (!skipReview) {
      const validation = await validateBeforeEdit({ filePath, newContent, oldContent });

      if (!validation.shouldProceed) {
        const errorMsg = `Edit blocked by pre-edit validation:\n${validation.errors.join('\n')}`;
        if (logger) logger.error('WriteAroundReview', errorMsg);
        throw new Error(errorMsg);
      }

      if (validation.warnings.length > 0) {
        const warnMsg = `Warnings for ${filePath}:\n${validation.warnings.join('\n')}`;
        if (logger) logger.warn('WriteAroundReview', warnMsg);
      }
    }

    // Apply the edit
    const result = editFn(filePath, newContent, ...args);

    // Post-edit review (async, non-blocking)
    if (!skipReview) {
      setImmediate(() => {
        reviewAfterEdit({ filePath, newContent, oldContent, hooks, llmCall, logger }).catch(() => {});
      });
    }

    return result;
  };
}

// ─── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  quickReview,
  validateBeforeEdit,
  reviewAfterEdit,
  withWriteAroundReview,
  detectDuplication,
  estimateComplexity,
  detectBreakingChanges,
  SECURITY_PATTERNS,
  QUICK_REVIEW_DIMENSIONS,
};
