/**
 * Functionality Evaluator — 功能正确性与完整性评估器
 *
 * Purpose: 自动评估代码产出的功能正确性和完整性
 *
 * Key Metrics:
 *   - Functional Correctness: 核心逻辑正确性、边界情况、类型正确性
 *   - Functional Completeness: 需求覆盖度、功能完整度、API完整度
 *
 * ADR-37 Compliance: 优先使用 IDE 原生工具，自建模块兜底
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Functional Correctness Assessment
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assesses functional correctness through multiple channels.
 * @param {ExecutionResult} result
 * @param {BenchmarkTask} task
 * @returns {Object} Correctness metrics
 */
async function assessFunctionalCorrectness(result, task) {
  const correctness = {
    coreLogicCorrectness: 0,      // 核心逻辑正确性
    edgeCaseHandling: 0,          // 边界情况处理
    typeCorrectness: 0,           // 类型正确性
    outputValidation: 0,          // 输出验证
    score: 0,
    details: [],
  };

  // 1. Core Logic Correctness (via test execution)
  const testResult = await runTests(result, task);
  correctness.coreLogicCorrectness = testResult.passRate;
  correctness.details.push({
    metric: 'coreLogicCorrectness',
    score: testResult.passRate,
    evidence: testResult.summary,
  });

  // 2. Edge Case Handling (via static analysis or test coverage)
  const edgeCases = await analyzeEdgeCases(result, task);
  correctness.edgeCaseHandling = edgeCases.score;
  correctness.details.push({
    metric: 'edgeCaseHandling',
    score: edgeCases.score,
    evidence: edgeCases.foundCases,
  });

  // 3. Type Correctness (TypeScript compilation check)
  const typeResult = await checkTypeCorrectness(result, task);
  correctness.typeCorrectness = typeResult.score;
  correctness.details.push({
    metric: 'typeCorrectness',
    score: typeResult.score,
    evidence: typeResult.errors,
  });

  // 4. Output Validation (semantic output check)
  const outputResult = await validateOutput(result, task);
  correctness.outputValidation = outputResult.score;
  correctness.details.push({
    metric: 'outputValidation',
    score: outputResult.score,
    evidence: outputResult.validationReport,
  });

  // Calculate weighted score
  const weights = {
    coreLogicCorrectness: 0.40,
    edgeCaseHandling: 0.25,
    typeCorrectness: 0.20,
    outputValidation: 0.15,
  };

  correctness.score = Math.round(
    correctness.coreLogicCorrectness * weights.coreLogicCorrectness +
    correctness.edgeCaseHandling * weights.edgeCaseHandling +
    correctness.typeCorrectness * weights.typeCorrectness +
    correctness.outputValidation * weights.outputValidation
  );

  return correctness;
}

/**
 * Runs tests and returns pass rate.
 */
async function runTests(executionResult, task) {
  const result = {
    passRate: 0,
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    summary: '',
  };

  // Check for test files in artifacts
  const testFiles = Object.keys(executionResult.artifacts || {}).filter(f => 
    /\.(test|spec)\.(js|ts|jsx|tsx|py)$/.test(f)
  );

  if (testFiles.length === 0) {
    result.summary = 'No test files found';
    return result;
  }

  // Try to run tests (if in testable environment)
  try {
    // Check for package.json to determine test command
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      
      if (packageJson.scripts?.test) {
        const output = execSync('npm test 2>&1 || true', { 
          encoding: 'utf-8',
          timeout: 60000,
        });
        
        // Parse test results
        // Jest format
        const jestMatch = output.match(/Tests:\s+(\d+)\s+passed,?\s+(\d+)\s+failed/);
        if (jestMatch) {
          result.passedTests = parseInt(jestMatch[1], 10);
          result.failedTests = parseInt(jestMatch[2], 10);
          result.totalTests = result.passedTests + result.failedTests;
          result.passRate = result.totalTests > 0 
            ? (result.passedTests / result.totalTests) * 100 
            : 0;
        }
        
        // Mocha/Vitest format
        const mochaMatch = output.match(/passing\s*\((\d+)\)|(\d+)\s+passing/);
        const failMatch = output.match(/failing\s*\((\d+)\)|(\d+)\s+failing/);
        if (mochaMatch && !jestMatch) {
          result.passedTests = parseInt(mochaMatch[1] || mochaMatch[2], 10) || 0;
          result.failedTests = parseInt(failMatch?.[1] || failMatch?.[2], 10) || 0;
          result.totalTests = result.passedTests + result.failedTests;
          result.passRate = result.totalTests > 0 
            ? (result.passedTests / result.totalTests) * 100 
            : 0;
        }
        
        result.summary = `Tests: ${result.passedTests}/${result.totalTests} passed`;
      }
    }
  } catch (err) {
    result.summary = `Test execution failed: ${err.message}`;
  }

  // Fallback: check test output in artifacts
  const testReport = executionResult.artifacts?.['test-report.md'] || '';
  if (testReport) {
    const passMatch = testReport.match(/(\d+)%\s*pass|passed[:\s]*(\d+)%/i);
    if (passMatch) {
      result.passRate = parseInt(passMatch[1] || passMatch[2], 10);
      result.summary = `Reported pass rate: ${result.passRate}%`;
    }
  }

  return result;
}

/**
 * Analyzes edge case handling through static code analysis.
 */
async function analyzeEdgeCases(result, task) {
  const analysis = {
    score: 0,
    foundCases: 0,
    expectedCases: 0,
    cases: [],
  };

  const codeFiles = Object.entries(result.artifacts || {}).filter(([f]) => 
    /\.(js|ts|jsx|tsx|py|java|go|rs)$/.test(f) && !/\.(test|spec)\./.test(f)
  );

  // Edge case patterns to look for
  const edgeCasePatterns = [
    { pattern: /null|undefined|None|nullptr/gi, name: 'null handling', weight: 1 },
    { pattern: /empty|length\s*===?\s*0|\.length\s*===?\s*0/gi, name: 'empty input', weight: 1 },
    { pattern: /try\s*\{|catch|except|rescue/gi, name: 'exception handling', weight: 2 },
    { pattern: /if\s*\([^)]+\?\s*[:\|]/gi, name: 'ternary checks', weight: 0.5 },
    { pattern: /typeof|instanceof|isinstance|type\s*\(/gi, name: 'type guards', weight: 1 },
    { pattern: /\.default|default:|fallback/gi, name: 'default values', weight: 0.5 },
    { pattern: /Array\.isArray|isArray|Array\s*instanceof/gi, name: 'array validation', weight: 1 },
    { pattern: /Number\.isNaN|isNaN|isnan/gi, name: 'NaN checks', weight: 1 },
    { pattern: /infinity|\/\s*0|division by zero/gi, name: 'infinity checks', weight: 1 },
    { pattern: /negative|negative\s*number|Math\.abs/gi, name: 'negative number handling', weight: 1 },
  ];

  for (const [file, content] of codeFiles) {
    for (const { pattern, name, weight } of edgeCasePatterns) {
      const matches = content.match(pattern);
      if (matches) {
        analysis.foundCases += weight * matches.length;
        analysis.cases.push({
          file,
          type: name,
          count: matches.length,
        });
      }
    }
  }

  // Estimate expected edge cases based on task complexity
  const levelMultiplier = {
    'simple': 2,
    'medium': 4,
    'complex': 6,
    'production': 8,
  };
  analysis.expectedCases = (levelMultiplier[task.level] || 4) * codeFiles.length;

  // Calculate score
  if (analysis.expectedCases > 0) {
    analysis.score = Math.min(100, (analysis.foundCases / analysis.expectedCases) * 100);
  }

  return analysis;
}

/**
 * Checks TypeScript type correctness.
 */
async function checkTypeCorrectness(result, task) {
  const check = {
    score: 100,
    errors: [],
    warnings: 0,
  };

  // Check if TypeScript files exist
  const tsFiles = Object.keys(result.artifacts || {}).filter(f => 
    /\.(ts|tsx)$/.test(f)
  );

  if (tsFiles.length === 0) {
    // No TypeScript, give full score for type correctness
    return check;
  }

  const projectPath = process.cwd();
  const tsconfigPath = path.join(projectPath, 'tsconfig.json');

  // Try to compile TypeScript if tsconfig exists
  if (fs.existsSync(tsconfigPath)) {
    try {
      const output = execSync('npx tsc --noEmit 2>&1 || true', {
        encoding: 'utf-8',
        timeout: 60000,
        cwd: projectPath,
      });

      // Parse TypeScript errors
      const errorMatches = output.matchAll(/error\s+TS\d+[:\s]/gi);
      const errorCount = Array.from(errorMatches).length;

      check.errors = errorCount;
      
      // Score calculation: 100 - (errors * 2) but not less than 0
      check.score = Math.max(0, 100 - errorCount * 2);
    } catch (err) {
      check.errors.push({ type: 'execution', message: err.message });
      check.score = 50; // Unknown state
    }
  } else {
    // No tsconfig, check for basic type annotations
    let typeAnnotations = 0;
    let totalFunctions = 0;

    for (const file of tsFiles) {
      const content = result.artifacts[file] || '';
      
      // Count functions with type annotations
      const typedFunctions = content.match(/function\s+\w+\s*\([^)]*:\s*\w+/g) || [];
      const typedArrows = content.match(/\([^)]*\)\s*:\s*\w+\s*=>/g) || [];
      
      typeAnnotations += typedFunctions.length + typedArrows.length;
      totalFunctions += (content.match(/function/g) || []).length;
    }

    // Score based on type annotation coverage
    if (totalFunctions > 0) {
      check.score = Math.min(100, (typeAnnotations / totalFunctions) * 100);
    }
  }

  return check;
}

/**
 * Validates output against expected patterns.
 */
async function validateOutput(result, task) {
  const validation = {
    score: 0,
    checksPassed: 0,
    totalChecks: 0,
    validationReport: [],
  };

  // Define expected output patterns based on task
  const expectedPatterns = task.evaluationCriteria || {};
  const codeContent = Object.values(result.artifacts || {}).join('\n');

  for (const [criterion, expectation] of Object.entries(expectedPatterns)) {
    validation.totalChecks++;
    
    // Check for implementation of each criterion
    const keyword = criterion.toLowerCase().replace(/\s+/g, '');
    const found = codeContent.toLowerCase().includes(keyword) ||
                  codeContent.toLowerCase().includes(expectation.toLowerCase());
    
    if (found) {
      validation.checksPassed++;
      validation.validationReport.push({ criterion, status: 'pass' });
    } else {
      validation.validationReport.push({ criterion, status: 'missing' });
    }
  }

  // Additional semantic checks
  // 1. Check if main export/function exists
  const hasMainExport = /export\s+(default\s+)?\w+|module\.exports\s*=/.test(codeContent);
  if (hasMainExport) validation.checksPassed++;
  validation.totalChecks++;

  // 2. Check for proper error messages
  const hasErrorMessages = /throw\s+new\s+Error|Error\s*\(|console\.error/.test(codeContent);
  if (hasErrorMessages) validation.checksPassed++;
  validation.totalChecks++;

  // Calculate score
  validation.score = validation.totalChecks > 0 
    ? (validation.checksPassed / validation.totalChecks) * 100 
    : 0;

  return validation;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: Functional Completeness Assessment
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assesses functional completeness.
 * @param {ExecutionResult} executionResult
 * @param {BenchmarkTask} task
 * @returns {Object} Completeness metrics
 */
async function assessFunctionalCompleteness(executionResult, task) {
  const completeness = {
    requirementCoverage: 0,       // 需求覆盖率
    featureCompleteness: 0,       // 功能完整度
    apiCompleteness: 0,           // API 完整度
    documentationCompleteness: 0, // 文档完整度
    score: 0,
    details: [],
  };

  // 1. Requirement Coverage
  const reqCoverage = await assessRequirementCoverage(executionResult, task);
  completeness.requirementCoverage = reqCoverage.score;
  completeness.details.push({
    metric: 'requirementCoverage',
    score: reqCoverage.score,
    covered: reqCoverage.covered,
    total: reqCoverage.total,
  });

  // 2. Feature Completeness
  const featureComplete = await assessFeatureCompleteness(executionResult, task);
  completeness.featureCompleteness = featureComplete.score;
  completeness.details.push({
    metric: 'featureCompleteness',
    score: featureComplete.score,
    missing: featureComplete.missing,
  });

  // 3. API Completeness
  const apiComplete = await assessAPICompleteness(executionResult, task);
  completeness.apiCompleteness = apiComplete.score;
  completeness.details.push({
    metric: 'apiCompleteness',
    score: apiComplete.score,
    endpoints: apiComplete.endpoints,
  });

  // 4. Documentation Completeness
  const docComplete = await assessDocumentationCompleteness(executionResult, task);
  completeness.documentationCompleteness = docComplete.score;
  completeness.details.push({
    metric: 'documentationCompleteness',
    score: docComplete.score,
  });

  // Calculate weighted score
  const weights = {
    requirementCoverage: 0.35,
    featureCompleteness: 0.30,
    apiCompleteness: 0.20,
    documentationCompleteness: 0.15,
  };

  completeness.score = Math.round(
    completeness.requirementCoverage * weights.requirementCoverage +
    completeness.featureCompleteness * weights.featureCompleteness +
    completeness.apiCompleteness * weights.apiCompleteness +
    completeness.documentationCompleteness * weights.documentationCompleteness
  );

  return completeness;
}

/**
 * Assesses requirement coverage.
 */
async function assessRequirementCoverage(executionResult, task) {
  const coverage = {
    score: 0,
    covered: 0,
    total: 0,
    items: [],
  };

  const criteria = task.evaluationCriteria || {};
  const codeContent = Object.values(executionResult.artifacts || {}).join('\n\n');
  const artifactNames = Object.keys(executionResult.artifacts || {});
  
  coverage.total = Object.keys(criteria).length;

  for (const [key, description] of Object.entries(criteria)) {
    const keywords = [
      key.toLowerCase(),
      ...description.toLowerCase().split(/\s+/).filter(w => w.length > 3),
    ];

    // Check if any keyword appears in code or artifacts
    const found = keywords.some(kw => 
      codeContent.toLowerCase().includes(kw) ||
      artifactNames.some(name => name.toLowerCase().includes(kw))
    );

    coverage.items.push({
      requirement: key,
      description,
      covered: found,
    });

    if (found) coverage.covered++;
  }

  coverage.score = coverage.total > 0 
    ? (coverage.covered / coverage.total) * 100 
    : 100;

  return coverage;
}

/**
 * Assesses feature completeness.
 * @param {ExecutionResult} executionResult
 * @param {BenchmarkTask} task
 * @returns {Object} Feature completeness assessment
 */
async function assessFeatureCompleteness(executionResult, task) {
  const result = {
    score: 0,
    missing: [],
    implemented: [],
  };

  // Expected features based on task level and type
  const expectedFeatures = getExpectedFeatures(task);
  const codeContent = Object.values(executionResult.artifacts || {}).join('\n\n');

  for (const feature of expectedFeatures) {
    const found = feature.patterns.some(pattern => pattern.test(codeContent));
    
    if (found) {
      result.implemented.push(feature.name);
    } else {
      result.missing.push(feature.name);
    }
  }

  const total = expectedFeatures.length;
  const implementedCount = result.implemented.length;
  result.score = total > 0 ? (implementedCount / total) * 100 : 100;

  return result;
}

/**
 * Returns expected features based on task characteristics.
 */
function getExpectedFeatures(task) {
  const features = [];

  // Common features for all levels
  features.push(
    { name: 'Input Validation', patterns: [/validate|Validation|sanitize|check/i] },
    { name: 'Error Handling', patterns: [/try\s*{|catch|throw|Error/i] },
    { name: 'Documentation', patterns: [/\/\*\*|\/\/|#\s|"""/] },
  );

  // Level-specific features
  if (task.level !== 'simple') {
    features.push(
      { name: 'Logging', patterns: [/console\.(log|warn|error)|logger|winston|pino/i] },
      { name: 'Configuration', patterns: [/config|options|settings|\.env/i] },
    );
  }

  if (task.level === 'medium' || task.level === 'complex') {
    features.push(
      { name: 'Tests', patterns: [/describe\(|it\(|test\(|expect\(/] },
      { name: 'Type Safety', patterns: [/: \w+|interface |type\s+\w+|@param/] },
    );
  }

  if (task.level === 'complex' || task.level === 'production') {
    features.push(
      { name: 'Performance Optimization', patterns: [/cache|memo|lazy|debounce|throttle/i] },
      { name: 'Security', patterns: [/sanitize|escape|csrf|xss|auth|jwt/i] },
    );
  }

  // Category-specific features
  if (task.category?.includes('api')) {
    features.push(
      { name: 'HTTP Methods', patterns: [/get|post|put|delete|patch/i] },
      { name: 'Status Codes', patterns: [/200|201|400|401|404|500|status\s*\(/] },
    );
  }

  return features;
}

/**
 * Assesses API completeness.
 */
async function assessAPICompleteness(executionResult, task) {
  const assessment = {
    score: 0,
    endpoints: [],
  };

  const codeContent = Object.values(executionResult.artifacts || {}).join('\n\n');

  // Count API endpoints or public functions
  const exports = codeContent.match(/export\s+(default\s+)?(function|class|const)\s+(\w+)/g) || [];
  const moduleExports = codeContent.match(/module\.exports\s*=\s*{([^}]+)}/g) || [];
  
  assessment.endpoints = [...exports, ...moduleExports];

  // Expected minimum based on task level
  const expectedEndpoints = {
    'simple': 1,
    'medium': 3,
    'complex': 5,
    'production': 4,
  };

  const expected = expectedEndpoints[task.level] || 2;
  const actual = Math.min(assessment.endpoints.length, expected * 2); // Cap at 2x expected

  assessment.score = actual >= expected ? 100 : (actual / expected) * 100;

  return assessment;
}

/**
 * Assesses documentation completeness.
 */
async function assessDocumentationCompleteness(executionResult, task) {
  const assessment = {
    score: 0,
    hasReadme: false,
    hasApiDocs: false,
    hasCodeComments: false,
    hasExamples: false,
  };

  const artifacts = executionResult.artifacts || {};

  // Check for README
  assessment.hasReadme = Object.keys(artifacts).some(f => 
    /readme/i.test(f)
  );

  // Check for API documentation
  assessment.hasApiDocs = Object.keys(artifacts).some(f => 
    /docs?|api|swagger|openapi/i.test(f)
  );

  // Check for code-level documentation (JSDoc/TSDoc)
  const codeContent = Object.values(artifacts).join('\n\n');
  const jsdocMatches = codeContent.match(/\/\*\*[\s\S]*?\*\//g) || [];
  const commentLines = (codeContent.match(/\/\/.*/g) || []).length;
  
  assessment.hasCodeComments = jsdocMatches.length > 0 || commentLines > 5;

  // Check for examples
  assessment.hasExamples = codeContent.includes('example') || 
                          Object.keys(artifacts).some(f => /example/i.test(f));

  // Calculate score
  const checks = ['hasReadme', 'hasApiDocs', 'hasCodeComments', 'hasExamples'];
  const passed = checks.filter(c => assessment[c]).length;
  assessment.score = (passed / checks.length) * 100;

  return assessment;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: Main Evaluator Class
// ═══════════════════════════════════════════════════════════════════════════

class FunctionalityEvaluator {
  constructor(options = {}) {
    this.verbose = options.verbose || false;
  }

  /**
   * Evaluates functionality correctness and completeness.
   * @param {ExecutionResult} executionResult
   * @param {BenchmarkTask} task
   * @returns {Promise<Object>} Functionality assessment
   */
  async evaluate(executionResult, task) {
    console.log('[FunctionalityEvaluator] Starting assessment...');

    const assessment = {
      functionalCorrectness: null,
      functionalCompleteness: null,
      overallScore: 0,
    };

    // Assess correctness
    try {
      console.log('  → Assessing functional correctness...');
      assessment.functionalCorrectness = await assessFunctionalCorrectness(executionResult, task);
      console.log(`     ✓ Correctness score: ${assessment.functionalCorrectness.score}/100`);
    } catch (err) {
      console.error('  ✗ Correctness assessment failed:', err.message);
      assessment.functionalCorrectness = { score: 0, details: [] };
    }

    // Assess completeness
    try {
      console.log('  → Assessing functional completeness...');
      assessment.functionalCompleteness = await assessFunctionalCompleteness(executionResult, task);
      console.log(`     ✓ Completeness score: ${assessment.functionalCompleteness.score}/100`);
    } catch (err) {
      console.error('  ✗ Completeness assessment failed:', err.message);
      assessment.functionalCompleteness = { score: 0, details: [] };
    }
    // Calculate overall functionality score (weighted average)
    assessment.overallScore = Math.round(
      assessment.functionalCorrectness.score * 0.55 +
      assessment.functionalCompleteness.score * 0.45
    );

    console.log(`\n[FunctionalityEvaluator] Overall: ${assessment.overallScore}/100`);

    return assessment;
  }
}

module.exports = {
  FunctionalityEvaluator,
  assessFunctionalCorrectness,
  assessFunctionalCompleteness,
  analyzeEdgeCases,
  validateOutput,
};
