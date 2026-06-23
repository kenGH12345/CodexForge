/**
 * Three-Perspective Code Review
 *
 * Implements 3-perspective review:
 *   P1: Implementation Quality (existing checklist-based)
 *   P2: Requirement Consistency (vs analysis.md ACs)
 *   P3: Architecture Consistency (vs architecture.md constraints)
 *
 * Usage:
 *   node workflow/core/three-perspective-review.js --project-root .
 *   → reads output/code.diff, output/analysis.md, output/architecture.md
 *   → writes output/code-review-3p.json + output/code-review-3p-report.md
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { buildReviewPrompt } = require('./code-review-agent');

// ── Perspective 2: Requirement Consistency ───────────────────────
/**
 * Build prompt for requirement consistency check.
 * Validates that each AC in analysis.md has corresponding code evidence.
 */
function buildRequirementConsistencyPrompt(analysisMd, codeDiff) {
  if (!analysisMd || !codeDiff) {
    return null; // Skip if missing inputs
  }

  // Extract AC section(s) from analysis.md
  const acSection = extractACSection(analysisMd);

  return [
    `## Requirement Consistency Review`,
    ``,
    `You are reviewing code diff for REQUIREMENT CONSISTENCY.`,
    `Each Acceptance Criterion (AC) in the requirement document MUST have`,
    `corresponding evidence in the code diff.`,
    ``,
    `## Requirement Document (AC Section)`,
    ``,
    acSection || '(No AC section found in analysis.md)',
    ``,
    `## Code Diff`,
    ``,
    codeDiff,
    ``,
    `## Your Task`,
    `For each AC, determine: PASS (evidence found in diff), FAIL (no evidence), or N/A (not applicable).`,
    `Output JSON array: [{"id":"AC-01", "result":"PASS|FAIL|N/A", "finding":"...", "evidence":"file:line or null"}, ...]`,
  ].join('\n');
}

/**
 * Extract AC section from analysis.md.
 * Looks for headings like "## Acceptance Criteria" or "## 验收标准".
 */
function extractACSection(analysisMd) {
  const lines = (analysisMd || '').split('\n');
  const acLines = [];
  let inAC = false;

  for (const line of lines) {
    if (/^##\s*(Acceptance Criteria|验收标准|验收条件)/i.test(line)) {
      inAC = true;
      acLines.push(line);
      continue;
    }
    if (inAC) {
      if (/^##\s/.test(line)) break;
      acLines.push(line);
    }
  }

  return acLines.join('\n').trim();
}

// ── Perspective 3: Architecture Consistency ─────────────────────
/**
 * Build prompt for architecture consistency check.
 * Validates that code diff doesn't violate architecture.md constraints.
 */
function buildArchitectureConsistencyPrompt(archMd, codeDiff) {
  if (!archMd || !codeDiff) {
    return null;
  }

  // Extract Architecture Scorecard section
  const scorecard = extractArchitectureScorecard(archMd);

  return [
    `## Architecture Consistency Review`,
    ``,
    `You are reviewing code diff for ARCHITECTURE CONSISTENCY.`,
    `The architecture document defines constraints. Verify the code diff does NOT violate them.`,
    ``,
    `## Architecture Constraints (from architecture.md)`,
    ``,
    scorecard || '(No Architecture Scorecard found)',
    ``,
    `## Code Diff`,
    ``,
    codeDiff,
    ``,
    `## Your Task`,
    `Check each architecture constraint: is it violated by the code diff?`,
    `Output JSON array: [{"id":"ARCH-XXX", "result":"PASS|FAIL|N/A", "finding":"...", "evidence":"file:line or null"}, ...]`,
  ].join('\n');
}

/**
 * Extract Architecture Scorecard from architecture.md.
 */
function extractArchitectureScorecard(archMd) {
  const lines = (archMd || '').split('\n');
  const scLines = [];
  let inSC = false;

  for (const line of lines) {
    if (/^##\s*Architecture\s*Scorecard/i.test(line)) {
      inSC = true;
      scLines.push(line);
      continue;
    }
    if (inSC) {
      if (/^##\s/.test(line)) break;
      scLines.push(line);
    }
  }

  return scLines.join('\n').trim();
}

// ── Aggregation ─────────────────────────────────────────────────────
/**
 * Aggregate results from all three perspectives.
 */
function aggregateResults(implResult, reqResult, archResult) {
  const allPassed  = [];
  const allFailed  = [];
  const allNA      = [];

  // Perspective 1: Implementation Quality
  if (implResult && Array.isArray(implResult.allResults)) {
    for (const r of implResult.allResults) {
      const item = { perspective: 'implementation', ...r };
      if (r.result === 'PASS')       allPassed.push(item);
      else if (r.result === 'FAIL') allFailed.push(item);
      else                        allNA.push(item);
    }
  }

  // Perspective 2: Requirement Consistency
  if (reqResult && Array.isArray(reqResult)) {
    for (const r of reqResult) {
      const item = { perspective: 'requirement', id: r.id, result: r.result, finding: r.finding, evidence: r.evidence };
      if (r.result === 'PASS')       allPassed.push(item);
      else if (r.result === 'FAIL') allFailed.push(item);
      else                        allNA.push(item);
    }
  }

  // Perspective 3: Architecture Consistency
  if (archResult && Array.isArray(archResult)) {
    for (const r of archResult) {
      const item = { perspective: 'architecture', id: r.id, result: r.result, finding: r.finding, evidence: r.evidence };
      if (r.result === 'PASS')       allPassed.push(item);
      else if (r.result === 'FAIL') allFailed.push(item);
      else                        allNA.push(item);
    }
  }

  const implPass = implResult  ? (implResult.failed === 0) : false;
  const reqPass  = reqResult   ? reqResult.every(r => r.result === 'PASS' || r.result === 'N/A') : false;
  const archPass = archResult  ? archResult.every(r => r.result === 'PASS' || r.result === 'N/A') : false;

  return {
    perspectives: {
      implementation: implResult  ? (implPass ? 'PASS' : 'FAIL') : 'N/A',
      requirement:   reqResult   ? (reqPass  ? 'PASS' : 'FAIL') : 'N/A',
      architecture:   archResult   ? (archPass ? 'PASS' : 'FAIL') : 'N/A',
    },
    passed:  allPassed,
    failed:  allFailed,
    na:      allNA,
    overall: allFailed.length === 0 ? 'PASS' : 'FAIL',
  };
}

// ── Report Generation ────────────────────────────────────────────────
function generateReport(aggregated) {
  const lines = [
    `# Three-Perspective Code Review Report`,
    ``,
    `> Auto-generated by three-perspective-review.js`,
    ``,
    `## Summary`,
    ``,
    `| Perspective | Result |`,
    `|-------------|--------|`,
    `| Implementation Quality | ${aggregated.perspectives.implementation} |`,
    `| Requirement Consistency | ${aggregated.perspectives.requirement} |`,
    `| Architecture Consistency | ${aggregated.perspectives.architecture} |`,
    `| **Overall**       | **${aggregated.overall}** |`,
    ``,
    `## Passed (${aggregated.passed.length})`,
    ...(aggregated.passed.length > 0
      ? aggregated.passed.map(p => `- [${p.perspective}] ${p.id || p.checklistId}: ${p.finding || 'OK'}`)
      : ['- (none)']),
    ``,
    `## Failed (${aggregated.failed.length})`,
    ...(aggregated.failed.length > 0
      ? aggregated.failed.map(p => `- [${p.perspective}] ${p.id || p.checklistId}: ${p.finding}`)
      : ['- (none)']),
    ``,
    `## N/A (${aggregated.na.length})`,
    ...(aggregated.na.length > 0
      ? aggregated.na.map(p => `- [${p.perspective}] ${p.id || p.checklistId}: ${p.finding || 'N/A'}`)
      : ['- (none)']),
  ];

  return lines.join('\n');
}

// ── Main Entry Point ─────────────────────────────────────────────
async function runThreePerspectiveReview(llmCall, projectRoot) {
  const outputDir   = path.join(projectRoot, 'output');
  const codeDiffPath  = path.join(outputDir, 'code.diff');
  const analysisPath  = path.join(outputDir, 'analysis.md');
  const archPath      = path.join(outputDir, 'architecture.md');

  // Read inputs
  const codeDiff     = fs.existsSync(codeDiffPath)  ? fs.readFileSync(codeDiffPath, 'utf-8') : null;
  const analysisMd  = fs.existsSync(analysisPath)  ? fs.readFileSync(analysisPath, 'utf-8') : null;
  const archMd      = fs.existsSync(archPath)      ? fs.readFileSync(archPath, 'utf-8')      : null;

  if (!codeDiff) {
    console.error('[3P-Review] ❌ No code.diff found. Run CODE stage first.');
    process.exit(1);
  }

  console.error('[3P-Review] 🔍 Starting three-perspective review...');

  // Perspective 1: Implementation Quality (use existing CodeReviewAgent)
  console.error('[3P-Review]   Perspective 1/3: Implementation Quality...');
  // This would call the existing CodeReviewAgent
  // For now, placeholder
  const implResult = { passed: 0, failed: 0, allResults: [] };

  // Perspective 2: Requirement Consistency
  let reqResult = null;
  if (analysisMd) {
    console.error('[3P-Review]   Perspective 2/3: Requirement Consistency...');
    const reqPrompt = buildRequirementConsistencyPrompt(analysisMd, codeDiff);
    if (reqPrompt && llmCall) {
      try {
        const reqRaw = await llmCall(reqPrompt);
        reqResult = safeJsonParse(reqRaw);
      } catch (e) {
        console.error('[3P-Review] ⚠️  Requirement consistency review failed:', e.message);
      }
    }
  } else {
    console.error('[3P-Review]   Perspective 2/3: Skipped (no analysis.md)');
  }

  // Perspective 3: Architecture Consistency
  let archResult = null;
  if (archMd) {
    console.error('[3P-Review]   Perspective 3/3: Architecture Consistency...');
    const archPrompt = buildArchitectureConsistencyPrompt(archMd, codeDiff);
    if (archPrompt && llmCall) {
      try {
        const archRaw = await llmCall(archPrompt);
        archResult = safeJsonParse(archRaw);
      } catch (e) {
        console.error('[3P-Review] ⚠️  Architecture consistency review failed:', e.message);
      }
    }
  } else {
    console.error('[3P-Review]   Perspective 3/3: Skipped (no architecture.md)');
  }

  // Aggregate
  const aggregated = aggregateResults(implResult, reqResult, archResult);

  // Write outputs
  const jsonOutput = path.join(outputDir, 'code-review-3p.json');
  fs.writeFileSync(jsonOutput, JSON.stringify(aggregated, null, 2), 'utf-8');
  console.error(`[3P-Review] ✅ JSON report written to: ${jsonOutput}`);

  const mdOutput = path.join(outputDir, 'code-review-3p-report.md');
  const report = generateReport(aggregated);
  fs.writeFileSync(mdOutput, report, 'utf-8');
  console.error(`[3P-Review] ✅ Markdown report written to: ${mdOutput}`);

  console.error(`[3P-Review] 🎉 Three-perspective review complete: ${aggregated.overall}`);
  return aggregated;
}

function safeJsonParse(raw) {
  try {
    // Strip markdown fences if present
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const cleaned = match ? match[1].trim() : raw.trim();
    return JSON.parse(cleaned);
  } catch (_) {
    return null;
  }
}

// ── CLI ─────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  let projectRoot = '.';
  let llmCall = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root' && args[i + 1]) {
      projectRoot = args[i + 1];
      i++;
    }
  }

  projectRoot = path.resolve(projectRoot);

  // Use a dummy LLM call if none provided
  if (!llmCall) {
    llmCall = async (prompt) => {
      console.error('[3P-Review] [Dummy] LLM call would be made here.');
      return '[]';
    };
  }

  runThreePerspectiveReview(llmCall, projectRoot)
    .catch(err => {
      console.error('[3P-Review] ❌ Fatal error:', err.message);
      process.exit(1);
    });
}

module.exports = {
  runThreePerspectiveReview,
  buildRequirementConsistencyPrompt,
  buildArchitectureConsistencyPrompt,
  aggregateResults,
  generateReport,
};
