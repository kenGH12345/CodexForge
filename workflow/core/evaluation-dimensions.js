/**
 * Evaluation Dimensions – 评价维度扩展
 *
 * 对标 Anthropic 三智能体架构的 Evaluator 维度：
 *   1. 设计质量 (Design Quality) - 架构合理性、模块化程度、可扩展性
 *   2. 原创性 (Originality) - 是否只是"AI泔水"，有无创新解法
 *   3. 工艺感 (Craftsmanship) - 代码精致度、边界处理、错误处理完整性
 *   4. 功能性 (Functionality) - 核心功能是否正确实现
 *
 * 权重设计 (参考 Anthropic):
 *   - 设计质量: 30% (Anthropic 故意拉高)
 *   - 原创性:   20% (避免"最安全答案"陷阱)
 *   - 工艺感:   25% (工程质量的体现)
 *   - 功能性:   25% (基础保障)
 *
 * ADR-52: Evaluation Dimensions Enhancement
 */

'use strict';

const path = require('path');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Dimension Definitions
// ═══════════════════════════════════════════════════════════════════════════

const EvaluationDimension = {
  DESIGN_QUALITY: 'designQuality',
  ORIGINALITY: 'originality',
  CRAFTSMANSHIP: 'craftsmanship',
  FUNCTIONALITY: 'functionality',
};

const DIMENSION_WEIGHTS = {
  [EvaluationDimension.DESIGN_QUALITY]: 0.30,
  [EvaluationDimension.ORIGINALITY]: 0.20,
  [EvaluationDimension.CRAFTSMANSHIP]: 0.25,
  [EvaluationDimension.FUNCTIONALITY]: 0.25,
};

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: Dimension Evaluators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluates design quality from architecture document.
 * Checks: modularity, separation of concerns, extensibility points.
 */
function evaluateDesignQuality(architectureMd, codeDiff) {
  const score = {
    overall: 0,
    modularity: 0,
    separationOfConcerns: 0,
    extensibility: 0,
    details: [],
  };

  if (!architectureMd && !codeDiff) {
    return { ...score, overall: 0, details: ['No architecture or code to evaluate'] };
  }

  const content = (architectureMd || '') + '\n' + (codeDiff || '');

  // Check modularity: multiple files/components
  const fileMarkers = (content.match(/---\s*a\//g) || []).length;
  const componentMentions = (content.match(/component|module|service|layer/gi) || []).length;
  score.modularity = Math.min(100, fileMarkers * 15 + componentMentions * 5);

  // Check separation of concerns: distinct responsibilities
  const separationKeywords = ['responsibility', 'concern', 'handle', 'manage', 'process'];
  const separationHits = separationKeywords.filter(k => content.toLowerCase().includes(k)).length;
  score.separationOfConcerns = Math.min(100, separationHits * 20);

  // Check extensibility: interfaces, abstract patterns, hooks
  const extensibilityPatterns = ['interface', 'abstract', 'hook', 'extend', 'plugin', 'middleware'];
  const extensibilityHits = extensibilityPatterns.filter(p => content.toLowerCase().includes(p)).length;
  score.extensibility = Math.min(100, extensibilityHits * 15);

  // Overall weighted average
  score.overall = Math.round(
    score.modularity * 0.4 +
    score.separationOfConcerns * 0.35 +
    score.extensibility * 0.25
  );

  // Generate details
  if (score.modularity < 30) score.details.push('Low modularity: consider splitting into more files');
  if (score.separationOfConcerns < 30) score.details.push('Unclear separation of concerns');
  if (score.extensibility < 30) score.details.push('Limited extensibility: add interfaces or hooks');
  if (score.overall >= 70) score.details.push('Good design quality overall');

  return score;
}

/**
 * Evaluates originality of the solution.
 * Checks: non-obvious patterns, creative solutions, avoiding boilerplate.
 */
function evaluateOriginality(codeDiff, requirementMd) {
  const score = {
    overall: 0,
    nonBoilerplate: 0,
    creativePattern: 0,
    tailoredSolution: 0,
    details: [],
  };

  if (!codeDiff) {
    return { ...score, overall: 0, details: ['No code to evaluate'] };
  }

  // Check for boilerplate indicators (lower is better for originality)
  const boilerplatePatterns = [
    'TODO', 'FIXME', 'hack', 'workaround',
    'console.log', 'print(', 'debugger',
    '// implementation', '// add your code',
  ];
  const boilerplateHits = boilerplatePatterns.filter(p => codeDiff.includes(p)).length;
  score.nonBoilerplate = Math.max(0, 100 - boilerplateHits * 15);

  // Check for creative patterns
  const creativePatterns = [
    'factory', 'strategy', 'observer', 'decorator', 'composite',
    'memoi[z]e', 'cache', 'lazy', 'async', 'stream',
    'pipeline', 'middleware', 'chain',
  ];
  const creativeHits = creativePatterns.filter(p => new RegExp(p, 'i').test(codeDiff)).length;
  score.creativePattern = Math.min(100, creativeHits * 12);

  // Check for tailored solution (domain-specific naming)
  const domainTerms = requirementMd
    ? extractDomainTerms(requirementMd)
    : [];
  const tailoredHits = domainTerms.filter(t => codeDiff.toLowerCase().includes(t.toLowerCase())).length;
  score.tailoredSolution = Math.min(100, tailoredHits * 10 + (domainTerms.length > 0 ? 30 : 0));

  // Overall weighted average
  score.overall = Math.round(
    score.nonBoilerplate * 0.35 +
    score.creativePattern * 0.35 +
    score.tailoredSolution * 0.30
  );

  // Generate details
  if (boilerplateHits > 3) score.details.push('Contains boilerplate or placeholders');
  if (creativeHits > 2) score.details.push('Uses creative design patterns');
  if (tailoredHits > 2) score.details.push('Solution tailored to domain');
  if (score.overall < 40) score.details.push('Solution appears generic, consider domain-specific approach');

  return score;
}

/**
 * Evaluates craftsmanship (code quality details).
 * Checks: error handling, edge cases, input validation, resource cleanup.
 */
function evaluateCraftsmanship(codeDiff, testReport) {
  const score = {
    overall: 0,
    errorHandling: 0,
    edgeCaseHandling: 0,
    inputValidation: 0,
    resourceCleanup: 0,
    details: [],
  };

  if (!codeDiff) {
    return { ...score, overall: 0, details: ['No code to evaluate'] };
  }

  // Check error handling
  const errorPatterns = ['try', 'catch', 'throw', 'error', 'exception', 'reject'];
  const errorHits = errorPatterns.filter(p => new RegExp(p, 'i').test(codeDiff)).length;
  score.errorHandling = Math.min(100, errorHits * 12);

  // Check edge case handling
  const edgePatterns = ['null', 'undefined', 'empty', 'default', 'fallback', 'boundary'];
  const edgeHits = edgePatterns.filter(p => new RegExp(p, 'i').test(codeDiff)).length;
  score.edgeCaseHandling = Math.min(100, edgeHits * 12);

  // Check input validation
  const validationPatterns = ['validate', 'check', 'verify', 'assert', 'require', 'if (!'];
  const validationHits = validationPatterns.filter(p => new RegExp(p, 'i').test(codeDiff)).length;
  score.inputValidation = Math.min(100, validationHits * 12);

  // Check resource cleanup
  const cleanupPatterns = ['finally', 'close', 'release', 'dispose', 'cleanup', 'destroy'];
  const cleanupHits = cleanupPatterns.filter(p => new RegExp(p, 'i').test(codeDiff)).length;
  score.resourceCleanup = Math.min(100, cleanupHits * 15);

  // Overall weighted average
  score.overall = Math.round(
    score.errorHandling * 0.30 +
    score.edgeCaseHandling * 0.25 +
    score.inputValidation * 0.25 +
    score.resourceCleanup * 0.20
  );

  // Generate details
  if (score.errorHandling < 30) score.details.push('Missing error handling');
  if (score.edgeCaseHandling < 30) score.details.push('Edge cases not handled');
  if (score.inputValidation < 30) score.details.push('Input validation weak');
  if (score.resourceCleanup < 20) score.details.push('Resource cleanup may be missing');
  if (score.overall >= 70) score.details.push('Good craftsmanship overall');

  // Cross-reference with test report
  if (testReport) {
    const defectMatch = testReport.match(/defects?[:\s]*(\d+)/i);
    if (defectMatch && parseInt(defectMatch[1]) > 3) {
      score.details.push('Multiple defects reported by tester');
      score.overall = Math.max(0, score.overall - 15);
    }
  }

  return score;
}

/**
 * Evaluates functional correctness.
 * Checks: test pass rate, acceptance criteria coverage.
 */
function evaluateFunctionality(testReport, executionPlan, codeDiff) {
  const score = {
    overall: 0,
    testPassRate: 0,
    acceptanceCoverage: 0,
    featureCompleteness: 0,
    details: [],
  };

  // Extract test pass rate from report
  if (testReport) {
    const passMatch = testReport.match(/(\d+)\s*\/\s*(\d+)\s*tests?\s*pass/i);
    if (passMatch) {
      const passed = parseInt(passMatch[1]);
      const total = parseInt(passMatch[2]);
      score.testPassRate = Math.round((passed / total) * 100);
    } else {
      // Look for percentage
      const pctMatch = testReport.match(/(\d+)%\s*pass/i);
      if (pctMatch) {
        score.testPassRate = parseInt(pctMatch[1]);
      }
    }
  }

  // Check acceptance criteria coverage
  if (executionPlan && codeDiff) {
    const criteriaPattern = /(?:acceptance|验收|criteria)[:\s]*\n([\s\S]*?)(?=\n##|\n---|\n$)/i;
    const criteriaMatch = executionPlan.match(criteriaPattern);
    if (criteriaMatch) {
      const criteria = criteriaMatch[1].split('\n').filter(l => l.trim().length > 0);
      const covered = criteria.filter(c => {
        const keywords = c.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        return keywords.some(k => codeDiff.toLowerCase().includes(k));
      }).length;
      score.acceptanceCoverage = Math.round((covered / criteria.length) * 100);
    }
  }

  // Feature completeness: check if diff has substantial content
  if (codeDiff) {
    const addLines = (codeDiff.match(/^\+/gm) || []).length;
    const delLines = (codeDiff.match(/^-/gm) || []).length;
    const netLines = addLines - delLines;
    score.featureCompleteness = Math.min(100, Math.max(0, netLines / 5));
  }

  // Overall weighted average
  score.overall = Math.round(
    score.testPassRate * 0.45 +
    score.acceptanceCoverage * 0.35 +
    score.featureCompleteness * 0.20
  );

  // Generate details
  if (score.testPassRate < 70) score.details.push('Test pass rate below 70%');
  if (score.acceptanceCoverage < 70) score.details.push('Not all acceptance criteria covered');
  if (score.featureCompleteness < 30) score.details.push('Limited code changes');
  if (score.overall >= 80) score.details.push('Good functionality coverage');

  return score;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: Composite Evaluation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Runs full multi-dimensional evaluation.
 * @param {Object} artifacts - { architectureMd, codeDiff, testReport, executionPlan, requirementMd }
 * @returns {Object} Full evaluation report
 */
function runFullEvaluation(artifacts) {
  const {
    architectureMd,
    codeDiff,
    testReport,
    executionPlan,
    requirementMd,
  } = artifacts;

  const dimensions = {
    [EvaluationDimension.DESIGN_QUALITY]: evaluateDesignQuality(architectureMd, codeDiff),
    [EvaluationDimension.ORIGINALITY]: evaluateOriginality(codeDiff, requirementMd),
    [EvaluationDimension.CRAFTSMANSHIP]: evaluateCraftsmanship(codeDiff, testReport),
    [EvaluationDimension.FUNCTIONALITY]: evaluateFunctionality(testReport, executionPlan, codeDiff),
  };

  // Calculate weighted composite score
  let compositeScore = 0;
  for (const [dim, score] of Object.entries(dimensions)) {
    compositeScore += score.overall * DIMENSION_WEIGHTS[dim];
  }
  compositeScore = Math.round(compositeScore);

  // Determine pass/fail
  // Thresholds based on Anthropic's philosophy: don't accept "AI Slop"
  const PASS_THRESHOLD = 60;
  const QUALITY_GATE_THRESHOLD = 70;

  const passed = compositeScore >= PASS_THRESHOLD;
  const qualityGatePassed = compositeScore >= QUALITY_GATE_THRESHOLD;

  // Generate summary
  const summary = {
    compositeScore,
    passed,
    qualityGatePassed,
    dimensions: Object.fromEntries(
      Object.entries(dimensions).map(([k, v]) => [k, v.overall])
    ),
    recommendations: generateRecommendations(dimensions),
  };

  return {
    summary,
    dimensions,
    weights: DIMENSION_WEIGHTS,
    thresholds: { pass: PASS_THRESHOLD, qualityGate: QUALITY_GATE_THRESHOLD },
  };
}

/**
 * Generates actionable recommendations based on dimension scores.
 */
function generateRecommendations(dimensions) {
  const recommendations = [];

  for (const [dimName, dimScore] of Object.entries(dimensions)) {
    if (dimScore.overall < 50) {
      recommendations.push({
        dimension: dimName,
        priority: 'high',
        message: `${dimName} score is low (${dimScore.overall}). ${dimScore.details.join('; ')}`,
      });
    } else if (dimScore.overall < 70) {
      recommendations.push({
        dimension: dimName,
        priority: 'medium',
        message: `${dimName} could be improved (${dimScore.overall}). ${dimScore.details.join('; ')}`,
      });
    }
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return recommendations;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extracts domain-specific terms from requirement document.
 */
function extractDomainTerms(requirementMd) {
  if (!requirementMd) return [];

  // Extract capitalized terms and quoted terms
  const capsTerms = requirementMd.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
  const quotedTerms = requirementMd.match(/"([^"]+)"|'([^']+)'/g) || [];

  const allTerms = [
    ...capsTerms,
    ...quotedTerms.map(t => t.replace(/["']/g, '')),
  ];

  // Filter common words
  const stopWords = ['The', 'This', 'That', 'These', 'Those', 'User', 'System', 'API'];
  return [...new Set(allTerms)].filter(t => !stopWords.includes(t) && t.length > 3);
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  EvaluationDimension,
  DIMENSION_WEIGHTS,
  evaluateDesignQuality,
  evaluateOriginality,
  evaluateCraftsmanship,
  evaluateFunctionality,
  runFullEvaluation,
};
