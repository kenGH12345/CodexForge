/**
 * Independent Evaluator – 独立评价器
 *
 * 解决问题："自己给自己打分"的隐性偏差
 *
 * 核心设计原则：
 *   1. **切断上下文传递**：Evaluator不接收Agent内存中的上下文，而是从磁盘读取产物文件
 *   2. **独立进程调用**：可以作为子进程执行，完全隔离
 *   3. **无状态设计**：每次评价都是独立的，不受历史上下文影响
 *   4. **标准化输出**：评价结果以结构化JSON输出，方便下游消费
 *
 * ADR-52: Evaluator Independence Enhancement
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { runFullEvaluation, EvaluationDimension, DIMENSION_WEIGHTS } = require('./evaluation-dimensions');

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Independent Evaluator Core
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Loads artifacts from output directory (disk-based, not memory-based).
 * This ensures the evaluator sees exactly what was written, not what the agent thinks it wrote.
 */
function loadArtifactsFromDisk(outputDir) {
  const artifacts = {
    requirementMd: null,
    architectureMd: null,
    executionPlan: null,
    codeDiff: null,
    testReport: null,
  };

  const artifactPaths = {
    requirementMd: 'requirement.md',
    architectureMd: 'architecture.md',
    executionPlan: 'execution-plan.md',
    codeDiff: 'code.diff',
    testReport: 'test-report.md',
  };

  for (const [key, filename] of Object.entries(artifactPaths)) {
    const filePath = path.join(outputDir, filename);
    if (fs.existsSync(filePath)) {
      artifacts[key] = fs.readFileSync(filePath, 'utf-8');
    }
  }

  return artifacts;
}

/**
 * Runs independent evaluation on disk artifacts.
 * This is the main entry point for standalone evaluation.
 */
function runIndependentEvaluation(outputDir, options = {}) {
  console.log(`[IndependentEvaluator] 🔍 Loading artifacts from: ${outputDir}`);

  const artifacts = loadArtifactsFromDisk(outputDir);
  const missingArtifacts = Object.entries(artifacts)
    .filter(([_, content]) => !content)
    .map(([key]) => key);

  if (missingArtifacts.length > 0) {
    console.warn(`[IndependentEvaluator] ⚠️  Missing artifacts: ${missingArtifacts.join(', ')}`);
  }

  // Run multi-dimensional evaluation
  const evaluation = runFullEvaluation(artifacts);

  // Add independent evaluation metadata
  const result = {
    timestamp: new Date().toISOString(),
    outputDir,
    evaluatorMode: 'independent',
    artifactsFound: Object.keys(artifacts).filter(k => artifacts[k]).length,
    artifactsMissing: missingArtifacts,
    ...evaluation,
  };

  // Log summary
  console.log(`[IndependentEvaluator] 📊 Composite Score: ${evaluation.summary.compositeScore}`);
  console.log(`[IndependentEvaluator] 📊 Passed: ${evaluation.summary.passed ? '✅' : '❌'}`);
  console.log(`[IndependentEvaluator] 📊 Quality Gate: ${evaluation.summary.qualityGatePassed ? '✅' : '❌'}`);

  for (const [dim, score] of Object.entries(evaluation.summary.dimensions)) {
    console.log(`[IndependentEvaluator]    - ${dim}: ${score}`);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: Integration with QualityGate
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates an evaluation gate result for integration with QualityGate.
 * This allows the new evaluation dimensions to be used alongside existing gates.
 */
function createEvaluationGates(evaluationResult) {
  const gates = [];

  for (const [dimName, dimScore] of Object.entries(evaluationResult.dimensions || {})) {
    const weight = DIMENSION_WEIGHTS[dimName] || 0.25;
    const threshold = dimName === EvaluationDimension.FUNCTIONALITY ? 60 : 50;

    gates.push({
      name: `eval_${dimName}`,
      passed: dimScore.overall >= threshold,
      actual: dimScore.overall,
      threshold,
      weight,
      message: dimScore.overall >= threshold
        ? `${dimName} passed (${dimScore.overall} ≥ ${threshold})`
        : `${dimName} failed (${dimScore.overall} < ${threshold}): ${dimScore.details.join('; ')}`,
      details: dimScore.details,
    });
  }

  // Add composite gate
  const compositeScore = evaluationResult.summary?.compositeScore || 0;
  gates.push({
    name: 'eval_composite',
    passed: compositeScore >= 60,
    actual: compositeScore,
    threshold: 60,
    weight: 1.0,
    message: compositeScore >= 60
      ? `Composite evaluation passed (${compositeScore} ≥ 60)`
      : `Composite evaluation failed (${compositeScore} < 60)`,
  });

  return gates;
}

/**
 * Integrates independent evaluation with existing QualityGate flow.
 * Call this after the TEST stage to get a comprehensive evaluation.
 */
function integrateWithQualityGate(outputDir, existingGates = []) {
  const evaluation = runIndependentEvaluation(outputDir);
  const evaluationGates = createEvaluationGates(evaluation);

  // Merge with existing gates
  const allGates = [...existingGates, ...evaluationGates];

  // Calculate weighted pass rate
  const totalWeight = allGates.reduce((sum, g) => sum + (g.weight || 1), 0);
  const passedWeight = allGates
    .filter(g => g.passed)
    .reduce((sum, g) => sum + (g.weight || 1), 0);
  const passRate = totalWeight > 0 ? passedWeight / totalWeight : 1;

  return {
    passed: passRate >= 0.7, // 70% of weighted gates must pass
    gates: allGates,
    evaluation,
    passRate: Math.round(passRate * 100),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: CLI Entry Point (for subprocess execution)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * CLI entry point for standalone evaluation.
 * Usage: node independent-evaluator.js <outputDir> [--format=json|text]
 */
function main() {
  const args = process.argv.slice(2);
  const outputDir = args.find(a => !a.startsWith('--'));
  const format = args.find(a => a.startsWith('--format='))?.split('=')[1] || 'text';

  if (!outputDir) {
    console.error('Usage: node independent-evaluator.js <outputDir> [--format=json|text]');
    process.exit(1);
  }

  if (!fs.existsSync(outputDir)) {
    console.error(`Output directory not found: ${outputDir}`);
    process.exit(1);
  }

  const result = runIndependentEvaluation(outputDir);

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Text format already logged by runIndependentEvaluation
  }

  // Exit with appropriate code
  process.exit(result.summary.passed ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  loadArtifactsFromDisk,
  runIndependentEvaluation,
  createEvaluationGates,
  integrateWithQualityGate,
};

// Run CLI if executed directly
if (require.main === module) {
  main();
}
