/**
 * Global constants for the multi-agent workflow system.
 */

const path = require('path');

// ─── Directory Layout ──────────────────────────────────────────────────────────

/** Root directory of the workflow system (resolved at runtime) */
const WORKFLOW_ROOT = path.resolve(__dirname, '..');

// ─── Runtime Output Directory (IoC) ────────────────────────────────────────────
//
// ADR-RUNTIME-OUTPUT: The output directory is a RUNTIME concern, not a static
// constant. It depends on which entry point launched the process:
//   - CLI mode:        process.cwd() + '/output'
//   - IDE Bridge mode: projectRoot + '/output'  (passed via args)
//   - MCP Server mode: projectRoot + '/output'  (passed via config)
//
// getDefaultOutputDir() returns a sensible default (process.cwd()/output).
// All modules should prefer the injected `outputDir` from Orchestrator/ServiceContainer
// and only fall back to getDefaultOutputDir() when no injection is available.
//
// outputPath(filename, outputDir?) is a convenience helper that resolves a
// filename relative to a given outputDir (or the default).

/**
 * Returns the default output directory based on the current working directory.
 * This is a RUNTIME function, not a static constant — it evaluates process.cwd()
 * at call time, so it always reflects the actual working directory.
 *
 * @returns {string} Absolute path to the default output directory
 */
function getDefaultOutputDir() {
  return path.join(process.cwd(), 'output');
}

/**
 * Resolves an artifact filename to an absolute path within the given output directory.
 * If no outputDir is provided, falls back to getDefaultOutputDir().
 *
 * @param {string} filename - The artifact filename (e.g. 'architecture.md', 'workflow-status.json')
 * @param {string} [outputDir] - Optional explicit output directory (from Orchestrator._outputDir)
 * @returns {string} Absolute path to the artifact file
 */
function outputPath(filename, outputDir) {
  return path.join(outputDir || getDefaultOutputDir(), filename);
}

const PATHS = {
  /** Persistent checkpoint file – written on every state transition */
  MANIFEST: path.join(WORKFLOW_ROOT, 'manifest.json'),
  /** Agent implementation modules */
  AGENTS_DIR: path.join(WORKFLOW_ROOT, 'agents'),
  /** Skills SOP markdown files */
  SKILLS_DIR: path.join(WORKFLOW_ROOT, 'skills'),
  /** Command handler modules */
  COMMANDS_DIR: path.join(WORKFLOW_ROOT, 'commands'),
  /** Hook handler modules */
  HOOKS_DIR: path.join(WORKFLOW_ROOT, 'hooks'),
  /** Thin/thick tool adapters */
  TOOLS_DIR: path.join(WORKFLOW_ROOT, 'tools'),
  /** Global memory context file */
  AGENTS_MD: path.join(WORKFLOW_ROOT, '..', 'AGENTS.md'),
  /** AgentFlow: project experience store (PROJECT scope - per-project) */
  PROJECT_EXPERIENCES_JSON: '.workflow/experiences.json',

  /**
   * @deprecated Use getDefaultOutputDir() or Orchestrator._outputDir instead.
   * This getter exists ONLY for backward compatibility during the migration period.
   * It will be removed once all 22 consuming files are migrated to DI.
   *
   * IMPORTANT: This is now a GETTER that evaluates at access time (not module-load time),
   * so it correctly reflects the current working directory even if process.cwd() changes.
   */
  get OUTPUT_DIR() {
    return getDefaultOutputDir();
  },
};

// ─── Output Artifact File Names ────────────────────────────────────────────────

const ARTIFACTS = {
  REQUIREMENT_MD: 'requirement.md',
  ARCHITECTURE_MD: 'architecture.md',
  EXECUTION_PLAN_MD: 'execution-plan.md',
  CODE_DIFF: 'code.diff',
  TEST_REPORT_MD: 'test-report.md',
};

// ─── LLM / Token Thresholds ────────────────────────────────────────────────────

/**
 * P1-B: Dynamic token threshold.
 * Reads from workflow.config.js `llm.hallucinationRiskThreshold` if available,
 * otherwise falls back to the built-in default (16000).
 *
 * P1-C: Configurable experience store capacity.
 * Reads from workflow.config.js `experienceStore.maxCapacity` if available,
 * otherwise falls back to the built-in default (500).
 *
 * Note: These are computed lazily on first access via getters so that
 * config-loader has time to initialise before these values are read.
 */
const _LLM_DEFAULTS = {
  HALLUCINATION_RISK_THRESHOLD: 16000,
  CHARS_PER_TOKEN: 4,
};

const _EXPERIENCE_DEFAULTS = {
  MAX_CAPACITY: 500,
};

const LLM = {
  /**
   * Token count above which a hallucination-risk warning is emitted.
   *
   * Rationale (R1-1 audit): previously 8000, which was far too conservative for
   * modern 128K–200K context-window models. At 8K, the degradation logic in
   * prompt-builder.js frequently stripped valuable skill/ADR context, reducing
   * output quality. Default 16K keeps a healthy safety margin while allowing the
   * full 3-layer skill injection + ADR digest + code graph to fit without degradation.
   *
   * P1-B: Now configurable via workflow.config.js → llm.hallucinationRiskThreshold
   */
  get HALLUCINATION_RISK_THRESHOLD() {
    try {
      const { getConfig } = require('./config-loader');
      const cfg = getConfig();
      if (cfg && cfg.llm && typeof cfg.llm.hallucinationRiskThreshold === 'number') {
        return cfg.llm.hallucinationRiskThreshold;
      }
    } catch (_) { /* config not loaded yet — use default */ }
    return _LLM_DEFAULTS.HALLUCINATION_RISK_THRESHOLD;
  },
  /** Approximate chars-per-token ratio used for quick estimation */
  CHARS_PER_TOKEN: 4,
};

/**
 * P1-C: Experience Store configuration constants.
 * Configurable via workflow.config.js → experienceStore.maxCapacity
 */
const EXPERIENCE = {
  get MAX_CAPACITY() {
    try {
      const { getConfig } = require('./config-loader');
      const cfg = getConfig();
      if (cfg && cfg.experienceStore && typeof cfg.experienceStore.maxCapacity === 'number') {
        return cfg.experienceStore.maxCapacity;
      }
    } catch (_) { /* config not loaded yet — use default */ }
    return _EXPERIENCE_DEFAULTS.MAX_CAPACITY;
  },
};

// ─── Project Scale Thresholds ─────────────────────────────────────────────────

const PROJECT_SCALE = {
  /** File count above which the project is treated as a large Monorepo */
  MONOREPO_FILE_THRESHOLD: 500,
};

// ─── Hook Event Names ─────────────────────────────────────────────────────────

const HOOK_EVENTS = {
  BEFORE_STATE_TRANSITION: 'before_state_transition',
  AFTER_STATE_TRANSITION: 'after_state_transition',
  AGENT_BOUNDARY_VIOLATION: 'agent_boundary_violation',
  HUMAN_REVIEW_REQUIRED: 'human_review_required',
  WORKFLOW_COMPLETE: 'workflow_complete',
  WORKFLOW_ERROR: 'workflow_error',
  // AgentFlow events
  TASK_CLAIMED:       'task_claimed',        // An agent claimed a task
  TASK_COMPLETED:     'task_completed',      // A task was completed
  TASK_FAILED:        'task_failed',         // A task failed
  TASK_INTERRUPTED:   'task_interrupted',    // A task was interrupted
  EXPERIENCE_RECORDED:'experience_recorded', // A new experience was saved
  SKILL_EVOLVED:      'skill_evolved',       // A skill was evolved
  SKILL_AUTO_CREATED:  'skill_auto_created',  // A new skill was auto-created from orphan experience (P1)
  SKILL_DISCOVERY_COMPLETE: 'skill_discovery_complete', // Project conventions auto-discovered and standards skill generated
  COMPLAINT_FILED:    'complaint_filed',     // A complaint was filed
  COMPLAINT_RESOLVED: 'complaint_resolved',  // A complaint was resolved
  // Observability events
  STAGE_STARTED:      'stage_started',       // A workflow stage started
  STAGE_ENDED:        'stage_ended',         // A workflow stage ended
  STAGE_ARTIFACT_PRODUCED: 'stage_artifact_produced', // A stage produced an output artifact
  LLM_CALL_RECORDED:  'llm_call_recorded',   // An LLM call was recorded
  ROUTER_DECISION_MADE:'router_decision_made', // LLM routing decision metadata captured
  ROUTER_FALLBACK_TRIGGERED:'router_fallback_triggered', // Fallback chain triggered for routing
  // CI integration events
  CI_PIPELINE_STARTED:  'ci_pipeline_started',
  CI_PIPELINE_COMPLETE: 'ci_pipeline_complete',
  CI_PIPELINE_FAILED:   'ci_pipeline_failed',
  // Code graph events
  CODE_GRAPH_BUILT:     'code_graph_built',
  CODE_GRAPH_QUERIED:   'code_graph_queried',
  // Git PR workflow events
  GIT_BRANCH_CREATED:   'git_branch_created',   // A feature branch was created
  GIT_BRANCH_PUSHED:    'git_branch_pushed',     // Branch pushed to remote
  GIT_PR_CREATED:       'git_pr_created',        // PR/MR created (or description saved)
  GIT_PR_MERGED:        'git_pr_merged',         // PR/MR merged
  // Dry-run / sandbox events
  DRYRUN_STARTED:       'dryrun_started',        // Dry-run mode activated
  DRYRUN_OP_RECORDED:   'dryrun_op_recorded',    // A file operation was intercepted
  DRYRUN_REPORT_SAVED:  'dryrun_report_saved',   // Dry-run report written to disk
  DRYRUN_APPLIED:       'dryrun_applied',        // Pending ops applied to real FS
  // Prompt A/B testing events
  PROMPT_VARIANT_PROMOTED:  'prompt_variant_promoted',   // A variant outperformed the active and was promoted
  PROMPT_VARIANT_ROLLEDBACK:'prompt_variant_rolledback', // Active variant rolled back to baseline after failures
  // HTML report events
  HTML_REPORT_GENERATED:    'html_report_generated',     // HTML session report generated
  // Optimistic lock events
  FILE_LOCK_CONFLICT:       'file_lock_conflict',        // Optimistic lock conflict detected during parallel edit
  // Agent Negotiation Protocol events (P1-2, ADR-40)
  NEGOTIATE_REQUEST:        'negotiate_request',         // Downstream agent raises a concern about upstream artifact
  NEGOTIATE_RESPONSE:       'negotiate_response',        // Orchestrator responds with a resolution
  // P0-2/P0-3: Stage execution lifecycle events (Temporal heartbeat inspired)
  STAGE_HEARTBEAT:          'stage_heartbeat',           // Periodic progress heartbeat during long-running stage execution
  STAGE_TIMEOUT:            'stage_timeout',             // Stage exceeded MAX_STAGE_DURATION_MS budget ceiling
  // Write-Around Review events (ADR-45)
  WRITE_AROUND_REVIEW_COMPLETE: 'write_around_review_complete', // Quick review completed after direct file edit
  WRITE_AROUND_REVIEW_BLOCKED:  'write_around_review_blocked',  // Critical issue detected, edit blocked
  WRITE_AROUND_REVIEW_WARNING:  'write_around_review_warning',  // High-severity issue found but not blocked
  // Tool execution lifecycle events (P1: Tool-level hooks)
  TOOL_EXECUTION_STARTED:   'tool_execution_started',   // A tool execution started
  TOOL_EXECUTION_COMPLETED: 'tool_execution_completed', // A tool execution completed successfully
  TOOL_EXECUTION_FAILED:    'tool_execution_failed',    // A tool execution failed
  TOOL_BEFORE_EXECUTION:    'tool_before_execution',    // Before tool execution (allows param modification)
  TOOL_AFTER_EXECUTION:     'tool_after_execution',     // After tool execution (allows result filtering)
  // ADR-42: Output truncation detection events
  OUTPUT_TRUNCATED:         'output_truncated',         // LLM response was truncated (stop_reason=max_tokens)
  OUTPUT_CONTINUATION:      'output_continuation',      // Auto-continuation attempt after truncation
  // Agent Self-Report events (Prompt-level observability for IDE Agent mode)
  AGENT_SELF_REPORT_FOUND:  'agent_self_report_found',  // Self-report block parsed from agent output
  AGENT_SELF_REPORT_MISSING:'agent_self_report_missing',// Agent output lacked self-report block
};

module.exports = {
  WORKFLOW_ROOT,
  PATHS,
  ARTIFACTS,
  LLM,
  EXPERIENCE,
  PROJECT_SCALE,
  HOOK_EVENTS,
  // ADR-RUNTIME-OUTPUT: Runtime output directory helpers (IoC)
  getDefaultOutputDir,
  outputPath,
};
