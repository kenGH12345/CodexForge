/**
 * Experience Event Handlers – Event-Driven Module Integration
 *
 * Central registry for all event handlers that wire up the experience library modules
 * in a decoupled, event-driven manner.
 *
 * Handlers:
 *   - Experience Recording → Pattern Detection, Evolution Triggering
 *   - Capacity Warnings → Auto-Distillation
 *   - Pattern Detection → ADR Generation, Refactoring Recommendations
 *   - Experience Evolution → Skill Updates
 *
 * Usage:
 *   const { registerExperienceEventHandlers } = require('./experience-event-handlers');
 *   registerExperienceEventHandlers(experienceStore, skillEvolution);
 *
 * @module experience-event-handlers
 */

'use strict';

const { getGlobalEventBus, ExperienceEvents, HandlerPriority } = require('./experience-event-bus');

/**
 * Register all event handlers for the experience library
 *
 * @param {ExperienceStore} store – Experience store instance
 * @param {SkillEvolution} [skillEvolution] – Optional skill evolution instance
 * @param {object} [options] – Handler options
 * @returns {Function} Unregister all handlers function
 */
function registerExperienceEventHandlers(store, skillEvolution = null, options = {}) {
  const eventBus = getGlobalEventBus();
  const unregisters = [];

  // ─── Handler 1: Auto-Distillation on Capacity Warning ────────────────────
  // Replaces: Direct call in knowledge-pipeline.js orchestration loop
  const distillationHandler = async ({ count, threshold, ratio }) => {
    if (ratio >= 0.8) {
      console.log(`[EventHandlers] Auto-distillation triggered by capacity warning (${count}/${threshold})`);
      try {
        const result = await store.distill();
        if (result.merged > 0 || result.removed > 0) {
          // Publish distillation completion event
          eventBus.emit(ExperienceEvents.EXPERIENCE_DISTILLED, {
            ...result,
            trigger: 'capacity_warning',
            beforeCount: count,
            afterCount: store.experiences.length,
          });
        }
      } catch (err) {
        console.error(`[EventHandlers] Auto-distillation failed: ${err.message}`);
      }
    }
  };
  unregisters.push(
    eventBus.on(ExperienceEvents.CAPACITY_WARNING, distillationHandler, { priority: HandlerPriority.NORMAL })
  );

  // ─── Handler 2: Pattern Detection → Recommendations ──────────────────────
  // Replaces: Direct ADR generation call in experience-abstraction-mixin
  const patternHandler = async ({ patternId, patternName, experience, severity, recommendations }) => {
    // High-severity patterns trigger immediate ADR consideration
    if (severity === 'high' && store._abstractionEngine) {
      console.log(`[EventHandlers] High-severity pattern "${patternName}" detected, triggering recommendation`);
      try {
        const trend = store._abstractionEngine.analyzer.getPatternTrend(patternId);
        const result = store._abstractionEngine.recommender.processTriggeredPattern(
          { patternId, patternName, severity, recommendations },
          trend
        );

        if (result && result.adr) {
          eventBus.emit(ExperienceEvents.PATTERN_EVOLVED, {
            patternId,
            adrId: result.adr.id,
            adrTitle: result.adr.title,
            experienceId: experience.id,
          });
        }
      } catch (err) {
        console.error(`[EventHandlers] Pattern recommendation failed: ${err.message}`);
      }
    }
  };
  unregisters.push(
    eventBus.on(ExperienceEvents.PATTERN_TRIGGERED, patternHandler, { priority: HandlerPriority.LOW })
  );

  // ─── Handler 3: Experience Recording → Evolution Triggering ──────────────
  // Replaces: Direct evolve() calls in orchestrator-teardown-impl.js and skill-enrichment.js
  // Removed: evolutionHandler was incorrectly listening to EXPERIENCE_RETRIEVED and bypassing QualityGate.
  // Evolution is now strictly handled in stage-runner-utils.js via runEvoMapFeedback.

  // ─── Handler 4: Conflict Detection Logging ──────────────────────────────
  const conflictHandler = ({ older, newer, reason }) => {
    console.log(`[EventHandlers] ⚠️ Experience conflict detected: "${older.title}" vs "${newer.title}"`);
    // Could trigger: notifications, quality metrics, manual review queue
  };
  unregisters.push(
    eventBus.on(ExperienceEvents.EXPERIENCE_CONFLICT, conflictHandler, { priority: HandlerPriority.LOW })
  );

  // ─── Handler 5: Distillation Tracking ───────────────────────────────────
  const distilledHandler = ({ merged, removed, conflicts, trigger }) => {
    console.log(`[EventHandlers] ✓ Experiences distilled: ${merged} merged, ${removed} removed (trigger: ${trigger})`);
    // Could trigger: analytics, reporting, health metrics updates
  };
  unregisters.push(
    eventBus.on(ExperienceEvents.EXPERIENCE_DISTILLED, distilledHandler, { priority: HandlerPriority.BACKGROUND })
  );

  // ─── Handler 6: Pattern Evolution Tracking ──────────────────────────────
  const patternEvolvedHandler = ({ patternId, adrId, adrTitle }) => {
    console.log(`[EventHandlers] 📋 Pattern evolved: ${patternId} → ADR ${adrId}`);
  };
  unregisters.push(
    eventBus.on(ExperienceEvents.PATTERN_EVOLVED, patternEvolvedHandler, { priority: HandlerPriority.BACKGROUND })
  );

  // ─── Handler 7: Quality Gate Pass → Reset Trigger Counters ──────────────
  // When a quality gate passes, emit event for SkillEvolutionTriggers to
  // run degradation and staleness checks (piggyback on end-of-run signal).
  const gatePassHandler = (data) => {
    // SkillEvolutionTriggers listens to QUALITY_GATE_PASSED directly
    // This handler just logs for observability
    if (data && data.gateCount) {
      console.log(`[EventHandlers] ✅ Quality gates passed (${data.gateCount} gates)`);
    }
  };
  unregisters.push(
    eventBus.on(ExperienceEvents.QUALITY_GATE_PASSED, gatePassHandler, { priority: HandlerPriority.BACKGROUND })
  );

  // ─── Handler 8: Quality Gate Failure → Trigger Skill Evolution ──────────
  // When a quality gate fails, emit enriched event with injected skill names
  // so SkillEvolutionTriggers can identify which skills may need updating.
  const gateFailHandler = (data) => {
    if (data && data.gateName) {
      console.log(`[EventHandlers] ❌ Quality gate failed: ${data.gateName}`);
    }
  };
  unregisters.push(
    eventBus.on(ExperienceEvents.QUALITY_GATE_FAILED, gateFailHandler, { priority: HandlerPriority.BACKGROUND })
  );

  console.log(`[EventHandlers] Registered ${unregisters.length} event handlers`);

  // Return function to unregister all handlers
  return () => {
    unregisters.forEach(unregister => unregister());
    console.log('[EventHandlers] All event handlers unregistered');
  };
}

/**
 * Register minimal handlers for testing environments
 */
function registerMinimalHandlers(store) {
  const eventBus = getGlobalEventBus();
  const unregisters = [];

  // Only register capacity-based distillation
  unregisters.push(
    eventBus.on(ExperienceEvents.CAPACITY_WARNING, async ({ ratio }) => {
      if (ratio >= 0.9) {
        await store.distill();
      }
    })
  );

  return () => unregisters.forEach(u => u());
}

/**
 * Debug helper: Log all events to console
 */
function enableEventDebugging() {
  const eventBus = getGlobalEventBus();
  return eventBus.onAny((eventType, data) => {
    console.log(`[EventDebug] ${eventType}:`, JSON.stringify(data, null, 2).slice(0, 200) + '...');
  });
}

module.exports = {
  registerExperienceEventHandlers,
  registerMinimalHandlers,
  enableEventDebugging,
};
