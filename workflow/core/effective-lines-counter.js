/**
 * Effective Lines Counter – Counts meaningful code lines (excludes comments & blanks)
 *
 * PROBLEM: architecture-constraints.md uses raw line counts, but:
 *   - Comments can occupy 30-50% of well-documented files
 *   - Blank lines improve readability but inflate counts
 *   - Current 400-line limit triggers false alarms on files with rich documentation
 *
 * SOLUTION: Count only "effective lines":
 *   - Code statements (function definitions, expressions, etc.)
 *   - Exclude: single-line comments, multi-line comments, blank lines
 *   - Configurable comment ratio threshold (default: 30%)
 *
 * @module workflow/core/effective-lines-counter
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Configuration Loading ─────────────────────────────────────────────────

/**
 * Load effective lines configuration from workflow.config.js via config-loader.
 * Falls back to defaults if config is not available or disabled.
 */
function loadConfig() {
  try {
    const { getConfig } = require('./config-loader');
    const config = getConfig();
    
    if (config.effectiveLines && config.effectiveLines.enabled !== false) {
      return {
        enabled: true,
        tiers: config.effectiveLines.tiers || {},
        commentRatioWarning: config.effectiveLines.commentRatioWarning || 50,
      };
    }
  } catch (_) {
    // Config not available or malformed, use defaults
  }
  
  return {
    enabled: true,
    tiers: {},
    commentRatioWarning: 50,
  };
}

const CONFIG = loadConfig();

// ─── Language Patterns ───────────────────────────────────────────────────────

const LANGUAGE_PATTERNS = {
  javascript: {
    singleLineComment: /^\s*(\/\/|#).*$/,
    multiLineStart: /\/\*/,
    multiLineEnd: /\*\//,
    blankLine: /^\s*$/,
    codeIndicators: [
      /^\s*(function|const|let|var|class|export|import|return|if|else|for|while|switch|try|catch|throw|async|await|new|\w+\s*\(|\w+\s*=)/,
      /^\s*['"`].*['"`]\s*[,;]?$/,  // String literals
      /^\s*[\]\[{}\(\)\w\s,;]+$/,   // Arrays, objects, parameters
    ],
  },
  typescript: {
    singleLineComment: /^\s*(\/\/|#).*$/,
    multiLineStart: /\/\*/,
    multiLineEnd: /\*\//,
    blankLine: /^\s*$/,
    codeIndicators: [
      /^\s*(function|const|let|var|class|export|import|return|if|else|for|while|switch|try|catch|throw|async|await|new|interface|type|enum|namespace|\w+\s*[:(]|\w+\s*=)/,
      /^\s*['"`].*['"`]\s*[,;]?$/,
      /^\s*[\]\[{}\(\)\w\s,;:<>=]+$/,
    ],
  },
  python: {
    singleLineComment: /^\s*#.*$/,
    multiLineStart: /'''|"""/,
    multiLineEnd: /'''|"""/,
    blankLine: /^\s*$/,
    codeIndicators: [
      /^\s*(def|class|import|from|return|if|else|elif|for|while|try|except|raise|with|async|await|@|\w+\s*=|\w+\s*\()/,
      /^\s*['"`].*['"`]\s*[,;]?$/,
      /^\s*[\]\[{}\(\)\w\s,:]+$/,
    ],
  },
  go: {
    singleLineComment: /^\s*\/\/.*$/,
    multiLineStart: /\/\*/,
    multiLineEnd: /\*\//,
    blankLine: /^\s*$/,
    codeIndicators: [
      /^\s*(func|type|var|const|import|package|return|if|else|for|switch|select|go|defer|chan|struct|interface|\w+\s*[:(=]|\w+\s*\()/,
      /^\s*['"`].*['"`]\s*[,;]?$/,
      /^\s*[\]\[{}\(\)\w\s,:.]+$/,
    ],
  },
  java: {
    singleLineComment: /^\s*\/\/.*$/,
    multiLineStart: /\/\*/,
    multiLineEnd: /\*\//,
    blankLine: /^\s*$/,
    codeIndicators: [
      /^\s*(public|private|protected|class|interface|enum|extends|implements|import|package|return|if|else|for|while|switch|try|catch|throw|new|static|final|void|\w+\s+[<\w]+\s*\(|\w+\s*=)/,
      /^\s*['"`].*['"`]\s*[,;]?$/,
      /^\s*[\]\[{}\(\)\w\s,;:<>.]+$/,
    ],
  },
};

// ─── Core Counting Functions ─────────────────────────────────────────────────

/**
 * Counts effective (non-comment, non-blank) lines in source code.
 *
 * @param {string} content - Source code content
 * @param {string} language - Language hint ('javascript', 'python', etc.)
 * @returns {{ totalLines: number, effectiveLines: number, commentLines: number, blankLines: number, commentRatio: number }}
 */
function countEffectiveLines(content, language = 'javascript') {
  const lines = content.split('\n');
  const patterns = LANGUAGE_PATTERNS[language] || LANGUAGE_PATTERNS.javascript;

  let effectiveLines = 0;
  let commentLines = 0;
  let blankLines = 0;
  let inMultiLineComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Handle blank lines
    if (patterns.blankLine.test(trimmedLine)) {
      blankLines++;
      continue;
    }

    // Handle multi-line comments
    if (inMultiLineComment) {
      commentLines++;
      if (patterns.multiLineEnd.test(trimmedLine)) {
        inMultiLineComment = false;
      }
      continue;
    }

    // Check for multi-line comment start
    if (patterns.multiLineStart.test(trimmedLine)) {
      commentLines++;
      // Check if it also ends on the same line
      if (!patterns.multiLineEnd.test(trimmedLine)) {
        inMultiLineComment = true;
      }
      continue;
    }

    // Handle single-line comments
    if (patterns.singleLineComment.test(trimmedLine)) {
      commentLines++;
      continue;
    }

    // Check if line looks like code
    const isCode = patterns.codeIndicators.some(pattern => pattern.test(trimmedLine));
    
    if (isCode || trimmedLine.length > 0) {
      effectiveLines++;
    } else {
      // Fallback: treat as comment if it doesn't match any pattern
      commentLines++;
    }
  }

  const totalLines = lines.length;
  const commentRatio = totalLines > 0 ? (commentLines / totalLines) * 100 : 0;

  return {
    totalLines,
    effectiveLines,
    commentLines,
    blankLines,
    commentRatio: parseFloat(commentRatio.toFixed(2)),
  };
}

/**
 * Analyzes a file and returns effective line metrics.
 *
 * @param {string} filePath - Path to the file
 * @returns {{ totalLines: number, effectiveLines: number, commentLines: number, blankLines: number, commentRatio: number, language: string }}
 */
function analyzeFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  
  const languageMap = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.java': 'java',
  };

  const language = languageMap[ext] || 'javascript';
  const result = countEffectiveLines(content, language);

  return {
    ...result,
    language,
    filePath,
  };
}

// ─── Tiered Limits Configuration ─────────────────────────────────────────────

/**
 * Default tiered file size limits based on file role and complexity.
 * Can be overridden via workflow.config.js → effectiveLines.tiers
 *
 * @typedef {Object} FileTier
 * @property {number} maxEffectiveLines - Maximum effective lines for this tier
 * @property {number} maxTotalLines - Maximum total lines (hard limit)
 * @property {string[]} patterns - File patterns that match this tier
 */

const DEFAULT_FILE_TIERS = [
  {
    name: 'entry-point',
    description: 'Entry points (index.js, main entry)',
    maxEffectiveLines: 700,
    maxTotalLines: 1000,
    patterns: ['index.js', 'main.js', 'app.js', 'server.js'],
  },
  {
    name: 'core-critical',
    description: 'Critical core modules (orchestrators, engines)',
    maxEffectiveLines: 1000,
    maxTotalLines: 1500,
    patterns: [
      'orchestrator-*.js',
      '*-engine.js',
      'state-machine.js',
      'quality-gate.js',
    ],
  },
  {
    name: 'core-standard',
    description: 'Standard core modules',
    maxEffectiveLines: 800,
    maxTotalLines: 1200,
    patterns: ['core/*.js'],
  },
  {
    name: 'agent',
    description: 'Agent implementations',
    maxEffectiveLines: 250,
    maxTotalLines: 400,
    patterns: ['agents/*.js'],
  },
  {
    name: 'command',
    description: 'Command handlers',
    maxEffectiveLines: 400,
    maxTotalLines: 600,
    patterns: ['commands/commands-*.js', 'commands/command-*.js'],
  },
  {
    name: 'default',
    description: 'Default limit for all other files',
    maxEffectiveLines: 300,
    maxTotalLines: 500,
    patterns: ['*'],
  },
];

/**
 * Get file tiers, merging defaults with config overrides
 */
function getFileTiers() {
  const configTiers = CONFIG.tiers || {};
  
  return DEFAULT_FILE_TIERS.map(tier => {
    const configOverride = configTiers[tier.name];
    if (configOverride) {
      return {
        ...tier,
        maxEffectiveLines: configOverride.maxEffectiveLines || tier.maxEffectiveLines,
        maxTotalLines: configOverride.maxTotalLines || tier.maxTotalLines,
      };
    }
    return tier;
  });
}

// Export for backwards compatibility
const FILE_TIERS = DEFAULT_FILE_TIERS;

/**
 * Determines the tier for a given file path.
 *
 * @param {string} filePath - File path to check
 * @returns {FileTier} The matching tier
 */
function getFileTier(filePath) {
  const tiers = getFileTiers();
  const basename = path.basename(filePath);
  const relativePath = filePath.replace(/\\/g, '/');

  for (const tier of tiers) {
    for (const pattern of tier.patterns) {
      // Handle glob-style patterns
      if (pattern.includes('*')) {
        const regex = new RegExp(
          pattern
            .replace(/\./g, '\\.')
            .replace(/\*/g, '.*')
        );
        if (regex.test(basename) || regex.test(relativePath)) {
          return tier;
        }
      } else if (basename === pattern || relativePath.includes(pattern)) {
        return tier;
      }
    }
  }

  // Fallback to default tier
  return tiers.find(t => t.name === 'default');
}

/**
 * Checks if a file violates its tier limits.
 *
 * @param {string} filePath - File path to check
 * @returns {{ tier: FileTier, analysis: object, violations: string[], isViolation: boolean }}
 */
function checkFileLimit(filePath) {
  const analysis = analyzeFile(filePath);
  const tier = getFileTier(filePath);
  const violations = [];
  const commentRatioWarning = CONFIG.commentRatioWarning || 50;

  // Check effective lines
  if (analysis.effectiveLines > tier.maxEffectiveLines) {
    violations.push(
      `Effective lines (${analysis.effectiveLines}) exceed tier limit (${tier.maxEffectiveLines})`
    );
  }

  // Check total lines (hard limit)
  if (analysis.totalLines > tier.maxTotalLines) {
    violations.push(
      `Total lines (${analysis.totalLines}) exceed hard limit (${tier.maxTotalLines})`
    );
  }

  // Check comment ratio warning (configurable threshold)
  if (analysis.commentRatio > commentRatioWarning) {
    violations.push(
      `High comment ratio (${analysis.commentRatio.toFixed(1)}%) — consider splitting or simplifying`
    );
  }

  return {
    tier,
    analysis,
    violations,
    isViolation: violations.length > 0,
  };
}

// ─── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  countEffectiveLines,
  analyzeFile,
  getFileTier,
  checkFileLimit,
  getFileTiers,
  loadConfig,
  FILE_TIERS,
  LANGUAGE_PATTERNS,
};
