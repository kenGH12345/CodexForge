/**
 * Orchestrator Run – Sequential Pipeline Execution Mixin
 *
 * ADR-33 (P0 decomposition): Extracted from orchestrator-lifecycle.js.
 * Contains the main run() method that executes the sequential pipeline:
 *   ANALYSE → ARCHITECT → PLAN → CODE → TEST
 *
 * ADR-54: Integrated SocraticChallenger for runtime quality questioning.
 *
 * This is the core entry point for workflow execution that was missing
 * after the big refactoring. It was referenced but never implemented.
 *
 * @module orchestrator-run
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { WorkflowState, AgentRole } = require('./types');
const { SocraticChallenger } = require('./socratic-challenger');
const { EvolutionLoop } = require('./evolution-loop');
const { UnifiedTraceCollector, TraceEventType } = require('./unified-trace-collector');
const { enforceRuntimePolicy } = require('./runtime-policy-enforcer');
const { enforceRequirementBudget, buildStageBudgetPlan } = require('./context-budget-policy');
const { runAcceptanceGate } = require('./acceptance-gate');
const { buildCapabilityCatalog, formatCapabilityCatalogForPrompt } = require('./capability-catalog');
const { computeHealthScore } = require('./health-score-model');
const { resolveHealthPaths } = require('./health-observability');
// RollbackCoordinator and HOOK_EVENTS moved to stage-executor.js

// ─── Run Mixin ───────────────────────────────────────────────────────────────

const OrchestratorRunMixin = {
  /**
   * Main entry point for sequential workflow execution.
   * Executes the full pipeline: ANALYSE → ARCHITECT → PLAN → CODE → TEST
   *
   * @this {Orchestrator} - Bound to Orchestrator instance
   * @param {string} rawRequirement - User's raw requirement text
   * @param {object} [options] - Additional options
   * @param {string} [options.userInput] - User's full input conversation (including attachments)
   * @param {object} [options.attachedImages] - Attached image recognition results
   * @returns {Promise<void>}
   */
  async run(rawRequirement, options = {}) {
    // Extract user input data
    const { userInput, attachedImages } = options;

    // ── Runtime Policy Enforcement (制度化约束) ──────────────────────────────
    const runtimePolicyCheck = enforceRuntimePolicy(rawRequirement, { config: this._config || {} });
    if (!runtimePolicyCheck.ok) {
      const message = `[Orchestrator] ❌ Runtime policy blocked workflow: ${runtimePolicyCheck.violations.join(' | ')}`;
      console.error(message);
      throw new Error(message);
    }
    if (runtimePolicyCheck.requiresManualApproval) {
      console.warn(`[Orchestrator] ⚠️ Runtime policy risky operation detected: ${runtimePolicyCheck.riskyMatches.join(', ')}`);
    }

    // ── Context Budget Policy (产品级预算策略) ───────────────────────────────
    const reqBudget = enforceRequirementBudget(rawRequirement, this._config || {});
    const effectiveRequirement = reqBudget.requirement;
    if (reqBudget.truncated) {
      console.warn(`[Orchestrator] ⚠️ Requirement truncated by budget policy (${rawRequirement.length} -> ${effectiveRequirement.length})`);
    }
    const stageBudgetPlan = buildStageBudgetPlan(this._config || {});
    console.error(`[Orchestrator] 📊 Stage budget plan total: ${stageBudgetPlan.totalBudget}`);

    // ── Capability Catalog (模型可见能力清单) ───────────────────────────────
    const runtimeCapabilities = (this.services && typeof this.services.getRegisteredNames === 'function')
      ? Object.fromEntries(this.services.getRegisteredNames().map(name => [name, true]))
      : {};
    const capabilityCatalog = buildCapabilityCatalog({ mode: 'node', capabilities: runtimeCapabilities });
    const capabilityCatalogPrompt = formatCapabilityCatalogForPrompt(capabilityCatalog);
    console.error(`[Orchestrator] 🧭 Capability catalog loaded (${capabilityCatalog.length} items)`);

    console.error(`\n${'═'.repeat(60)}`);
    console.error(`[Orchestrator] 🚀 Starting sequential workflow execution`);
    console.error(`[Orchestrator] 📋 Requirement: ${effectiveRequirement.slice(0, 100)}${effectiveRequirement.length > 100 ? '...' : ''}`);
    if (userInput) {
      console.error(`[Orchestrator] 📝 User Input: ${userInput.slice(0, 100)}${userInput.length > 100 ? '...' : ''}`);
    }
    console.error(`${'═'.repeat(60)}\n`);

    // ── Initialize SocraticChallenger for quality checks ─────────────────────
    // P1-STARTUP-4 fix: use wrappedLlm() so SocraticChallenger calls go through
    // LlmRouter's 4-hop fallback chain + Observability metering + RunGuard limits.
    // Previously used this._rawLlmCall which bypassed all LLM routing protection.
    const _challengerLlm = this.agents?.[AgentRole.ANALYST]
      ? (prompt) => this.agents[AgentRole.ANALYST].llmCall(prompt)
      : this._rawLlmCall || null;
    const challenger = new SocraticChallenger({
      minContentLength: 200,
      maxRetries: 1,
      verbose: true,
      llmCall: _challengerLlm,
    });
    console.error(`[Orchestrator] 🤔 SocraticChallenger initialized (maxRetries=1)`);

    // ── Initialize EvolutionLoop for self-evolution ───────────────────────────
    const evolutionLoop = new EvolutionLoop({
      experienceStore: this.experienceStore || null,
      skillEvolution: this.skillEvolution || null,
      outputDir: this._outputDir, // 如果未定义，EvolutionLoop 应使用默认值
      confidenceThreshold: 0.5,
      verbose: true,
    });
    console.error(`[Orchestrator] 🧬 EvolutionLoop initialized for self-evolution`);

    // ── Initialize UnifiedTraceCollector for health monitoring ───────────────────
    // 不传入 fallback，让 UnifiedTraceCollector 使用 PATHS.OUTPUT_DIR 作为默认值
    const traceRunCategory = this._runCategory || 'prod';
    const traceCollector = new UnifiedTraceCollector({
      outputDir: this._outputDir, // 如果未定义，UnifiedTraceCollector 会使用 PATHS.OUTPUT_DIR
      runCategory: traceRunCategory,
      sessionId: this._sessionId || `run-${Date.now()}`,
      captureArtifactContent: true,
      maxContentLength: 5000,
      verbose: true,
      observationMainline: OBSERVATION_MAINLINE,
    });
    traceCollector.start();
    traceCollector.recordWorkflowStart({ 
      requirement: effectiveRequirement,
      mode: 'sequential',
      userInput: userInput || `/wf ${effectiveRequirement}`,
      attachedImages: attachedImages,
    });
    console.error(`[Orchestrator] 📖 UnifiedTraceCollector initialized: ${traceCollector.tracePath}`);

    // 1. Initialize workflow (StateMachine, Memory, AGENTS.md, etc.)
    const initStartTime = Date.now();
    console.error(`[Orchestrator] 🔧 Initializing workflow...`);
    const resumeState = await this._initWorkflow();
    console.error(`[Orchestrator] ✅ Initialization complete (${Date.now() - initStartTime}ms)`);
    console.error(`[Orchestrator] 📍 Resume state: ${resumeState || '(fresh start)'}`);

    // ADR-XX: /wf always executes full pipeline from INIT.
    // Root-cause fix for terminal transition errors:
    // If we resume from a mid/late state (e.g. TEST) but still replay all stages,
    // the first transition can jump to FINISHED and later transitions will throw
    // "Cannot transition: already in terminal state FINISHED".
    if (this.stateMachine && resumeState && resumeState !== WorkflowState.INIT) {
      try {
        await this.stateMachine.jumpTo(WorkflowState.INIT, 'Reset for full /wf replay from INIT');
        console.error(`[Orchestrator] 🔄 StateMachine reset to INIT for full pipeline replay (was ${resumeState}).`);
      } catch (resetErr) {
        // P1-STARTUP-5 fix: jumpTo failure is FATAL, not just a warning.
        // Continuing with an inconsistent state (StateMachine thinks it's in TEST
        // but stage loop starts from ANALYSE) causes "already in terminal state"
        // errors on the first state transition. Better to fail fast and clear.
        const fatalMsg = `[Orchestrator] ❌ FATAL: Failed to reset StateMachine from ${resumeState} to INIT: ${resetErr.message}. Cannot safely replay pipeline with inconsistent state.`;
        console.error(fatalMsg);
        throw new Error(fatalMsg);
      }
    }

    // 2. Record requirement in StateMachine for completeness gate
    if (this.stateMachine && typeof this.stateMachine.recordRequirementData === 'function') {
      const { _extractRequirementData } = require('../orchestrator-auto');
      const reqData = _extractRequirementData(effectiveRequirement);
      this.stateMachine.recordRequirementData(reqData);
      console.error(`[Orchestrator] 📝 Requirement data recorded in StateMachine`);
    }

    // 3. Emit workflow start event
    this._emit?.('workflow:start', {
      requirement: effectiveRequirement,
      mode: 'sequential',
      capabilityCatalog,
      capabilityCatalogPrompt,
      stageBudgetPlan,
    });
    console.error(`[Orchestrator] 📡 Event emitted: workflow:start`);

    // 4. Determine execution order (always start from first stage - ADR-XX)
    const stageOrder = this.stageRegistry.getOrder();
    const stagesToRun = stageOrder; // Always run all stages (skipping is per-stage via SmartSkip)

    // 4b. Detect task intent for non-code tasks (design/analysis/review/research)
    // Layer 1: Regex pre-detection — instant feedback before pipeline starts.
    // Layer 2 confirmation happens after ANALYSE completes (see stage loop below).
    if (this.stageSmartSkip) {
      const intentResult = this.stageSmartSkip.setTaskIntent(effectiveRequirement);
      if (intentResult.intent !== 'full') {
        console.error(`[Orchestrator] 🎯 Layer 1 pre-detection: ${intentResult.intent} (matched: "${intentResult.matchedPattern}")`);
        console.error(`[Orchestrator] 📋 ${intentResult.description}`);
        console.error(`[Orchestrator] ℹ️  This is a preliminary detection — will be confirmed after ANALYSE.`);
      }
    }

    console.error(`[Orchestrator] 📊 Pipeline stages: [${stagesToRun.join(' → ')}]\n`);

    // 5. Execute stages sequentially
    let currentArtifact = null;
    const executionResults = [];

    for (const stageName of stagesToRun) {
      const runner = this.stageRegistry.get(stageName);
      if (!runner) {
        console.warn(`[Orchestrator] ⚠️  Stage "${stageName}" not registered, skipping.`);
        continue;
      }

      // Delegate to StageExecutor for single-stage lifecycle management
      const { executeStage } = require('./stage-executor');
      const stageResult = await executeStage({
        stageName,
        runner,
        orchestrator: this,
        challenger,
        evolutionLoop,
        traceCollector,
        effectiveRequirement,
        rawRequirement,
        currentArtifact,
        capabilityCatalog,
        capabilityCatalogPrompt,
        stageBudgetPlan,
        runtimePolicy: runtimePolicyCheck.policy,
      });

      // Update shared state from stage result
      if (stageResult.currentArtifact) {
        currentArtifact = stageResult.currentArtifact;
      }
      executionResults.push(stageResult.executionRecord);

      // If stage failed, propagate the error (preserves original behavior)
      if (!stageResult.success && !stageResult.skipped) {
        throw stageResult.error || new Error(`Stage ${stageName} failed`);
      }

      // Clear challenge history for next stage
      challenger.clearHistory();

      // ── Layer 2: Confirm/override task intent after ANALYSE completes ─────
      // ANALYSE is always the first stage. After it completes, we have the enriched
      // requirement with LLM-processed context. Use this to confirm or override
      // the Layer 1 regex pre-detection.
      if (stageName === 'ANALYSE' && this.stageSmartSkip) {
        console.error(`\n[Orchestrator] 🔄 Running Layer 2 task intent confirmation...`);
        const confirmResult = this.stageSmartSkip.confirmTaskIntent({
          stageCtx: this.stageCtx,
        });
        if (confirmResult.overridden) {
          console.error(`[Orchestrator] 🔄 Task intent updated: ${confirmResult.layer1?.intent || 'unknown'} → ${confirmResult.intent} (source: ${confirmResult.source})`);
        } else {
          console.error(`[Orchestrator] ✅ Task intent confirmed: ${confirmResult.intent} (source: ${confirmResult.source})`);
        }
      }
    }

    // 6. Finalize workflow (teardown, reports, evolution)
    console.error(`\n${'═'.repeat(60)}`);
    console.error(`[Orchestrator] 🏁 Pipeline completed, running finalization...`);
    console.error(`${'═'.repeat(60)}\n`);

    const finalizeStartTime = Date.now();
    await this._finalizeWorkflow('sequential', { goal: effectiveRequirement });
    console.error(`[Orchestrator] ✅ Finalization complete (${Date.now() - finalizeStartTime}ms)`);

    // 7. Emit workflow complete event
    this._emit?.('workflow:complete', {
      requirement: effectiveRequirement,
      mode: 'sequential',
      results: executionResults,
      capabilityCatalog,
      stageBudgetPlan,
    });
    console.error(`[Orchestrator] 📡 Event emitted: workflow:complete`);

    // 8. Print summary
    const totalDuration = executionResults.reduce((sum, r) => sum + r.duration, 0);
    const successCount = executionResults.filter(r => r.success).length;
    const confidences = executionResults.filter(r => r.confidence).map(r => r.confidence);
    const avgConfidence = confidences.length > 0
      ? (confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(2)
      : 'N/A';
    const totalChallenges = executionResults.reduce((sum, r) => sum + (r.challengeQuestions?.length || 0), 0);
    const totalBlindSpots = executionResults.reduce((sum, r) => sum + (r.blindSpots?.length || 0), 0);

    const skippedResults = executionResults.filter(r => r.skipped);
    const executedResults = executionResults.filter(r => !r.skipped);

    console.error(`\n${'═'.repeat(60)}`);
    console.error(`[Orchestrator] 📊 WORKFLOW SUMMARY`);
    console.error(`${'═'.repeat(60)}`);
    console.error(`  Total stages:     ${executionResults.length}`);
    console.error(`  Executed:         ${executedResults.length}`);
    console.error(`  Skipped:          ${skippedResults.length}`);
    if (skippedResults.length > 0) {
      console.error(`  Skipped stages:   ${skippedResults.map(r => r.stage).join(', ')}`);
      const taskIntent = this.stageSmartSkip?.getTaskIntent?.();
      if (taskIntent && taskIntent.intent !== 'full') {
        console.error(`  Task intent:      ${taskIntent.intent} (matched: "${taskIntent.matchedPattern}")`);
      }
    }
    console.error(`  Successful:       ${successCount}`);
    console.error(`  Failed:           ${executionResults.length - successCount - skippedResults.length}`);
    console.error(`  Total time:       ${(totalDuration / 1000).toFixed(2)}s`);
    console.error(`  Avg confidence:   ${avgConfidence}`);
    console.error(`  Challenges made:  ${totalChallenges}`);
    console.error(`  Blind spots found:${totalBlindSpots}`);
    console.error(`${'═'.repeat(60)}\n`);

    // 9. Generate EvolutionLoop reports (打点日志 + 质量报告)
    const evolutionStats = evolutionLoop.getStats();
    console.error(`[Orchestrator] 🧬 Evolution Stats:`);
    console.error(`[Orchestrator]    Signals captured: ${evolutionStats.totalSignals}`);
    console.error(`[Orchestrator]    Evolution actions: ${evolutionStats.evolutionActions}`);
    console.error(`[Orchestrator]    Quality score: ${evolutionStats.qualityScore.score} (${evolutionStats.qualityScore.grade})`);

    // Save structured log and quality report (with validation)
    const evolutionLogName = `health/${traceCollector.runCategory || 'prod'}/evolution-log.json`;
    const qualityReportName = `health/${traceCollector.runCategory || 'prod'}/quality-report.md`;
    const logResult = evolutionLoop.saveStructuredLog(evolutionLogName);
    const reportResult = evolutionLoop.saveQualityReport(qualityReportName);

    // Verify output files (critical for quality gate)
    const outputVerification = evolutionLoop.verifyOutputFiles([evolutionLogName, qualityReportName]);

    if (outputVerification.passed) {
      console.error(`[Orchestrator] ✅ Output files verified: ${outputVerification.files.length} file(s)`);
    } else {
      console.error(`[Orchestrator] ⚠️  Output file verification FAILED`);
      if (outputVerification.missingFiles.length > 0) {
        console.error(`[Orchestrator]    Missing: ${outputVerification.missingFiles.join(', ')}`);
      }
      if (outputVerification.emptyFiles.length > 0) {
        console.error(`[Orchestrator]    Empty: ${outputVerification.emptyFiles.join(', ')}`);
      }
    }

    console.error(`[Orchestrator] 📄 Evolution log: ${logResult.path} (${logResult.success ? '✅' : '❌'} ${logResult.size} bytes)`);
    console.error(`[Orchestrator] 📊 Quality report: ${reportResult.path} (${reportResult.success ? '✅' : '❌'} ${reportResult.size} bytes)`);

    // 9b. Run Skill Ablation Test (Agent Skills Spec improvement)
    // Auto-runs after every pipeline to accumulate per-skill ROI data.
    // Uses minUsageCount=0 to include all skills (even cold-start).
    try {
      const ablationResult = evolutionLoop.runAblationTest({ minUsageCount: 0 });
      if (ablationResult.success && ablationResult.report) {
        const { analyzed, avgEffectiveness, positiveROICount, negativeROICount } = ablationResult.report;
        console.error(`[Orchestrator] 🧪 Skill Ablation: ${analyzed} skill(s) analyzed, avg effectiveness: ${avgEffectiveness}%`);
        if (negativeROICount > 0) {
          console.error(`[Orchestrator]    ⚠️  ${negativeROICount} skill(s) with negative ROI — review recommended`);
        }
        if (ablationResult.recommendations.length > 0) {
          for (const rec of ablationResult.recommendations.slice(0, 3)) {
            console.error(`[Orchestrator]    ${rec.severity === 'high' ? '🔴' : rec.severity === 'medium' ? '🟡' : 'ℹ️'} ${rec.action} "${rec.skill}": ${rec.reason.slice(0, 100)}`);
          }
        }
      }
    } catch (ablationErr) {
      console.error(`[Orchestrator] ⚠️  Skill ablation test failed (non-fatal): ${ablationErr.message}`);
    }

    // ── UnifiedTraceCollector: Final verification and workflow end ────────────────────────
    traceCollector.recordWorkflowEnd({
      success: successCount === executionResults.length,
      totalDuration,
      stagesCompleted: successCount,
      avgConfidence: avgConfidence !== 'N/A' ? parseFloat(avgConfidence) : null,
    });

    // NOTE: end() is async and must be awaited to avoid stale reads in
    // generate-health-report.js right after workflow completion.
    await traceCollector.end();

    // Exclude skipped stages from completeness check — they are intentionally not executed
    const skippedStageNames = new Set(skippedResults.map(r => r.stage));
    const expectedStages = ['ANALYSE', 'ARCHITECT', 'PLAN', 'CODE', 'TEST'].filter(s => !skippedStageNames.has(s));
    const traceVerification = traceCollector.verifyCompleteness(expectedStages);
    const traceSummary = traceCollector.getSummary();

    // ── Independent Acceptance Gate (做事/验收分离) ─────────────────────────
    const acceptance = await runAcceptanceGate({
      outputDir: this._outputDir || 'output',
      config: this._config || {},
      executionResults,
    });
    if (acceptance.passed) {
      console.error(`[Orchestrator] ✅ Independent acceptance gate passed.`);
    } else {
      console.warn(`[Orchestrator] ⚠️ Independent acceptance gate found issues: ${acceptance.issues.join(' | ')}`);
    }

    // ── Health Monitoring Report (系统健康度监控报告) ────────────────────────
    console.error(`\n${'═'.repeat(60)}`);
    console.error(`[Orchestrator] 🏥 SYSTEM HEALTH MONITORING REPORT`);
    console.error(`${'═'.repeat(60)}`);
    
    // 1. 完整性检查
    console.error(`\n📋 COMPLETENESS CHECK:`);
    console.error(`   Status: ${traceVerification.passed ? '✅ PASSED' : '⚠️ ISSUES FOUND'}`);
    console.error(`   Workflow start: ${traceVerification.details.hasWorkflowStart ? '✅' : '❌'}`);
    console.error(`   Workflow end:   ${traceVerification.details.hasWorkflowEnd ? '✅' : '❌'}`);
    
    if (traceVerification.present.length > 0) {
      console.error(`   Stages completed: ${traceVerification.present.join(', ')}`);
    }
    if (!traceVerification.passed) {
      console.error(`   ⚠️ Missing stages:`);
      traceVerification.missing.forEach(m => console.error(`      - ${m}`));
    }
    
    // 2. 事件统计
    console.error(`\n📊 EVENT STATISTICS:`);
    console.error(`   Total events:    ${traceSummary.totalEvents}`);
    console.error(`   Stage starts:    ${traceVerification.details.stageStarts}`);
    console.error(`   Stage ends:      ${traceVerification.details.stageEnds}`);
    console.error(`   Socratic checks: ${traceVerification.details.socraticChallenges}`);
    console.error(`   Session ID:      ${traceSummary.sessionId}`);
    console.error(`   Duration:        ${(traceSummary.duration / 1000).toFixed(2)}s`);
    
    // 3. 按类型统计
    if (traceSummary.eventTypes) {
      console.error(`\n📈 EVENT TYPES:`);
      Object.entries(traceSummary.eventTypes).forEach(([type, count]) => {
        console.error(`   ${type}: ${count}`);
      });
    }
    
    // 4. 苏格拉底提问详情 (关键健康度指标)
    const allEvents = traceCollector.getAllEvents();
    const socraticEvents = allEvents.filter(e => e.event === 'socratic_challenge');
    
    if (socraticEvents.length > 0) {
      console.error(`\n🤔 SOCRATIC CHALLENGE DETAILS:`);
      socraticEvents.forEach((evt, idx) => {
        console.error(`\n   ┌─ Stage: ${evt.stage} ─────────────────────────────────`);
        const data = evt.data || {};
        
        // 置信度
        if (data.confidenceStatus === 'na') {
          console.error(`   │  Confidence: ⬜ N/A (${data.confidenceReason || 'insufficient evidence'})`);
        } else if (data.confidence !== undefined) {
          const confPercent = (data.confidence * 100).toFixed(0);
          const confEmoji = data.confidence >= 0.7 ? '✅' : data.confidence >= 0.5 ? '⚠️' : '❌';
          console.error(`   │  Confidence: ${confEmoji} ${confPercent}%`);
        }
        
        // 提问
        if (data.questions && data.questions.length > 0) {
          console.error(`   │  Questions (${data.questions.length}):`);
          data.questions.slice(0, 3).forEach((q, i) => {
            const qText = q.length > 60 ? q.substring(0, 60) + '...' : q;
            console.error(`   │    ${i + 1}. ${qText}`);
          });
          if (data.questions.length > 3) {
            console.error(`   │    ... and ${data.questions.length - 3} more`);
          }
        }
        
        // 盲点
        if (data.blindSpots && data.blindSpots.length > 0) {
          console.error(`   │  Blind Spots (${data.blindSpots.length}):`);
          data.blindSpots.slice(0, 3).forEach((bs, i) => {
            const bsText = bs.length > 50 ? bs.substring(0, 50) + '...' : bs;
            console.error(`   │    ${i + 1}. ${bsText}`);
          });
          if (data.blindSpots.length > 3) {
            console.error(`   │    ... and ${data.blindSpots.length - 3} more`);
          }
        }
        
        // 维度评分
        if (data.dimensionScores && Object.keys(data.dimensionScores).length > 0) {
          console.error(`   │  Dimension Scores:`);
          Object.entries(data.dimensionScores).slice(0, 5).forEach(([dim, score]) => {
            const scoreEmoji = score >= 0.7 ? '✅' : score >= 0.5 ? '⚠️' : '❌';
            console.error(`   │    ${dim}: ${scoreEmoji} ${(score * 100).toFixed(0)}%`);
          });
        }
        
        console.error(`   └──────────────────────────────────────────────────`);
      });
    } else {
      console.error(`\n🤔 SOCRATIC CHALLENGE: No challenges recorded`);
    }
    
    // 5. 健康度评分（改进型A + D：统一口径 + 配置化参数）
    const hmConfig = this._config?.healthMonitoring || {};
    const scoringConfig = hmConfig.scoring || {};
    const stagesWithGateFailures = allEvents
      .filter(e => (e.event === 'stage_end' || e.event === 'stage_error') && e.data?.metricsGate && e.data.metricsGate.passed === false)
      .map(e => e.stage)
      .filter(Boolean);
    const uniqueGateFailures = Array.from(new Set(stagesWithGateFailures));

    const deliveryScore = Number.isFinite(evolutionStats.qualityScore?.deliveryScore)
      ? evolutionStats.qualityScore.deliveryScore
      : (Number.isFinite(evolutionStats.qualityScore?.score) ? evolutionStats.qualityScore.score : 100);
    const detectionScore = Number.isFinite(evolutionStats.qualityScore?.detectionScore)
      ? evolutionStats.qualityScore.detectionScore
      : (Number.isFinite(evolutionStats.qualityScore?.score) ? evolutionStats.qualityScore.score : 100);

    const socraticCoveredStages = traceVerification.present.filter(stage =>
      socraticEvents.some(e => e.stage === stage)
    );
    const challengedStages = Array.from(new Set(
      socraticEvents
        .filter(e => e.data?.challenged !== false)
        .map(e => e.stage)
        .filter(Boolean)
    ));
    const effectiveChallengeStages = Array.from(new Set(
      socraticEvents
        .filter(e => e.data?.challenged !== false && e.data?.effectiveChallenge === true)
        .map(e => e.stage)
        .filter(Boolean)
    ));

    const scoreResult = computeHealthScore({
      completenessOk: traceVerification.passed,
      missingStages: traceVerification.missing,
      presentStages: traceVerification.present,
      socraticCoveredStages,
      challengedStages,
      effectiveChallengeStages,
      failedGateStages: uniqueGateFailures,
      deliveryScore,
      detectionScore,
      scoringConfig,
    });
    const healthScore = scoreResult.score;
    const healthGrade = scoreResult.grade;
    console.error(`\n🏥 HEALTH SCORE: ${healthScore}/100 (Grade: ${healthGrade})`);
    console.error(`[Orchestrator]    Breakdown: completeness=${scoreResult.breakdown.completenessScore}, process=${scoreResult.breakdown.processScore}, delivery=${scoreResult.breakdown.deliveryScore}, detection=${scoreResult.breakdown.detectionScore}`);
    
    // 5. 文件位置
    console.error(`\n📁 TRACE FILE:`);
    console.error(`   Path: ${traceCollector.tracePath}`);
    console.error(`   Events: ${traceCollector.eventCount}`);
    
    console.error(`${'═'.repeat(60)}\n`);

    // ── Write Health Report to File (输出到 IDE 可见文件) ────────────────────────
    // Delegate to standalone generate-health-report.js script for clean separation of concerns.
    // This avoids 300+ lines of inline report generation and ensures consistency with
    // the standalone script that can also be run independently.
    try {
      const { execFileSync } = require('child_process');
      const reportScriptPath = path.join(__dirname, '../tools/generate-health-report.js');
      const outputDirArg = path.resolve(this._outputDir || 'output');
      const runCategoryArg = traceCollector.runCategory || 'prod';
      const tracePath = path.join(outputDirArg, 'health', runCategoryArg, 'workflow-trace.jsonl');

      if (!fs.existsSync(tracePath)) {
        console.warn(`[Orchestrator] ⚠️ Health report generation skipped: no trace found for run-category=${runCategoryArg}`);
      } else {
        execFileSync(process.execPath, [
          reportScriptPath,
          '--output-dir', outputDirArg,
          '--run-category', runCategoryArg,
          '--session', traceSummary.sessionId,
          '--project-root', this.projectRoot || process.cwd(),
        ], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10000,
        });
        const healthPaths = resolveHealthPaths({ outputDir: outputDirArg, runCategory: runCategoryArg });
        console.error(`[Orchestrator] 🧭 Run Category: ${healthPaths.runCategory}`);
        console.error(`[Orchestrator] 📄 Health report written to: ${healthPaths.healthReportPath}`);
        console.error(`[Orchestrator] 📁 Trace path: ${healthPaths.tracePath}`);
        console.error(`[Orchestrator] 📁 Quality report path: ${healthPaths.qualityReportPath}`);
        console.error(`[Orchestrator] 📁 Evolution log path: ${healthPaths.evolutionLogPath}`);
      }
    } catch (reportErr) {
      console.warn(`[Orchestrator] ⚠️ Health report generation failed: ${reportErr.message}`);
    }

    // (legacy inline vars kept for return value below)
    const workflowStartEvent = allEvents.find(e => e.event === 'workflow_start');
    const userData = workflowStartEvent?.data || {};
    
    return {
      success: successCount === executionResults.length,
      stages: executionResults,
      totalDuration,
      avgConfidence: avgConfidence !== 'N/A' ? parseFloat(avgConfidence) : null,
      totalChallenges,
      totalBlindSpots,
      acceptance,
      runtimePolicy: runtimePolicyCheck,
      contextBudget: {
        requirement: reqBudget,
        stageBudgetPlan,
      },
      capabilityCatalog,
      capabilityCatalogPrompt,
      // Task intent and smart-skip info
      taskIntent: this.stageSmartSkip?.getTaskIntent?.() || { intent: 'full' },
      smartSkip: {
        skippedStages: skippedResults.map(r => ({ stage: r.stage, reason: r.skipReason, source: r.skipSource })),
        executedStages: executedResults.map(r => r.stage),
      },
      outputVerification: {
        passed: outputVerification.passed,
        files: outputVerification.files,
      },
      // Health monitoring info
      healthMonitoring: {
        passed: traceVerification.passed,
        score: healthScore,
        grade: healthGrade,
        sessionId: traceSummary.sessionId,
        totalEvents: traceSummary.totalEvents,
        tracePath: traceCollector.tracePath,
        missingStages: traceVerification.missing,
        scoringModel: scoreResult.model,
        scoreWeights: scoreResult.weights,
        scorePenalties: scoreResult.penalties,
        scoreThresholds: scoreResult.thresholds,
        scoreBreakdown: scoreResult.breakdown,
        socraticChallenges: socraticEvents.map(evt => ({
          stage: evt.stage,
          challenged: evt.data?.challenged !== false,
          effectiveChallenge: evt.data?.effectiveChallenge === true,
          confidence: evt.data?.confidence || 0,
          questionCount: evt.data?.questions?.length || 0,
          blindSpotCount: evt.data?.blindSpots?.length || 0,
          triggerReasons: evt.data?.triggerReasons || [],
          p2Protocol: evt.data?.p2Protocol || null,
          deltaScore: Number.isFinite(evt.data?.deltaScore) ? evt.data.deltaScore : null,
          dimensionScores: evt.data?.dimensionScores || null,
        }))      },
    };
  },

  /**
   * Determines if a failed stage should be retried.
   * Can be overridden for custom retry logic.
   *
   * @param {string} stageName
   * @param {Error} error
   * @returns {boolean}
   */
  _shouldRetryStage(stageName, error, challengeResult) {
    // Confidence-based retry gate: if SocraticChallenger produced a very low
    // confidence score (< 0.30), allow one retry with challenge context injected.
    // This is a pure extension — existing callers that don't pass challengeResult
    // will still get `false` (no retry), preserving backward compatibility.
    if (challengeResult && typeof challengeResult.confidence === 'number') {
      return challengeResult.confidence < 0.30;
    }
    return false;
  },

  /**
   * Maps stage names to their expected artifact file names.
   *
   * @param {string} stageName
   * @returns {string} The artifact file name for the stage
   */
  _getArtifactFileName(stageName) {
    const ARTIFACT_FILE_NAMES = {
      'ANALYSE': 'requirement.md',
      'ARCHITECT': 'architecture.md',
      'PLAN': 'execution-plan.md',
      'CODE': 'code.diff',
      'TEST': 'test-report.md',
      'REVIEW': 'review-output.md',
      'DEPLOY': 'deploy-output.md',
    };
    return ARTIFACT_FILE_NAMES[stageName] || `${stageName.toLowerCase()}-output.md`;
  },
};

// ─── Module Exports ───────────────────────────────────────────────────────────
// Export methods directly (not wrapped in a named object)
// This matches the pattern used by orchestrator-lifecycle.js
module.exports = OrchestratorRunMixin;
