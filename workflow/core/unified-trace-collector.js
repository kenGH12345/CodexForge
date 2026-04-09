/**
 * UnifiedTraceCollector – Single Source of Truth for Workflow Health Monitoring
 *
 * ADR-XX: Unified Logging Architecture for Health Observability
 *
 * Solves the "scattered logs" problem by collecting HEALTH-RELATED workflow events
 * into a single JSONL file for easy inspection and test verification.
 *
 * Design Principles:
 *   1. Category-scoped file: output/health/<runCategory>/workflow-trace.jsonl (append-only JSONL)
 *   2. Unified schema: All events use the same {ts, event, stage, data} structure
 *   3. TraceID correlation: All events share the same sessionId for correlation
 *   4. Content capture: Stage input/output artifacts are captured with hashes
 *   5. Health focus: ONLY for system health monitoring, NOT for functional logs
 *
 * Event Types Collected (Health Monitoring Only):
 *   - workflow_start / workflow_end
 *   - stage_start / stage_end (with input/output artifact content)
 *   - socratic_challenge (questions, blindspots, confidence)
 *   - test_result (passed/failed, coverage, failures)
 *   - error (any error events)
 *
 * NOT Collected Here (Independent Logs):
 *   - evolution_signal → evolution-log.json (EvolutionLoop)
 *   - experience_recorded → ExperienceStore
 *   - agent_handoff → agent-handoff-log.json (AgentHandoffLog)
 *   - agent_feedback → agent-feedback-history.jsonl (AgentFeedbackSystem)
 *   - communication → communication-log.json (FileRefBus)
 *
 * Integration:
 *   - Orchestrator: Direct calls for stage lifecycle and workflow health
 *
 * @module unified-trace-collector
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

// 导入 PATHS 常量作为默认 outputDir
const { PATHS } = require('./constants');

// ─── Event Types ─────────────────────────────────────────────────────────────
// NOTE: UnifiedTraceCollector 只用于系统健康度观测
// 其他功能的日志保持独立：
//   - evolution-log.json (EvolutionLoop)
//   - agent-handoff-log.json (AgentHandoffLog)
//   - communication-log.json (FileRefBus)
//   - agent-feedback-history.jsonl (AgentFeedbackSystem)

const TraceEventType = {
  // Workflow lifecycle
  WORKFLOW_START:   'workflow_start',
  WORKFLOW_END:     'workflow_end',
  
  // Stage lifecycle (CRITICAL: with input/output for health monitoring)
  STAGE_START:      'stage_start',
  STAGE_END:        'stage_end',
  STAGE_ERROR:      'stage_error',
  
  // Quality gates (health indicators)
  SOCRATIC_CHALLENGE: 'socratic_challenge',
  TEST_RESULT:       'test_result',
  
  // System health
  ERROR:            'error',
};

const OBSERVATION_MAINLINE = ['goal', 'tool', 'plan', 'execute', 'evaluate', 'retry'];

// ─── UnifiedTraceCollector ─────────────────────────────────────────────────────

class UnifiedTraceCollector {
  /**
   * @param {object} opts
   * @param {string} opts.outputDir - Output directory for trace file
   * @param {string} opts.sessionId - Unique session identifier
   * @param {boolean} [opts.captureArtifactContent=true] - Whether to capture artifact content
   * @param {number} [opts.maxContentLength=5000] - Max chars to capture per artifact
   * @param {boolean} [opts.verbose=true] - Log to console
   */
  constructor(opts = {}) {
    // 默认使用 PATHS.OUTPUT_DIR 而不是 process.cwd()
    // 这确保 trace 文件始终写入 workflow/output 目录
    this._outputDir = opts.outputDir || PATHS.OUTPUT_DIR;
    this._runCategory = this._normalizeRunCategory(opts.runCategory);
    this._healthOutputDir = path.join(this._outputDir, 'health', this._runCategory);
    this._sessionId = opts.sessionId || this._generateSessionId();
    this._captureArtifactContent = opts.captureArtifactContent !== false;
    this._maxContentLength = opts.maxContentLength || 5000;
    this._verbose = opts.verbose !== false;
    
    this._tracePath = path.join(this._healthOutputDir, 'workflow-trace.jsonl');
    this._healthReportPath = path.join(this._healthOutputDir, 'health-report.md');
    this._writeStream = null;
    this._eventCount = 0;
    this._startTime = null;
    this._syncWrites = opts.syncWrites !== false;
    
    // In-memory event buffer for current session (avoids file read race conditions)
    this._events = [];

    // 统一观测主线（表达层）：目标→工具→计划→执行→评估→重试
    this._observationMainline = Array.isArray(opts.observationMainline) && opts.observationMainline.length > 0
      ? [...opts.observationMainline]
      : [...OBSERVATION_MAINLINE];

    // Stage tracking for input/output correlation
    this._currentStage = null;
    this._stageStartTime = null;
    this._stageInput = null;

    // Process lifecycle tracking (确保中断时也能补齐stage_end/workflow_end)
    this._workflowEnded = false;
    this._shutdownHandled = false;
    this._exitHooksRegistered = false;
    
    // Ensure health namespace directory exists
    if (!fs.existsSync(this._healthOutputDir)) {
      fs.mkdirSync(this._healthOutputDir, { recursive: true });
    }

    this._registerProcessExitHooks();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Start the trace collector. Call at workflow start.
   */
  start() {
    this._startTime = Date.now();
    this._resetSessionFiles();
    this._openStream();
    this._log(`[UnifiedTrace] 📖 Trace started: ${this._tracePath}`);
  }

  /**
   * End the trace collector. Call at workflow end.
   *
   * IMPORTANT: async by design.
   * We must wait for write stream drain + finish to avoid races where
   * health-report reads workflow-trace.jsonl before final events are flushed.
   */
  async end() {
    this._workflowEnded = true;
    await this._flush();
    await this._closeStream();
    const duration = Date.now() - this._startTime;
    this._log(`[UnifiedTrace] 📕 Trace ended: ${this._eventCount} events, ${(duration / 1000).toFixed(2)}s`);
  }

  /**
   * Record workflow start event.
   * @param {object} data
   * @param {string} [data.requirement] - The requirement text
   * @param {string} [data.mode] - Execution mode
   * @param {string} [data.userInput] - User's full input conversation (including attachments, commands, etc.)
   * @param {object} [data.attachedImages] - Attached image recognition results
   */
  recordWorkflowStart(data = {}) {
    // 捕获调用栈以便追踪未知入口
    const callStack = this._captureCallStack();
    
    this._append({
      event: TraceEventType.WORKFLOW_START,
      stage: null,
      data: {
        requirement: data.requirement ? this._truncate(data.requirement, 500) : null,
        mode: data.mode || 'sequential',
        callStack: callStack, // 添加调用栈信息
        observationMainline: this._observationMainline,
        // 用户完整输入对话（包括附件内容）
        userInput: data.userInput || null,
        // 用户附加的图片识别结果
        attachedImages: data.attachedImages || null,
        // 保留其他字段
        ...data,
      },
    });
  }

  /**
   * Record workflow end event.
   * @param {object} data
   */
  recordWorkflowEnd(data = {}) {
    this._workflowEnded = true;
    this._append({
      event: TraceEventType.WORKFLOW_END,
      stage: null,
      data: {
        success: data.success,
        totalDuration: data.totalDuration,
        stagesCompleted: data.stagesCompleted,
        observationMainline: this._observationMainline,
        ...data,
      },
    });
  }

  /**
   * Record stage start event with INPUT artifact.
   * CRITICAL: Captures input artifact content for traceability.
   *
   * @param {string} stageName - Stage name (ANALYSE, ARCHITECT, etc.)
   * @param {object} opts
   * @param {string} [opts.inputArtifactPath] - Path to input artifact
   * @param {string} [opts.inputArtifactContent] - Content of input artifact
   * @param {object} [opts.context] - Additional context
   */
  recordStageStart(stageName, opts = {}) {
    this._currentStage = stageName;
    this._stageStartTime = Date.now();
    
    let inputData = null;
    if (opts.inputArtifactPath && this._captureArtifactContent) {
      inputData = this._captureArtifact(opts.inputArtifactPath, opts.inputArtifactContent);
    }
    
    this._stageInput = inputData;
    
    const context = opts.context || null;
    this._append({
      event: TraceEventType.STAGE_START,
      stage: stageName,
      data: {
        input: inputData,
        context,
        mainlinePhase: opts.mainlinePhase || context?.mainlinePhase || null,
        mainlineStepIndex: Number.isFinite(opts.mainlineStepIndex)
          ? opts.mainlineStepIndex
          : (Number.isFinite(context?.mainlineStepIndex) ? context.mainlineStepIndex : null),
      },
    });
  }

  /**
   * Record stage end event with OUTPUT artifact.
   * CRITICAL: Captures output artifact content for traceability.
   *
   * @param {string} stageName - Stage name
   * @param {object} opts
   * @param {boolean} opts.success - Whether stage succeeded
   * @param {string} [opts.outputArtifactPath] - Path to output artifact
   * @param {string} [opts.outputArtifactContent] - Content of output artifact
   * @param {number} [opts.duration] - Stage duration in ms
   * @param {string} [opts.error] - Error message if failed
   */
  recordStageEnd(stageName, opts = {}) {
    const duration = opts.duration || (this._stageStartTime ? Date.now() - this._stageStartTime : 0);
    
    let outputData = null;
    if (opts.outputArtifactPath && this._captureArtifactContent) {
      outputData = this._captureArtifact(opts.outputArtifactPath, opts.outputArtifactContent);
    }
    
    this._append({
      event: opts.success === false ? TraceEventType.STAGE_ERROR : TraceEventType.STAGE_END,
      stage: stageName,
      data: {
        success: opts.success !== false,
        duration,
        input: this._stageInput,
        output: outputData,
        error: opts.error || null,
        mainlinePhase: opts.mainlinePhase || null,
        mainlineStepIndex: Number.isFinite(opts.mainlineStepIndex) ? opts.mainlineStepIndex : null,
      },
    });
    
    this._currentStage = null;
    this._stageInput = null;
  }

  /**
   * Record Socratic challenge event.
   * @param {string} stageName
   * @param {object} challengeResult - From SocraticChallenger
   */
  recordSocraticChallenge(stageName, challengeResult) {
    this._append({
      event: TraceEventType.SOCRATIC_CHALLENGE,
      stage: stageName,
      data: {
        challenged: challengeResult.challenged !== false,
        triggerReasons: challengeResult.triggerReasons || [],
        questions: challengeResult.questions || [],
        blindSpots: challengeResult.blindSpots || [],
        confidence: Number.isFinite(challengeResult.confidence) ? challengeResult.confidence : 0,
        confidenceStatus: challengeResult.confidenceStatus || 'ok',
        confidenceReason: challengeResult.confidenceReason || null,
        shouldRetry: challengeResult.shouldRetry || false,
        requiresRevision: challengeResult.requiresRevision === true,
        revisionSummary: challengeResult.revisionSummary || null,
        p2Protocol: challengeResult.p2Protocol || null,
        preChallengeScore: Number.isFinite(challengeResult.preChallengeScore) ? challengeResult.preChallengeScore : null,
        postRevisionScore: Number.isFinite(challengeResult.postRevisionScore) ? challengeResult.postRevisionScore : null,
        deltaScore: Number.isFinite(challengeResult.deltaScore) ? challengeResult.deltaScore : null,
        effectiveChallenge: challengeResult.effectiveChallenge === true,
        dimensionScores: challengeResult.dimensionScores || null,
        evidenceBreakdown: challengeResult.evidenceBreakdown || null,
      },
    });
  }

  /**
   * Record test result event.
   * @param {string} stageName
   * @param {object} testResult
   */
  recordTestResult(stageName, testResult) {
    this._append({
      event: TraceEventType.TEST_RESULT,
      stage: stageName,
      data: {
        passed: testResult.passed || false,
        passedCount: testResult.passedCount || 0,
        failedCount: testResult.failedCount || 0,
        coverage: testResult.coverage || null,
        failures: (testResult.failures || []).slice(0, 10), // Limit failure details
        testCommand: testResult.testCommand || null,
        duration: testResult.duration || null,
      },
    });
  }

  /**
   * Record error event.
   * @param {string} stageName
   * @param {Error|string} error
   */
  recordError(stageName, error) {
    this._append({
      event: TraceEventType.ERROR,
      stage: stageName || this._currentStage,
      data: {
        message: error.message || String(error),
        stack: error.stack ? this._truncate(error.stack, 1000) : null,
      },
    });
  }

  /**
   * Generic record method for custom events.
   * @param {string} eventType
   * @param {string} stage
   * @param {object} data
   */
  record(eventType, stage, data = {}) {
    this._append({
      event: eventType,
      stage,
      data,
    });
  }

  // ─── Integration ───────────────────────────────────────────────────────────

  /**
   * Attach to HookSystem for automatic event capture.
   * @param {object} hookSystem - HookSystem instance
   */
  attachToHookSystem(hookSystem) {
    if (!hookSystem || typeof hookSystem.emit !== 'function') return;
    
    // Store original emit
    const originalEmit = hookSystem.emit.bind(hookSystem);
    const self = this;
    
    // Wrap emit to capture events
    hookSystem.emit = async function(event, data) {
      // Auto-capture specific events
      self._captureHookEvent(event, data);
      
      // Call original
      return originalEmit(event, data);
    };
    
    this._log(`[UnifiedTrace] 🔗 Attached to HookSystem`);
  }

  /**
   * Capture specific hook events.
   * @private
   */
  _captureHookEvent(event, data) {
    // NOTE: 只捕获与健康度观测相关的事件
    // 不捕获 evolution/experience 等功能日志
    switch (event) {
      case 'stage_started':
      case 'STAGE_STARTED':
        this.recordStageStart(data.stage, { context: data });
        break;
      case 'stage_ended':
      case 'STAGE_ENDED':
        this.recordStageEnd(data.stage, { success: true, ...data });
        break;
      case 'workflow_error':
      case 'WORKFLOW_ERROR':
        this.recordError(data.stage, data.error);
        break;
      case 'ci_pipeline_complete':
      case 'CI_PIPELINE_COMPLETE':
        if (data.result) {
          this.recordTestResult(this._currentStage || 'TEST', {
            passed: data.result.success,
            passedCount: data.result.passed,
            failedCount: data.result.failed,
            coverage: data.result.coverage,
          });
        }
        break;
      // Add more HEALTH-RELATED event mappings as needed
    }
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  /**
   * Get all events from current session.
   * Uses in-memory buffer first (fast, no race condition), falls back to file.
   * @returns {Array<object>}
   */
  getAllEvents() {
    // Prefer in-memory buffer (current session, no file read race condition)
    if (this._events && this._events.length > 0) {
      return [...this._events];
    }
    
    // Fallback: read from file (for post-run analysis)
    if (!fs.existsSync(this._tracePath)) return [];
    
    const content = fs.readFileSync(this._tracePath, 'utf-8');
    const allEvents = content.trim().split('\n').map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
    
    // Filter to current session only to avoid mixing events from different runs
    return allEvents.filter(e => e.session === this._sessionId);
  }

  /**
   * Get events by type.
   * @param {string} eventType
   * @returns {Array<object>}
   */
  getEventsByType(eventType) {
    return this.getAllEvents().filter(e => e.event === eventType);
  }

  /**
   * Get events by stage.
   * @param {string} stage
   * @returns {Array<object>}
   */
  getEventsByStage(stage) {
    return this.getAllEvents().filter(e => e.stage === stage);
  }

  /**
   * Get trace summary for testing.
   * @returns {object}
   */
  getSummary() {
    const events = this.getAllEvents();
    
    return {
      sessionId: this._sessionId,
      tracePath: this._tracePath,
      runCategory: this._runCategory,
      healthOutputDir: this._healthOutputDir,
      totalEvents: events.length,
      eventTypes: this._countByField(events, 'event'),
      stages: this._countByField(events.filter(e => e.stage), 'stage'),
      duration: this._startTime ? Date.now() - this._startTime : 0,
    };
  }

  /**
   * Verify trace completeness for testing.
   * Checks that all expected events are present.
   * 
   * @param {string[]} expectedStages - Expected stage names
   * @returns {{ passed: boolean, missing: string[], present: string[], details: object }}
   */
  verifyCompleteness(expectedStages = ['ANALYSE', 'ARCHITECT', 'PLAN', 'CODE', 'TEST']) {
    const events = this.getAllEvents();
    const stageStarts = events.filter(e => e.event === TraceEventType.STAGE_START);
    const stageEnds = events.filter(e => e.event === TraceEventType.STAGE_END || e.event === TraceEventType.STAGE_ERROR);
    const socraticChallenges = events.filter(e => e.event === TraceEventType.SOCRATIC_CHALLENGE);
    
    const missing = [];
    const present = [];
    
    for (const stage of expectedStages) {
      const hasStart = stageStarts.some(e => e.stage === stage);
      const hasEnd = stageEnds.some(e => e.stage === stage);
      
      if (hasStart && hasEnd) {
        present.push(stage);
      } else {
        missing.push(`${stage} (${hasStart ? '✓ start' : '✗ start'} / ${hasEnd ? '✓ end' : '✗ end'})`);
      }
    }
    
    return {
      passed: missing.length === 0,
      missing,
      present,
      details: {
        totalEvents: events.length,
        stageStarts: stageStarts.length,
        stageEnds: stageEnds.length,
        socraticChallenges: socraticChallenges.length,
        hasWorkflowStart: events.some(e => e.event === TraceEventType.WORKFLOW_START),
        hasWorkflowEnd: events.some(e => e.event === TraceEventType.WORKFLOW_END),
      },
    };
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  _registerProcessExitHooks() {
    if (this._exitHooksRegistered) return;
    this._exitHooksRegistered = true;

    const safeShutdown = (reason) => {
      this._ensureTerminalEventsOnShutdown(reason);
    };

    process.once('SIGINT', () => safeShutdown('signal:SIGINT'));
    process.once('SIGTERM', () => safeShutdown('signal:SIGTERM'));

    process.once('uncaughtException', (err) => {
      this.recordError(this._currentStage, err);
      safeShutdown('uncaughtException');
    });

    process.once('unhandledRejection', (reason) => {
      this.recordError(this._currentStage, reason instanceof Error ? reason : new Error(String(reason)));
      safeShutdown('unhandledRejection');
    });

    process.once('exit', (code) => {
      safeShutdown(`process_exit:${code}`);
    });
  }

  _ensureTerminalEventsOnShutdown(reason) {
    if (this._shutdownHandled) return;
    this._shutdownHandled = true;

    const safeReason = reason || 'unknown_shutdown';

    if (this._currentStage) {
      const fallbackDuration = this._stageStartTime ? Math.max(0, Date.now() - this._stageStartTime) : 0;
      this.recordStageEnd(this._currentStage, {
        success: false,
        duration: fallbackDuration,
        error: `interrupted: ${safeReason}`,
        mainlinePhase: 'retry',
        mainlineStepIndex: this._observationMainline.indexOf('retry') + 1,
      });
    }

    if (!this._workflowEnded) {
      this.recordWorkflowEnd({
        success: false,
        totalDuration: this._startTime ? Math.max(0, Date.now() - this._startTime) : 0,
        stagesCompleted: this.getEventsByType(TraceEventType.STAGE_END).length,
        interrupted: true,
        interruptReason: safeReason,
      });
    }
  }

  _generateSessionId() {
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const random = crypto.randomBytes(4).toString('hex');
    return `${timestamp}-${random}`;
  }

  _normalizeRunCategory(category) {
    const value = String(category || 'prod').trim().toLowerCase();
    return ['prod', 'test', 'diag'].includes(value) ? value : 'prod';
  }

  _resetSessionFiles() {
    try {
      if (!fs.existsSync(this._healthOutputDir)) {
        fs.mkdirSync(this._healthOutputDir, { recursive: true });
      }
      fs.writeFileSync(this._tracePath, '', 'utf-8');
      fs.writeFileSync(this._healthReportPath, '', 'utf-8');
      this._events = [];
      this._eventCount = 0;
      this._log(`[UnifiedTrace] 🧹 Cleared previous session logs: ${this._tracePath}`);
    } catch (err) {
      this._log(`[UnifiedTrace] ⚠️ Failed to clear previous session logs: ${err.message}`);
    }
  }

  /**
   * Capture call stack for tracing workflow entry points.
   * Helps identify where workflow was triggered from (IDE, test, CLI, etc.)
   * @private
   */
  _captureCallStack() {
    const stack = new Error('Workflow entry point trace').stack;
    if (!stack) return null;
    
    const lines = stack.split('\n');
    
    // 过滤并格式化调用栈
    // 支持两种路径格式：workflow/ 和 workflow\
    const filtered = lines
      .slice(1) // 移除 "Error: Workflow entry point trace"
      .filter(line => {
        // 支持 Windows 和 Unix 路径分隔符
        const hasWorkflowPath = line.includes('workflow/') || line.includes('workflow\\');
        const isCurrentFile = line.includes('unified-trace-collector.js');
        return hasWorkflowPath && !isCurrentFile;
      })
      .map(line => line.trim())
      .slice(0, 10); // 限制栈深度
    
    // 如果 filtered 为空，尝试从原始调用栈推断入口
    const entryHint = filtered.length > 0 
      ? this._inferEntryPoint(filtered)
      : this._inferEntryPointFromRaw(stack);
    
    return {
      raw: stack.split('\n').slice(0, 15).join('\n'),
      filtered: filtered,
      entryHint: entryHint,
    };
  }

  /**
   * Infer workflow entry point from call stack.
   * @private
   */
  _inferEntryPoint(filteredStack) {
    if (!filteredStack || filteredStack.length === 0) return 'unknown';
    
    const firstFrame = filteredStack[0] || '';
    
    // 根据调用路径推断入口（支持 Windows 和 Unix 路径）
    if (firstFrame.includes('ide-workflow-bridge')) return 'IDE_BRIDGE';
    if (firstFrame.includes('commands-workflow')) return 'CLI_WF_COMMAND';
    if (firstFrame.includes('orchestrator-run')) return 'ORCHESTRATOR_RUN';
    if (firstFrame.includes('mcp-server')) return 'MCP_SERVER';
    if (firstFrame.includes('.test.') || firstFrame.includes('test/') || firstFrame.includes('test\\')) return 'TEST';
    if (firstFrame.includes('smoke-')) return 'SMOKE_TEST';
    
    return 'DIRECT_CALL';
  }

  /**
   * 从原始调用栈推断入口（当 filtered 为空时的 fallback）
   */
  _inferEntryPointFromRaw(rawStack) {
    if (!rawStack) return 'unknown';
    
    // 检查原始调用栈中的关键路径
    if (rawStack.includes('ide-workflow-bridge')) return 'IDE_BRIDGE';
    if (rawStack.includes('commands-workflow')) return 'CLI_WF_COMMAND';
    if (rawStack.includes('orchestrator-run')) return 'ORCHESTRATOR_RUN';
    if (rawStack.includes('mcp-server')) return 'MCP_SERVER';
    if (rawStack.includes('.test.') || rawStack.includes('test/') || rawStack.includes('test\\')) return 'TEST';
    if (rawStack.includes('smoke-')) return 'SMOKE_TEST';
    if (rawStack.includes('[eval]')) return 'EVAL_SCRIPT';
    
    return 'DIRECT_CALL';
  }

  _openStream() {
    if (this._syncWrites) {
      return;
    }
    if (!this._writeStream) {
      // Use 'w' (overwrite) mode: each new session starts a fresh trace file.
      // This prevents getAllEvents() from mixing events from different sessions.
      this._writeStream = fs.createWriteStream(this._tracePath, { flags: 'w' });
    }
  }

  async _closeStream() {
    if (!this._writeStream) return;

    const stream = this._writeStream;
    this._writeStream = null;

    try {
      stream.end();
      await once(stream, 'finish');
    } catch {}
  }

  async _flush() {
    // Wait for internal write buffer to drain before closing.
    if (!this._writeStream) return;
    if (this._writeStream.writableNeedDrain) {
      try {
        await once(this._writeStream, 'drain');
      } catch {}
    }
  }

  _append(entry) {
    const fullEntry = {
      ts: new Date().toISOString(),
      session: this._sessionId,
      seq: ++this._eventCount,
      ...entry,
    };
    
    // Keep in-memory copy for fast access (avoids file read race conditions)
    this._events.push(fullEntry);

    const line = JSON.stringify(fullEntry) + '\n';

    // Durability-first path: sync append per event to avoid losing stage logs on abrupt failure.
    if (this._syncWrites) {
      try {
        fs.appendFileSync(this._tracePath, line, 'utf-8');
      } catch (syncErr) {
        if (this._writeStream) {
          this._writeStream.write(line);
        }
        if (process.env.DEBUG) {
          console.warn(`[UnifiedTrace] Sync append failed (fallback to stream): ${syncErr.message}`);
        }
      }
    } else if (this._writeStream) {
      this._writeStream.write(line);
    }

    if (this._verbose) {
      console.error(`[UnifiedTrace][PERSISTED] seq=${fullEntry.seq} event=${fullEntry.event} stage=${fullEntry.stage || '-'} session=${this._sessionId}`);
    }

    // Real-time health report refresh (non-blocking best-effort)
    this._refreshHealthReportRealtime(fullEntry);
  }

  _captureArtifact(artifactPath, providedContent = null) {
    try {
      const content = providedContent || (
        fs.existsSync(artifactPath) 
          ? fs.readFileSync(artifactPath, 'utf-8') 
          : null
      );
      
      if (!content) {
        return { path: artifactPath, hash: null, preview: null, size: 0 };
      }
      
      const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
      const preview = this._truncate(content, this._maxContentLength);
      
      return {
        path: artifactPath,
        hash,
        preview,
        size: content.length,
        lines: content.split('\n').length,
      };
    } catch (err) {
      return { path: artifactPath, error: err.message };
    }
  }

  _truncate(str, maxLength) {
    if (!str || typeof str !== 'string') return str;
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength) + '... [truncated]';
  }

  _countByField(events, field) {
    const counts = {};
    for (const e of events) {
      const key = e[field];
      if (key) counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  _log(msg) {
    if (this._verbose) {
      console.error(msg);
    }
  }

  /**
   * Best-effort live updater for health-report.md.
   * Appends a concise event line for current session so IDE users can observe progress in real time.
   * Never throws: tracing must not break workflow execution.
   *
   * @param {object} event
   */
  _refreshHealthReportRealtime(event) {
    try {
      if (!event || !event.event) return;

      const ts = event.ts || new Date().toISOString();
      const stage = event.stage || '-';
      const eventName = event.event;
      const seq = event.seq || this._eventCount;

      let summary = '';
      if (eventName === TraceEventType.STAGE_START) {
        summary = `stage-start ${stage}`;
      } else if (eventName === TraceEventType.STAGE_END) {
        const ok = event.data?.success !== false ? 'success' : 'failed';
        summary = `stage-end ${stage} (${ok})`;
      } else if (eventName === TraceEventType.STAGE_ERROR) {
        summary = `stage-error ${stage}: ${String(event.data?.error || '').slice(0, 80)}`;
      } else if (eventName === TraceEventType.SOCRATIC_CHALLENGE) {
        const confidence = event.data?.confidence;
        summary = `socratic ${stage} (confidence=${typeof confidence === 'number' ? confidence.toFixed(2) : 'n/a'})`;
      } else if (eventName === TraceEventType.WORKFLOW_START) {
        summary = 'workflow-start';
      } else if (eventName === TraceEventType.WORKFLOW_END) {
        summary = 'workflow-end';
      } else {
        summary = `${eventName} ${stage}`;
      }

      const workflowStartEvt = (this._events || []).find((evt) => evt.event === TraceEventType.WORKFLOW_START);
      const requirementInline = String(workflowStartEvt?.data?.requirement || '').replace(/\r?\n/g, ' ').slice(0, 200);
      const fullUserInput = workflowStartEvt?.data?.userInput ? String(workflowStartEvt.data.userInput) : '';

      const header = [
        '# 🏥 Live Health Stream',
        '',
        `> Session: \`${this._sessionId}\``,
        `> Run Category: \`${this._runCategory}\``,
        '> Mode: Realtime overwrite (file is rebuilt from current session events)',
        ...(requirementInline ? [`> Requirement: ${requirementInline}`] : []),
        '',
        ...(fullUserInput
          ? [
              '## 📝 User Input',
              '',
              '```',
              fullUserInput.slice(0, 2000),
              '```',
              '',
            ]
          : []),
        '| Timestamp | Seq | Event | Stage | Summary |',
        '|-----------|-----|-------|-------|---------|',
      ].join('\n');

      const rows = (this._events || []).map((evt) => {
        const evtTs = evt.ts || new Date().toISOString();
        const evtSeq = evt.seq || '-';
        const evtStage = evt.stage || '-';
        const evtName = evt.event || 'unknown';

        let evtSummary = '';
        if (evtName === TraceEventType.STAGE_START) {
          evtSummary = `stage-start ${evtStage}`;
        } else if (evtName === TraceEventType.STAGE_END) {
          const ok = evt.data?.success !== false ? 'success' : 'failed';
          evtSummary = `stage-end ${evtStage} (${ok})`;
        } else if (evtName === TraceEventType.STAGE_ERROR) {
          evtSummary = `stage-error ${evtStage}: ${String(evt.data?.error || '').slice(0, 80)}`;
        } else if (evtName === TraceEventType.SOCRATIC_CHALLENGE) {
          const confidence = evt.data?.confidence;
          evtSummary = `socratic ${evtStage} (confidence=${typeof confidence === 'number' ? confidence.toFixed(2) : 'n/a'})`;
        } else if (evtName === TraceEventType.WORKFLOW_START) {
          evtSummary = 'workflow-start';
        } else if (evtName === TraceEventType.WORKFLOW_END) {
          evtSummary = 'workflow-end';
        } else {
          evtSummary = `${evtName} ${evtStage}`;
        }

        return `| ${evtTs} | ${evtSeq} | ${evtName} | ${evtStage} | ${evtSummary} |`;
      });

      const content = `${header}\n${rows.join('\n')}\n`;
      fs.writeFileSync(this._healthReportPath, content, 'utf-8');
    } catch (err) {
      if (process.env.DEBUG) {
        console.warn(`[UnifiedTrace] Realtime health update failed (non-fatal): ${err.message}`);
      }
    }
  }

  // ─── Getters ───────────────────────────────────────────────────────────────

  get tracePath() {
    return this._tracePath;
  }

  get sessionId() {
    return this._sessionId;
  }

  get runCategory() {
    return this._runCategory;
  }

  get eventCount() {
    return this._eventCount;
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  UnifiedTraceCollector,
  TraceEventType,
};
