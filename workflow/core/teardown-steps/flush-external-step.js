'use strict';

/**
 * Step: Flush External Systems (Negotiation, ExperienceRouter, EventJournal, P0Runtime, Logger)
 *
 * Flush and close all external-facing systems.
 *
 * Priority: 50
 * After: dryrun-lock
 */

const { TeardownStep } = require('../teardown-step');
const path = require('path');

class FlushExternalStep extends TeardownStep {
  constructor() {
    super({
      name: 'flush-external',
      description: 'Flush NegotiationEngine, ExperienceRouter, EventJournal, P0Runtime, Logger',
      priority: 50,
      after: ['dryrun-lock'],
    });
  }

  async execute(ctx) {
    const { orch, mode } = ctx;

    // NegotiationEngine flush
    if (orch.negotiation) {
      try {
        const negLog = orch.negotiation.getLog();
        if (negLog.length > 0) {
          orch.negotiation.flush();
          console.log(`[Orchestrator] 🤝 NegotiationEngine: ${negLog.length} negotiation(s) persisted.`);
        }
      } catch (negErr) {
        console.warn(`[Orchestrator] ⚠️  NegotiationEngine flush failed (non-fatal): ${negErr.message}`);
      }
    }

    // ExperienceRouter publish
    if (orch.experienceRouter) {
      try {
        const pubResult = orch.experienceRouter.publish();
        if (pubResult.published > 0) {
          console.log(`[Orchestrator] 🌐 ExperienceRouter: published ${pubResult.published} experience(s) to cross-project registry.`);
        }
      } catch (pubErr) {
        console.warn(`[Orchestrator] ⚠️  ExperienceRouter publish failed (non-fatal): ${pubErr.message}`);
      }
    }

    // EventJournal flush and close
    if (orch.eventJournal) {
      try {
        await orch.eventJournal.close();
        const stats = orch.eventJournal.getStats();
        console.log(`[Orchestrator] 📖 EventJournal: ${stats.totalEvents} events captured in ${path.basename(orch.eventJournal.journalPath)}`);
      } catch (ejErr) {
        console.warn(`[Orchestrator] ⚠️  EventJournal close failed (non-fatal): ${ejErr.message}`);
      }
    }

    // P0 runtime loop finalization
    if (orch.p0RuntimeLoop) {
      try {
        const cacheResult = orch.p0RuntimeLoop.refreshMetricsCache();
        orch.p0RuntimeLoop.markWorkflowEnd({
          mode,
          metricsCacheHit: cacheResult.hit,
        });
        orch.p0RuntimeLoop.detachEventJournal();
      } catch (p0Err) {
        console.warn(`[Orchestrator] ⚠️  P0 runtime loop finalization failed (non-fatal): ${p0Err.message}`);
      }
    }

    // Structured Logger flush and close
    if (orch.logger) {
      try {
        orch.logger.info('Orchestrator', 'Workflow finalisation complete', {
          mode,
          projectId: orch.projectId,
        });
        const entryCount = orch.logger.flush();
        if (entryCount > 0) {
          console.log(`[Orchestrator] 📝 Structured Logger: ${entryCount} log entries written to workflow.log.jsonl`);
        }
      } catch (logErr) {
        console.warn(`[Orchestrator] ⚠️  Logger flush failed (non-fatal): ${logErr.message}`);
      }
    }
  }
}

module.exports = { FlushExternalStep };
