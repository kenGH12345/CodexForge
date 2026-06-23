'use strict';

/**
 * GateEngine — 统一数值门禁检查器
 *
 * 从 6 个旧门禁模块中提取所有数值型检查, 集中到一个模块:
 *   quality-gate.js， acceptance-gate.js， analysis-quality-gate.js
 *   post-code-quality-guard.js， retry-gate.js， gate-controller.js
 *
 * 旧模块保持不变, GateEngine 是纯新增. 规则型检查 (安全审查清单等)
 * 由 LLM 读取 skills/quality-gate-rules.md 自主执行.
 */

const STAGE_THRESHOLDS = {
  ANALYSE:   { maxErrorCount: 1, maxLlmCalls:  5, maxDurationMs: 300000 },
  ARCHITECT: { maxErrorCount: 2, maxLlmCalls:  8, maxDurationMs: 400000 },
  PLAN:      { maxErrorCount: 1, maxLlmCalls:  5, maxDurationMs: 300000 },
  DEVELOP:   { maxErrorCount: 2, maxLlmCalls: 10, maxDurationMs: 600000 },
  TEST:      { maxErrorCount: 0, maxLlmCalls:  8, maxDurationMs: 500000 },
  FULL:      { maxErrorCount: 3, maxLlmCalls: 15, maxDurationMs: 600000 },
};

const DEFAULTS = {
  minTestPassRate: 0.70,
  maxTokenWasteRatio: 0.35,
  minComplianceScore: 0.80,
  minLintPassRate: 0.80,
  maxCriticalCves: 0,
  minIntegrationTests: 1,
  maxFileLines: 900,
  fileLinesWarn: 600,
};

class GateEngine {
  constructor(opts = {}) {
    this.thresholds = { ...DEFAULTS };
    if (opts.projectRoot) {
      this._loadProjectConfig(opts.projectRoot);
    }
    Object.assign(this.thresholds, opts);
  }

  _loadProjectConfig(projectRoot) {
    try {
      const config = require('../../workflow.config');
      const qg = config.qualityGate || {};
      if (qg.maxCriticalCves !== undefined) this.thresholds.maxCriticalCves = qg.maxCriticalCves;
      if (qg.minLintPassRate !== undefined) this.thresholds.minLintPassRate = qg.minLintPassRate;
      if (qg.minIntegrationTests !== undefined) this.thresholds.minIntegrationTests = qg.minIntegrationTests;
    } catch (_) { /* config not available */ }
  }

  getStageThresholds(stage) {
    return STAGE_THRESHOLDS[stage] || STAGE_THRESHOLDS.FULL;
  }

  // ── Check 1: lint pass rate ──
  checkLintPassRate(passRate, minRate) {
    const threshold = minRate == null ? this.thresholds.minLintPassRate : minRate;
    const pass = passRate >= threshold;
    return { check: 'lintPassRate', pass, actual: passRate, threshold, reason: pass ? '' : `lint pass rate ${passRate} < ${threshold}` };
  }

  // ── Check 2: test pass rate ──
  checkTestPassRate(passRate, minRate) {
    const threshold = minRate == null ? this.thresholds.minTestPassRate : minRate;
    const pass = passRate >= threshold;
    return { check: 'testPassRate', pass, actual: passRate, threshold, reason: pass ? '' : `test pass rate ${passRate} < ${threshold}` };
  }

  // ── Check 3: critical CVEs ──
  checkCriticalCves(cves, maxCount) {
    const cveList = Array.isArray(cves) ? cves : [];
    const threshold = maxCount == null ? this.thresholds.maxCriticalCves : maxCount;
    const pass = cveList.length <= threshold;
    return {
      check: 'criticalCves', pass, actual: cveList.length, threshold,
      found: cveList.map(c => c.id || c).slice(0, 10),
      reason: pass ? '' : `${cveList.length} critical CVEs found, max allowed: ${threshold}`,
    };
  }

  // ── Check 4: syntax validity ──
  checkSyntaxValidity(errors) {
    const errs = Array.isArray(errors) ? errors : [];
    const pass = errs.length === 0;
    return {
      check: 'syntax', pass, actual: errs.length, threshold: 0,
      errors: errs.slice(0, 5),
      reason: pass ? '' : `${errs.length} syntax error(s) in modified files`,
    };
  }

  // ── Check 5: file size ──
  checkFileSize(files) {
    const fileList = Array.isArray(files) ? files : [];
    const violations = fileList
      .filter(f => f.lines > this.thresholds.maxFileLines)
      .map(f => ({ file: f.path, lines: f.lines, limit: this.thresholds.maxFileLines }));
    const warnings = fileList
      .filter(f => f.lines > this.thresholds.fileLinesWarn && f.lines <= this.thresholds.maxFileLines);
    return {
      check: 'fileSize', pass: violations.length === 0,
      actual: violations.length, threshold: 0,
      violations,
      warnings: warnings.map(f => ({ file: f.path, lines: f.lines, warnAt: this.thresholds.fileLinesWarn })),
      reason: violations.length ? `${violations.length} file(s) exceed ${this.thresholds.maxFileLines} lines` : '',
    };
  }

  // ── Check 6: stage-specific error count ──
  checkErrorCount(errorCount, stage) {
    const st = this.getStageThresholds(stage);
    const pass = errorCount <= st.maxErrorCount;
    return { check: 'errorCount', pass, actual: errorCount, threshold: st.maxErrorCount, stage,
      reason: pass ? '' : `${errorCount} errors exceeds max ${st.maxErrorCount} for ${stage} stage` };
  }

  // ── Check 7: LLM calls ──
  checkLlmCalls(count, stage) {
    const st = this.getStageThresholds(stage);
    const pass = count <= st.maxLlmCalls;
    return { check: 'llmCalls', pass, actual: count, threshold: st.maxLlmCalls, stage,
      reason: pass ? '' : `${count} LLM calls exceeds max ${st.maxLlmCalls}` };
  }

  // ── Check 8: duration ──
  checkDuration(durationMs, stage) {
    const st = this.getStageThresholds(stage);
    const pass = durationMs <= st.maxDurationMs;
    return { check: 'duration', pass, actual: durationMs, threshold: st.maxDurationMs, stage,
      reason: pass ? '' : `stage duration ${Math.round(durationMs / 1000)}s exceeds max ${Math.round(st.maxDurationMs / 1000)}s` };
  }

  // ── Check 9: token waste ratio ──
  checkTokenWasteRatio(wasteRatio, maxRatio) {
    const threshold = maxRatio == null ? this.thresholds.maxTokenWasteRatio : maxRatio;
    const pass = wasteRatio <= threshold;
    return { check: 'tokenWasteRatio', pass, actual: wasteRatio, threshold,
      reason: pass ? '' : `token waste ratio ${wasteRatio} exceeds max ${threshold}` };
  }

  // ── Check 10: compliance score ──
  checkComplianceScore(score, minScore) {
    const threshold = minScore == null ? this.thresholds.minComplianceScore : minScore;
    const pass = score >= threshold;
    return { check: 'complianceScore', pass, actual: score, threshold,
      reason: pass ? '' : `compliance score ${score} below minimum ${threshold}` };
  }

  // ── Check 11: integration tests ──
  checkIntegrationTests(count, minCount) {
    const threshold = minCount == null ? this.thresholds.minIntegrationTests : minCount;
    const pass = count >= threshold;
    return { check: 'integrationTests', pass, actual: count, threshold,
      reason: pass ? '' : `integration tests ${count} below minimum ${threshold}` };
  }

  // ── Run all checks ──
  runAllChecks(metrics, stage = 'FULL') {
    const results = [];
    if (metrics.lintPassRate != null)     results.push(this.checkLintPassRate(metrics.lintPassRate));
    if (metrics.testPassRate != null)     results.push(this.checkTestPassRate(metrics.testPassRate));
    if (metrics.criticalCves != null)     results.push(this.checkCriticalCves(metrics.criticalCves));
    if (metrics.syntaxErrors != null)     results.push(this.checkSyntaxValidity(metrics.syntaxErrors));
    if (metrics.modifiedFiles != null)    results.push(this.checkFileSize(metrics.modifiedFiles));
    if (metrics.errorCount != null)       results.push(this.checkErrorCount(metrics.errorCount, stage));
    if (metrics.llmCallCount != null)     results.push(this.checkLlmCalls(metrics.llmCallCount, stage));
    if (metrics.durationMs != null)       results.push(this.checkDuration(metrics.durationMs, stage));
    if (metrics.tokenWasteRatio != null)  results.push(this.checkTokenWasteRatio(metrics.tokenWasteRatio));
    if (metrics.complianceScore != null)  results.push(this.checkComplianceScore(metrics.complianceScore));
    if (metrics.integrationTests != null) results.push(this.checkIntegrationTests(metrics.integrationTests));

    const blockedBy = results.filter(r => !r.pass).map(r => r.check);
    const warnings = results.filter(r => r.pass && r.warnings && r.warnings.length > 0)
      .flatMap(r => r.warnings);

    return {
      passed: blockedBy.length === 0,
      checks: results,
      blockedBy,
      warnings,
      summary: blockedBy.length
        ? `BLOCKED by: ${blockedBy.join(', ')}`
        : `All ${results.length} checks passed`,
    };
  }
}

module.exports = { GateEngine, STAGE_THRESHOLDS, DEFAULTS };
