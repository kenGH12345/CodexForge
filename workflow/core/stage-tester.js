/**
 * Stage Runner: TESTER
 *
 * Extracted from orchestrator-stages.js (P0 decomposition – ADR-33).
 * Contains: _runTester, _runTesterOnce, _runRealTestLoop
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { AgentRole, WorkflowState } = require('./types');
const { ExperienceType, ExperienceCategory } = require('./experience-store');
const { SelfCorrectionEngine, formatClarificationReport } = require('./clarification-engine');
const { TestRunner } = require('./test-runner');
const { TestCaseGenerator } = require('./test-case-generator');
const { TestCaseExecutor } = require('./test-case-executor');
const { DECISION_QUESTIONS } = require('./socratic-engine');
const { RollbackCoordinator } = require('./rollback-coordinator');
const { QualityGate } = require('./quality-gate');
const { translateMdFile } = require('./i18n-translator');
const { runEvoMapFeedback, recordSelfReport, runStageMetricsGate } = require('./stage-runner-utils');
const { scanSourceFiles } = require('./file-scanner');
const { _recordPromptABOutcome } = require('./stage-analyst');
const { TestFailureExperienceRecorder } = require('./test-failure-recorder');
const {
  buildTesterUpstreamCtx,
  buildTesterContextBlock,
  storeTestContext,
  webSearchHelper,
} = require('./orchestrator-stage-helpers');
const {
  buildFixAgentPrompt,
  buildPreviousFixesBlock,
  buildFailureContext,
  buildWebSearchContext,
} = require('./stage-tester-prompts');
const { buildRetryContext, compareOutputFingerprint } = require('./retry-divergence-guard');
const { ExecutionLogValidator } = require('./execution-log-validator');
const { EvolutionLoop } = require('./evolution-loop');
const { ContainerSandboxAdapter } = require('../hooks/adapters/container-sandbox-adapter');

// Forward reference: _runDeveloper is needed for rollback. Lazy-loaded to avoid circular deps.
let _runDeveloper = null;
function _getRunDeveloper() {
  if (!_runDeveloper) {
    _runDeveloper = require('./stage-developer')._runDeveloper;
  }
  return _runDeveloper;
}

/**
 * Runs the TEST stage: test generation, execution, auto-fix loop, and quality gate.
 *
 * P1-2 fix: @this annotation for IDE IntelliSense and safe refactoring.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @returns {Promise<string|null>} Path to the test report, or null on failure
 */
async function _runTester() {
  const _testStageStartTime = Date.now();
  // Print stage header via handoffLog if available
  if (this.handoffLog) {
    this.handoffLog.printStageHeader('TEST', 'TesterAgent');
  } else {
    console.error(`\n[Orchestrator] Stage: TEST (TesterAgent)`);
  }

  const MAX_TEST_ITERATIONS = 2;
  let testIteration = 0;

  while (testIteration < MAX_TEST_ITERATIONS) {
    testIteration++;
    const fixConversationHistory = [];
    const iterResult = await _runTesterOnce.call(this, testIteration, MAX_TEST_ITERATIONS, fixConversationHistory);

  if (iterResult.__done) {
      // ── Metrics Quality Gate: validate TEST stage runtime metrics ──────
      runStageMetricsGate(this, {
        stageName: 'TEST',
        durationMs: Date.now() - _testStageStartTime,
        errorCount: 0,
        llmCalls: (this.obs && this.obs._llmCallCount) ? this.obs._llmCallCount : 0,
      });
      return iterResult.outputPath;
    }

    if (iterResult.__alreadyTransitioned) {
      return iterResult;
    }

    console.error(`[Orchestrator] 🔄 Re-running TEST stage (iteration ${testIteration + 1}/${MAX_TEST_ITERATIONS}) after developer retry...`);
  }

  console.warn(`[Orchestrator] ⚠️  TEST stage iteration limit reached without resolution.`);
  return null;
}

/**
 * Single iteration of the TEST stage. Separated from _runTester for retry logic.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @param {number} testIteration
 * @param {number} maxIterations
 * @param {Array} fixConversationHistory
 */
async function _runTesterOnce(testIteration, maxIterations, fixConversationHistory) {
  // P1-4 fix: Declare corrResult at function scope so storeTestContext() at the
  // bottom always sees the actual correction result. Previously corrResult was
  // declared as `const` inside the `if (testContent)` else-branch, making it
  // block-scoped — storeTestContext() always received null via the ?? fallback.
  let corrResult = null;

  // Print stage header via handoffLog if available
  const iterationSuffix = testIteration > 1 ? ` [iteration ${testIteration}/${maxIterations}]` : '';
  if (this.handoffLog) {
    this.handoffLog.printStageHeader('TEST', 'TesterAgent');
    if (testIteration > 1) {
      console.error(`  🔄 Retry iteration ${testIteration}/${maxIterations}`);
    }
  } else {
    console.error(`\n[Orchestrator] Stage: TEST (TesterAgent)${iterationSuffix}`);
  }  const inputPath = this.bus.consume(AgentRole.TESTER);

  const upstreamCtxForTest = buildTesterUpstreamCtx(this);

  const devMeta = this.bus.getMeta(AgentRole.TESTER);
  if (devMeta && devMeta.reviewRounds > 0) {
    console.error(`[Orchestrator] ℹ️  Code was self-corrected in ${devMeta.reviewRounds} round(s) (${devMeta.failedItems} issue(s) fixed). Tester should pay attention to corrected areas.`);
  }

  // ── Step 0: Pre-generate test cases ──────────────────────────────────────
  console.error(`\n[Orchestrator] 📋 Pre-generating test cases (test-first planning)...`);
  let tcGenResult = { skipped: true, caseCount: 0 };
  let isDetailedMode = false;
  
  // Check if detailed test generation mode is enabled
  const useDetailedTestGen = this._config?.testGeneration?.mode === 'advanced';
  
  try {
    const tcGen = new TestCaseGenerator(this._rawLlmCall, {
      verbose: true,
      outputDir: this._outputDir,
    });
    
    if (useDetailedTestGen && fs.existsSync(PATHS.CODE_DIFF_FILE)) {
      // Advanced mode: generate detailed test document from code.diff
      console.error(`[Orchestrator] 🔬 Using ADVANCED test generation mode (from code.diff)`);
      tcGenResult = await tcGen.generateAdvanced();
      isDetailedMode = true;
      
      if (!tcGenResult.skipped) {
        console.error(`[Orchestrator] ✅ Detailed test plan generated: ${tcGenResult.caseCount} case(s) for ${tcGenResult.features?.length || 0} feature(s) → output/test-cases-detailed.md`);
      } else {
        console.error(`[Orchestrator] ⏭️  Advanced generation skipped, falling back to basic mode...`);
        tcGenResult = await tcGen.generate();
        isDetailedMode = false;
      }
    } else {
      // Basic mode: generate from requirements
      tcGenResult = await tcGen.generate();
    }
    
    if (!tcGenResult.skipped && !isDetailedMode) {
      console.error(`[Orchestrator] ✅ Test cases generated: ${tcGenResult.caseCount} case(s) → output/test-cases.md`);
    } else if (tcGenResult.skipped && !useDetailedTestGen) {
      console.error(`[Orchestrator] ⏭️  Test case generation skipped (no requirements.md found).`);
    }
  } catch (err) {
    console.warn(`[Orchestrator] ⚠️  Test case generation failed (non-fatal): ${err.message}`);
  }

  // ── Step 0.5: Execute generated test cases ─────────────────────────────────
  let tcExecutionReport = null;
  if (!tcGenResult.skipped && tcGenResult.caseCount > 0) {
    console.error(`\n[Orchestrator] 🔬 Executing generated test cases (real execution)...`);
    try {
      const tcExecutor = new TestCaseExecutor({
        projectRoot: this.projectRoot,
        testCommand: this._config.testCommand || null,
        framework: this._config.testFramework || 'auto',
        outputDir: this._outputDir,
        timeoutMs: 90_000,
        verbose: true,
      });
      tcExecutionReport = await tcExecutor.execute();
      if (!tcExecutionReport.skipped) {
        const _manualPending = tcExecutionReport.manualPending ?? 0;
        const _automatedTotal = tcExecutionReport.automatedTotal ?? (tcExecutionReport.total - _manualPending);
        console.error(`[Orchestrator] 📊 Test case execution: ${tcExecutionReport.passed}/${_automatedTotal} passed, ${tcExecutionReport.failed} failed, ${tcExecutionReport.blocked} blocked, ${_manualPending} manual-pending`);
        const execReportPath = path.join(this._outputDir, 'test-execution-report.md');
        fs.writeFileSync(execReportPath, tcExecutionReport.summaryMd, 'utf-8');
        console.error(`[Orchestrator] 📝 Execution report saved → output/test-execution-report.md`);
        if (tcExecutionReport.failed > 0) {
          this.stateMachine.recordRisk('medium',
            `[TestCaseExecutor] ${tcExecutionReport.failed}/${_automatedTotal} automated test case(s) failed real execution. See output/test-execution-report.md.`);
        }
        if (_manualPending > 0) {
          console.error(`[Orchestrator] 🖐️  ${_manualPending} manual test case(s) require human verification – not counted as failures.`);
        }
      } else {
        console.error(`[Orchestrator] ⏭️  Test case execution skipped: ${tcExecutionReport.skipReason}`);
      }
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  Test case execution failed (non-fatal): ${err.message}`);
    }
  } else {
    console.error(`[Orchestrator] ⏭️  Test case execution skipped (no cases generated).`);
  }

  // A-3 fix: buildTesterContextBlock now returns { content, injectedExpIds } struct
  const testContextResult = await buildTesterContextBlock(this, upstreamCtxForTest, tcExecutionReport);
  const testExpContext = testContextResult.content;
  const testInjectedExpIds = testContextResult.injectedExpIds || [];
  this.obs.recordExpUsage({ injected: testInjectedExpIds.length });
const outputPath = await this.agents[AgentRole.TESTER].run(inputPath, null, testExpContext, this.handoffLog);

  // ── Adapter Telemetry ─────────────────────────────────────────────────────────
  if (this._adapterTelemetry && outputPath && fs.existsSync(outputPath)) {
    try {
      const testOutput = fs.readFileSync(outputPath, 'utf-8');
      this._adapterTelemetry.scanReferences(testOutput, 'TESTER');
      // ── Agent Self-Report: extract self-report from TESTER output ──
      recordSelfReport('TEST', testOutput, { agentRole: AgentRole.TESTER });
    } catch (_) { /* non-fatal */ }
  }
  let testContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
  if (!testContent) {
    console.warn(`[Orchestrator] ⚠️  TesterAgent produced an empty test report at: ${outputPath}. Skipping self-correction.`);
    this.stateMachine.recordRisk('high', '[TestReport] TesterAgent produced an empty test report – self-correction skipped.');
  } else {
    const corrector = new SelfCorrectionEngine(
      this._rawLlmCall,
      {
        maxRounds: 2,
        verbose: true,
        semanticMode: true,
        cheapLlmCall: this.llmRouter?.getTierConfig()?.fast || null,
        investigationTools: this._buildInvestigationTools('TestReport'),
      }
    );
    corrResult = await corrector.correct(testContent, 'Test Report');

    if (corrResult.rounds > 0) {
      const tmpPath = outputPath + '.tmp';
      fs.writeFileSync(tmpPath, corrResult.content, 'utf-8');
      fs.renameSync(tmpPath, outputPath);
      console.error(`[Orchestrator] Test report self-corrected in ${corrResult.rounds} round(s).`);
    }

    const report = formatClarificationReport(corrResult);
    if (report) {
      fs.appendFileSync(outputPath, `\n\n---\n${report}`, 'utf-8');
    }

    if (corrResult.needsHumanReview) {
      const riskMsg = `[TestReport] ${corrResult.signals.filter(s => s.severity === 'high').map(s => s.label).join(', ')} – unresolved after self-correction.`;
      this.stateMachine.recordRisk('high', riskMsg);
      console.warn(`[Orchestrator] ⚠️  High-severity test report issues detected.`);
      try {
        const defectDecision = this.socratic.askAsync(DECISION_QUESTIONS.TEST_DEFECTS_ACTION, 0);
        console.error(`[Orchestrator] ⚡ Defect handling decision (non-blocking): "${defectDecision.optionText}"`);
        this.stateMachine.recordRisk('low', `[SocraticEngine] Defect handling: ${defectDecision.optionText}`);
      } catch (err) {
        this.stateMachine.recordRisk('low', `[SocraticEngine] Defect handling decision skipped (engine unavailable): ${err.message}`);
        console.warn(`[Orchestrator] ⚠️  SocraticEngine defect decision skipped – proceeding automatically. Reason: ${err.message}`);
      }

      const testGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
      const testRollbackCountForGate = this._rollbackCounters?.get(WorkflowState.TEST) ?? 0;
      // Plan-A: Use LoopGuard for centralized retry limit management
      const loopGuard = this._loopGuard;
      const loopGuardCanRetry = loopGuard ? loopGuard.canRetry('TEST', 'CODE') : true;
      const testGateInput = {
        failed: corrResult.signals.filter(s => s.severity === 'high').length,
        needsHumanReview: corrResult.needsHumanReview,
        total: corrResult.signals.length,
        rounds: corrResult.rounds,
        riskNotes: [riskMsg],
        history: corrResult.history || [],
      };
      const testDecision = testGate.evaluate(testGateInput, WorkflowState.TEST, testRollbackCountForGate);
      testGate.recordExperience(testDecision, WorkflowState.TEST, testGateInput, { skill: 'test-report', category: ExperienceCategory.PITFALL });

      _recordPromptABOutcome('tester', !testDecision.rollback, corrResult.rounds ?? 0);

      if (testDecision.rollback) {
        // Plan-A: Check LoopGuard before allowing rollback
        if (loopGuard && !loopGuardCanRetry) {
          console.warn(`[Orchestrator] ⚠️  LoopGuard: TEST→CODE retry blocked (max retries reached: ${loopGuard.getRetryCount('TEST', 'CODE')}/${loopGuard.getMaxRetries('TEST', 'CODE')}). Proceeding with risks recorded.`);
          this.stateMachine.recordRisk('medium', `[LoopGuard] TEST→CODE rollback blocked after ${loopGuard.getRetryCount('TEST', 'CODE')} retries. Unresolved issues: ${riskMsg.slice(0, 200)}`);
        } else {
        const testRollbackCount = this._rollbackCounters?.get(WorkflowState.TEST) ?? 0;
        if (this._rollbackCounters) this._rollbackCounters.set(WorkflowState.TEST, testRollbackCount + 1);
        // Plan-A: Record retry in LoopGuard
        if (loopGuard) loopGuard.recordRetry('TEST', 'CODE');
        if (!this._pendingTestMeta) this._pendingTestMeta = {};
        this._pendingTestMeta._testRollbackCount = testRollbackCount + 1;
        try {
          const coordinator = new RollbackCoordinator(this);
          await coordinator.rollback(WorkflowState.TEST, `Test report failed: ${riskMsg.slice(0, 200)}`);
          
          // Record rollback in handoff log
          if (this.handoffLog) {
            this.handoffLog.recordRollback('TEST', 'CODE', `Test report failed: ${riskMsg.slice(0, 200)}`);
          }

          const codeDiffPath = path.join(this._outputDir, 'code.diff');
          // RetryDivergenceGuard: build enhanced failure note with Negative Prompt + Creativity Directive
          let previousTestOutput = '';
          try {
            const testReportPath = path.join(this._outputDir, 'test-report.md');
            if (fs.existsSync(testReportPath)) previousTestOutput = fs.readFileSync(testReportPath, 'utf-8');
          } catch (_) { /* non-fatal */ }

          const retryContext = await buildRetryContext({
            previousOutput: previousTestOutput,
            failureReason: riskMsg,
            retryCount: testRollbackCount + 1,
            stageName: 'TEST',
          });
          const failureNote = `\n\n---\n${retryContext}\n\nPlease fix the implementation to address these test failures before the tester retries.`;
          if (fs.existsSync(codeDiffPath)) {
            fs.appendFileSync(codeDiffPath, failureNote, 'utf-8');
          }
          const archOutputPath = path.join(this._outputDir, 'architecture.md');
          if (fs.existsSync(archOutputPath)) {
          this.bus.publish(AgentRole.ARCHITECT, AgentRole.PLANNER, archOutputPath, {
              testReportFailed: true,
              riskMsg,
              rollbackRetry: testRollbackCount + 1,
              reviewRounds: 1,
              failedItems: 1,
            });
          }
          const devStageLabel = 'TEST→CODE(rollback-retry)';
          this.obs.stageStart(devStageLabel);
          let devRetry;
          try {
            devRetry = await _getRunDeveloper().call(this);
            this.obs.stageEnd(devStageLabel, 'ok');
          } catch (devErr) {
            this.obs.stageEnd(devStageLabel, 'error');
            this.obs.recordError(devStageLabel, devErr.message);
            await this.hooks.emit(HOOK_EVENTS.WORKFLOW_ERROR, { error: devErr, state: 'TEST→CODE(rollback)' }).catch(() => {});
            throw devErr;
          }
          if (devRetry && typeof devRetry === 'object' && devRetry.__alreadyTransitioned) {
            return { __done: true, __alreadyTransitioned: true };
          }
          let devOutputPath;
          if (typeof devRetry === 'string') {
            devOutputPath = devRetry;
          } else {
            const codeCtxArtifacts = this.stageCtx?.get(WorkflowState.CODE)?.artifacts;
            const stageCtxCodePath = Array.isArray(codeCtxArtifacts) && codeCtxArtifacts.length > 0
              ? codeCtxArtifacts[0]
              : null;
            devOutputPath = stageCtxCodePath || path.join(this._outputDir, 'code.diff');
          }
          if (fs.existsSync(devOutputPath)) {
            this.bus.publish(AgentRole.DEVELOPER, AgentRole.TESTER, devOutputPath, {
              testRollbackRetry: testRollbackCount + 1,
            });
          }
          console.error(`[Orchestrator] 🔄 Signalling TEST stage retry (rollback round ${testRollbackCount + 1}) – iterative loop will continue...`);
          this._pendingTestMeta = null;
          return { __retry: true };
        } catch (rollbackErr) {
          console.warn(`[Orchestrator] Test rollback failed (non-fatal): ${rollbackErr.message}. Proceeding with risks recorded.`);
        }
        } // end Plan-A LoopGuard else block
      } else {
        console.warn(`[Orchestrator] ⚠️  Test rollback limit reached (max 1). Proceeding with ${corrResult.signals.filter(s => s.severity === 'high').length} unresolved high-severity issue(s).`);
      }
    } else {
      console.error(`[Orchestrator] ✅ Test report passed self-correction. Workflow proceeding.`);
      const testPassTitle = 'Test report passed self-correction with no high-severity issues';
      this.experienceStore.recordIfAbsent(testPassTitle, {
        type: ExperienceType.POSITIVE,
        category: ExperienceCategory.STABLE_PATTERN,
        title: testPassTitle,
        content: `Test report passed self-correction with no high-severity issues remaining.`,
        skill: 'test-report',
        tags: ['test-report', 'passed', 'stable'],
      });
    }
  }

  // ── Real Test Execution + Auto-Fix Loop ──────────────────────────────────
  const baseTestCommand = this._config.testCommand || null;
  const autoFixCfg = this._config.autoFixLoop || {};
  const configuredTestProfile = _normalizeTestProfile(this._config.testProfile || 'fast');
  const hasHighRiskChanges = _hasHighRiskTestScope(this);
  const effectiveTestProfile = hasHighRiskChanges ? 'full' : configuredTestProfile;

  const changedFiles = _collectChangedFilesFromCodeDiff();
  const impactedSuites = effectiveTestProfile === 'full' ? ['smoke', 'unit', 'integration'] : _inferImpactedSuites(changedFiles);

  const baselineTestCommand = _buildProfiledTestCommand.call(this, baseTestCommand, effectiveTestProfile, null);
  const testCommand = _buildProfiledTestCommand.call(this, baseTestCommand, effectiveTestProfile, impactedSuites);
  const autoFixEnabled = autoFixCfg.enabled !== false && !!testCommand;
  const maxFixRounds = this._adaptiveStrategy.maxFixRounds ?? autoFixCfg.maxFixRounds ?? 2;
  const failOnUnfixed = autoFixCfg.failOnUnfixed ?? false;

  if (baseTestCommand && testCommand !== baseTestCommand) {
    console.error(`[Orchestrator] 🧪 TEST profile active: ${effectiveTestProfile} (command adapted)`);
  } else if (baseTestCommand) {
    console.error(`[Orchestrator] 🧪 TEST profile active: ${effectiveTestProfile}`);
  }

  if (!hasHighRiskChanges && effectiveTestProfile !== 'full' && impactedSuites.length > 0) {
    console.error(`[Orchestrator] 🎯 Impact-driven suites: ${impactedSuites.join(', ')}${changedFiles.length > 0 ? ` (from ${changedFiles.length} changed file(s))` : ''}`);
  }

  if (hasHighRiskChanges && configuredTestProfile !== 'full') {
    console.error(`[Orchestrator] ⚠️  High-risk core changes detected. Escalating test profile: ${configuredTestProfile} → full`);
  }

  if (maxFixRounds !== (autoFixCfg.maxFixRounds ?? 2)) {
    console.error(`[Orchestrator] 📈 Adaptive maxFixRounds: ${maxFixRounds} (history-adjusted from default ${autoFixCfg.maxFixRounds ?? 2})`);
  }

  if (!testCommand) {
    console.error(`[Orchestrator] ℹ️  No testCommand configured – skipping real test execution.`);
    console.error(`[Orchestrator] 💡 Set testCommand in workflow.config.js to enable automated verification.`);
  } else {
    await _runRealTestLoop.call(this, { testCommand, baselineTestCommand: baselineTestCommand || testCommand, autoFixEnabled, maxFixRounds, failOnUnfixed, testReportPath: outputPath, lintCommand: this._config?.lintCommand || null, fixConversationHistory, injectedExpIds: testInjectedExpIds });
  }

  // ── CIIntegration ────────────────────────────────────────────────────────
  try {
    console.error(`\n[Orchestrator] 🚀 Running CI pipeline validation (post-test)...`);
    await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_STARTED, { command: testCommand || null });
    const ciResult = await this.ci.runLocalPipeline({ skipEntropy: this._adaptiveStrategy.skipEntropyOnClean });
    this.obs.recordCIResult(ciResult);
    await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_COMPLETE, { result: ciResult });
    if (ciResult.status === 'success') {
      console.error(`[Orchestrator] ✅ CI pipeline passed: ${ciResult.message}`);
    } else {
      const ciMsg = `[CIIntegration] Pipeline ${ciResult.status}: ${ciResult.message}`;
      console.warn(`[Orchestrator] ⚠️  ${ciMsg}`);
      this.stateMachine.recordRisk('medium', ciMsg);
      await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_FAILED, { result: ciResult });
    }
  } catch (err) {
    console.warn(`[Orchestrator] CI pipeline validation failed (non-fatal): ${err.message}`);
  }

  // ── Entropy GC ───────────────────────────────────────────────────────────
  if (this._adaptiveStrategy.skipEntropyOnClean) {
    console.error(`[Orchestrator] ⏭️  Entropy scan skipped (last 3 sessions had 0 violations – adaptive strategy).`);
    this.obs._entropySkipped = true;
  } else {
    console.error(`\n[Orchestrator] 🔍 Running entropy scan after Tester stage...`);
    try {
      const gcResult = await this.entropyGC.run();
      this.obs.recordEntropyResult(gcResult);
      if (gcResult.violations > 0) {
        const gcMsg = `[EntropyGC] ${gcResult.violations} violation(s) found after Tester stage (${gcResult.details?.high ?? 0} high / ${gcResult.details?.medium ?? 0} medium / ${gcResult.details?.low ?? 0} low). See output/entropy-report.md.`;
        console.warn(`[Orchestrator] ⚠️  ${gcMsg}`);
        if ((gcResult.details?.high ?? 0) > 0) {
          this.stateMachine.recordRisk('medium', gcMsg);
        }
        if (fs.existsSync(outputPath)) {
          const entropyNote = [
            ``, `---`, ``,
            `## 🔍 Entropy GC Scan (post-test)`, ``,
            `> Scanned ${gcResult.filesScanned} files | Found **${gcResult.violations}** violation(s)`,
            `> High: ${gcResult.details?.high ?? 0} | Medium: ${gcResult.details?.medium ?? 0} | Low: ${gcResult.details?.low ?? 0}`,
            `> Full report: \`output/entropy-report.md\``,
          ].join('\n');
          fs.appendFileSync(outputPath, entropyNote, 'utf-8');
        }
      } else {
      console.error(`[Orchestrator] ✅ Entropy scan: no violations found.`);
      }
    } catch (err) {
      console.warn(`[Orchestrator] EntropyGC scan failed (non-fatal): ${err.message}`);
    }
  }

  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  try {
    if (this.experienceStore && typeof this.experienceStore.flushDirty === 'function') {
      await this.experienceStore.flushDirty();
      console.error(`[Orchestrator] 💾 ExperienceStore flushed (hitCount increments persisted).`);
    }
  } catch (flushErr) {
    console.warn(`[Orchestrator] ⚠️  ExperienceStore flush failed (non-fatal): ${flushErr.message}`);
  }

  // ── Document Output Validation (打点日志审查) ─────────────────────────────
  // ADR-XX: Document output validation is part of TEST stage, not just teardown.
  // This ensures output artifacts are verified BEFORE the workflow completes.
  console.error(`\n[Orchestrator] 📋 Running document output validation (打点日志审查)...`);

  let outputValidationResult = { passed: true, details: {} };

  const stageOutputDir = this._outputDir || this._outputDir;

  try {
    // 1. Validate required output files exist
    const requiredFiles = [
      'requirement.md',
      'architecture.md',
      'test-report.md',
      'code.diff',
    ];

    const missingFiles = [];
    const emptyFiles = [];

    for (const file of requiredFiles) {
      const filePath = path.join(stageOutputDir, file);
      if (!fs.existsSync(filePath)) {
        missingFiles.push(file);
      } else {
        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
          emptyFiles.push(file);
        }
      }
    }

    // 2. Run ExecutionLogValidator for structured validation
    const execValidator = new ExecutionLogValidator({
      outputDir: stageOutputDir,
      verbose: false,
      strictMode: false,
      reportOutputDir: stageOutputDir,
    });

    const execValidation = await execValidator.validate();
    const { summary, stageValidations } = execValidation.report;

    // 3. Run EvolutionLoop output verification
    const evolutionLoop = new EvolutionLoop({ outputDir: stageOutputDir, verbose: false });
    const evolutionVerification = evolutionLoop.verifyOutputFiles([`health/${this._runCategory || 'prod'}/evolution-log.json`, `health/${this._runCategory || 'prod'}/quality-report.md`]);

    // 4. Aggregate results
    outputValidationResult = {
      passed: missingFiles.length === 0 && emptyFiles.length === 0 && summary.status !== 'failed',
      summary: {
        status: summary.status,
        score: summary.score,
        completedStages: summary.completedStages,
        totalStages: summary.totalStages,
      },
      missingFiles,
      emptyFiles,
      evolutionFiles: evolutionVerification,
      stageValidations: Object.fromEntries(
        Object.entries(stageValidations).map(([k, v]) => [k, { status: v.status, score: v.score }])
      ),
    };

    // 5. Log results
    const statusEmoji = outputValidationResult.passed ? '✅' : '❌';
    console.error(`[Orchestrator] ${statusEmoji} Document Output Validation: ${outputValidationResult.passed ? 'PASSED' : 'FAILED'}`);
    console.error(`[Orchestrator]    Execution Score: ${summary.score}/100 (${summary.status})`);
    console.error(`[Orchestrator]    Stages: ${summary.completedStages}/${summary.totalStages} completed`);

    if (missingFiles.length > 0) {
      console.error(`[Orchestrator]    ❌ Missing: ${missingFiles.join(', ')}`);
      this.stateMachine.recordRisk('high', `[OutputValidation] Missing required files: ${missingFiles.join(', ')}`);
    }

    if (emptyFiles.length > 0) {
      console.error(`[Orchestrator]    ⚠️  Empty: ${emptyFiles.join(', ')}`);
      this.stateMachine.recordRisk('medium', `[OutputValidation] Empty output files: ${emptyFiles.join(', ')}`);
    }

    if (!evolutionVerification.passed) {
      console.error(`[Orchestrator]    ⚠️  Evolution files: ${evolutionVerification.missingFiles.concat(evolutionVerification.emptyFiles).join(', ')}`);
    }

    // 6. Record to ExperienceStore if score is low
    if (summary.score < 80 && this.experienceStore) {
      this.experienceStore.recordIfAbsent('test-stage-output-validation-low-score', {
        type: ExperienceType.NEGATIVE,
        category: ExperienceCategory.PITFALL,
        title: 'Output document validation score below threshold',
        content: `TEST stage output validation score: ${summary.score}/100. Missing: ${missingFiles.join(', ')}. Empty: ${emptyFiles.join(', ')}.`,
        skill: 'test-validation',
        tags: ['output-validation', 'quality-gate', 'test-stage'],
        metrics: { score: summary.score },
      });
    }

    // 7. Generate output validation report
    const validationReportPath = path.join(stageOutputDir, 'test-output-validation.json');
    fs.writeFileSync(validationReportPath, JSON.stringify(outputValidationResult, null, 2), 'utf-8');
    console.error(`[Orchestrator] 📝 Output validation report: output/test-output-validation.json`);

    // 8. Signal to EvolutionLoop for potential retry
    if (this._evolutionLoop) {
      this._evolutionLoop.processSignal({
        type: summary.score < 80 ? 'QUALITY_GATE_FAILURE' : 'OUTPUT_VALIDATION_PASSED',
        severity: summary.score < 80 ? 'high' : 'info',
        stage: 'TEST',
        evidence: `Output validation score: ${summary.score}/100. Missing: ${missingFiles.length}, Empty: ${emptyFiles.length}`,
        confidence: 0.95,
        timestamp: new Date().toISOString(),
      });
    }

  } catch (validationErr) {
    console.warn(`[Orchestrator] ⚠️  Document output validation failed (non-fatal): ${validationErr.message}`);
    this.stateMachine.recordRisk('medium', `[OutputValidation] Validation error: ${validationErr.message}`);
    outputValidationResult = { passed: false, error: validationErr.message };
  }

  await storeTestContext(this, outputPath, tcGenResult, tcExecutionReport, corrResult ?? null);

  return { __done: true, outputPath, outputValidation: outputValidationResult };
}

/**
 * Real test execution loop with auto-fix capability.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @param {object} opts - Loop configuration
 */
async function _runRealTestLoop({ testCommand, baselineTestCommand = testCommand, autoFixEnabled, maxFixRounds, failOnUnfixed, testReportPath, lintCommand = null, fixConversationHistory = null, injectedExpIds = [] }) {
  const fixHistory = fixConversationHistory || [];
  const runner = new TestRunner({
    projectRoot: this.projectRoot,
    testCommand,
    timeoutMs: 180_000,
    verbose: true,
  });

  console.error(`\n[Orchestrator] 🔬 Running real test suite: ${testCommand}`);
  let result;
  try {
    result = runner.run();
  } catch (runErr) {
    console.error(`[Orchestrator] ❌ Test runner threw an unexpected error: ${runErr.message}`);
    this.stateMachine.recordRisk('high', `[RealTest] Test runner crashed: ${runErr.message}`);
    if (failOnUnfixed) throw runErr;
    return;
  }

  const realResultMd = TestRunner.formatResultAsMarkdown(result);
  if (fs.existsSync(testReportPath)) {
    fs.appendFileSync(testReportPath, `\n\n---\n\n${realResultMd}`, 'utf-8');
  }

  if (result.passed) {
    console.error(`[Orchestrator] ✅ Real tests PASSED on first run.`);

    const securityAudit = await _runSecurityAuditForTestStage.call(this, {
      testReportPath,
      stageLabel: 'TEST (first-run pass)',
    });

    if (securityAudit.passed) {
      this.obs.recordTestResult({ passed: result.passed ? 1 : 0, failed: 0, skipped: 0, rounds: 1 });
      await runEvoMapFeedback(this, {
        injectedExpIds,
        errorContext: '',
        stageLabel: 'TEST (first-run pass)',
      });
      // P1: Use recordWithContentCheck to avoid duplicate experience entries
      this.experienceStore.recordWithContentCheck({
        type: ExperienceType.POSITIVE,
        category: ExperienceCategory.STABLE_PATTERN,
        title: `Real tests passed: ${testCommand}`,
        content: `All tests and security checks passed on first run. Command: ${testCommand}. Duration: ${result.durationMs}ms.`,
        skill: 'test-report',
        tags: ['real-test', 'security-audit', 'passed', 'first-run'],
      });
      return;
    }

    const securityMsg = `[SecurityTest] Blocking findings detected after first-run pass: ${securityAudit.blockingReasons.join('; ')}`;
    this.stateMachine.recordRisk('high', securityMsg);
    console.warn(`[Orchestrator] ⚠️  ${securityMsg}`);

    if (!autoFixEnabled) {
      if (failOnUnfixed) throw new Error(securityMsg);
      return;
    }

    result = {
      ...result,
      passed: false,
      exitCode: result.exitCode || 1,
      failureSummary: [...(result.failureSummary || []), ...securityAudit.blockingReasons],
    };
  }

  console.warn(`[Orchestrator] ❌ Real tests FAILED (exit ${result.exitCode}).`);
  if (!autoFixEnabled) {
    const msg = `[RealTest] Tests failed (exit ${result.exitCode}). Auto-fix disabled. Manual fix required.`;
    this.stateMachine.recordRisk('high', msg);
    console.warn(`[Orchestrator] ⚠️  Auto-fix disabled. Recorded as risk.`);
    if (failOnUnfixed) throw new Error(msg);
    return;
  }

  let fixRound = 0;

  while (!result.passed && fixRound < maxFixRounds) {
    fixRound++;
    console.error(`\n[Orchestrator] 🔧 Auto-fix round ${fixRound}/${maxFixRounds}...`);

    const _rawFailureContext = TestRunner.formatResultAsMarkdown(result);
    const failureContext = _rawFailureContext.length > 6000
      ? `... [${_rawFailureContext.length - 6000} chars omitted] ...\n` + _rawFailureContext.slice(-6000)
      : _rawFailureContext;
    const codeDiffPath = path.join(this._outputDir, 'code.diff');
    const existingDiff = fs.existsSync(codeDiffPath) ? fs.readFileSync(codeDiffPath, 'utf-8') : '(no previous diff)';

    const previousFixesBlock = fixRound > 1
      ? `## Fix History\n> This is fix round ${fixRound}. Your previous fix attempt(s) are in the conversation history above.\n> Review what you tried before and why it did not fully resolve the failures.`
      : '';

    // ── Sandbox Diagnostics (Optimization 2) ────────────────────────────────
    let sandboxDiagnosticsContext = '';
    try {
      console.error(`[Orchestrator] 🩺 Running Sandbox Diagnostics...`);
      const diagnostics = await _runSandboxDiagnostics.call(this, result);
      if (diagnostics) {
        sandboxDiagnosticsContext = `## 🩺 Sandbox Diagnostics\n> The following diagnostic information was collected from the test execution environment to help identify the root cause.\n\n\`\`\`\n${diagnostics}\n\`\`\`\n`;
        console.error(`[Orchestrator] 🩺 Sandbox Diagnostics collected (${diagnostics.length} chars).`);
      }
    } catch (diagErr) {
      console.warn(`[Orchestrator] ⚠️  Sandbox Diagnostics failed (non-fatal): ${diagErr.message}`);
    }

    // Collect source files for Fix Agent context
    let sourceFilesContext = '';
    try {
      const sourceExts = (this._config.sourceExtensions || ['.js', '.ts', '.py', '.go', '.java', '.cs']);
      const ignoreDirs = this._config.ignoreDirs || ['node_modules', '.git', 'dist', 'build', 'output'];

      const sourceFiles = scanSourceFiles(this.projectRoot, {
        extensions: sourceExts,
        ignoreDirs,
        maxDepth: 4,
        skipDotFiles: true,
      });

      const failureText = result.output || (result.failureSummary || []).join('\n');
      const mentionedFiles = sourceFiles.filter(f => {
        const rel = path.relative(this.projectRoot, f).replace(/\\/g, '/');
        return failureText.includes(rel) || failureText.includes(path.basename(f));
      });
      const otherFiles = sourceFiles.filter(f => !mentionedFiles.includes(f));
      const orderedFiles = [...mentionedFiles, ...otherFiles];

      const fileSnippets = [];
      let totalChars = 0;
      const MAX_SOURCE_CHARS = 8000;

      for (const filePath of orderedFiles) {
        if (totalChars >= MAX_SOURCE_CHARS) break;
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const rel = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
          const rawSnippet = content.length > 3000 ? content.slice(0, 3000) + '\n... (truncated)' : content;
          const numberedSnippet = rawSnippet.split('\n').map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`).join('\n');
          fileSnippets.push(`### ${rel}\n\`\`\`\n${numberedSnippet}\n\`\`\``);
          totalChars += numberedSnippet.length;
        } catch { /* skip unreadable files */ }
      }

      if (fileSnippets.length > 0) {
        sourceFilesContext = `## Current Source Files (${fileSnippets.length} file(s))\n\n${fileSnippets.join('\n\n')}`;
        console.error(`[Orchestrator] 📂 Fix Agent context: ${fileSnippets.length} source file(s) injected (${totalChars} chars)`);
      }
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  Could not collect source files for Fix Agent: ${err.message}`);
    }

    // ── Web Search: search for error solutions ────────────────────────────
    let webSearchContext = '';
    try {
      if (this.services && this.services.has('mcpRegistry')) {
        const registry = this.services.resolve('mcpRegistry');
        const wsAdapter = registry.get('websearch');
        if (wsAdapter) {
          const rawOutput = result.output || (result.failureSummary || []).join('\n');
          const errorLines = rawOutput.split('\n')
            .filter(line => /\b(Error|TypeError|ReferenceError|SyntaxError|FAIL|AssertionError|Cannot find|Module not found|unexpected token|is not a function|is not defined|ENOENT|EACCES|ECONNREFUSED)/i.test(line))
            .map(line => line.trim())
            .filter(line => line.length > 10 && line.length < 300)
            .slice(0, 3);
          if (errorLines.length > 0) {
            const primaryError = errorLines[0]
              .replace(/\bat\s+.*$/i, '')
              .replace(/\(.*?\)/g, '')
              .replace(/['"]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 150);
            const searchQuery = `${primaryError} fix solution`;
            console.error(`[Orchestrator] 🌐 Auto-fix web search: "${searchQuery.slice(0, 80)}..."`);
            const searchResult = await wsAdapter.search(searchQuery, { maxResults: 3 });
            if (searchResult && searchResult.results && searchResult.results.length > 0) {
              const formatted = searchResult.results.map((r, i) =>
                `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${(r.snippet || '').slice(0, 250)}`
              ).join('\n\n');
              webSearchContext = [
                `## 🌐 Web Research (Error Solutions)`,
                `> The following web search results may contain relevant fixes, workarounds, or explanations.`,
                `> **Evaluate critically** — apply only solutions that match the root cause you diagnosed above.`,
                ``,
                `**Search query**: "${primaryError}"`,
                `**Error lines found**:`,
                ...errorLines.map(l => `- \`${l.slice(0, 200)}\``),
                ``,
                `**Relevant solutions**:`,
                formatted,
              ].join('\n');
              console.error(`[Orchestrator] 🌐 Auto-fix web search: ${searchResult.results.length} result(s) injected (provider: ${searchResult.provider}).`);
            } else {
              console.error(`[Orchestrator] 🌐 Auto-fix web search: no results found.`);
            }
          }
        }
      }
    } catch (wsErr) {
      console.warn(`[Orchestrator] 🌐 Auto-fix web search failed (non-fatal): ${wsErr.message}`);
    }

    // Inject sandbox diagnostics into the failure context
    const enhancedFailureContext = sandboxDiagnosticsContext 
      ? `${failureContext}\n\n${sandboxDiagnosticsContext}`
      : failureContext;

    const fixPrompt = buildFixAgentPrompt({
      existingDiff,
      previousFixesBlock,
      sourceFilesContext,
      failureContext: enhancedFailureContext,
      webSearchContext,
      projectRoot: this.projectRoot,
    });

    console.error(`[Orchestrator] 🤖 Invoking Code Fix Agent for fix round ${fixRound}...`);
    let fixResponse;
    try {
      fixHistory.push({ role: 'user', content: fixPrompt });

      const llmInput = fixHistory.length > 1
        ? fixHistory
        : fixPrompt;

      fixResponse = await this._rawLlmCall(llmInput);

      if (fixResponse && fixResponse.trim()) {
        fixHistory.push({ role: 'assistant', content: fixResponse });
      }
    } catch (err) {
      console.error(`[Orchestrator] ❌ LLM call failed during fix round ${fixRound}: ${err.message}`);
      break;
    }

    if (!fixResponse || !fixResponse.trim()) {
      console.warn(`[Orchestrator] ⚠️  Code Fix Agent returned empty response in fix round ${fixRound}. Stopping.`);
      break;
    }

    const fixedDiffPath = path.join(this._outputDir, `code-fix-round${fixRound}.txt`);
    fs.writeFileSync(fixedDiffPath, fixResponse, 'utf-8');
    console.error(`[Orchestrator] 📝 Fix response saved to: ${fixedDiffPath}`);

    const applyResult = this._applyFileReplacements(fixResponse);
    console.error(`[Orchestrator] 🔧 Applied ${applyResult.applied} replacement(s), ${applyResult.failed} failed.`);
    if (applyResult.failed > 0) {
      console.warn(`[Orchestrator] ⚠️  Some replacements failed:\n${applyResult.errors.join('\n')}`);
    }
    if (applyResult.applied === 0) {
      console.warn(`[Orchestrator] ⚠️  No replacements were applied. Stopping fix loop.`);
      fixRound--;
      break;
    }

    // ── Post-fix validation ─────────────────────────────────────────────────
    if (lintCommand) {
      console.error(`[Orchestrator] 🔍 Post-fix lint check: ${lintCommand}`);
      try {
        const { execSync } = require('child_process');
        execSync(lintCommand, { cwd: this.projectRoot, stdio: 'pipe', timeout: 60_000 });
        console.error(`[Orchestrator] ✅ Post-fix lint: no errors.`);
      } catch (lintErr) {
        const lintOutput = (lintErr.stdout?.toString() || '') + (lintErr.stderr?.toString() || '');
        console.warn(`[Orchestrator] ⚠️  Post-fix lint FAILED in fix round ${fixRound}:\n${lintOutput.slice(0, 800)}`);
        this.stateMachine.recordRisk('medium', `[RealTest] Fix round ${fixRound} introduced lint errors: ${lintOutput.slice(0, 200)}`);
      }
    }

    if (applyResult.modifiedFiles && applyResult.modifiedFiles.length > 0) {
      const testFilePattern = /\.(test|spec)\.[jt]s$|__tests__\//i;
      const modifiedTestFiles = applyResult.modifiedFiles.filter(f => testFilePattern.test(f));
      if (modifiedTestFiles.length > 0) {
        const warnMsg = `[RealTest] Fix round ${fixRound} modified test file(s): ${modifiedTestFiles.join(', ')}. This may indicate the fix is gaming the tests rather than fixing the code.`;
        console.warn(`[Orchestrator] ⚠️  ${warnMsg}`);
        this.stateMachine.recordRisk('medium', warnMsg);
      }
    }

    const fixRoundRetestCommand = _buildFixRoundRetestCommand.call(this, testCommand, result, fixRound);
    const usesOptimizedRetest = fixRoundRetestCommand !== testCommand;

    console.error(`[Orchestrator] 🔬 Re-running tests after fix round ${fixRound}${usesOptimizedRetest ? ` (optimized: ${fixRoundRetestCommand})` : ''}...`);
    try {
      const roundRunner = new TestRunner({
        projectRoot: this.projectRoot,
        testCommand: fixRoundRetestCommand,
        timeoutMs: 180_000,
        verbose: true,
      });
      result = roundRunner.run();
    } catch (rerunErr) {
      console.error(`[Orchestrator] ❌ Test runner threw an error in fix round ${fixRound}: ${rerunErr.message}`);
      this.stateMachine.recordRisk('high', `[RealTest] Test runner crashed in fix round ${fixRound}: ${rerunErr.message}`);
      if (result) result = { ...result, passed: false, exitCode: rerunErr.status ?? 1 };
      if (failOnUnfixed) throw rerunErr;
      break;
    }

    const roundMd = `\n\n---\n\n## Auto-Fix Round ${fixRound} Result\n\n` + TestRunner.formatResultAsMarkdown(result);
    if (fs.existsSync(testReportPath)) {
      fs.appendFileSync(testReportPath, roundMd, 'utf-8');
    }

    // P1.5 safety net: if optimized subset check passed, run baseline regression before accepting.
    if (result.passed && usesOptimizedRetest) {
      console.error(`[Orchestrator] 🛡️  Optimized re-test passed. Running baseline regression before accepting fix...`);
      try {
        const baselineRunner = new TestRunner({
          projectRoot: this.projectRoot,
          testCommand: baselineTestCommand,
          timeoutMs: 180_000,
          verbose: true,
        });
        result = baselineRunner.run();
        const guardMd = `\n\n---\n\n## Auto-Fix Round ${fixRound} Safety Regression\n\n` + TestRunner.formatResultAsMarkdown(result);
        if (fs.existsSync(testReportPath)) {
          fs.appendFileSync(testReportPath, guardMd, 'utf-8');
        }
      } catch (guardErr) {
        console.error(`[Orchestrator] ❌ Safety regression crashed in fix round ${fixRound}: ${guardErr.message}`);
        this.stateMachine.recordRisk('high', `[RealTest] Safety regression crashed in fix round ${fixRound}: ${guardErr.message}`);
        if (failOnUnfixed) throw guardErr;
      }
    }

    if (result.passed) {
      console.error(`[Orchestrator] ✅ Tests PASSED after fix round ${fixRound}.`);

      const securityAudit = await _runSecurityAuditForTestStage.call(this, {
        testReportPath,
        stageLabel: `TEST (auto-fix round ${fixRound})`,
      });

      if (!securityAudit.passed) {
        const securityMsg = `[SecurityTest] Blocking findings detected after auto-fix round ${fixRound}: ${securityAudit.blockingReasons.join('; ')}`;
        this.stateMachine.recordRisk('high', securityMsg);
        console.warn(`[Orchestrator] ⚠️  ${securityMsg}`);
        result = {
          ...result,
          passed: false,
          exitCode: result.exitCode || 1,
          failureSummary: [...(result.failureSummary || []), ...securityAudit.blockingReasons],
        };
      } else {
        this.obs.recordTestResult({ passed: 1, failed: 0, skipped: 0, rounds: fixRound });
        await runEvoMapFeedback(this, {
          injectedExpIds,
          errorContext: (result.failureSummary || []).join(' ') || (result.output || ''),
          stageLabel: `TEST (auto-fix round ${fixRound})`,
        });
        // P1: Use recordWithContentCheck to avoid duplicate experience entries
        this.experienceStore.recordWithContentCheck({
          type: ExperienceType.POSITIVE,
          category: ExperienceCategory.STABLE_PATTERN,
          title: `Real tests passed after ${fixRound} auto-fix round(s)`,
          content: `Tests and security checks passed after ${fixRound} fix round(s). Command: ${testCommand}. Failure summary: ${(result.failureSummary || []).slice(0, 3).join('; ')}.`,
          skill: 'test-report',
          tags: ['real-test', 'security-audit', 'auto-fix', 'passed'],
        });

        // Re-annotate test-cases.md with post-fix PASS statuses
        try {
          const tcExecutorForUpdate = new TestCaseExecutor({
            projectRoot: this.projectRoot,
            testCommand,
            outputDir: this._outputDir,
            verbose: false,
          });
          const cases = tcExecutorForUpdate._parseCasesFromMd();
          if (cases.length > 0) {
            const updatedResults = cases.map(tc => ({
              ...tc,
              _executionStatus: 'PASS',
              _executionOutput: `Passed after auto-fix round ${fixRound}`,
            }));
            const statusIcon = { PASS: '✅', FAIL: '❌', BLOCKED: '⚠️', SKIPPED: '⏭️' };
            const rows = updatedResults.map(tc => {
              const icon = statusIcon[tc._executionStatus] || '❓';
              const title = (tc.title || tc.case_id || '').replace(/\|/g, '\\|');
              return `| ${tc.case_id} | ${title} | ${icon} ${tc._executionStatus} |`;
            });
            const annotation = [
              ``,
              `---`,
              ``,
              `## 🔧 Post-Fix Execution Results (Fix Round ${fixRound})`,
              ``,
              `> Auto-updated by TestCaseExecutor at ${new Date().toISOString()}`,
              `> **${updatedResults.length} passed** | **0 failed** | **0 blocked**`,
              ``,
              `| Case ID | Title | Status |`,
              `|---------|-------|--------|`,
              ...rows,
            ].join('\n');
            const testCasesPath = path.join(this._outputDir, 'test-cases.md');
            if (fs.existsSync(testCasesPath)) {
              fs.appendFileSync(testCasesPath, annotation, 'utf-8');
              console.error(`[Orchestrator] 📝 test-cases.md updated with post-fix PASS statuses (${updatedResults.length} case(s)).`);
            }
          }
        } catch (annotateErr) {
          console.warn(`[Orchestrator] ⚠️  Could not update test-cases.md after fix (non-fatal): ${annotateErr.message}`);
        }

        return;
      }
    }

    console.warn(`[Orchestrator] ❌ Tests still failing after fix round ${fixRound}.`);
  }

  const failMsg = `[RealTest] Tests still failing after ${fixRound} auto-fix round(s). Exit code: ${result.exitCode}. Failures: ${(result.failureSummary || []).slice(0, 3).join('; ')}`;
  this.stateMachine.recordRisk('high', failMsg);
  this.obs.recordTestResult({ passed: 0, failed: (result.failureSummary || []).length || 1, skipped: 0, rounds: fixRound });

  // ADR-56 Production-First activation of test-fix-loop.js:
  // Reuse its failure classifier to tag each failure with a structured type,
  // which improves downstream failure-recorder search quality. Zero LLM cost.
  let classifiedFailures = null;
  try {
    const { TestFixLoop } = require('./test-fix-loop');
    const fixLoop = new TestFixLoop({ maxFixRounds: 0, verbose: false, outputDir: this._outputDir });
    const failuresForClassify = (result.failureSummary || []).map((msg, idx) => ({
      test: `test-${idx}`,
      error: String(msg),
    }));
    classifiedFailures = fixLoop._classifyFailures(failuresForClassify);
  } catch (classErr) {
    console.warn(`[Orchestrator] TestFixLoop classification skipped: ${classErr.message}`);
  }

  // Enhanced test failure experience recording (ADR-XX)
  try {
    const failureRecorder = new TestFailureExperienceRecorder(this.experienceStore, { verbose: this._verbose });
    failureRecorder.recordFailure({
      error: new Error(failMsg),
      testFile: 'multiple',
      testCommand,
      attempt: fixRound,
      fixHistory: fixConversationHistory || [],
      projectContext: 'workflow-agent',
      classifiedFailures,
    });
  } catch (recErr) {
    console.warn(`[Orchestrator] ⚠️  Failed to record test failure experience (non-fatal): ${recErr.message}`);
  }
  
  // Legacy recording (P1: use recordWithContentCheck to avoid duplicates)
  this.experienceStore.recordWithContentCheck({
    type: ExperienceType.NEGATIVE,
    category: ExperienceCategory.PITFALL,
    title: `Real tests failed after ${fixRound} auto-fix rounds`,
    content: failMsg,
    skill: 'test-report',
    tags: ['real-test', 'auto-fix', 'failed'],
  });
  
  console.warn(`[Orchestrator] ⚠️  Tests still failing after all fix rounds. Recorded as high-risk.`);
  if (failOnUnfixed) {
    throw new Error(failMsg);
  }
}

function _normalizeTestProfile(profile) {
  const p = String(profile || '').toLowerCase().trim();
  return p === 'full' ? 'full' : 'fast';
}

/**
 * P0 policy: changes on core orchestration or bridge/quality gate paths are high-risk.
 * High-risk changes force TEST profile to full.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @returns {boolean}
 */
function _hasHighRiskTestScope() {
  try {
    const codeDiffPath = path.join(this._outputDir, 'code.diff');
    if (!fs.existsSync(codeDiffPath)) return false;

    const diff = fs.readFileSync(codeDiffPath, 'utf-8');
    return /\+\+\+\s+b\/workflow\/core\//.test(diff)
      || /\+\+\+\s+b\/workflow\/tools\/ide-workflow-bridge\.js/.test(diff)
      || /\+\+\+\s+b\/workflow\/core\/quality-gate\.js/.test(diff)
      || /\+\+\+\s+b\/workflow\/core\/mcp-server\.js/.test(diff);
  } catch (_) {
    return false;
  }
}

/**
 * Build effective test command from base command + profile + impacted suites.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @param {string|null} baseTestCommand
 * @param {'fast'|'full'} testProfile
 * @param {string[]|null} impactedSuites
 * @returns {string|null}
 */
function _buildProfiledTestCommand(baseTestCommand, testProfile, impactedSuites = null) {
  if (!baseTestCommand) return null;

  const profile = _normalizeTestProfile(testProfile);
  if (profile === 'full') return baseTestCommand;

  if (/--profile=/.test(baseTestCommand)) return baseTestCommand;
  if (/--filter=/.test(baseTestCommand) || /--file=/.test(baseTestCommand)) return baseTestCommand;

  const unifiedRunnerPath = path.join(this.projectRoot, 'workflow', 'tests', 'run-all-tests.js');
  const impactedArg = Array.isArray(impactedSuites) && impactedSuites.length > 0
    ? ` --suites=${impactedSuites.join(',')}`
    : '';

  if (/run-all-tests\.js/.test(baseTestCommand)) {
    return `${baseTestCommand} --profile=fast${impactedArg}`;
  }

  if (/^npm\s+test\b/.test(baseTestCommand) && fs.existsSync(unifiedRunnerPath)) {
    return `node workflow/tests/run-all-tests.js --profile=fast${impactedArg}`;
  }

  return baseTestCommand;
}

/**
 * P1: Parse changed files from output/code.diff.
 *
 * @returns {string[]}
 */
function _collectChangedFilesFromCodeDiff() {
  try {
    const codeDiffPath = path.join(this._outputDir, 'code.diff');
    if (!fs.existsSync(codeDiffPath)) return [];

    const diff = fs.readFileSync(codeDiffPath, 'utf-8');
    const files = new Set();
    const patterns = [
      /^\+\+\+\s+b\/(.+)$/gm,
      /^---\s+a\/(.+)$/gm,
    ];

    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(diff)) !== null) {
        const rel = (m[1] || '').trim().replace(/\\/g, '/');
        if (rel && rel !== '/dev/null' && !rel.startsWith('null')) {
          files.add(rel);
        }
      }
    }

    return Array.from(files);
  } catch (_) {
    return [];
  }
}

/**
 * P1: infer impacted test suites from changed files.
 * Always includes smoke suite as safety baseline.
 *
 * @param {string[]} changedFiles
 * @returns {string[]}
 */
function _inferImpactedSuites(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return ['smoke', 'unit', 'integration'];
  }

  const normalized = changedFiles.map(f => String(f || '').replace(/\\/g, '/'));
  const impacted = new Set(['smoke']);

  for (const file of normalized) {
    if (/workflow\/core\/integration-|workflow\/tests\/dual-mode-e2e/.test(file)) {
      impacted.add('integration');
      continue;
    }

    if (/workflow\/core\//.test(file) || /workflow\/tests\//.test(file)) {
      impacted.add('unit');
    }

    if (/\.test\.[jt]s$|\.spec\.[jt]s$/.test(file)) {
      impacted.add('unit');
    }
  }

  const order = ['smoke', 'unit', 'integration'];
  return order.filter(s => impacted.has(s));
}

/**
 * Run diagnostic commands in the sandbox/environment to gather more context for test failures.
 * 
 * @this {import('./orchestrator').Orchestrator}
 * @param {import('./test-runner').TestRunResult} result
 * @returns {Promise<string|null>}
 */
async function _runSandboxDiagnostics(result) {
  const diagnostics = [];
  const isContainerEnabled = this._config?.containerSandbox === true || typeof this._config?.containerSandbox === 'object';
  
  try {
    if (isContainerEnabled) {
      const adapter = new ContainerSandboxAdapter({ projectRoot: this.projectRoot, ...this._config.containerSandbox });
      await adapter.connect();
      
      // 1. Check environment variables
      const envRes = await adapter.execute('env | grep -i -E "NODE_ENV|PATH|PORT|HOST|TEST" || true', { timeout: 10000 });
      if (envRes.stdout) diagnostics.push(`[Environment Variables]\n${envRes.stdout.trim()}`);
      
      // 2. Check recent file modifications (last 5 mins)
      const filesRes = await adapter.execute('find . -type f -mmin -5 -not -path "*/node_modules/*" -not -path "*/.git/*" | head -n 10 || true', { timeout: 10000 });
      if (filesRes.stdout) diagnostics.push(`[Recently Modified Files]\n${filesRes.stdout.trim()}`);
      
      // 3. Check memory/disk usage
      const memRes = await adapter.execute('free -m || true', { timeout: 10000 });
      if (memRes.stdout) diagnostics.push(`[Memory Usage]\n${memRes.stdout.trim()}`);
      
    } else {
      // Fallback to host diagnostics if container sandbox is not enabled
      const { execSync } = require('child_process');
      
      // 1. Check node/npm versions
      try {
        const nodeVer = execSync('node -v', { cwd: this.projectRoot, encoding: 'utf-8' }).trim();
        const npmVer = execSync('npm -v', { cwd: this.projectRoot, encoding: 'utf-8' }).trim();
        diagnostics.push(`[Runtime Versions]\nNode: ${nodeVer}\nNPM: ${npmVer}`);
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  Sandbox diagnostics (node/npm versions) failed: ${err.message}`);
      }
      
      // 2. Check if ports are in use (common cause of test failures)
      if (result.output && (result.output.includes('EADDRINUSE') || result.output.includes('port'))) {
        try {
          const portRes = execSync('netstat -tuln | grep LISTEN | head -n 10 || true', { encoding: 'utf-8' }).trim();
          if (portRes) diagnostics.push(`[Listening Ports]\n${portRes}`);
        } catch (err) {
          console.warn(`[Orchestrator] ⚠️  Sandbox diagnostics (netstat) failed: ${err.message}`);
        }
      }
      
      // 3. Check recent logs if they exist
      try {
        const logFiles = execSync('find . -name "*.log" -mmin -10 -not -path "*/node_modules/*" | head -n 3', { cwd: this.projectRoot, encoding: 'utf-8' }).trim();
        if (logFiles) {
          const logPaths = logFiles.split('\n').filter(Boolean);
          for (const logPath of logPaths) {
            const tail = execSync(`tail -n 20 "${logPath}"`, { cwd: this.projectRoot, encoding: 'utf-8' }).trim();
            if (tail) diagnostics.push(`[Recent Log: ${logPath}]\n${tail}`);
          }
        }
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  Sandbox diagnostics (recent logs) failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`[Orchestrator] ⚠️  Sandbox diagnostics error: ${err.message}`);
  }
  
  return diagnostics.length > 0 ? diagnostics.join('\n\n') : null;
}

/**
 * P1.5: Build optimized re-test command for auto-fix rounds.
 * Strategy:
 *  - round 1: rerun failed subset when possible
 *  - round >=2: fallback to fast profile for broad signal
 *  - always run full baseline regression before accepting pass
 *
 * @this {import('./orchestrator').Orchestrator}
 * @param {string} baseTestCommand
 * @param {import('./test-runner').TestRunResult} previousResult
 * @param {number} fixRound
 * @returns {string}
 */
function _buildFixRoundRetestCommand(baseTestCommand, previousResult, fixRound) {
  const fallback = baseTestCommand;
  if (!baseTestCommand) return fallback;

  const normalizedCmd = String(baseTestCommand);
  const canUseUnifiedRunner = /run-all-tests\.js/.test(normalizedCmd)
    || /^npm\s+test\b/.test(normalizedCmd)
    || /^pnpm\s+test\b/.test(normalizedCmd)
    || /^yarn\s+test\b/.test(normalizedCmd);

  if (!canUseUnifiedRunner) return fallback;

  const runnerCmd = 'node workflow/tests/run-all-tests.js';

  if (fixRound === 1 && previousResult && Array.isArray(previousResult.failureSummary)) {
    const failedTokens = previousResult.failureSummary
      .map(line => {
        const m = String(line || '').match(/(?:●|\d+\)\s*)([A-Za-z0-9_.-]{3,})/);
        return m ? m[1] : null;
      })
      .filter(Boolean)
      .slice(0, 3);

    if (failedTokens.length > 0) {
      return `${runnerCmd} --files=${failedTokens.join(',')}`;
    }
  }

  return `${runnerCmd} --profile=fast`;
}

function _getSecurityAuditPolicy(config = {}) {
  const policy = config.securityAudit || {};
  const blockingSeverity = String(policy.blockingSeverity || 'high').toLowerCase();
  return {
    blockingSeverity: ['critical', 'high'].includes(blockingSeverity) ? blockingSeverity : 'high',
    failOnSecrets: policy.failOnSecrets !== false,
    cveTop: Number.isFinite(policy.cveTop) ? policy.cveTop : 30,
    secretMaxFiles: Number.isFinite(policy.secretMaxFiles) ? policy.secretMaxFiles : 200,
  };
}

function _severityRank(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical') return 4;
  if (s === 'high') return 3;
  if (s === 'medium') return 2;
  if (s === 'low') return 1;
  return 0;
}

function _secretScanProject(projectRoot, maxFiles = 200) {
  const findings = [];
  const sourceExts = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.java', '.cs', '.rb', '.php', '.env', '.yaml', '.yml', '.json']);
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', 'output', '.idea', '.vscode', 'coverage']);

  const patterns = [
    { name: 'aws-access-key-id', severity: 'critical', regex: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: 'aws-secret-access-key', severity: 'critical', regex: /(?:AWS|aws)?[_-]?SECRET[_-]?ACCESS[_-]?KEY\s*[:=]\s*['"][A-Za-z0-9\/+=]{30,}['"]/g },
    { name: 'github-token', severity: 'critical', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
    { name: 'private-key-block', severity: 'critical', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
    { name: 'hardcoded-password', severity: 'high', regex: /\b(password|passwd|pwd)\b\s*[:=]\s*['"][^'"\n]{6,}['"]/gi },
    { name: 'hardcoded-api-key', severity: 'high', regex: /\b(api[_-]?key|access[_-]?token|secret[_-]?key)\b\s*[:=]\s*['"][A-Za-z0-9_\-\/.+=]{12,}['"]/gi },
    { name: 'slack-token', severity: 'high', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  ];

  function walk(dir, acc) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return acc;
    }
    for (const e of entries) {
      if (acc.length >= maxFiles) break;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!ignoreDirs.has(e.name)) walk(full, acc);
      } else if (sourceExts.has(path.extname(e.name).toLowerCase())) {
        acc.push(full);
      }
    }
    return acc;
  }

  const files = walk(projectRoot, []);
  for (const absPath of files) {
    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch (_) {
      continue;
    }

    for (const p of patterns) {
      p.regex.lastIndex = 0;
      let m;
      while ((m = p.regex.exec(content)) !== null) {
        const snippet = String(m[0] || '').slice(0, 120);
        findings.push({
          type: p.name,
          severity: p.severity,
          file: path.relative(projectRoot, absPath).replace(/\\/g, '/'),
          snippet,
        });
        if (findings.length >= 100) break;
      }
      if (findings.length >= 100) break;
    }
    if (findings.length >= 100) break;
  }

  return {
    filesScanned: files.length,
    findings,
  };
}

async function _runSecurityAuditForTestStage({ testReportPath, stageLabel }) {
  const policy = _getSecurityAuditPolicy(this._config || {});
  const blockingRank = _severityRank(policy.blockingSeverity);

  const report = {
    passed: true,
    blockingReasons: [],
    cve: null,
    secrets: null,
  };

  try {
    const scannerPath = path.join(this.projectRoot, 'workflow', 'tools', 'ide-cve-scanner.js');
    if (fs.existsSync(scannerPath)) {
      const raw = execFileSync('node', [scannerPath, '--project-root', this.projectRoot, '--top', String(policy.cveTop)], {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(raw || '{}');
      report.cve = parsed;
      const vulns = Array.isArray(parsed.vulnerabilities) ? parsed.vulnerabilities : [];
      const blockingCve = vulns.filter(v => _severityRank(v.severity) >= blockingRank);
      if (blockingCve.length > 0) {
        report.passed = false;
        report.blockingReasons.push(`CVE findings >= ${policy.blockingSeverity}: ${blockingCve.length}`);
      }
    } else {
      console.warn(`[Orchestrator] ⚠️  Security CVE scanner not found: ${scannerPath}`);
    }
  } catch (err) {
    report.passed = false;
    report.blockingReasons.push(`CVE scan failed: ${err.message}`);
  }

  try {
    const secretReport = _secretScanProject(this.projectRoot, policy.secretMaxFiles);
    report.secrets = secretReport;
    if (policy.failOnSecrets && secretReport.findings.length > 0) {
      report.passed = false;
      const highOrAbove = secretReport.findings.filter(f => _severityRank(f.severity) >= blockingRank).length;
      if (highOrAbove > 0) {
        report.blockingReasons.push(`Secret findings >= ${policy.blockingSeverity}: ${highOrAbove}`);
      } else {
        report.blockingReasons.push(`Secret findings detected: ${secretReport.findings.length}`);
      }
    }
  } catch (err) {
    report.passed = false;
    report.blockingReasons.push(`Secret scan failed: ${err.message}`);
  }

  const summaryLine = `[Orchestrator][SECURITY_AUDIT] stage=${stageLabel} passed=${report.passed} cveTotal=${report.cve?.summary?.total ?? 0} secrets=${report.secrets?.findings?.length ?? 0} threshold=${policy.blockingSeverity}`;
  console.error(summaryLine);

  if (fs.existsSync(testReportPath)) {
    const cveSummary = report.cve?.summary || { total: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    const secretTop = (report.secrets?.findings || []).slice(0, 10);
    const appendix = [
      '',
      '---',
      '',
      '## 🔐 Security Audit (Dependency + Secret Scan)',
      '',
      `- Stage: ${stageLabel}`,
      `- Blocking Threshold: ${policy.blockingSeverity.toUpperCase()}`,
      `- Overall: ${report.passed ? 'PASS' : 'FAIL'}`,
      `- CVE: total=${cveSummary.total}, critical=${cveSummary.critical}, high=${cveSummary.high}, medium=${cveSummary.medium}, low=${cveSummary.low}`,
      `- Secrets: ${(report.secrets?.findings || []).length} finding(s) across ${(report.secrets?.filesScanned || 0)} scanned file(s)`,
      ...(report.blockingReasons.length > 0 ? ['', `- Blocking Reasons: ${report.blockingReasons.join(' | ')}`] : []),
      ...(secretTop.length > 0 ? ['', '### Top Secret Findings', ...secretTop.map((f, i) => `${i + 1}. [${String(f.severity || '').toUpperCase()}] ${f.type} in ${f.file}: \`${String(f.snippet || '').replace(/`/g, '')}\``)] : []),
    ].join('\n');
    fs.appendFileSync(testReportPath, appendix, 'utf-8');
  }

  return report;
}

module.exports = { _runTester, _runRealTestLoop };
