/**
 * StageExecutor – Single-stage execution logic extracted from orchestrator-run.js
 *
 * Encapsulates the per-stage execution lifecycle:
 *   1. SmartSkip check
 *   2. Hook events (STAGE_STARTED, AGENT_START, AGENT_COMPLETE, STAGE_ENDED)
 *   3. Context building
 *   4. Runner execution with retry loop
 *   5. Artifact path resolution (return value → inferred → bus log)
 *   6. SocraticChallenger integration
 *   7. EvolutionLoop signal processing
 *   8. UnifiedTraceCollector recording
 *   9. StateMachine transition
 *   10. RollbackCoordinator on failure
 *
 * This separation enables:
 *   - Independent unit testing of stage execution (mock runner + mock orchestrator)
 *   - Reuse in alternative execution modes (parallel, selective)
 *   - Cleaner orchestrator-run.js (~200 lines shorter)
 *
 * @module stage-executor
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { RollbackCoordinator } = require('./rollback-coordinator');
const { HOOK_EVENTS } = require('./constants');
const { generatePreStageQuestions } = require('./pre-stage-questions');
const { buildRetryContext } = require('./stage-context');
const { computeArtifactHash, verifyRetryImprovement } = require('./retry-gate');
const { RetryDivergenceGuard } = require('./retry-divergence-guard');
const { LoopGuard } = require('./loop-guard');

/**
 * @typedef {object} StageExecutionParams
 * @property {string} stageName
 * @property {import('./stage-runner').StageRunner} runner
 * @property {object} orchestrator - Orchestrator instance (this)
 * @property {import('./socratic-challenger').SocraticChallenger} challenger
 * @property {import('./evolution-loop').EvolutionLoop} evolutionLoop
 * @property {import('./unified-trace-collector').UnifiedTraceCollector} traceCollector
 * @property {string} effectiveRequirement
 * @property {string} rawRequirement
 * @property {string|null} currentArtifact - Input artifact from previous stage
 * @property {object} capabilityCatalog
 * @property {string} capabilityCatalogPrompt
 * @property {object} stageBudgetPlan
 * @property {object} runtimePolicy
 */

/**
 * @typedef {object} StageExecutionResult
 * @property {boolean} skipped
 * @property {boolean} success
 * @property {string|null} currentArtifact - Updated artifact path after execution
 * @property {object} executionRecord - Record to push into executionResults array
 */

/**
 * Checks if a stage should be skipped via SmartSkip.
 *
 * @param {object} orchestrator
 * @param {string} stageName
 * @param {string|null} currentArtifact
 * @param {import('./unified-trace-collector').UnifiedTraceCollector} traceCollector
 * @returns {{ skip: boolean, record?: object }}
 */
async function checkSmartSkip(orchestrator, stageName, currentArtifact, traceCollector) {
  if (!orchestrator.stageSmartSkip) return { skip: false };

  const skipResult = orchestrator.stageSmartSkip.shouldSkip(stageName, {
    stageCtx: orchestrator.stageCtx,
    complexity: null,
  });

  if (!skipResult.skip) return { skip: false };

  console.error(`\n${'─'.repeat(60)}`);
  console.error(`[Orchestrator] ⏭️  SKIPPING stage: ${stageName}`);
  console.error(`[Orchestrator]    Reason: ${skipResult.reason}`);
  console.error(`${'─'.repeat(60)}`);

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

  if (orchestrator.stateMachine) {
    try {
      await orchestrator.stateMachine.transition(currentArtifact, `Stage ${stageName} skipped: ${skipResult.reason}`);
    } catch (transErr) {
      console.warn(`[Orchestrator] ⚠️ StateMachine transition for skipped stage failed: ${transErr.message}`);
    }
  }

  return {
    skip: true,
    record: {
      stage: stageName,
      success: true,
      duration: 0,
      skipped: true,
      skipReason: skipResult.reason,
      skipSource: skipResult.skipSource || 'unknown',
    },
  };
}

/**
 * Resolves the artifact path from a stage result.
 *
 * Resolution order:
 *   1. String return value (direct path)
 *   2. Object with .artifactPath property
 *   3. Inferred from stage name convention + outputDir
 *   4. Last FileRefBus publish entry
 *
 * @param {*} result - Stage runner return value
 * @param {string} stageName
 * @param {object} orchestrator
 * @returns {{ artifactPath: string|null }}
 */
function resolveArtifactPath(result, stageName, orchestrator) {
  if (result && typeof result === 'string') {
    console.error(`[Orchestrator] 📄 Artifact path: ${result}`);
    return { artifactPath: result };
  }

  if (result && result.artifactPath) {
    console.error(`[Orchestrator] 📄 Artifact path (from object): ${result.artifactPath}`);
    return { artifactPath: result.artifactPath };
  }

  // Infer from convention
  const inferredFileName = orchestrator._getArtifactFileName(stageName);
  const inferredPath = path.join(orchestrator._outputDir || 'output', inferredFileName);
  if (fs.existsSync(inferredPath)) {
    console.error(`[Orchestrator] 📄 Artifact path (inferred): ${inferredPath}`);
    return { artifactPath: inferredPath };
  }

  // Check FileRefBus
  if (orchestrator.bus) {
    const busLog = orchestrator.bus.getLog();
    const lastPublish = [...busLog].reverse().find(l => l.timestamp);
    if (lastPublish && lastPublish.filePath && fs.existsSync(lastPublish.filePath)) {
      console.error(`[Orchestrator] 📄 Artifact path (from bus log): ${lastPublish.filePath}`);
      return { artifactPath: lastPublish.filePath };
    }
  }

  console.warn(`[Orchestrator] ⚠️  Stage ${stageName} returned no artifact path (result type: ${typeof result})`);
  return { artifactPath: null };
}

/**
 * Executes a single pipeline stage with full lifecycle management.
 *
 * @param {StageExecutionParams} params
 * @returns {Promise<StageExecutionResult>}
 */
async function executeStage(params) {
  const {
    stageName,
    runner,
    orchestrator,
    challenger,
    evolutionLoop,
    traceCollector,
    effectiveRequirement,
    rawRequirement,
    capabilityCatalog,
    capabilityCatalogPrompt,
    stageBudgetPlan,
    runtimePolicy,
  } = params;

  let currentArtifact = params.currentArtifact;

  // 1. SmartSkip check
  const skipCheck = await checkSmartSkip(orchestrator, stageName, currentArtifact, traceCollector);
  if (skipCheck.skip) {
    return {
      skipped: true,
      success: true,
      currentArtifact,
      executionRecord: skipCheck.record,
    };
  }

  // 2. Stage header
  console.error(`\n${'─'.repeat(60)}`);
  console.error(`[Orchestrator] ▶️  Executing stage: ${stageName}`);
  console.error(`${'─'.repeat(60)}`);

  const stageStartTime = Date.now();
  if (orchestrator.p0RuntimeLoop) {
    orchestrator.p0RuntimeLoop.markStageStart(stageName, {
      previousArtifact: currentArtifact || null,
    });
  }

  // 3. Emit STAGE_STARTED hook
  if (orchestrator.hooks && typeof orchestrator.hooks.emit === 'function') {
    await orchestrator.hooks.emit(HOOK_EVENTS.STAGE_STARTED, {
      stage: stageName,
      previousArtifact: currentArtifact || null,
    }).catch(() => {});
  }

  let stageSuccess = false;
  let stageResult = null;
  let retryCount = 0;
  const maxRetries = 1;
  let pendingRevisionContext = null;
  let previousConfidence = null;

  // P0: Retry storm circuit-breaking
  const divergenceGuard = new RetryDivergenceGuard({ maxDivergenceScore: 0.85, windowSize: 3 });
  const progressGuard = new LoopGuard({ maxRetries: 2, jaccardThreshold: 0.8 });
  let llmCallCount = 0;

  // 4. Retry loop with SocraticChallenger
  let preRetryArtifactHash = null;
  let preRetryArtifactContent = null;

  while (!stageSuccess && retryCount <= maxRetries) {
    if (retryCount > 0) {
      console.error(`\n[Orchestrator] 🔄 Retry attempt ${retryCount} for stage: ${stageName}`);
      // FORCED_RETRY_GATE: snapshot artifact before retry to verify improvement
      if (currentArtifact && fs.existsSync(currentArtifact)) {
        try {
          preRetryArtifactContent = fs.readFileSync(currentArtifact, 'utf-8');
          preRetryArtifactHash = computeArtifactHash(preRetryArtifactContent);
          console.error(`[Orchestrator] 🔒 Pre-retry artifact hash: ${preRetryArtifactHash.slice(0, 12)}...`);
        } catch (_e) {
          console.warn(`[Orchestrator] ⚠️  Could not read artifact for retry hash — skipping improvement gate`);
        }
      }
    }

    try {
      // Record stage start
      traceCollector.recordStageStart(stageName, {
        inputArtifactPath: currentArtifact,
        context: { retryCount, requirement: effectiveRequirement.slice(0, 200) },
      });
      console.error(`[Orchestrator][STAGE_START] ${stageName} (attempt=${retryCount + 1}) @ ${new Date().toISOString()}`);

      // Build stage context
      if (!orchestrator.stageCtx) {
        console.error(`[Orchestrator] ⚠️ stageCtx not initialized — cross-stage context will be unavailable`);
      }
      if (!orchestrator.bus) {
        console.error(`[Orchestrator] ⚠️ bus (FileRefBus) not initialized — file-ref routing will be unavailable`);
      }

      const context = {
        rawRequirement: effectiveRequirement,
        originalRequirement: rawRequirement,
        orchestrator,
        services: orchestrator.services,
        previousArtifact: currentArtifact,
        previousChallenge: pendingRevisionContext,
        capabilityCatalog,
        capabilityCatalogPrompt,
        stageBudgetPlan,
        runtimePolicy,
        stageCtx: orchestrator.stageCtx || null,
        bus: orchestrator.bus || null,
        preStageThinking: generatePreStageQuestions(stageName, effectiveRequirement || ''),
        retryContext: buildRetryContext(pendingRevisionContext),
      };

      // Execute stage
      console.error(`[Orchestrator] 🏃 Running stage executor...`);

      // Emit AGENT_START hook
      if (orchestrator.hooks && typeof orchestrator.hooks.emit === 'function') {
        await orchestrator.hooks.emit(HOOK_EVENTS.AGENT_START, {
          stage: stageName,
          role: stageName.toLowerCase(),
          attempt: retryCount + 1,
        }).catch(() => {});
      }

      const result = await runner.execute(context);

      // P0: Track LLM call count for budget warning
      llmCallCount++;
      const maxLlmCalls = runtimePolicy?.maxLlmCalls ?? 30;
      if (llmCallCount >= maxLlmCalls * 0.7) {
        console.warn(`[Orchestrator] ⚠️  LLM call budget warning: ${llmCallCount}/${maxLlmCalls} (70% threshold)`);
      }

      // P0: Exponential backoff when approaching LLM call budget
      if (llmCallCount >= maxLlmCalls * 0.8 && llmCallCount < maxLlmCalls) {
        const backoffDelay = Math.min(1000 * Math.pow(2, llmCallCount - Math.floor(maxLlmCalls * 0.8)), 10000);
        console.warn(`[Orchestrator] ⏳ Exponential backoff: ${backoffDelay}ms (LLM budget ${llmCallCount}/${maxLlmCalls})`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }

      // P0: Hard stop when LLM call budget exceeded
      if (llmCallCount >= maxLlmCalls) {
        console.error(`[Orchestrator] 🛑 LLM call budget EXCEEDED: ${llmCallCount}/${maxLlmCalls}. Forcing stage forward.`);
        stageSuccess = true;
        stageResult = result;
        break;
      }

      // P0: Check progress via LoopGuard.hasProgress
      const resultText = typeof result === 'string' ? result : JSON.stringify(result);
      const progressCheck = progressGuard.hasProgress(resultText);
      if (progressCheck.signal === 'STALE_LOOP') {
        console.error(`[Orchestrator] ⚡ STALE_LOOP detected (similarity=${progressCheck.similarity.toFixed(2)}, stale=${progressCheck.staleCount}). Forcing stage forward.`);
        stageSuccess = true;
        stageResult = result;
        break;
      }

      // Emit AGENT_COMPLETE hook
      if (orchestrator.hooks && typeof orchestrator.hooks.emit === 'function') {
        await orchestrator.hooks.emit(HOOK_EVENTS.AGENT_COMPLETE, {
          stage: stageName,
          role: stageName.toLowerCase(),
          success: true,
          attempt: retryCount + 1,
        }).catch(() => {});
      }

      const stageDuration = Date.now() - stageStartTime;
      console.error(`[Orchestrator] ⏱️  Stage execution time: ${stageDuration}ms`);

      // Resolve artifact path
      const { artifactPath } = resolveArtifactPath(result, stageName, orchestrator);
      if (artifactPath) {
        currentArtifact = artifactPath;
      }
      stageResult = result;

      // HARD-REJECT: artifact must contain ## 思考摘要 section
      // (Self-Ask/CoVe verification traceability — ensures pre-stage questions were answered)
      let thinkingSummaryPresent = true;
      if (currentArtifact && fs.existsSync(currentArtifact)) {
        try {
          const artifactContent = fs.readFileSync(currentArtifact, 'utf-8');
          if (!artifactContent.includes('## 思考摘要')) {
            thinkingSummaryPresent = false;
            console.error(`[Orchestrator] 🚫 HARD-REJECT: Artifact missing "## 思考摘要" section`);
            console.error(`[Orchestrator] 🚫 Pre-Stage questions were not answered — retrying with enforcement`);
            stageSuccess = false;
            if (retryCount < maxRetries) {
              pendingRevisionContext = {
                stageName,
                triggerReasons: ['MISSING_THINKING_SUMMARY'],
                revisionSummary: 'Artifact missing ## 思考摘要 — pre-stage questions must be answered before proceeding',
                questions: ['Why were the pre-stage questions not addressed in the output?'],
                blindSpots: ['Output lacks structured thinking trace — Self-Ask/CoVe verification cannot proceed'],
              };
              retryCount++;
              previousConfidence = 0;
              continue;
            }
          }
        } catch (_e) {
          // Read failure is non-blocking
        }
      }

      // SocraticChallenger
      console.error(`[Orchestrator] 🤔 Running SocraticChallenger: DEVIL'S ADVOCATE mode...`);
      const challengeResult = await challenger.challenge(stageName, currentArtifact, {
        rawRequirement: effectiveRequirement,
        retryCount,
        previousChallenge: pendingRevisionContext,
        llmSource: orchestrator._llmSource || 'external',
        isMockLlm: (orchestrator._llmSource || 'external') === 'mock',
      });

      // Log challenge questions
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

      // EvolutionLoop + TraceCollector
      evolutionLoop.processSocraticChallenge(stageName, challengeResultWithDelta);
      traceCollector.recordSocraticChallenge(stageName, challengeResultWithDelta);

      // FORCED_RETRY_GATE: verify retry produced meaningful improvement
      if (retryCount > 0 && preRetryArtifactHash && currentArtifact && fs.existsSync(currentArtifact)) {
        try {
          const postRetryContent = fs.readFileSync(currentArtifact, 'utf-8');
          const improvementCheck = verifyRetryImprovement(preRetryArtifactContent, postRetryContent);
          if (!improvementCheck.passed) {
            console.error(`[Orchestrator] 🚫 FORCED_RETRY_GATE: ${improvementCheck.reason}`);
            console.error(`[Orchestrator] 🚫 Artifact unchanged after retry — skipping further retries`);
            stageSuccess = true;
            previousConfidence = challengeResult.confidence;
            pendingRevisionContext = null;
            break;
          }
          console.error(`[Orchestrator] ✅ FORCED_RETRY_GATE: ${improvementCheck.reason}`);
        } catch (_e) {
          console.warn(`[Orchestrator] ⚠️  Could not verify retry improvement — proceeding`);
        }
      }

      // Revision loop (single retry)
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

      // Stage completed
      console.error(`[Orchestrator] ✅ Stage ${stageName} completed (challenged=${challengeResult.challenged ? 'yes' : 'no'}, questions=${challengeResult.questions?.length || 0})`);
      stageSuccess = true;
      previousConfidence = challengeResult.confidence;
      pendingRevisionContext = null;

      console.error(`[Orchestrator] ✅ Stage ${stageName} completed in ${Date.now() - stageStartTime}ms`);

      // Record stage end
      traceCollector.recordStageEnd(stageName, {
        success: true,
        outputArtifactPath: currentArtifact,
        duration: Date.now() - stageStartTime,
      });
      console.error(`[Orchestrator][STAGE_END] ${stageName} (success) @ ${new Date().toISOString()}`);

      // Emit STAGE_ENDED hook (success)
      if (orchestrator.hooks && typeof orchestrator.hooks.emit === 'function') {
        await orchestrator.hooks.emit(HOOK_EVENTS.STAGE_ENDED, {
          stage: stageName,
          success: true,
          artifactPath: currentArtifact || null,
          duration: Date.now() - stageStartTime,
          confidence: challengeResult?.confidence || null,
        }).catch(() => {});
      }

      const executionRecord = {
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
      };

      if (orchestrator.p0RuntimeLoop) {
        orchestrator.p0RuntimeLoop.markStageEnd(stageName, {
          artifactPath: currentArtifact || null,
          confidence: challengeResult.confidence,
        });
      }

      // Emit stage complete event
      orchestrator._emit?.('stage:complete', { stageName, result, duration: Date.now() - stageStartTime });

      // Update state machine
      const stageAlreadyTransitioned = !!(
        (result && typeof result === 'object' && result.__alreadyTransitioned) ||
        (result && typeof result === 'object' && result.__stageResult === true && result.type === 'rolled_back')
      );
      if (orchestrator.stateMachine && !stageAlreadyTransitioned) {
        await orchestrator.stateMachine.transition(artifactPath, `Stage ${stageName} completed`);
        console.error(`[Orchestrator] 📊 StateMachine transitioned to: ${stageName} (artifact: ${artifactPath})`);
      } else if (stageAlreadyTransitioned) {
        console.error(`[Orchestrator] ℹ️  Stage ${stageName} already transitioned StateMachine via rollback chain. Skipping duplicate transition.`);
      }

      return {
        skipped: false,
        success: true,
        currentArtifact,
        executionRecord,
      };

    } catch (stageError) {
      const stageDuration = Date.now() - stageStartTime;
      console.error(`[Orchestrator] ❌ Stage ${stageName} failed: ${stageError.message}`);
      console.error(stageError.stack);

      // Record stage error
      traceCollector.recordError(stageName, stageError);
      traceCollector.recordStageEnd(stageName, {
        success: false,
        outputArtifactPath: currentArtifact,
        duration: stageDuration,
        error: stageError.message,
      });
      console.error(`[Orchestrator][STAGE_END] ${stageName} (failed) @ ${new Date().toISOString()} reason=${stageError.message}`);

      // Emit STAGE_ENDED hook (failure)
      if (orchestrator.hooks && typeof orchestrator.hooks.emit === 'function') {
        await orchestrator.hooks.emit(HOOK_EVENTS.STAGE_ENDED, {
          stage: stageName,
          success: false,
          artifactPath: currentArtifact || null,
          duration: stageDuration,
          error: stageError.message,
        }).catch(() => {});
      }

      if (retryCount < maxRetries) {
        // P0: Check for retry divergence before retrying
        const divergenceResult = divergenceGuard.check(stageError.message || '', stageName);
        if (divergenceResult.divergent) {
          console.warn(`[Orchestrator] ⚡ Retry divergence detected (score=${divergenceResult.score.toFixed(2)}). Skipping retry to prevent storm.`);
          break;
        }
        console.error(`[Orchestrator] 🔄 Retrying stage ${stageName} due to error...`);
        retryCount++;
        continue;
      }

      // Feed failure signal to EvolutionLoop
      evolutionLoop.processSignal({
        type: 'STAGE_FAILURE',
        severity: 'critical',
        stage: stageName,
        evidence: `Stage ${stageName} failed after ${retryCount + 1} attempt(s): ${stageError.message}`,
        context: { stack: (stageError.stack || '').slice(0, 500), retryCount },
        confidence: 0.95,
      });

      // Emit stage error event
      orchestrator._emit?.('stage:error', { stageName, error: stageError });

      // RollbackCoordinator cleanup
      try {
        const rollbackCoord = new RollbackCoordinator(orchestrator);
        await rollbackCoord.rollback(stageName, `Stage ${stageName} failed: ${stageError.message}`);
        console.error(`[Orchestrator] 🧹 RollbackCoordinator: coordinated cleanup for ${stageName} completed.`);
      } catch (rbErr) {
        console.warn(`[Orchestrator] ⚠️  RollbackCoordinator cleanup failed (non-fatal): ${rbErr.message}`);
      }

      // Return failure record (caller decides whether to throw)
      return {
        skipped: false,
        success: false,
        currentArtifact,
        executionRecord: {
          stage: stageName,
          success: false,
          duration: stageDuration,
          error: stageError.message,
        },
        error: stageError,
      };
    }
  }

  // Should not reach here, but safety fallback
  return {
    skipped: false,
    success: false,
    currentArtifact,
    executionRecord: {
      stage: stageName,
      success: false,
      duration: Date.now() - params._stageStartTime || 0,
      error: 'Unexpected exit from retry loop',
    },
  };
}

module.exports = { executeStage, checkSmartSkip, resolveArtifactPath };
