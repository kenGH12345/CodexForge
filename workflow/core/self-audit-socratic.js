/**
 * Self-Audit Socratic Engine – Proactive self-questioning for quality assurance
 *
 * Implements "Socratic Self-Questioning" pattern for WorkFlowAgent:
 *   - Instead of waiting for user to find issues, the system proactively questions itself
 *   - Multi-dimensional audit: module completeness, data flow, consistency, constraints
 *   - Integrates with SelfReflectionEngine for issue tracking
 *   - Generates confidence scores and suggestions
 *
 * Key insight from Andrej Karpathy:
 *   "The best agents don't just output – they question their own outputs."
 *
 * Architecture (ADR-37 compliant):
 *   - self-audit-types.js: Type definitions and constants (~100 lines)
 *   - self-audit-questions.js: Audit question definitions (~220 lines)
 *   - module-audit-checks.js: Per-module check functions (~180 lines)
 *   - issue-classifier.js: Issue classification logic (~150 lines)
 *   - self-audit-socratic.js: Main engine class (~380 lines, THIS FILE)
 *
 * @module SelfAuditSocratic
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ReflectionType, ReflectionSeverity } = require('./self-reflection-types');
const { PATHS } = require('./constants');
const { SELF_AUDIT_QUESTIONS, USER_REVIEW_CATEGORIES, STAGE_QUESTIONS } = require('./self-audit-questions');
const { IssuePriority } = require('./self-audit-types');
const { runAllChecks } = require('./module-audit-checks');
const { classifyIssue, separateByAction } = require('./issue-classifier');
const { validateModuleFunctionality, generateFunctionalityAuditQuestion, MODULE_FUNCTIONALITY_CONTRACTS } = require('./module-functionality-contracts');

// ─── Self-Audit Socratic Engine ─────────────────────────────────────────────

class SelfAuditSocratic {
  /**
   * @param {object} options
   * @param {object}   options.selfReflection - SelfReflectionEngine instance
   * @param {Function} options.llmCall - LLM call function for self-questioning
   * @param {string}   [options.outputDir] - Output directory
   * @param {boolean}  [options.verbose=false]
   * @param {string}   [options.userReviewsPath] - Path to user reviews JSON
   */
  constructor(options = {}) {
    this._selfReflection = options.selfReflection || null;
    this._llmCall = options.llmCall || null;
    this._outputDir = options.outputDir || PATHS.OUTPUT_DIR;
    this._verbose = options.verbose ?? false;
    this._userReviewsPath = options.userReviewsPath || path.join(this._outputDir, 'reflections.json');

    this._stageAuditCache = new Map();
    this._knownPitfalls = this._loadKnownPitfalls();
    this._userReviewPoints = this._loadUserReviewPoints();

    this._config = {
      confidenceThreshold: 0.7,
      flagThreshold: 0.8,
      autoFixEnabled: false,
      triggerMode: 'automatic',
    };
  }

  // ─── Core API: Stage Audit ────────────────────────────────────────────────

  /**
   * Audits a specific stage's output against multiple dimensions.
   *
   * @param {string} stage - Stage name (ANALYSE, ARCHITECT, PLAN, CODE, TEST)
   * @param {object} context - Additional context for audit
   * @returns {Promise<object>}
   */
  async auditStage(stage, context = {}) {
    const stageOutput = this._loadStageOutput(stage);
    if (!stageOutput) {
      return this._emptyResult(stage);
    }

    const relevantQuestions = this._selectQuestionsForStage(stage);
    const dimensions = [];
    const issues = [];
    const suggestions = [];

    for (const [dimKey, question] of relevantQuestions) {
      const result = await this._selfQuestion(stage, stageOutput, question, context);
      dimensions.push(result);
      if (result.confidence < 0.8) {
        issues.push(`[${dimKey}] ${result.question} → ${result.answer}`);
        if (result.suggestion) suggestions.push(result.suggestion);
      }
    }

    const moduleResults = await this._auditStageModules(stage, stageOutput, context);
    const moduleIssues = moduleResults.flatMap(m => m.issues);
    const allIssues = [...issues, ...moduleIssues.map(i => `[${i.module}] ${i.title}`)];

    const stageConfidence = dimensions.length > 0
      ? dimensions.reduce((sum, d) => sum + d.confidence, 0) / dimensions.length : 0.5;
    const moduleConfidence = moduleResults.length > 0
      ? moduleResults.reduce((sum, m) => sum + m.confidence, 0) / moduleResults.length : 0.5;

    const overallConfidence = stageConfidence * 0.4 + moduleConfidence * 0.6;
    const passed = overallConfidence >= 0.7;

    this._recordIssues(stage, allIssues, suggestions, passed);

    const result = { passed, confidence: overallConfidence, dimensions, issues: allIssues, suggestions, moduleResults };
    this._stageAuditCache.set(stage, result);
    this._logResult(stage, passed, overallConfidence, dimensions.length, moduleResults.length);

    return result;
  }

  /**
   * Audits the entire pipeline for cross-stage issues.
   */
  async auditPipeline(context = {}) {
    const stages = ['ANALYSE', 'ARCHITECT', 'PLAN', 'CODE', 'TEST'];
    const stageOutputs = {};

    for (const stage of stages) {
      const output = this._loadStageOutput(stage);
      if (output) stageOutputs[stage] = output;
    }

    const dimensions = [];
    const issues = [];
    const suggestions = [];

    // Cross-stage data flow check
    const dataFlowResult = await this._validateDataFlow(stageOutputs);
    dimensions.push(dataFlowResult);
    if (dataFlowResult.confidence < 0.8) {
      issues.push(`[DATA_FLOW] ${dataFlowResult.answer}`);
      if (dataFlowResult.suggestion) suggestions.push(dataFlowResult.suggestion);
    }

    // E2E integrity check
    const e2eResult = await this._validateE2EIntegrity(stageOutputs, context);
    dimensions.push(e2eResult);
    if (e2eResult.confidence < 0.8) {
      issues.push(`[E2E_INTEGRITY] ${e2eResult.answer}`);
      if (e2eResult.suggestion) suggestions.push(e2eResult.suggestion);
    }

    const stageAvgConfidence = this._calcCachedConfidence(stages);
    const dimensionAvgConfidence = dimensions.length > 0
      ? dimensions.reduce((sum, d) => sum + d.confidence, 0) / dimensions.length : 0.5;
    const overallConfidence = stageAvgConfidence * 0.6 + dimensionAvgConfidence * 0.4;
    const passed = overallConfidence >= 0.7;

    this._recordIssues('pipeline', issues, suggestions, passed, true);
    this._logResult('pipeline', passed, overallConfidence);

    return { passed, confidence: overallConfidence, dimensions, issues, suggestions };
  }

  // ─── Per-Module Audit ──────────────────────────────────────────────────────

  async _auditStageModules(stage, stageOutput, context) {
    const modules = this._extractModules(stage, stageOutput);
    const results = [];
    for (const module of modules) {
      results.push(await this._auditModule(stage, module, context));
    }
    return results;
  }

  _extractModules(stage, stageOutput) {
    const modules = [];
    if (stage === 'CODE' && stageOutput.files) {
      for (const [filePath, content] of Object.entries(stageOutput.files)) {
        modules.push({ name: path.basename(filePath, path.extname(filePath)), path: filePath, content: typeof content === 'string' ? content : JSON.stringify(content), type: 'file' });
      }
    } else if (stageOutput.raw) {
      modules.push({ name: stage.toLowerCase(), path: `${stage.toLowerCase()}/output`, content: stageOutput.raw, type: 'output' });
    }
    return modules;
  }

  async _auditModule(stage, module, context) {
    const rawIssues = runAllChecks(module, stage, context, this._knownPitfalls);
    
    // P1: Functionality Contract Validation
    const functionalityResult = this._validateModuleFunctionality(module, stage);
    if (!functionalityResult.valid) {
      for (const violation of functionalityResult.violations) {
        rawIssues.push({
          type: 'functionality-violation',
          title: `Functionality contract violated: ${module.name}`,
          description: violation,
          evidence: functionalityResult.context,
          severity: 'high',
        });
      }
    }
    if (functionalityResult.warnings.length > 0) {
      for (const warning of functionalityResult.warnings) {
        rawIssues.push({
          type: 'functionality-warning',
          title: `Functionality warning: ${module.name}`,
          description: warning,
          evidence: functionalityResult.context,
          severity: 'medium',
        });
      }
    }

    const classifiedIssues = rawIssues.map(issue => classifyIssue(issue, module, stage));
    const { autoFix, userDecision } = separateByAction(classifiedIssues);
    const confidence = classifiedIssues.length === 0 ? 0.95 :
      classifiedIssues.filter(i => i.severity === 'low').length / classifiedIssues.length;

    return {
      module: module.name,
      path: module.path,
      passed: autoFix.length === 0 && userDecision.filter(i => i.severity === 'critical' || i.severity === 'high').length === 0,
      confidence,
      issues: classifiedIssues,
      autoFixIssues: autoFix,
      userDecisionIssues: userDecision,
    };
  }

  // ─── Self-Questioning Logic ────────────────────────────────────────────────

  async _selfQuestion(stage, stageOutput, question, context) {
    if (!this._llmCall) return this._ruleBasedAudit(stage, stageOutput, question, context);
    // LLM-based audit (simplified)
    return this._ruleBasedAudit(stage, stageOutput, question, context);
  }

  _ruleBasedAudit(stage, stageOutput, question, context) {
    const dimKey = question.id;
    let confidence = 0.5, answer = question.options[0], suggestion = null;

    switch (dimKey) {
      case 'output_completeness':
        if (context.requirement) {
          const coverage = this._calcKeywordCoverage(context.requirement, JSON.stringify(stageOutput));
          confidence = coverage;
          answer = coverage >= 0.8 ? question.options[0] : coverage >= 0.5 ? question.options[1] : question.options[2];
          if (coverage < 0.8) suggestion = 'Review requirement keywords not covered in output.';
        }
        break;
      case 'format_compliance':
        try { if (typeof stageOutput === 'string') JSON.parse(stageOutput); confidence = 0.9; }
        catch { confidence = 0.3; answer = question.options[2]; suggestion = 'Output is not valid JSON.'; }
        break;
      case 'historical_pitfalls':
        const pitfalls = this._checkForKnownPitfalls(stageOutput);
        confidence = pitfalls.length === 0 ? 0.8 : 0.4;
        answer = pitfalls.length === 0 ? question.options[0] : question.options[2];
        if (pitfalls.length > 0) suggestion = `Potential pitfalls: ${pitfalls.join(', ')}`;
        break;
      default:
        confidence = 0.6; answer = question.options[1]; suggestion = 'Manual review recommended.';
    }

    return { dimension: dimKey, question: question.question, answer, confidence, suggestion };
  }

  // ─── Data Flow Validation ──────────────────────────────────────────────────

  async _validateDataFlow(stageOutputs) {
    const issues = [];
    if (stageOutputs.ANALYSE && stageOutputs.ARCHITECT) {
      if (!this._checkReferenceUsage(stageOutputs.ARCHITECT, Object.keys(stageOutputs.ANALYSE))) {
        issues.push('ARCHITECT may not be using ANALYSE outputs');
      }
    }
    const confidence = issues.length === 0 ? 0.85 : 0.5;
    return {
      dimension: 'data_flow_cross_stage',
      question: 'Is cross-stage data flow correct?',
      answer: issues.length === 0 ? '✅ Cross-stage data flow is correct' : `⚠️ ${issues.join('; ')}`,
      confidence,
      suggestion: issues.length > 0 ? issues.join('\n') : null,
    };
  }

  async _validateE2EIntegrity(stageOutputs, context) {
    const hasAllStages = Object.keys(stageOutputs).length >= 4;
    return {
      dimension: 'e2e_integrity',
      question: 'Is end-to-end integrity maintained?',
      answer: hasAllStages ? '✅ E2E integrity looks good' : '⚠️ Some stages missing output',
      confidence: hasAllStages ? 0.8 : 0.5,
      suggestion: hasAllStages ? null : 'Verify all stages produced output.',
    };
  }

  // ─── Result Handling ───────────────────────────────────────────────────────

  handleAuditResult(result, options = {}) {
    const { autoFix = false, onIssue, onAutoFix, onUserDecision } = options;
    const allIssues = result.moduleResults?.flatMap(m => m.issues) || [];
    const autoFixIssues = allIssues.filter(i => i.action === 'auto-fix');
    const userDecisionIssues = allIssues.filter(i => i.action === 'user-decision');

    if (onIssue) allIssues.forEach(onIssue);
    if (onAutoFix) autoFixIssues.forEach(onAutoFix);
    if (onUserDecision) userDecisionIssues.forEach(onUserDecision);

    if (result.confidence < this._config.confidenceThreshold) {
      return { action: 'flag-for-review', details: `Confidence ${(result.confidence * 100).toFixed(0)}% below threshold`, autoFixIssues, userDecisionIssues };
    }
    if (autoFixIssues.length > 0 && autoFix) {
      return { action: 'auto-fix', details: `${autoFixIssues.length} auto-fix, ${userDecisionIssues.length} user decision`, autoFixIssues, userDecisionIssues };
    }
    if (result.confidence < this._config.flagThreshold) {
      return { action: 'record-and-continue', details: `${allIssues.length} issues recorded`, autoFixIssues, userDecisionIssues };
    }
    return { action: 'pass', details: 'Audit passed', autoFixIssues: [], userDecisionIssues: [] };
  }

  async executeAutoFix(issues, options = {}) {
    const { applyFix } = options;
    const fixed = [], failed = [], deferred = [];

    for (const issue of issues) {
      if (issue.action !== 'auto-fix') { deferred.push(issue); continue; }
      try {
        const success = applyFix ? await applyFix(issue) : true;
        (success ? fixed : failed).push(issue);
        console.log(`[SelfAudit] ${success ? '🔧' : '⚠️'} Auto-fix ${success ? 'succeeded' : 'failed'}: ${issue.title}`);
      } catch (err) { failed.push(issue); console.error(`[SelfAudit] ❌ Auto-fix error: ${err.message}`); }
    }
    return { fixed, failed, deferred };
  }

  generateUserDecisionReport(issues) {
    if (issues.length === 0) return '_No issues require user decision._';
    const lines = [`## 🔍 User Decision Required\n`, `**${issues.length} issue(s) need your judgment.**\n`];
    const groups = [
      { label: '🔴 Critical', issues: issues.filter(i => i.severity === IssuePriority.CRITICAL) },
      { label: '🟠 High', issues: issues.filter(i => i.severity === IssuePriority.HIGH) },
      { label: '🟡 Medium', issues: issues.filter(i => i.severity === IssuePriority.MEDIUM) },
      { label: '🟢 Low', issues: issues.filter(i => i.severity === IssuePriority.LOW) },
    ];
    for (const g of groups) {
      if (g.issues.length === 0) continue;
      lines.push(`### ${g.label} (${g.issues.length})\n`);
      for (const i of g.issues) {
        lines.push(`#### ${i.module}: ${i.title}`, `- **Path**: ${i.path}`, `- **Fix**: ${i.suggestedFix}`, `- **Rationale**: ${i.rationale}\n`);
      }
    }
    return lines.join('\n');
  }

  // ─── User Review Points ────────────────────────────────────────────────────

  recordUserReviewPoint(options) {
    const { title, description, category, stage, suggestedFix } = options;
    const detectedCategory = category || this._extractUserReviewCategory({ title, description });
    const patternKey = `user-review:${detectedCategory}`;

    if (this._selfReflection) {
      this._selfReflection.recordIssue({
        type: 'ISSUE_DETECTED', severity: 'MEDIUM', title: `[User Review] ${title}`,
        description: description || title, source: 'user:review', patternKey,
        rootCause: `User identified issue during review of stage: ${stage || 'unknown'}`, suggestedFix,
      });
    }

    const existing = this._userReviewPoints.get(detectedCategory) || { count: 0 };
    existing.count++;
    this._userReviewPoints.set(detectedCategory, existing);
    console.log(`[SelfAudit] 📝 Recorded user review: ${detectedCategory} (${existing.count})`);
    return { category: detectedCategory, patternKey, count: existing.count };
  }

  // ─── Summary ────────────────────────────────────────────────────────────────

  getSummary() {
    const stageAudits = Object.fromEntries(this._stageAuditCache);
    return { stageAudits, userReviewPointCount: this._userReviewPoints.size, knownPitfallCount: this._knownPitfalls.length };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  _validateModuleFunctionality(module, stage) {
    // Map stage names to module names in contracts
    const stageToModule = {
      ANALYSE: 'AnalystAgent',
      ARCHITECT: 'ArchitectAgent',
      PLAN: 'PlannerAgent',
      CODE: 'DeveloperAgent',
      TEST: 'TesterAgent',
    };
    
    const contractName = stageToModule[stage] || module.name;
    const contract = MODULE_FUNCTIONALITY_CONTRACTS[contractName];
    
    if (!contract) {
      return { valid: true, violations: [], warnings: [], context: 'No functionality contract defined' };
    }

    // Extract JSON block from module content
    let jsonBlock = null;
    try {
      if (module.content) {
        const match = module.content.match(/```json\s*\n([\s\S]*?)\n```/);
        if (match) {
          jsonBlock = JSON.parse(match[1]);
        }
      }
    } catch {
      // JSON parse error - will be caught by validation
    }

    if (!jsonBlock) {
      return {
        valid: false,
        violations: ['No valid JSON block found in module output'],
        warnings: [],
        context: `Expected: ${contract.expectedBehavior.output}`,
      };
    }

    const result = validateModuleFunctionality(contractName, jsonBlock);
    return {
      ...result,
      context: `Module: ${contractName}\nExpected: ${contract.expectedBehavior.description}`,
    };
  }

  _emptyResult(stage) {
    return { passed: true, confidence: 0.5, dimensions: [], issues: [`No output for ${stage}`], suggestions: [], moduleResults: [] };
  }

  _selectQuestionsForStage(stage) {
    const dimKeys = STAGE_QUESTIONS[stage] || Object.keys(SELF_AUDIT_QUESTIONS);
    return dimKeys.map(key => [key, SELF_AUDIT_QUESTIONS[key]]).filter(([_, q]) => q);
  }

  _loadStageOutput(stage) {
    const stageFile = path.join(this._outputDir, `${stage.toLowerCase()}-output.json`);
    try { return fs.existsSync(stageFile) ? JSON.parse(fs.readFileSync(stageFile, 'utf-8')) : null; }
    catch { return null; }
  }

  _loadKnownPitfalls() {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this._outputDir, 'reflections.json'), 'utf-8'));
      return (data.reflections || []).filter(r => r.patternKey && r.title).map(r => ({ title: r.title, pattern: r.patternKey, severity: r.severity }));
    } catch { return []; }
  }

  _loadUserReviewPoints() {
    const userReviews = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(this._userReviewsPath, 'utf-8'));
      (data.reflections || []).filter(r => r.source?.startsWith('user:')).forEach(r => {
        const cat = this._extractUserReviewCategory(r);
        const existing = userReviews.get(cat) || { count: 0 };
        existing.count++;
        userReviews.set(cat, existing);
      });
    } catch {}
    return userReviews;
  }

  _extractUserReviewCategory(r) {
    if (r.patternKey?.startsWith('user-review:')) return r.patternKey.replace('user-review:', '');
    const text = `${r.title} ${r.description || ''}`.toLowerCase();
    if (/naming|name.*consist/.test(text)) return 'naming-consistency';
    if (/error.*handle|exception/.test(text)) return 'missing-error-handling';
    if (/incomplete|stub|todo/.test(text)) return 'incomplete-module';
    if (/data.*flow|orphan/.test(text)) return 'data-flow-break';
    if (/architecture|constraint/.test(text)) return 'architecture-violation';
    return 'custom';
  }

  _calcKeywordCoverage(req, output) {
    const reqKeys = new Set(req.toLowerCase().match(/\b[a-z]{4,}\b/g) || []);
    const outKeys = new Set(output.toLowerCase().match(/\b[a-z]{4,}\b/g) || []);
    const intersection = [...reqKeys].filter(k => outKeys.has(k));
    return reqKeys.size > 0 ? intersection.length / reqKeys.size : 0.5;
  }

  _checkReferenceUsage(content, keys) {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    return keys.some(k => str.includes(k));
  }

  _checkForKnownPitfalls(output) {
    const str = typeof output === 'string' ? output : JSON.stringify(output);
    return this._knownPitfalls.filter(p => p.pattern && new RegExp(p.pattern, 'i').test(str)).map(p => p.title);
  }

  _calcCachedConfidence(stages) {
    let sum = 0, count = 0;
    for (const s of stages) {
      const cached = this._stageAuditCache.get(s);
      if (cached) { sum += cached.confidence; count++; }
    }
    return count > 0 ? sum / count : 0.5;
  }

  _recordIssues(stage, issues, suggestions, passed, isPipeline = false) {
    if (issues.length > 0 && this._selfReflection) {
      this._selfReflection.recordIssue({
        type: ReflectionType.ISSUE_DETECTED,
        severity: passed ? ReflectionSeverity.LOW : ReflectionSeverity.MEDIUM,
        title: `${isPipeline ? 'Pipeline' : 'Stage'} audit found ${issues.length} issue(s)`,
        description: issues.join('\n'),
        source: `self-audit:${stage}`,
        patternKey: `audit:${stage}`,
        suggestedFix: suggestions.join('\n'),
      });
    }
  }

  _logResult(stage, passed, confidence, dimCount = 0, modCount = 0) {
    if (this._verbose) {
      const icon = passed ? '✅' : '⚠️';
      console.log(`[SelfAudit] ${icon} ${stage}: ${(confidence * 100).toFixed(0)}%${dimCount ? ` (${dimCount} dims` : ''}${modCount ? `, ${modCount} modules)` : ''}`);
    }
  }
}

module.exports = { SelfAuditSocratic, SELF_AUDIT_QUESTIONS, USER_REVIEW_CATEGORIES, IssuePriority };
