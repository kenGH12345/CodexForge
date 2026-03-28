/**
 * Code Quality Evaluator — 代码质量评估器
 *
 * Purpose: 自动评估代码产出质量，包括 Lint、复杂度、可维护性、架构合理性
 *
 * Key Metrics:
 *   - Lint Score: 代码规范符合度
 *   - Complexity: 圈复杂度、认知复杂度
 *   - Maintainability: Halstead 复杂度、可维护性指数
 *   - Architecture: 模块化程度、依赖合理性
 *
 * ADR-37 Compliance: 
 *   - 优先使用 IDE 原生 LSP 能力
 *   - 自建模块作为 fallback
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Quality Metrics Computation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Computes lint score based on available linters.
 * @param {string} projectPath - Path to project
 * @param {string[]} changedFiles - List of changed files
 * @returns {Promise<{score: number, issues: number, errors: number, warnings: number}>}
 */
async function computeLintScore(projectPath, changedFiles) {
  const result = {
    score: 100,
    issues: 0,
    errors: 0,
    warnings: 0,
    details: [],
  };

  // Detect available linters
  const linters = detectAvailableLinters(projectPath);
  
  if (linters.length === 0) {
    // No linter available, use basic checks
    return computeBasicStyleScore(projectPath, changedFiles);
  }

  for (const linter of linters) {
    try {
      const lintResult = await runLinter(projectPath, linter, changedFiles);
      result.errors += lintResult.errors;
      result.warnings += lintResult.warnings;
      result.details.push(...lintResult.details);
    } catch (err) {
      console.warn(`[CodeQuality] Linter ${linter.name} failed:`, err.message);
    }
  }

  result.issues = result.errors + result.warnings;
  
  // Score calculation: 100 - (errors * 5) - (warnings * 1)
  // Min score: 0
  result.score = Math.max(0, 100 - (result.errors * 5) - (result.warnings * 1));
  
  return result;
}

/**
 * Detects available linters for the project.
 */
function detectAvailableLinters(projectPath) {
  const linters = [];
  const packageJsonPath = path.join(projectPath, 'package.json');
  
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    
    // Check for ESLint
    if (hasDependency(packageJson, 'eslint')) {
      linters.push({ name: 'eslint', cmd: 'npx eslint --format json' });
    }
    
    // Check for Prettier
    if (hasDependency(packageJson, 'prettier')) {
      linters.push({ name: 'prettier', cmd: 'npx prettier --check' });
    }
    
    // Check for TypeScript compiler
    if (hasDependency(packageJson, 'typescript')) {
      linters.push({ name: 'tsc', cmd: 'npx tsc --noEmit' });
    }
  }
  
  // Check for Python linters
  if (fs.existsSync(path.join(projectPath, 'requirements.txt')) ||
      fs.existsSync(path.join(projectPath, 'pyproject.toml'))) {
    if (fs.existsSync(path.join(projectPath, '.flake8')) || 
        fs.existsSync(path.join(projectPath, 'setup.cfg'))) {
      linters.push({ name: 'flake8', cmd: 'flake8 --format=json' });
    }
  }
  
  return linters;
}

/**
 * Checks if a dependency exists in package.json
 */
function hasDependency(packageJson, depName) {
  const deps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
  };
  return Object.keys(deps).some(name => 
    name === depName || name.startsWith(`${depName}/`)
  );
}

/**
 * Runs a linter and returns results.
 */
async function runLinter(projectPath, linter, files) {
  const result = {
    errors: 0,
    warnings: 0,
    details: [],
  };

  try {
    // Run linter on specific files
    const cmd = `cd "${projectPath}" && ${linter.cmd} ${files.join(' ')} 2>/dev/null || true`;
    const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    
    // Parse output based on linter type
    if (linter.name === 'eslint') {
      const reports = JSON.parse(output);
      for (const report of reports) {
        result.errors += report.errorCount || 0;
        result.warnings += report.warningCount || 0;
        result.details.push(...(report.messages || []).map(m => ({
          file: report.filePath,
          line: m.line,
          severity: m.severity === 2 ? 'error' : 'warning',
          message: m.message,
          rule: m.ruleId,
        })));
      }
    }
  } catch (err) {
    // Linter errors are expected format, not execution errors
  }

  return result;
}

/**
 * Computes basic style score without external linters.
 */
function computeBasicStyleScore(projectPath, files) {
  const issues = [];
  
  for (const file of files) {
    const filePath = path.join(projectPath, file);
    if (!fs.existsSync(filePath)) continue;
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    // Check trailing spaces
    lines.forEach((line, idx) => {
      if (line.endsWith(' ')) {
        issues.push({
          file: file,
          line: idx + 1,
          severity: 'warning',
          message: 'Trailing whitespace detected',
          rule: 'style/trailing-space',
        });
      }
    });
    
    // Check line endings (should be LF)
    if (content.includes('\r\n')) {
      issues.push({
        file: file,
        line: 0,
        severity: 'warning',
        message: 'CRLF line endings detected',
        rule: 'style/line-ending',
      });
    }
    
    // Check file ending newline
    if (!content.endsWith('\n')) {
      issues.push({
        file: file,
        line: lines.length,
        severity: 'warning',
        message: 'No newline at end of file',
        rule: 'style/eof-newline',
      });
    }
    
    // Check tab indentation (should use spaces)
    lines.forEach((line, idx) => {
      if (line.startsWith('\t')) {
        issues.push({
          file: file,
          line: idx + 1,
          severity: 'warning',
          message: 'Tab indentation detected (use spaces)',
          rule: 'style/indentation',
        });
      }
    });
  }
  
  return {
    score: Math.max(0, 100 - issues.length),
    issues: issues.length,
    errors: 0,
    warnings: issues.length,
    details: issues,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: Complexity Analysis
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Computes cyclomatic complexity for code.
 * @param {string} code - Source code
 * @returns {number} Complexity score
 */
function computeCyclomaticComplexity(code) {
  // Simple heuristic-based complexity estimation
  let complexity = 1; // Base complexity
  
  // Count decision points
  const patterns = [
    /\bif\b/g,
    /\belse\s+if\b/g,
    /\bswitch\b/g,
    /\bcase\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bdo\b/g,
    /\?\s*[^:]+\s*:/g, // ternary
    /\|\|/g, // logical OR
    /&&/g,   // logical AND
    /\bcatch\b/g,
  ];
  
  for (const pattern of patterns) {
    const matches = code.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }
  
  return complexity;
}

/**
 * Computes cognitive complexity (simplified version).
 * Similar to cyclomatic but increments for nesting.
 */
function computeCognitiveComplexity(code) {
  let complexity = 0;
  let nestingLevel = 0;
  const lines = code.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Increase nesting
    if (/^\{/.test(trimmed) || /\{$/.test(trimmed)) {
      nestingLevel++;
    }
    // Decrease nesting
    else if (/^\}/.test(trimmed)) {
      nestingLevel--;
    }
    // Decision points with nesting penalty
    else if (/\b(if|switch|for|while)\b/.test(trimmed)) {
      complexity += 1 + nestingLevel;
    }
  }
  
  return complexity;
}

/**
 * Analyzes complexity of changed files.
 * @param {string} projectPath
 * @param {string[]} files
 * @returns {Object} Complexity metrics
 */
function analyzeComplexity(projectPath, files) {
  const results = {
    files: [],
    avgCyclomatic: 0,
    avgCognitive: 0,
    maxCyclomatic: 0,
    maxCognitive: 0,
    functions: [],
  };

  for (const file of files) {
    const filePath = path.join(projectPath, file);
    if (!fs.existsSync(filePath)) continue;
    
    // Skip non-code files
    const ext = path.extname(file);
    if (!['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs'].includes(ext)) {
      continue;
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const cyclo = computeCyclomaticComplexity(content);
    const cognitive = computeCognitiveComplexity(content);
    
    results.files.push({
      file,
      cyclomatic: cyclo,
      cognitive,
    });
    
    results.maxCyclomatic = Math.max(results.maxCyclomatic, cyclo);
    results.maxCognitive = Math.max(results.maxCognitive, cognitive);
  }

  // Calculate averages
  if (results.files.length > 0) {
    results.avgCyclomatic = results.files.reduce((a, b) => a + b.cyclomatic, 0) / results.files.length;
    results.avgCognitive = results.files.reduce((a, b) => a + b.cognitive, 0) / results.files.length;
  }

  // Score: max 10 complexity is acceptable
  const complexityScore = Math.max(0, 100 - (results.avgCyclomatic - 10) * 5);
  
  return {
    ...results,
    score: Math.min(100, complexityScore),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: Architecture & Maintainability Analysis
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Analyzes code maintainability.
 * Based on Halstead metrics and maintainability index.
 */
function computeMaintainabilityMetrics(code, filePath) {
  // Halstead Volume (simplified)
  const operators = code.match(/[\+\-\*\/\=\%\!\&\|\^\~\<\>\?\:]+/g) || [];
  const operands = code.match(/\b[a-zA-Z_]\w*\b/g) || [];
  
  const n1 = new Set(operators).size; // Unique operators
  const n2 = new Set(operands).size;  // Unique operands
  const N1 = operators.length;        // Total operators
  const N2 = operands.length;         // Total operands
  
  // Calculate Halstead metrics
  const vocabulary = n1 + n2;
  const length = N1 + N2;
  const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
  
  // Maintainability Index (simplified version)
  // MI = 171 - 5.2 * ln(Halstead Volume) - 0.23 * (Cyclomatic Complexity) - 16.2 * ln(Lines of Code)
  const lines = code.split('\n').length;
  const cyclomatic = computeCyclomaticComplexity(code);
  
  const maintainabilityIndex = 171 
    - 5.2 * Math.log(volume + 1)
    - 0.23 * cyclomatic
    - 16.2 * Math.log(lines + 1);

  return {
    halstead: {
      volume: Math.round(volume),
      vocabulary,
      length,
    },
    cyclomatic,
    lines,
    maintainabilityIndex: Math.min(171, Math.max(0, maintainabilityIndex)),
  };
}

/**
 * Analyzes architecture quality.
 */
function analyzeArchitecture(projectPath, files) {
  const metrics = {
    moduleCount: 0,
    avgModuleSize: 0,
    couplingScore: 0,  // Lower is better
    cohesionScore: 0,  // Higher is better
    score: 0,
  };

  // Count files by directory (modules)
  const modules = new Map();
  for (const file of files) {
    const dir = path.dirname(file);
    modules.set(dir, (modules.get(dir) || 0) + 1);
  }

  metrics.moduleCount = modules.size;
  
  if (modules.size > 0) {
    metrics.avgModuleSize = files.length / modules.size;
    
    // Score: Ideal module size is 3-7 files per module
    if (metrics.avgModuleSize >= 3 && metrics.avgModuleSize <= 7) {
      metrics.score += 40;
    } else if (metrics.avgModuleSize > 0) {
      const deviation = Math.abs(metrics.avgModuleSize - 5);
      metrics.score += Math.max(0, 40 - deviation * 5);
    }
  }

  // Check for test co-location (good practice)
  let testFiles = 0;
  let sourceFiles = 0;
  
  for (const file of files) {
    if (/\.(test|spec)\.(js|ts|jsx|tsx|py)$/.test(file)) {
      testFiles++;
    } else if (/\.(js|ts|jsx|tsx|py|java|go|rs)$/.test(file)) {
      sourceFiles++;
    }
  }

  // Score test coverage ratio
  const testRatio = sourceFiles > 0 ? testFiles / sourceFiles : 0;
  metrics.score += Math.min(30, testRatio * 30);

  // Check for clear separation (core/, utils/, types/, etc.)
  const commonDirs = ['core', 'utils', 'helpers', 'types', 'models', 'services', 'tests'];
  const hasGoodStructure = commonDirs.some(dir => 
    files.some(f => f.includes(`/${dir}/`))
  );
  
  if (hasGoodStructure) {
    metrics.score += 30;
  }

  return metrics;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: Main Quality Evaluator Class
// ═══════════════════════════════════════════════════════════════════════════

class CodeQualityEvaluator {
  constructor(options = {}) {
    this.projectPath = options.projectPath || process.cwd();
    this.verbose = options.verbose || false;
    this.useExternalTools = options.useExternalTools !== false;
  }

  /**
   * Evaluates code quality for changed files.
   * @param {Object} result - ExecutionResult
   * @returns {Promise<Object>} Quality metrics
   */
  async evaluate(result) {
    const files = Object.keys(result.artifacts || {});
    const projectPath = this.projectPath;

    const evaluation = {
      lint: null,
      complexity: null,
      maintainability: null,
      architecture: null,
      overallScore: 0,
    };

    // 1. Lint Score
    try {
      evaluation.lint = await computeLintScore(projectPath, files);
    } catch (err) {
      this._log('Lint evaluation failed:', err.message);
      evaluation.lint = { score: 0, issues: 0, errors: 0, warnings: 0, details: [] };
    }

    // 2. Complexity Analysis
    try {
      evaluation.complexity = analyzeComplexity(projectPath, files);
    } catch (err) {
      this._log('Complexity analysis failed:', err.message);
      evaluation.complexity = { score: 0, files: [], avgCyclomatic: 0, avgCognitive: 0 };
    }

    // 3. Maintainability Analysis
    try {
      const maintainabilityResults = [];
      for (const file of files) {
        const filePath = path.join(projectPath, file);
        if (!fs.existsSync(filePath)) continue;
        
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.length > 100) { // Skip tiny files
          maintainabilityResults.push(computeMaintainabilityMetrics(content, file));
        }
      }
      
      evaluation.maintainability = {
        files: maintainabilityResults,
        avgIndex: maintainabilityResults.length > 0
          ? maintainabilityResults.reduce((a, b) => a + b.maintainabilityIndex, 0) / maintainabilityResults.length
          : 0,
        score: 0,
      };
      
      // Convert MI to score (171 is max)
      evaluation.maintainability.score = (evaluation.maintainability.avgIndex / 171) * 100;
    } catch (err) {
      this._log('Maintainability analysis failed:', err.message);
      evaluation.maintainability = { score: 0, files: [], avgIndex: 0 };
    }

    // 4. Architecture Analysis
    try {
      evaluation.architecture = analyzeArchitecture(projectPath, files);
    } catch (err) {
      this._log('Architecture analysis failed:', err.message);
      evaluation.architecture = { score: 0, moduleCount: 0, avgModuleSize: 0 };
    }

    // 5. Calculate Overall Score (weighted)
    evaluation.overallScore = this._computeOverallScore(evaluation);

    return evaluation;
  }

  /**
   * Computes weighted overall quality score.
   */
  _computeOverallScore(evaluation) {
    const weights = {
      lint: 0.25,
      complexity: 0.25,
      maintainability: 0.30,
      architecture: 0.20,
    };

    let score = 0;
    let totalWeight = 0;

    if (evaluation.lint) {
      score += evaluation.lint.score * weights.lint;
      totalWeight += weights.lint;
    }
    if (evaluation.complexity) {
      score += evaluation.complexity.score * weights.complexity;
      totalWeight += weights.complexity;
    }
    if (evaluation.maintainability) {
      score += evaluation.maintainability.score * weights.maintainability;
      totalWeight += weights.maintainability;
    }
    if (evaluation.architecture) {
      score += evaluation.architecture.score * weights.architecture;
      totalWeight += weights.architecture;
    }

    return totalWeight > 0 ? Math.round(score / totalWeight) : 0;
  }

  _log(...args) {
    if (this.verbose) {
      console.log('[CodeQualityEvaluator]', ...args);
    }
  }
}

module.exports = {
  CodeQualityEvaluator,
  computeLintScore,
  computeCyclomaticComplexity,
  computeCognitiveComplexity,
  computeMaintainabilityMetrics,
  analyzeArchitecture,
};
