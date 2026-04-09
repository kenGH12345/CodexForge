/**
 * Stage Runner Utilities – Shared micro-operations for orchestrator stages.
 *
 * P1-3 fix: _runArchitect, _runDeveloper, and _runTester all share identical
 * structural patterns (Quality Gate → Rollback → EvoMap → Context Store → Publish).
 * Instead of a heavyweight Template Method base class (which would require
 * over-abstraction given each stage's unique details), we extract the three
 * highest-frequency repeated code blocks as composable helper functions.
 *
 * Each helper is a pure function that receives the Orchestrator instance and
 * stage-specific parameters, keeping orchestrator-stages.js focused on the
 * unique orchestration logic of each stage.
 *
 * Extracted patterns:
 *   1. consumeAndPrepareStage()     – Bus consume + upstream ctx + meta log + exp block + obs record
 *   2. runQualityGateWithRollback() – QualityGate evaluate + experience record + rollback decision
 *   3. runEvoMapFeedback()          – computeMatchedIds + markUsedBatch + recordExpUsage + triggerEvolutions
 */

'use strict';

const { QualityGate } = require('./quality-gate');
const { selfReportCollector } = require('./agent-self-report');

// ─── 1. consumeAndPrepareStage ──────────────────────────────────────────────

/**
 * Shared pre-execution sequence for ARCHITECT, DEVELOPER, and TESTER stages.
 *
 * Steps:
 *   1. Consume the bus message for this stage
 *   2. Build upstream cross-stage context
 *   3. Log upstream meta (if previous stage had corrections)
 *   4. Build experience + complaint context block
 *   5. Record injection count to Observability
 *
 * @param {Orchestrator} orch         - Orchestrator instance
 * @param {object}       opts
 * @param {string}       opts.agentRole        - AgentRole enum value for this stage
 * @param {Function}     opts.buildUpstreamCtx - (orch) => string
 * @param {Function}     opts.buildContextBlock - async (orch, upstreamCtx, ...extra) => string
 * @param {Array}        [opts.contextBlockArgs] - Extra args passed to buildContextBlock after upstreamCtx
 * @param {string}       [opts.prevStageName]   - Human-readable name of the previous stage (for logging)
 * @param {string}       [opts.prevMetaField]   - Meta field to check for correction rounds (e.g. 'reviewRounds')
 * @returns {{ inputPath: string, upstreamCtx: string, contextBlock: string }}
 */
async function consumeAndPrepareStage(orch, {
  agentRole,
  buildUpstreamCtx,
  buildContextBlock,
  contextBlockArgs = [],
  prevStageName = null,
  prevMetaField = 'reviewRounds',
}) {
  const inputPath = orch.bus.consume(agentRole);

  // P0-FIX: Validate inputPath is not null/undefined before proceeding.
  // If upstream stage did not publish to the bus, consuming returns null.
  // Failing early here with a clear message prevents a confusing downstream
  // error inside Agent.run() → _readInput() where the null path would either
  // silently fall through to rawInput or throw a generic "No input provided" error.
  if (!inputPath) {
    // Build diagnostic info about available bus entries for debugging
    const availableEntries = orch.bus && typeof orch.bus._entries === 'object'
      ? Array.from(orch.bus._entries.keys())
      : 'N/A';
    const upstreamRole = _inferUpstreamRole(agentRole);

    throw new Error(
      `[Pipeline] Stage ${agentRole}: No input from upstream ${upstreamRole}. ` +
      `FileRefBus has entries: ${JSON.stringify(availableEntries)}. ` +
      `This usually means: (1) ${upstreamRole} stage failed silently, ` +
      `(2) ${upstreamRole} was skipped as optional stage, or ` +
      `(3) publish/consume role mismatch.`
    );
  }

  // Build upstream cross-stage context
  const upstreamCtx = buildUpstreamCtx(orch);

  // Log upstream meta if previous stage had corrections
  if (prevStageName) {
    const meta = orch.bus.getMeta(agentRole);
    if (meta && meta[prevMetaField] > 0) {
      console.log(
        `[Orchestrator] ℹ️  ${prevStageName} was self-corrected in ${meta[prevMetaField]} round(s)` +
        `${meta.failedItems != null ? ` (${meta.failedItems} issue(s) fixed)` : ''}.`
      );
    }
  }

  // Build experience + complaint context block
  const contextBlock = await buildContextBlock(orch, upstreamCtx, ...contextBlockArgs);

  // Record injection count to Observability for hit-rate tracking
  // A-3 fix: contextBlock may be either { content, injectedExpIds } struct (new)
  // or a legacy String object with ._injectedExpIds expando (old).
  const _expIds = contextBlock.injectedExpIds || contextBlock._injectedExpIds || [];
  orch.obs.recordExpUsage({
    injected: _expIds.length,
  });

  return { inputPath, upstreamCtx, contextBlock };
}

// ─── 2. runQualityGateWithRollback ──────────────────────────────────────────

/**
 * Evaluates the QualityGate for a stage and records the experience outcome.
 *
 * This encapsulates the pattern repeated in ARCHITECT, CODE, and TEST stages:
 *   1. Create QualityGate instance
 *   2. Read rollback counter
 *   3. Evaluate review result
 *   4. Record experience
 *   5. Record Prompt A/B outcome
 *
 * @param {Orchestrator} orch
 * @param {object}       opts
 * @param {object}       opts.reviewResult - Result from ReviewAgent or SelfCorrectionEngine
 * @param {string}       opts.workflowState - WorkflowState enum value (e.g. ARCHITECT, CODE, TEST)
 * @param {string}       opts.agentRoleForAB - Role name for Prompt A/B recording
 * @param {string}       opts.skill        - Skill name for experience recording
 * @param {string}       opts.category     - ExperienceCategory for experience recording
 * @param {number}       [opts.maxRollbacks=1] - Max rollback attempts
 * @param {Function}     opts.recordPromptABOutcome - _recordPromptABOutcome function
 * @returns {{ decision: object, rollbackCount: number }}
 */
function runQualityGateWithRollback(orch, {
  reviewResult,
  workflowState,
  agentRoleForAB,
  skill,
  category,
  maxRollbacks = 1,
  recordPromptABOutcome,
}) {
  const gate = new QualityGate({
    experienceStore: orch.experienceStore,
    maxRollbacks,
  });

  // Read rollback counter from the appropriate source
  // P1-NEW-3 pattern: prefer _rollbackCounters (instance-level Map) over stageCtx.meta
  const rollbackCount = orch._rollbackCounters?.get(workflowState)
    ?? orch.stageCtx?.get(workflowState)?.meta?.[`_${_stateKeyLower(workflowState)}RollbackCount`]
    ?? 0;

  const decision = gate.evaluate(reviewResult, workflowState, rollbackCount);

  gate.recordExperience(decision, workflowState, reviewResult, {
    skill,
    category,
  });

  // Prompt A/B recording
  if (recordPromptABOutcome) {
    recordPromptABOutcome(agentRoleForAB, decision.pass, reviewResult.rounds ?? 0);
  }

  return { decision, rollbackCount };
}

/**
 * Converts a WorkflowState string to the lowercase key fragment used in
 * rollback counter meta fields (e.g. `_archRollbackCount`).
 *
 * P0-3 fix: The original implementation only mapped 3 states (ARCHITECT, CODE,
 * TEST). PLAN and any custom stages registered via StageRegistry would fall
 * through to `workflowState.toLowerCase()`, producing keys like `_planRollbackCount`
 * that are never written — causing QualityGate to silently read 0 and ignore
 * rollback history.
 *
 * Fix: Added PLAN mapping and a defensive log for unknown states so that
 * unmapped custom stages produce a visible warning instead of silent failure.
 *
 * @param {string} workflowState - e.g. 'ARCHITECT', 'CODE', 'TEST', 'PLAN'
 * @returns {string} Lowercase key fragment (e.g. 'arch', 'code', 'test', 'plan')
 */
function _stateKeyLower(workflowState) {
  const map = {
    ARCHITECT: 'arch',
    CODE: 'code',
    TEST: 'test',
    PLAN: 'plan',
    ANALYSE: 'analyse',
  };
  const key = map[workflowState];
  if (!key) {
    console.warn(
      `[stage-runner-utils] ⚠️  _stateKeyLower: no mapping for state "${workflowState}". ` +
      `Using "${workflowState.toLowerCase()}". If this state uses rollback counters, ` +
      `add a mapping to _stateKeyLower().`
    );
    return workflowState.toLowerCase();
  }
  return key;
}

/**
 * Infers the upstream AgentRole based on the current stage's AgentRole.
 * Used for diagnostic error messages when bus.consume() returns null.
 *
 * @param {string} agentRole - Current stage's AgentRole
 * @returns {string} Upstream role name for error messages
 */
function _inferUpstreamRole(agentRole) {
  // Pipeline flow: ANALYST → ARCHITECT → PLANNER → DEVELOPER → TESTER
  const upstreamMap = {
    ARCHITECT: 'ANALYST',
    PLANNER: 'ARCHITECT',
    DEVELOPER: 'PLANNER', // Note: PLANNER is optional, ARCHITECT is fallback
    TESTER: 'DEVELOPER',
  };
  return upstreamMap[agentRole] || 'unknown';
}

// ─── 3. runEvoMapFeedback ───────────────────────────────────────────────────

/**
 * Executes the EvoMap experience feedback loop after a stage passes QualityGate.
 *
 * This encapsulates the pattern repeated 4+ times across orchestrator-stages.js:
 *   1. computeMatchedIds() – measure which injected experiences actually matched
 *   2. markUsedBatch()     – increment hit counts for matched experiences
 *   3. recordExpUsage()    – report confirmed hits to Observability
 *   4. triggerEvolutions() – trigger skill evolution for high-usage experiences
 *
 * @param {Orchestrator} orch
 * @param {object}       opts
 * @param {string[]}     opts.injectedExpIds - IDs of experiences injected into the agent prompt
 * @param {string}       opts.errorContext   - Error text for matching NEGATIVE experiences
 * @param {string}       opts.stageLabel     - Human-readable stage label for logging
 * @returns {Promise<{ matchedCount: number, evolvedCount: number }>}
 */
async function runEvoMapFeedback(orch, { injectedExpIds, errorContext, stageLabel }) {
  if (!injectedExpIds || injectedExpIds.length === 0) {
    return { matchedCount: 0, evolvedCount: 0 };
  }

  // Defect H fix: use computeMatchedIds() for accurate hit-rate measurement.
  // POSITIVE experiences are always matched. NEGATIVE experiences are only matched
  // when the review's risk notes mention their tags/category.
  const { matchedIds, matchedCount } = orch.experienceStore.computeMatchedIds(
    injectedExpIds,
    errorContext,
  );

  // Only markUsedBatch on matched IDs – unmatched experiences were prompt noise
  const evolutionTriggers = orch.experienceStore.markUsedBatch(matchedIds);

  // Report only confirmed matched hits to Observability
  // P2 Enhancement: pass matchedIds and stageResult for fine-grained attribution
  orch.obs.recordExpUsage({
    hits: matchedCount,
    matchedExpIds: matchedIds,
    stageResult: { passed: true, stageLabel },
  });
  console.log(`[Orchestrator] 🎯 Experience hit-rate (${stageLabel}): ${matchedCount}/${injectedExpIds.length} matched`);

  // Centralized evolution trigger via ExperienceStore.triggerEvolutions()
  // P1 Enhancement: triggerEvolutions now returns { evolved, created } instead of just a number.
  // 'created' tracks newly auto-created skills from orphan experiences.
  const evoResult = await orch.experienceStore.triggerEvolutions(
    evolutionTriggers,
    orch.skillEvolution,
    orch.hooks,
    stageLabel,
  );
  // Backward-compatible: handle both old (number) and new ({ evolved, created }) return format
  const evolvedCount = typeof evoResult === 'number' ? evoResult : (evoResult.evolved || 0);
  const createdCount = typeof evoResult === 'object' ? (evoResult.created || 0) : 0;
  console.log(`[Orchestrator] 📊 Marked ${matchedCount}/${injectedExpIds.length} experience(s) as effective (${stageLabel} passed). Evolution triggers: ${evolvedCount}${createdCount > 0 ? `, new skills: ${createdCount}` : ''}`);

  // Skill Lifecycle: mark all skills that were injected during this stage as effective.
  // This is the key feedback signal: skills injected into prompts for stages that
  // pass QualityGate are confirmed as contributing to successful outcomes.
  // The skill names are aggregated by Observability across all LLM calls this session.
  if (orch.obs._skillInjectedCounts && orch.obs._skillInjectedCounts.size > 0) {
    orch.obs.markSkillEffective([...orch.obs._skillInjectedCounts.keys()]);
  }

  return { matchedCount, evolvedCount, createdCount };
}

// ─── 4. recordSelfReport ────────────────────────────────────────────────────

/**
 * Extracts and records an Agent Self-Report from stage output.
 *
 * In IDE Agent mode, the prompt instructs the Agent to emit a structured
 * `json:self-report` block at the end of its output. This helper parses
 * that block and feeds it into the selfReportCollector singleton.
 *
 * Plan A Enhancement: If LLM output does NOT contain a self-report block
 * (0% compliance observed across 125 attempts), falls back to code-forced
 * report built from deterministic data in the meta parameter.
 *
 * Design: Called once per stage, right after agent.run() returns and the
 * output file has been read. Placed here (stage-runner-utils) to avoid
 * duplicating the call in every stage file.
 *
 * Cost: Zero LLM calls. Pure regex + JSON.parse on already-loaded content.
 *
 * @param {string} stageName   - Human-readable stage label (e.g. 'ANALYSE', 'ARCHITECT')
 * @param {string} outputContent - Full text content of the agent's output artifact
 * @param {object} [meta]       - Optional metadata (agentRole, durationMs, etc.)
 *   Plan A fields: meta.artifactValidation, meta.socraticResult, meta.metricsGate,
 *   meta.traceEvents, meta.summary, meta.projectRoot, meta.session
 * @returns {{ found: boolean, report: object|null }}
 */
function recordSelfReport(stageName, outputContent, meta = {}) {
  try {
    // Try prompt-based parsing first (legacy path)
    const result = selfReportCollector.record(stageName, outputContent, meta);
    if (result.found && result.report) {
      console.error(
        `[AgentSelfReport] 📊 ${stageName}: confidence=${result.report.confidence}/5, ` +
        `decisions=${result.report.decisions.length}, blockers=${result.report.blockers.length} (prompt-based)`
      );
      return result;
    }

    // Plan A fallback: build code-forced report from meta data
    // This is the 100% compliance path — no LLM dependency
    if (meta.session || meta.artifactValidation || meta.socraticResult) {
      try {
        const { buildCodeForcedReport } = require('./agent-self-report');
        const codeForcedReport = buildCodeForcedReport({
          stage: stageName,
          session: meta.session || '',
          artifactValidation: meta.artifactValidation || {},
          socraticResult: meta.socraticResult || null,
          metricsGate: meta.metricsGate || null,
          traceEvents: meta.traceEvents || [],
          summary: meta.summary || '',
          projectRoot: meta.projectRoot || '.',
        });
        const cfResult = selfReportCollector.recordCodeForced(stageName, codeForcedReport, meta);
        console.error(
          `[AgentSelfReport] 📊 ${stageName}: confidence=${codeForcedReport.confidence}/5, ` +
          `decisions=${codeForcedReport.decisions.length}, blockers=${codeForcedReport.blockers.length} (code-forced fallback)`
        );
        return cfResult;
      } catch (cfErr) {
        console.warn(`[AgentSelfReport] ⚠️ Code-forced fallback failed for ${stageName}: ${cfErr.message}`);
      }
    }

    return result;
  } catch (err) {
    // Non-fatal: self-report collection must never break the pipeline
    console.warn(`[AgentSelfReport] ⚠️  Failed to record self-report for ${stageName}: ${err.message}`);
    return { found: false, report: null };
  }
}

// ─── 5. runStageMetricsGate ─────────────────────────────────────────────────

/**
 * Validates per-stage runtime metrics against STAGE_QUALITY_GATES thresholds.
 *
 * This is the METRICS-based gate (error count, duration, LLM calls) — distinct from
 * runQualityGateWithRollback() which is the REVIEW-based gate (checklist failures).
 *
 * Both gates serve different purposes:
 *   - runQualityGateWithRollback() → "Did the agent produce good output?" (review-based)
 *   - runStageMetricsGate()        → "Did the stage run within healthy bounds?" (metrics-based)
 *
 * Called at the end of every stage (ANALYSE, ARCHITECT, PLAN, DEVELOP, TEST).
 * Non-blocking: gate failures are logged and recorded as risks, but do NOT abort the pipeline.
 * This matches the design intent of validateStage() — early warning, not hard stop.
 *
 * @param {Orchestrator} orch
 * @param {object}       opts
 * @param {string}       opts.stageName     - Stage identifier (ANALYSE, ARCHITECT, PLAN, DEVELOP, TEST)
 * @param {number}       opts.durationMs    - Stage wall-clock duration in milliseconds
 * @param {number}       [opts.errorCount=0] - Number of errors encountered during stage
 * @param {number}       [opts.llmCalls=0]  - Number of LLM calls made during stage
 * @param {object}       [opts.context={}]  - Additional context for diagnostics
 * @returns {{ passed: boolean, gates: Array, failedGateNames: string[] }}
 */
function runStageMetricsGate(orch, {
  stageName,
  durationMs,
  errorCount = 0,
  llmCalls = 0,
  context = {},
}) {
  try {
    const gate = new QualityGate({
      recordIssue: (opts) => {
        // Record as a workflow risk (non-fatal)
        if (orch.stateMachine && typeof orch.stateMachine.recordRisk === 'function') {
          orch.stateMachine.recordRisk('medium', `[QualityGate:${stageName}] ${opts.title}: ${opts.description?.slice(0, 200)}`);
        }
        return { ...opts, timestamp: new Date().toISOString() };
      },
    });

    const metrics = {
      errors: { count: errorCount },
      totalDurationMs: durationMs,
      llm: { totalCalls: llmCalls },
    };

    const result = gate.validateStage(stageName, metrics, context);

    const failedGateNames = result.gates.filter(g => !g.passed).map(g => g.name);

    if (!result.passed) {
      console.warn(
        `[QualityGate:${stageName}] ⚠️  ${failedGateNames.length} metric gate(s) failed: ` +
        `[${failedGateNames.join(', ')}] — recorded as risks, pipeline continues.`
      );
    } else {
      console.log(`[QualityGate:${stageName}] ✅ All metric gates passed (duration=${(durationMs/1000).toFixed(1)}s, errors=${errorCount}, llmCalls=${llmCalls})`);
    }

    return { passed: result.passed, gates: result.gates, failedGateNames };
  } catch (err) {
    // Non-fatal: metrics gate must never break the pipeline
    console.warn(`[QualityGate:${stageName}] ⚠️  Metrics gate check failed (non-fatal): ${err.message}`);
    return { passed: true, gates: [], failedGateNames: [] };
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  consumeAndPrepareStage,
  runQualityGateWithRollback,
  runEvoMapFeedback,
  recordSelfReport,
  runStageMetricsGate,
};
