'use strict';

// ── Artifact & Error Primitives ──

/**
 * @typedef {Object} ArtifactRef
 * @property {string} path - File path relative to project root
 * @property {string} [role] - e.g. 'input', 'output', 'checkpoint'
 * @property {string} [hash] - Content hash for integrity check
 */

/**
 * @typedef {Object} SerializedError
 * @property {string} name
 * @property {string} message
 * @property {string} [code]
 * @property {string} [stack]
 */

// ── State Layer Types (Section 4.5) ──

/**
 * @typedef {Object} WorkflowSession
 * @property {string} sessionId
 * @property {string} requirement
 * @property {string} requirementFingerprint
 * @property {'orchestrator'|'ide-bridge'} mode
 * @property {'created'|'running'|'paused'|'failed'|'completed'} status
 * @property {string|null} currentStage
 * @property {string} startedAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 * @property {number} version - Monotonic version for optimistic concurrency
 * @property {Record<string, StageRun>} stages
 * @property {Record<string, TaskRun>} tasks
 * @property {RecoveryMeta} recovery
 */

/**
 * @typedef {Object} StageRun
 * @property {string} stage
 * @property {'pending'|'running'|'completed'|'failed'|'rolled_back'} status
 * @property {number} attempt
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {ArtifactRef[]} inputRefs
 * @property {ArtifactRef[]} outputRefs
 * @property {string|null} resumeToken
 * @property {number} lastEventSeq
 */

/**
 * @typedef {Object} TaskRun
 * @property {string} taskId
 * @property {string} stage
 * @property {string} subtask
 * @property {'pending'|'running'|'completed'|'failed'|'cached'} status
 * @property {string} idempotencyKey
 * @property {ArtifactRef|null} resultRef
 * @property {SerializedError|null} error
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 */

/**
 * @typedef {Object} Checkpoint
 * @property {string} checkpointId
 * @property {string} sessionId
 * @property {string} stage
 * @property {number} snapshotVersion
 * @property {number} eventSeq
 * @property {Object} [taskCursor]
 * @property {string} createdAt
 */

/**
 * @typedef {Object} RecoveryMeta
 * @property {boolean} recoverable
 * @property {boolean} pendingRetry
 * @property {Object|null} [lastRollback]
 * @property {Array} [compensationPlan]
 * @property {Record<string, string>} [idempotencyScopes]
 */

/**
 * @typedef {Object} CompatibilityView
 * @property {Object} manifestLike - Projection matching old manifest.json shape
 * @property {Object} workflowStatusLike - Projection matching old workflow-status.json shape
 */

// ── Event Layer Types (Section 5.6) ──

/**
 * @typedef {Object} StoredEvent
 * @property {number} seq
 * @property {string} ts
 * @property {string} iso - ISO 8601 timestamp (CloudEvents time)
 * @property {string} sessionId
 * @property {string} kind
 * @property {string} category - CloudEvents-compliant event category
 * @property {string|null} stage
 * @property {string|null} taskId
 * @property {number|null} attempt
 * @property {Record<string, unknown>} payload
 * @property {string|null} causationId
 * @property {string|null} correlationId
 * @property {boolean} snapshotHint
 * @property {'1.0'|'2.0'} schemaVersion
 */

/**
 * @typedef {Object} AppendEventInput
 * @property {string} sessionId
 * @property {string} kind
 * @property {string} [category] - CloudEvents-compliant event category (derived from kind if omitted)
 * @property {string|null} [stage]
 * @property {string|null} [taskId]
 * @property {number|null} [attempt]
 * @property {Record<string, unknown>} [payload]
 * @property {string|null} [causationId]
 * @property {string|null} [correlationId]
 * @property {boolean} [snapshotHint]
 */

// ── StateManager Input/Output Types ──

/**
 * @typedef {Object} CreateSessionInput
 * @property {string} requirement
 * @property {string} requirementFingerprint
 * @property {'orchestrator'|'ide-bridge'} mode
 * @property {string} [initialStage]
 * @property {string|null} [correlationId]
 */

/**
 * @typedef {Object} SaveOptions
 * @property {number|null} [expectedVersion] - null skips version check; 0 means first write
 */

/**
 * @typedef {Object} SaveResult
 * @property {boolean} success
 * @property {number} newVersion
 * @property {string|null} [error]
 */

/**
 * @typedef {Object} BeginStageInput
 * @property {string} sessionId
 * @property {string} stage
 * @property {number} [attempt]
 * @property {ArtifactRef[]} [inputRefs]
 * @property {number} [eventSeq]
 */

/**
 * @typedef {Object} CompleteStageInput
 * @property {string} sessionId
 * @property {string} stage
 * @property {ArtifactRef[]} [outputRefs]
 * @property {number} [eventSeq]
 */

/**
 * @typedef {Object} FailStageInput
 * @property {string} sessionId
 * @property {string} stage
 * @property {SerializedError} [error]
 * @property {number} [eventSeq]
 */

/**
 * @typedef {Object} BeginTaskInput
 * @property {string} sessionId
 * @property {string} taskId
 * @property {string} stage
 * @property {string} subtask
 * @property {string} idempotencyKey
 */

/**
 * @typedef {Object} CompleteTaskInput
 * @property {string} sessionId
 * @property {string} taskId
 * @property {ArtifactRef} [resultRef]
 * @property {number} [eventSeq]
 */

/**
 * @typedef {Object} FailTaskInput
 * @property {string} sessionId
 * @property {string} taskId
 * @property {SerializedError} [error]
 */

/**
 * @typedef {Object} SaveCheckpointInput
 * @property {string} sessionId
 * @property {string} stage
 * @property {number} eventSeq
 * @property {Object} [taskCursor]
 */

/**
 * @typedef {Object} RollbackMetaInput
 * @property {string} sessionId
 * @property {string} stage
 * @property {Object} rollbackInfo
 * @property {number} [eventSeq]
 */

/**
 * @typedef {Object} RetryMetaInput
 * @property {string} sessionId
 * @property {string} stage
 * @property {number} nextAttempt
 * @property {number} [eventSeq]
 */

// ── EventStore Input/Output Types ──

/**
 * @typedef {Object} ReadStreamInput
 * @property {string} sessionId
 * @property {number} [fromSeq]
 * @property {number} [untilSeq]
 */

/**
 * @typedef {Object} QueryEventsInput
 * @property {string} [sessionId]
 * @property {string} [stage]
 * @property {string} [taskId]
 * @property {string} [kind]
 * @property {number} [fromSeq]
 * @property {number} [untilSeq]
 * @property {number} [limit]
 */

/**
 * @typedef {Object} ReplayInput
 * @property {string} sessionId
 * @property {number} fromSeq
 * @property {number} [untilSeq]
 * @property {function(StoredEvent): void} [handler]
 */

/**
 * @typedef {Object} ReplayResult
 * @property {number} eventsApplied
 * @property {number} lastSeq
 * @property {string|null} checkpointUsed
 */

/**
 * @typedef {Object} SubscribeInput
 * @property {string} sessionId
 * @property {string[]} [kinds]
 */

/**
 * @typedef {Object} CompactInput
 * @property {string} sessionId
 * @property {number} [keepFromSeq]
 */

/**
 * @typedef {Object} CompactResult
 * @property {boolean} success
 * @property {number} [eventsRemoved]
 */

// ── Event Kinds (Section 5.4) ──

const EVENT_KINDS = Object.freeze({
  SESSION_CREATED: 'workflow.session.created',
  STAGE_STARTED: 'workflow.stage.started',
  STAGE_COMPLETED: 'workflow.stage.completed',
  STAGE_FAILED: 'workflow.stage.failed',
  STAGE_RETRY_SCHEDULED: 'workflow.stage.retry_scheduled',
  STAGE_ROLLBACK_APPLIED: 'workflow.stage.rollback_applied',
  TASK_STARTED: 'workflow.task.started',
  TASK_COMPLETED: 'workflow.task.completed',
  TASK_FAILED: 'workflow.task.failed',
  TASK_CACHED_REUSED: 'workflow.task.cached_reused',
  CHECKPOINT_SAVED: 'workflow.checkpoint.saved',
  COMPENSATION_REGISTERED: 'workflow.compensation.registered',
  COMPENSATION_EXECUTED: 'workflow.compensation.executed',
  COMPENSATION_FAILED: 'workflow.compensation.failed',
  COMPENSATION_SKIPPED: 'workflow.compensation.skipped',
  RESUME_INSPECTED: 'workflow.resume.inspected',
  RESUME_PLANNED: 'workflow.resume.planned',
  RESUME_STARTED: 'workflow.resume.started',
  RESUME_COMPLETED: 'workflow.resume.completed',
  RESUME_BLOCKED: 'workflow.resume.blocked',
  ARTIFACT_PRODUCED: 'artifact.produced',
  HEALTH_EMITTED: 'trace.health.emitted',
});

// ── Session Status Enum ──

const SESSION_STATUS = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  PAUSED: 'paused',
  FAILED: 'failed',
  COMPLETED: 'completed',
});

const STAGE_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
});

const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CACHED: 'cached',
});

const RUNTIME_MODE = Object.freeze({
  ORCHESTRATOR: 'orchestrator',
  IDE_BRIDGE: 'ide-bridge',
});

const RESUME_DECISION = Object.freeze({
  REPLAY_SAFE: 'REPLAY_SAFE',
  SUBTASK_RETRY: 'SUBTASK_RETRY',
  COMPENSATE_THEN_RETRY: 'COMPENSATE_THEN_RETRY',
  FULL_STAGE_ROLLBACK: 'FULL_STAGE_ROLLBACK',
  ABORT: 'ABORT',
});

const COMPENSATION_STATUS = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

const RISK_LEVEL = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const SCHEMA_VERSION = '2.0';

const EVENT_CATEGORY = Object.freeze({
  LIFECYCLE:   'lifecycle',
  STAGE:       'stage',
  LLM:         'llm',
  ARTIFACT:    'artifact',
  AGENT:       'agent',
  EXPERIENCE:  'experience',
  CI:          'ci',
  GIT:         'git',
  ERROR:       'error',
  DRYRUN:      'dryrun',
  PROMPT:      'prompt',
  CODE_GRAPH:  'code_graph',
  COMPLAINT:   'complaint',
  NEGOTIATION: 'negotiation',
  SYSTEM:      'system',
  COMPENSATION: 'compensation',
  RESUME:      'resume',
});

const HOOK_TO_CATEGORY_MAP = Object.freeze({
  before_state_transition:    EVENT_CATEGORY.LIFECYCLE,
  after_state_transition:     EVENT_CATEGORY.LIFECYCLE,
  workflow_complete:          EVENT_CATEGORY.LIFECYCLE,
  workflow_error:             EVENT_CATEGORY.ERROR,
  stage_started:              EVENT_CATEGORY.STAGE,
  stage_ended:                EVENT_CATEGORY.STAGE,
  stage_artifact_produced:    EVENT_CATEGORY.ARTIFACT,
  stage_heartbeat:            EVENT_CATEGORY.STAGE,
  stage_timeout:              EVENT_CATEGORY.STAGE,
  llm_call_recorded:          EVENT_CATEGORY.LLM,
  router_decision_made:       EVENT_CATEGORY.LLM,
  router_fallback_triggered:  EVENT_CATEGORY.LLM,
  task_claimed:               EVENT_CATEGORY.AGENT,
  task_completed:             EVENT_CATEGORY.AGENT,
  task_failed:                EVENT_CATEGORY.AGENT,
  task_interrupted:           EVENT_CATEGORY.AGENT,
  experience_recorded:        EVENT_CATEGORY.EXPERIENCE,
  skill_evolved:              EVENT_CATEGORY.EXPERIENCE,
  skill_auto_created:         EVENT_CATEGORY.EXPERIENCE,
  skill_discovery_complete:   EVENT_CATEGORY.EXPERIENCE,
  complaint_filed:            EVENT_CATEGORY.COMPLAINT,
  complaint_resolved:         EVENT_CATEGORY.COMPLAINT,
  ci_pipeline_started:        EVENT_CATEGORY.CI,
  ci_pipeline_complete:       EVENT_CATEGORY.CI,
  ci_pipeline_failed:         EVENT_CATEGORY.CI,
  code_graph_built:           EVENT_CATEGORY.CODE_GRAPH,
  code_graph_queried:         EVENT_CATEGORY.CODE_GRAPH,
  git_branch_created:         EVENT_CATEGORY.GIT,
  git_branch_pushed:          EVENT_CATEGORY.GIT,
  git_pr_created:             EVENT_CATEGORY.GIT,
  git_pr_merged:              EVENT_CATEGORY.GIT,
  dryrun_started:             EVENT_CATEGORY.DRYRUN,
  dryrun_op_recorded:         EVENT_CATEGORY.DRYRUN,
  dryrun_report_saved:        EVENT_CATEGORY.DRYRUN,
  dryrun_applied:             EVENT_CATEGORY.DRYRUN,
  prompt_variant_promoted:    EVENT_CATEGORY.PROMPT,
  prompt_variant_rolledback:  EVENT_CATEGORY.PROMPT,
  html_report_generated:      EVENT_CATEGORY.ARTIFACT,
  file_lock_conflict:         EVENT_CATEGORY.ERROR,
  agent_boundary_violation:   EVENT_CATEGORY.ERROR,
  human_review_required:      EVENT_CATEGORY.LIFECYCLE,
  negotiate_request:          EVENT_CATEGORY.NEGOTIATION,
  negotiate_response:         EVENT_CATEGORY.NEGOTIATION,
  write_around_review_complete: EVENT_CATEGORY.LIFECYCLE,
  write_around_review_blocked:  EVENT_CATEGORY.ERROR,
  write_around_review_warning:  EVENT_CATEGORY.LIFECYCLE,
  tool_execution_started:    EVENT_CATEGORY.AGENT,
  tool_execution_completed:  EVENT_CATEGORY.AGENT,
  tool_execution_failed:     EVENT_CATEGORY.ERROR,
  tool_before_execution:     EVENT_CATEGORY.AGENT,
  tool_after_execution:      EVENT_CATEGORY.AGENT,
  output_truncated:          EVENT_CATEGORY.LLM,
  output_continuation:       EVENT_CATEGORY.LLM,
  agent_self_report_found:   EVENT_CATEGORY.SYSTEM,
  agent_self_report_missing: EVENT_CATEGORY.SYSTEM,
});

/**
 * @typedef {Object} CompensationDescriptor
 * @property {string} compensationId - Unique ID (e.g. 'comp-<ts>-<rand>')
 * @property {string} sessionId
 * @property {string} stage
 * @property {string} taskId
 * @property {string} actionType - e.g. 'DELETE_ARTIFACT', 'CLEAR_STAGE_CTX', 'ROLLBACK_GIT_BRANCH'
 * @property {Object} args - Action-specific arguments (must be JSON-serialisable)
 * @property {string} idempotencyKey - For dedup on replay
 * @property {string} registeredAt - ISO timestamp
 * @property {'pending'|'completed'|'failed'|'skipped'} status
 * @property {SerializedError|null} [error]
 */

/**
 * @typedef {Object} ResumeInspection
 * @property {string} sessionId
 * @property {string|null} currentStage
 * @property {Checkpoint|null} lastCheckpoint
 * @property {number} lastEventSeq
 * @property {Array<{taskId:string,stage:string,subtask:string,status:string}>} unfinishedOperations
 * @property {CompensationDescriptor[]} pendingCompensations
 * @property {Record<string,{idempotencyKey:string,resultRef:ArtifactRef|null}>} reusableResults
 * @property {Array<{type:string,detail:string,severity:string}>} inconsistencies
 * @property {'low'|'medium'|'high'|'critical'} riskLevel
 */

/**
 * @typedef {Object} ResumePlan
 * @property {string} planId - Unique ID (e.g. 'plan-<ts>-<rand>')
 * @property {string} sessionId
 * @property {string} decision - One of RESUME_DECISION values
 * @property {string|null} resumeFromStage
 * @property {string|null} resumeFromTaskId
 * @property {string[]} operationsToSkip - Task IDs whose results are reusable
 * @property {string[]} operationsToReplay - Task IDs that need re-execution
 * @property {CompensationDescriptor[]} compensationsToRun
 * @property {string} why - Human-readable explanation
 * @property {'low'|'medium'|'high'|'critical'} riskLevel
 */

module.exports = {
  EVENT_KINDS,
  SESSION_STATUS,
  STAGE_STATUS,
  TASK_STATUS,
  RUNTIME_MODE,
  RESUME_DECISION,
  COMPENSATION_STATUS,
  RISK_LEVEL,
  SCHEMA_VERSION,
  EVENT_CATEGORY,
  HOOK_TO_CATEGORY_MAP,
};
