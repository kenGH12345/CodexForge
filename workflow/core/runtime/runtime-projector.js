'use strict';

const RUNTIME_PROJECTOR_METHODS = Object.freeze([
  'projectManifest',
  'projectWorkflowStatus',
  'projectHealthTrace',
]);

class IRuntimeProjector {
  /** @deprecated Use runtime state directly instead of projection */
  projectManifest(sessionId) {
    throw new Error('IRuntimeProjector.projectManifest: not implemented');
  }

  /** @deprecated Use runtime state directly instead of projection */
  projectWorkflowStatus(sessionId) {
    throw new Error('IRuntimeProjector.projectWorkflowStatus: not implemented');
  }

  /** @deprecated Use runtime event stream directly instead of projection */
  projectHealthTrace(sessionId) {
    throw new Error('IRuntimeProjector.projectHealthTrace: not implemented');
  }
}

class RuntimeProjector extends IRuntimeProjector {
  constructor(stateManager, eventStore) {
    super();
    this._stateManager = stateManager;
    this._eventStore = eventStore;
  }

  /**
   * @deprecated Projected for backward compatibility; callers should read StateManager directly.
   * Produces a manifest-shaped object matching createManifest() output from types.js.
   */
  projectManifest(sessionId) {
    const session = this._stateManager.loadSession(sessionId);
    if (!session) return null;

    const artifacts = this._projectArtifacts(session);
    const history = this._projectHistory(session);

    return {
      version: '1.0.0',
      projectId: session.projectId || sessionId,
      currentState: session.currentStage,
      createdAt: session.startedAt,
      updatedAt: session.updatedAt,
      history,
      artifacts: {
        requirementMd: null,
        architectureMd: null,
        codeDiff: null,
        executionPlanMd: null,
        testReportMd: null,
        ...artifacts,
      },
      risks: this._projectRisks(session),
      meta: { sessionId: session.sessionId, runtimeMode: session.mode, recovery: this._projectRecoveryMeta(session) },
    };
  }

  /**
   * @deprecated Projected for backward compatibility; callers should read StateManager directly.
   * Produces a workflow-status-shaped object matching the bridge's workflow-status.json schema.
   */
  projectWorkflowStatus(sessionId) {
    const session = this._stateManager.loadSession(sessionId);
    if (!session) return null;

    const completedStages = [];
    if (session.stages) {
      for (const [name, run] of Object.entries(session.stages)) {
        if (run.status === 'completed') completedStages.push(name);
      }
    }

    const activeWorkflow = {
      session: session.sessionId,
      startedAt: session.startedAt,
      currentStage: session.currentStage,
      completedStages,
      requirement: session.requirement || '',
      requirementFingerprint: session.requirementFingerprint || '',
      ttlExpiry: session.ttlExpiry || null,
      stageStartTime: this._extractStageStartTime(session),
    };

    const result = { activeWorkflow };

    if (session.recovery) {
      result.recoveryState = session.recovery.resumeState || null;
      result.blockedReason = session.recovery.blockedReason || null;
    }

    if (session.recovery && session.recovery.pendingRetry) {
      result.pendingRetry = {
        stage: session.recovery.nextRetryStage || session.currentStage,
        retryCount: session.recovery.nextRetryAttempt || 1,
        questions: session.recovery.questions || [],
        blindSpots: session.recovery.blindSpots || [],
        artifactHash: session.recovery.artifactHash || '',
      };
    }

    return result;
  }

  _extractStageStartTime(session) {
    if (!session.stages || !session.currentStage) return null;
    const current = session.stages[session.currentStage];
    return current ? current.startedAt || null : null;
  }

  /**
   * @deprecated Use EventStore query directly instead of projection.
   * Produces a health-trace array from StateManager session + EventStore events.
   */
  projectHealthTrace(sessionId) {
    const entries = [];
    const session = this._stateManager.loadSession(sessionId);
    if (!session) return entries;

    this._appendStageTraceEntries(entries, session);
    this._appendRecoveryTraceEntries(entries, session);
    this._appendEventStoreTraceEntries(entries, sessionId);

    entries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    return entries;
  }

  _projectArtifacts(session) {
    const stageKeyMap = {
      ANALYSE: 'requirementMd',
      ARCHITECT: 'architectureMd',
      CODE: 'codeDiff',
      TEST: 'testReportMd',
    };
    const artifacts = {};
    if (session.stages) {
      for (const [stage, run] of Object.entries(session.stages)) {
        const key = stageKeyMap[stage];
        if (key && run.outputRefs && run.outputRefs.length > 0) {
          artifacts[key] = run.outputRefs[0].path || run.outputRefs[0];
        }
      }
    }
    return artifacts;
  }

  _projectHistory(session) {
    const history = [];
    if (session.stages) {
      for (const [stage, run] of Object.entries(session.stages)) {
        if (run.startedAt) {
          history.push({
            fromState: null,
            toState: stage,
            timestamp: run.startedAt,
            artifactPath: null,
            note: '',
          });
        }
      }
    }
    return history;
  }

  _projectRisks(session) {
    if (session.recovery && session.recovery.lastRollback) {
      return [{ reason: session.recovery.lastRollback.reason || session.recovery.lastRollback.info || '' }];
    }
    return [];
  }

  _projectRecoveryMeta(session) {
    if (!session.recovery) return { resumeState: null, blockedReason: null, pendingCompensationCount: 0 };
    return {
      resumeState: session.recovery.resumeState || null,
      blockedReason: session.recovery.blockedReason || null,
      pendingCompensationCount: session.recovery.pendingCompensationCount || 0,
    };
  }

  _appendStageTraceEntries(entries, session) {
    if (!session.stages) return;
    for (const [stage, run] of Object.entries(session.stages)) {
      if (run.startedAt) {
        entries.push({ event: 'stage_start', stage, timestamp: run.startedAt, sessionId: session.sessionId });
      }
      if (run.completedAt) {
        entries.push({ event: 'stage_end', stage, timestamp: run.completedAt, sessionId: session.sessionId, status: run.status });
      }
      if (run.error) {
        entries.push({ event: 'stage_error', stage, timestamp: run.completedAt || run.startedAt, sessionId: session.sessionId, error: run.error });
      }
    }
  }

  _appendRecoveryTraceEntries(entries, session) {
    if (session.recovery && session.recovery.lastRollback) {
      entries.push({
        event: 'rollback',
        timestamp: session.recovery.lastRollback.rolledBackAt || session.updatedAt,
        sessionId: session.sessionId,
        fromStage: session.recovery.lastRollback.stage,
        toStage: null,
        reason: session.recovery.lastRollback.info || '',
      });
    }
  }

  _appendEventStoreTraceEntries(entries, sessionId) {
    if (!this._eventStore) return;
    try {
      const events = this._eventStore.query({ sessionId, limit: 500 });
      for (const ev of events) {
        if (ev.kind === 'stage_started' || ev.kind === 'stage_completed' || ev.kind === 'stage_failed'
          || ev.kind === 'workflow.resume.inspected' || ev.kind === 'workflow.resume.planned'
          || ev.kind === 'workflow.resume.started' || ev.kind === 'workflow.resume.completed'
          || ev.kind === 'workflow.resume.blocked'
          || ev.kind === 'workflow.compensation.registered' || ev.kind === 'workflow.compensation.executed'
          || ev.kind === 'workflow.compensation.failed' || ev.kind === 'workflow.compensation.skipped') {
          const mapped = this._mapEventStoreEntry(ev, sessionId);
          const tsNorm = (mapped.timestamp || '').replace(/\.\d{3}Z$/, 'Z');
          if (!entries.some(e => {
            const eTsNorm = (e.timestamp || '').replace(/\.\d{3}Z$/, 'Z');
            return eTsNorm === tsNorm && e.event === mapped.event && e.stage === mapped.stage;
          })) {
            entries.push(mapped);
          }
        }
      }
    } catch (_) { /* EventStore unavailable — session-derived entries suffice */ }
  }

  _mapEventStoreEntry(ev, sessionId) {
    const kindToEvent = {
      stage_started: 'stage_start',
      stage_completed: 'stage_end',
      stage_failed: 'stage_error',
      'workflow.resume.inspected': 'resume_inspected',
      'workflow.resume.planned': 'resume_planned',
      'workflow.resume.started': 'resume_started',
      'workflow.resume.completed': 'resume_completed',
      'workflow.resume.blocked': 'resume_blocked',
      'workflow.compensation.registered': 'compensation_registered',
      'workflow.compensation.executed': 'compensation_executed',
      'workflow.compensation.failed': 'compensation_failed',
      'workflow.compensation.skipped': 'compensation_skipped',
    };
    return {
      event: kindToEvent[ev.kind] || ev.kind,
      stage: ev.stage || null,
      timestamp: ev.ts,
      sessionId,
      ...(ev.payload || {}),
    };
  }
}

module.exports = { IRuntimeProjector, RuntimeProjector, RUNTIME_PROJECTOR_METHODS };
