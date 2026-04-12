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
const { WorkflowState } = require('./types');
const { SocraticChallenger } = require('./socratic-challenger');
const { EvolutionLoop } = require('./evolution-loop');
const { UnifiedTraceCollector, TraceEventType } = require('./unified-trace-collector');
const { enforceRuntimePolicy } = require('./runtime-policy-enforcer');
const { enforceRequirementBudget, buildStageBudgetPlan } = require('./context-budget-policy');
const { runAcceptanceGate } = require('./acceptance-gate');
const { buildCapabilityCatalog, formatCapabilityCatalogForPrompt } = require('./capability-catalog');
const { computeHealthScore } = require('./health-score-model');
const { resolveHealthPaths } = require('./health-observability');
const { RollbackCoordinator } = require('./rollback-coordinator');
const { HOOK_EVENTS } = require('./constants');

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

      // ── StageSmartSkip: Check if this stage should be skipped ──────────────
      if (this.stageSmartSkip) {
        const skipResult = this.stageSmartSkip.shouldSkip(stageName, {
          stageCtx: this.stageCtx,
          complexity: null, // Will be read from stageCtx internally
        });
        if (skipResult.skip) {
          console.error(`\n${'─'.repeat(60)}`);
          console.error(`[Orchestrator] ⏭️  SKIPPING stage: ${stageName}`);
          console.error(`[Orchestrator]    Reason: ${skipResult.reason}`);
          console.error(`${'─'.repeat(60)}`);

          // Record skip in trace
          traceCollector.recordStageStart(stageName, {
            inputArtifactPath: currentArtifact,
            context: { skipped: true, reason: skipResult.reason },
          });
          traceCollector.recordStageEnd(stageName, {
            success: true,
            outputArtifactPath: currentArtifact,
            duration: 0,
            skipped: true,
            skipReason: skipResult.reason,
          });

          // Transition state machine past this stage
          if (this.stateMachine) {
            try {
              await this.stateMachine.transition(currentArtifact, `Stage ${stageName} skipped: ${skipResult.reason}`);
            } catch (transErr) {
              console.warn(`[Orchestrator] ⚠️ StateMachine transition for skipped stage failed: ${transErr.message}`);
            }
          }

          executionResults.push({
            stage: stageName,
            success: true,
            duration: 0,
            skipped: true,
            skipReason: skipResult.reason,
            skipSource: skipResult.skipSource || 'unknown',
          });
          continue;
        }
      }

      console.error(`\n${'─'.repeat(60)}`);
      console.error(`[Orchestrator] ▶️  Executing stage: ${stageName}`);
      console.error(`${'─'.repeat(60)}`);

      const stageStartTime = Date.now();
      if (this.p0RuntimeLoop) {
        this.p0RuntimeLoop.markStageStart(stageName, {
          previousArtifact: currentArtifact || null,
        });
      }

      // ── P0 fix: Emit STAGE_STARTED hook event ────────────────────────
      // Previously defined in constants.js HOOK_EVENTS but never emitted.
      // Consumers: DecisionTrail (plugin), EventJournal, P0RuntimeLoop,
      // IntrospectionManager, RunGuard (plugin).
      if (this.hooks && typeof this.hooks.emit === 'function') {
        await this.hooks.emit(HOOK_EVENTS.STAGE_STARTED, {
          stage: stageName,
          previousArtifact: currentArtifact || null,
        }).catch(() => {});
      }
      let stageSuccess = false;
      let stageResult = null;
      let retryCount = 0;
      const maxRetries = 1; // Max one retry per stage
      let pendingRevisionContext = null;
      let previousConfidence = null;

      // Retry loop with SocraticChallenger
      while (!stageSuccess && retryCount <= maxRetries) {
        if (retryCount > 0) {
          console.error(`\n[Orchestrator] 🔄 Retry attempt ${retryCount} for stage: ${stageName}`);
        }

        try {
          // ── UnifiedTraceCollector: Record stage start with INPUT artifact ────────────────────────
          // NOTE: keep this as the first operation in the attempt so start events are never skipped.
          traceCollector.recordStageStart(stageName, {
            inputArtifactPath: currentArtifact,
            context: { retryCount, requirement: effectiveRequirement.slice(0, 200) },
          });
          console.error(`[Orchestrator][STAGE_START] ${stageName} (attempt=${retryCount + 1}) @ ${new Date().toISOString()}`);

          // Build stage context
          // P0-1 fix: Expose stageCtx and bus directly on context so StageRunners
          // can access cross-stage context and file-ref bus without coupling to
          // the full Orchestrator instance. This enables independent testing of
          // StageRunners with minimal mocking.
          // P2-3 fix: Assert stageCtx and bus are initialized before building
          // context. These are created in _initWorkflow() (workflow/index.js L274/L370).
          // If they're missing, downstream StageRunners will get null and may NPE.
          if (!this.stageCtx) {
            console.error(`[Orchestrator] ⚠️ stageCtx not initialized — cross-stage context will be unavailable`);
          }
          if (!this.bus) {
            console.error(`[Orchestrator] ⚠️ bus (FileRefBus) not initialized — file-ref routing will be unavailable`);
          }

          const context = {
            rawRequirement: effectiveRequirement,
            originalRequirement: rawRequirement,
            orchestrator: this,
            services: this.services,
            previousArtifact: currentArtifact,
            previousChallenge: pendingRevisionContext,
            capabilityCatalog,
            capabilityCatalogPrompt,
            stageBudgetPlan,
            runtimePolicy: runtimePolicyCheck.policy,
            stageCtx: this.stageCtx || null,
            bus: this.bus || null,
          };

          // Execute stage
          console.error(`[Orchestrator] 🏃 Running stage executor...`);

          // ── P1 fix: Emit AGENT_START hook event ──────────────────────
          // Previously subscribed by IntrospectionManager but never emitted.
          // This enables agent execution tracking and introspection.
          if (this.hooks && typeof this.hooks.emit === 'function') {
            await this.hooks.emit(HOOK_EVENTS.AGENT_START, {
              stage: stageName,
              role: stageName.toLowerCase(),
              attempt: retryCount + 1,
            }).catch(() => {});
          }

          const result = await runner.execute(context);

          // ── P1 fix: Emit AGENT_COMPLETE hook event ───────────────────
          if (this.hooks && typeof this.hooks.emit === 'function') {
            await this.hooks.emit(HOOK_EVENTS.AGENT_COMPLETE, {
              stage: stageName,
              role: stageName.toLowerCase(),
              success: true,
              attempt: retryCount + 1,
            }).catch(() => {});
          }

          const stageDuration = Date.now() - stageStartTime;
          console.error(`[Orchestrator] ⏱️  Stage execution time: ${stageDuration}ms`);

          // ── CRITICAL: Handle stage result (path or object) ─────────────────
          // Stage runners return artifact PATH string, not content
          let artifactPath = null;
          if (result && typeof result === 'string') {
            // Stage returned artifact path - use directly
            artifactPath = result;
            currentArtifact = artifactPath;
            console.error(`[Orchestrator] 📄 Artifact path: ${artifactPath}`);
          } else if (result && result.artifactPath) {
            // Stage returned result object with artifactPath
            currentArtifact = result.artifactPath;
            artifactPath = result.artifactPath;
            console.error(`[Orchestrator] 📄 Artifact path (from object): ${artifactPath}`);
          } else {
            // Fallback: infer artifact path from stage name convention
            const inferredFileName = this._getArtifactFileName(stageName);
            const inferredPath = require('path').join(this._outputDir || 'output', inferredFileName);
            if (require('fs').existsSync(inferredPath)) {
              artifactPath = inferredPath;
              currentArtifact = inferredPath;
              console.error(`[Orchestrator] 📄 Artifact path (inferred): ${inferredPath}`);
            } else if (this.bus) {
              // P1-3 fix: Sync with FileRefBus — check if the stage published
              // an artifact to the bus that we missed from the return value.
              const busLog = this.bus.getLog();
              const lastPublish = [...busLog].reverse().find(l => l.timestamp);
              if (lastPublish && lastPublish.filePath && require('fs').existsSync(lastPublish.filePath)) {
                artifactPath = lastPublish.filePath;
                currentArtifact = lastPublish.filePath;
                console.error(`[Orchestrator] 📄 Artifact path (from bus log): ${artifactPath}`);
              } else {
                console.warn(`[Orchestrator] ⚠️  Stage ${stageName} returned no artifact path (result type: ${typeof result})`);
              }
            } else {
              console.warn(`[Orchestrator] ⚠️  Stage ${stageName} returned no artifact path (result type: ${typeof result})`);
            }
          }
          stageResult = result;

          // ── SocraticChallenger: Challenge the CONCLUSIONS (self-doubt) ─────────────────────────
          console.error(`[Orchestrator] 🤔 Running SocraticChallenger: DEVIL'S ADVOCATE mode...`);
          const challengeResult = await challenger.challenge(stageName, currentArtifact, {
            rawRequirement: effectiveRequirement,
            retryCount,
            previousChallenge: pendingRevisionContext,
            llmSource: this._llmSource || 'external',
            isMockLlm: (this._llmSource || 'external') === 'mock',
          });

          // Log the challenge questions (self-doubt in action)
          if (challengeResult.challenged && challengeResult.questions && challengeResult.questions.length > 0) {
            console.error(`[Orchestrator] ── CHALLENGE QUESTIONS (Self-Doubt) ──`);
            challengeResult.questions.forEach((q, i) => {
              console.error(`[Orchestrator]    Q${i + 1}: ${q}`);
            });
          }

          if (challengeResult.challenged && challengeResult.blindSpots && challengeResult.blindSpots.length > 0) {
            console.error(`[Orchestrator] ── BLIND SPOTS DETECTED ──`);
            challengeResult.blindSpots.forEach((bs, i) => {
              console.error(`[Orchestrator]    ${i + 1}. ${bs}`);
            });
          }

          if (!challengeResult.challenged) {
            console.error(`[Orchestrator] 💤 Challenge gate skipped: ${(challengeResult.triggerReasons || []).join('; ') || 'no critical gap'}`);
          }

          const confidenceLabel = challengeResult?.confidenceStatus === 'na'
            ? `N/A (${challengeResult?.confidenceReason || 'insufficient evidence'})`
            : `${(challengeResult.confidence * 100).toFixed(0)}%`;
          console.error(`[Orchestrator] 📊 Confidence in conclusions: ${confidenceLabel}`);

          const preChallengeScore = Number.isFinite(previousConfidence) ? previousConfidence : null;
          const postRevisionScore = Number.isFinite(challengeResult.confidence) ? challengeResult.confidence : null;
          const deltaScore = (Number.isFinite(preChallengeScore) && Number.isFinite(postRevisionScore))
            ? Number((postRevisionScore - preChallengeScore).toFixed(4))
            : null;
          const effectiveChallenge = challengeResult.challenged && Number.isFinite(deltaScore) ? deltaScore >= 0.05 : false;

          const challengeResultWithDelta = {
            ...challengeResult,
            preChallengeScore,
            postRevisionScore,
            deltaScore,
            effectiveChallenge,
          };

          // ── EvolutionLoop: Process Socratic challenge for self-evolution ───────────
          evolutionLoop.processSocraticChallenge(stageName, challengeResultWithDelta);

          // ── UnifiedTraceCollector: Record Socratic challenge result ────────────────────────
          traceCollector.recordSocraticChallenge(stageName, challengeResultWithDelta);

          // P1: revision loop (single retry) - only when challenge is triggered AND not advisory-only
          // Plan A+B: advisoryOnly challenges provide questions as suggestions, not forced retries
          if (challengeResult.challenged && !challengeResult.advisoryOnly && retryCount < maxRetries) {
            pendingRevisionContext = {
              stageName,
              triggerReasons: challengeResult.triggerReasons || [],
              revisionSummary: challengeResult.revisionSummary || null,
              questions: challengeResult.questions || [],
              blindSpots: challengeResult.blindSpots || [],
              p2Protocol: challengeResult.p2Protocol || null,
            };
            console.warn(`[Orchestrator] 🔁 Revision required, revisiting stage once with challenge context...`);
            retryCount++;
            previousConfidence = challengeResult.confidence;
            continue;
          }

          // Stage completed (even if challenged - that's normal)
          console.error(`[Orchestrator] ✅ Stage ${stageName} completed (challenged=${challengeResult.challenged ? 'yes' : 'no'}, questions=${challengeResult.questions?.length || 0})`);
          stageSuccess = true;
          previousConfidence = challengeResult.confidence;
          pendingRevisionContext = null;

          // Record success
          console.error(`[Orchestrator] ✅ Stage ${stageName} completed in ${Date.now() - stageStartTime}ms`);
          
          // ── UnifiedTraceCollector: Record stage end with OUTPUT artifact ────────────────────────
          traceCollector.recordStageEnd(stageName, {
            success: true,
            outputArtifactPath: currentArtifact,
            duration: Date.now() - stageStartTime,
          });
          console.error(`[Orchestrator][STAGE_END] ${stageName} (success) @ ${new Date().toISOString()}`);

          // ── P0 fix: Emit STAGE_ENDED hook event (success) ──────────────
          // Previously defined in constants.js HOOK_EVENTS but never emitted.
          // Consumers: DecisionTrail (plugin), EventJournal, P0RuntimeLoop.
          if (this.hooks && typeof this.hooks.emit === 'function') {
            await this.hooks.emit(HOOK_EVENTS.STAGE_ENDED, {
              stage: stageName,
              success: true,
              artifactPath: currentArtifact || null,
              duration: Date.now() - stageStartTime,
              confidence: challengeResult?.confidence || null,
            }).catch(() => {});
          }

          executionResults.push({
            stage: stageName,
            success: true,
            duration: Date.now() - stageStartTime,
            artifact: currentArtifact,
            confidence: challengeResult.confidence,
            challengeTriggered: !!challengeResult.challenged,
            challengeQuestions: challengeResult.questions,
            blindSpots: challengeResult.blindSpots,
            triggerReasons: challengeResult.triggerReasons || [],
            p2Protocol: challengeResult.p2Protocol || null,
            preChallengeScore: Number.isFinite(challengeResultWithDelta.preChallengeScore) ? challengeResultWithDelta.preChallengeScore : null,
            postRevisionScore: Number.isFinite(challengeResultWithDelta.postRevisionScore) ? challengeResultWithDelta.postRevisionScore : null,
            deltaScore: Number.isFinite(challengeResultWithDelta.deltaScore) ? challengeResultWithDelta.deltaScore : null,
            effectiveChallenge: !!challengeResultWithDelta.effectiveChallenge,
          });

          if (this.p0RuntimeLoop) {
            this.p0RuntimeLoop.markStageEnd(stageName, {
              artifactPath: currentArtifact || null,
              confidence: challengeResult.confidence,
            });
          }

          // Emit stage complete event
          this._emit?.('stage:complete', { stageName, result, duration: Date.now() - stageStartTime });

          // Update state machine - CRITICAL: pass artifactPath for precondition validation
          // But if stage already performed transition via rollback chain, do not transition again.
          const stageAlreadyTransitioned = !!(
            (result && typeof result === 'object' && result.__alreadyTransitioned) ||
            (result && typeof result === 'object' && result.__stageResult === true && result.type === 'rolled_back')
          );
          if (this.stateMachine && !stageAlreadyTransitioned) {
            await this.stateMachine.transition(artifactPath, `Stage ${stageName} completed`);
            console.error(`[Orchestrator] 📊 StateMachine transitioned to: ${stageName} (artifact: ${artifactPath})`);
          } else if (stageAlreadyTransitioned) {
            console.error(`[Orchestrator] ℹ️  Stage ${stageName} already transitioned StateMachine via rollback chain. Skipping duplicate transition.`);
          }

        } catch (stageError) {
          const stageDuration = Date.now() - stageStartTime;
          console.error(`[Orchestrator] ❌ Stage ${stageName} failed: ${stageError.message}`);
          console.error(stageError.stack);

          // ── UnifiedTraceCollector: Record stage error ────────────────────────
          traceCollector.recordError(stageName, stageError);
          traceCollector.recordStageEnd(stageName, {
            success: false,
            outputArtifactPath: currentArtifact,
            duration: stageDuration,
            error: stageError.message,
            mainlinePhase,
            mainlineStepIndex,
          });
          console.error(`[Orchestrator][STAGE_END] ${stageName} (failed) @ ${new Date().toISOString()} reason=${stageError.message}`);

          // ── P0 fix: Emit STAGE_ENDED hook event (failure) ──────────────
          if (this.hooks && typeof this.hooks.emit === 'function') {
            await this.hooks.emit(HOOK_EVENTS.STAGE_ENDED, {
              stage: stageName,
              success: false,
              artifactPath: currentArtifact || null,
              duration: stageDuration,
              error: stageError.message,
            }).catch(() => {});
          }

          if (retryCount < maxRetries) {
            console.error(`[Orchestrator] 🔄 Retrying stage ${stageName} due to error...`);
            retryCount++;
            continue;
          }

          // P1-2 fix: Feed stage failure signal to EvolutionLoop so it can
          // learn from negative outcomes (not just Socratic challenges).
          // Without this, the quality report misses the most important signal
          // source — actual execution failures.
          evolutionLoop.processSignal({
            type: 'STAGE_FAILURE',
            severity: 'critical',
            stage: stageName,
            evidence: `Stage ${stageName} failed after ${retryCount + 1} attempt(s): ${stageError.message}`,
            context: { stack: (stageError.stack || '').slice(0, 500), retryCount },
            confidence: 0.95,
          });

          // Record failure
          executionResults.push({
            stage: stageName,
            success: false,
            duration: stageDuration,
            error: stageError.message,
          });

          // Emit stage error event
          this._emit?.('stage:error', { stageName, error: stageError });

          // P0: Use RollbackCoordinator for unified rollback cleanup.
          // Previously, stage failure just threw the error without cleaning up
          // Bus messages, StageContext entries, or cache – causing the "fake rollback"
          // bug where stateMachine rolled back but stale data remained.
          try {
            const rollbackCoord = new RollbackCoordinator(this);
            await rollbackCoord.rollback(stageName, `Stage ${stageName} failed: ${stageError.message}`);
            console.error(`[Orchestrator] 🧹 RollbackCoordinator: coordinated cleanup for ${stageName} completed.`);
          } catch (rbErr) {
            console.warn(`[Orchestrator] ⚠️  RollbackCoordinator cleanup failed (non-fatal): ${rbErr.message}`);
          }

          throw stageError;
        }
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
  _shouldRetryStage(stageName, error) {
    // Default: don't retry
    // Subclasses can override for custom retry logic
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
