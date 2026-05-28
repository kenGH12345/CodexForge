'use strict';

/**
 * Teardown Steps Registry — Declarative Pipeline Entry Point
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  ADDING A NEW TEARDOWN STEP:                                │
 * │                                                              │
 * │  1. Create a file in teardown-steps/ extending TeardownStep  │
 * │  2. Import + register it below                              │
 * │  That's it — 1 file, 1 line. (Was: modify 5+ files)        │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Execution order is determined by:
 *   - `before`/`after` constraints (topological sort)
 *   - `priority` as tie-breaker (lower = earlier)
 *
 * Step dependency graph (simplified):
 *
 *   plugin-activate ──┐
 *                     ├──► aef-refinement ──► evolution-pipeline ──┐
 *                     │                                              │
 *                     ├──► session-signal ──────────────────────────┤
 *                     ├──► failure-pattern ─────────────────────────┤
 *                     ├──► issue-pattern ───────────────────────────┤
 *                                                                    │
 *                     ◄─────────────────────────────────────────────┘
 *                                     │
 *                                     ▼
 *   obs-flush ──► self-reflection ──► prompt-trace ──► summary-prints
 *       │
 *       ├──► skill-lifecycle
 *       ├──► obs-dashboard ──► risk-correlation ──► handoff-log
 *       │                        │
 *       │                        ▼
 *       │                  auto-deploy ──► dryrun-lock ──► flush-external
 *       │                                                    │
 *       │                                                    ▼
 *       │                  task-history ──► staleness-check ──► introspection
 *       │                                                    │
 *       │                                                    ▼
 *       │       execution-validation ──► independent-evaluator ──► feedback-system
 *       │                                                    │
 *       │                                                    ▼
 *       │       prompt-optimizer ──► deep-audit ──► changelog ──► git-pr
 *       │                                                    │
 *       │                                                    ▼
 *       └─────────────────────────────────────────► plugin-deactivate
 *
 * @module teardown-steps
 */

const { TeardownPipeline } = require('../teardown-pipeline');

// ─── Import all teardown steps ──────────────────────────────────────────────

const { PluginActivateStep }    = require('./plugin-activate-step');
const { AefRefinementStep }     = require('./aef-refinement-step');
const { RegressionGuardStep }  = require('./regression-guard-step');
const { SessionSignalStep }     = require('./session-signal-step');
const { FailurePatternStep }    = require('./failure-pattern-step');
const { IssuePatternStep }      = require('./issue-pattern-step');
const { EvolutionPipelineStep } = require('./evolution-pipeline-step');
const { ObsFlushStep }          = require('./obs-flush-step');
const { SelfReflectionStep }    = require('./self-reflection-step');
const { ReflectionCycleStep }  = require('./reflection-cycle-step');
const { PromptTraceStep }       = require('./prompt-trace-step');
const { SummaryPrintsStep }     = require('./summary-prints-step');
const { SkillLifecycleStep }    = require('./skill-lifecycle-step');
const { ObsDashboardStep }      = require('./obs-dashboard-step');
const { RiskCorrelationStep }   = require('./risk-correlation-step');
const { HandoffLogStep }        = require('./handoff-log-step');
const { AutoDeployStep }        = require('./auto-deploy-step');
const { DryRunAndLockStep }     = require('./dryrun-lock-step');
const { FlushExternalStep }     = require('./flush-external-step');
const { TaskHistoryStep }       = require('./task-history-step');
const { FixSessionCloseStep }   = require('./fix-session-close-step');
const { StalenessCheckStep }    = require('./staleness-check-step');
const { IntrospectionStep }     = require('./introspection-step');
const { ExecutionValidationStep } = require('./execution-validation-step');
const { IndependentEvaluatorStep } = require('./independent-evaluator-step');
const { FeedbackSystemStep }    = require('./feedback-system-step');
const { PromptOptimizerStep }   = require('./prompt-optimizer-step');
const { DeepAuditStep }         = require('./deep-audit-step');
const { ChangelogStep }         = require('./changelog-step');
const { GitPrStep }             = require('./git-pr-step');
const { PluginDeactivateStep }  = require('./plugin-deactivate-step');

// ─── Build the pipeline ─────────────────────────────────────────────────────

/**
 * Create and return a fully-registered TeardownPipeline.
 * Each step is registered with its before/after constraints and priority.
 *
 * @returns {TeardownPipeline}
 */
function createTeardownPipeline() {
  const pipeline = new TeardownPipeline();

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │  REGISTRATION — One line per step. Order doesn't matter;                │
  // │  execution order is resolved by before/after + priority.                │
  // └─────────────────────────────────────────────────────────────────────────┘

  pipeline
    // Phase 1: Init & Discovery (priority 10-15)
    .register(new PluginActivateStep())
    .register(new AefRefinementStep())

    // Phase 2: Signal Detection & Evolution (priority 20-25)
    .register(new RegressionGuardStep())
    .register(new SessionSignalStep())
    .register(new FailurePatternStep())
    .register(new IssuePatternStep())
    .register(new EvolutionPipelineStep())

    // Phase 3: Metrics Flush & Validation (priority 30-36)
    .register(new ObsFlushStep())
    .register(new SelfReflectionStep())
    .register(new ReflectionCycleStep())
    .register(new PromptTraceStep())
    .register(new SummaryPrintsStep())

    // Phase 4: Skill & Dashboard (priority 38-44)
    .register(new SkillLifecycleStep())
    .register(new ObsDashboardStep())
    .register(new RiskCorrelationStep())
    .register(new HandoffLogStep())

    // Phase 5: Auto-Deploy & External Flush (priority 46-52)
    .register(new AutoDeployStep())
    .register(new DryRunAndLockStep())
    .register(new FlushExternalStep())
    .register(new TaskHistoryStep())
    .register(new FixSessionCloseStep())

    // Phase 6: Staleness & Introspection (priority 54-58)
    .register(new StalenessCheckStep())
    .register(new IntrospectionStep())
    .register(new ExecutionValidationStep())

    // Phase 7: Evaluation & Feedback (priority 60-64)
    .register(new IndependentEvaluatorStep())
    .register(new FeedbackSystemStep())
    .register(new PromptOptimizerStep())

    // Phase 8: Audit, Changelog, Git (priority 66-70)
    .register(new DeepAuditStep())
    .register(new ChangelogStep())
    .register(new GitPrStep())

    // Phase 9: Cleanup (priority 90)
    .register(new PluginDeactivateStep());

  return pipeline;
}

module.exports = { createTeardownPipeline };
