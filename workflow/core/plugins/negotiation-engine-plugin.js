'use strict';

/**
 * Negotiation Engine Plugin — Declarative lifecycle integration
 *
 * Phase 4 of Lifecycle Plugin Registry migration.
 * Replaces the hand-coded integration in index.js (constructor + SafeProxy)
 * and orchestrator-init.js (Step 8 reset).
 *
 * Key integration: subscribes to HOOK_EVENTS.NEGOTIATE_REQUEST via the
 * plugin hook system. When a downstream agent discovers an incompatibility
 * with an upstream artifact, it emits NEGOTIATE_REQUEST → this plugin
 * automatically calls NegotiationEngine.negotiate() and emits
 * NEGOTIATE_RESPONSE with the resolution.
 *
 * Verified API (2026-04-11):
 *   - Constructor: { outputDir, maxRounds }
 *   - negotiate(request) → { resolution, action, detail }
 *   - getLog() → Array<NegotiationLogEntry>
 *   - getInterfaceMismatchCount() → number
 *   - flush() — persists negotiation log to disk
 *   - reset() — clears round counters for a new workflow run
 *
 * Dual-mode compliance (ADR-37):
 *   - Node Orchestrator: auto-discovered from core/plugins/ by LifecyclePluginRegistry
 *   - IDE Agent (Bridge): available via 'negotiate' subcommand
 */

const { LifecyclePlugin, PluginPriority, PluginPhase } = require('../lifecycle-plugin-registry');

module.exports = new LifecyclePlugin({
  name: 'negotiation-engine',
  phase: PluginPhase.BOTH,
  hooks: ['negotiate_request'],
  priority: PluginPriority.HIGH,
  description: 'Inter-agent negotiation to reduce wasteful rollbacks — auto-responds to NEGOTIATE_REQUEST hook events',

  async activate(orch) {
    const { NegotiationEngine } = require('../negotiation-engine');

    const engine = new NegotiationEngine({
      outputDir: orch._outputDir,
      maxRounds: 2,
    });

    // Reset round counters for a fresh workflow run
    engine.reset();

    // Register into orchestrator for backward compatibility
    // Stage runners and other modules may access orch.negotiation directly
    orch.negotiation = engine;

    // Also register into ServiceContainer for dependency injection
    if (orch.services && typeof orch.services.registerValue === 'function') {
      orch.services.registerValue('negotiation', engine);
    }

    // Store orch reference for onStage/deactivate callbacks
    this._orch = orch;

    console.log(`[Plugin:ne] 🤝 NegotiationEngine activated (maxRounds=${engine._maxRounds})`);

    return engine;
  },

  /**
   * Hook event handler: responds to NEGOTIATE_REQUEST events.
   * When a downstream agent raises a concern about an upstream artifact,
   * this automatically invokes NegotiationEngine.negotiate() and emits
   * the NEGOTIATE_RESPONSE event with the resolution.
   *
   * Expected payload from hook emitter:
   *   { from, to, concernType, description, suggestion?, context? }
   *
   * Where:
   *   - from: downstream stage name (e.g. 'CODE')
   *   - to: upstream stage name (e.g. 'ARCHITECT')
   *   - concernType: one of ConcernType values
   *   - description: human-readable description of the concern
   *   - suggestion: optional proposed resolution
   *   - context: optional additional context (file paths, line numbers, etc.)
   */
  async onStage(event, payload) {
    if (event !== 'negotiate_request') return;

    const orch = this._orch;
    const engine = orch?.negotiation;
    if (!engine || typeof engine.negotiate !== 'function') return;

    // Extract negotiation request from hook event payload
    const request = payload?.request || payload;
    if (!request?.from && !request?.fromStage) return;

    try {
      const result = engine.negotiate({
        fromStage:  request.fromStage || request.from,
        toStage:    request.toStage || request.to,
        concernType: request.concernType,
        description: request.description,
        suggestion:  request.suggestion,
        context:     request.context,
      });

      // Emit response event so other modules can react
      if (orch?.hooks && typeof orch.hooks.emit === 'function') {
        orch.hooks.emit('negotiate_response', {
          fromStage:  request.fromStage || request.from,
          toStage:    request.toStage || request.to,
          resolution: result.resolution,
          action:     result.action,
          detail:     result.detail,
        });
      }

      // Record negotiation outcome as experience for future routing
      if (result.resolution !== 'auto_approve' && orch?.experienceStore) {
        const isNegative = result.action === 'rollback_upstream' || result.action === 'escalate';
        orch.experienceStore.recordIfAbsent(
          `negotiation:${(request.fromStage || request.from)}->${(request.toStage || request.to)}:${request.concernType}:${Date.now()}`,
          {
            type: isNegative ? 'negative' : 'positive',
            category: 'negotiation',
            title: `Negotiation: ${request.concernType} from ${(request.fromStage || request.from)} to ${(request.toStage || request.to)}`,
            content: `Resolution: ${result.resolution}. Action: ${result.action}. Detail: ${result.detail}. Description: ${request.description}`,
            tags: ['negotiation', request.concernType, `from:${request.fromStage || request.from}`, `to:${request.toStage || request.to}`],
            ttlDays: 90,
          }
        );
      }

      console.log(`[Plugin:ne] 🤝 Negotiation resolved: ${result.resolution} → ${result.action}`);
    } catch (err) {
      console.warn(`[Plugin:ne] ⚠️  Negotiation failed (non-fatal): ${err.message}`);
    }
  },

  async deactivate(orch) {
    const engine = (orch || this._orch)?.negotiation;
    if (!engine) return;

    // Persist negotiation log to disk before teardown
    try {
      engine.flush();
    } catch (err) {
      console.warn(`[Plugin:ne] ⚠️  Flush failed (non-fatal): ${err.message}`);
    }

    // Log negotiation summary
    const log = engine.getLog();
    if (log.length > 0) {
      console.log(`[Plugin:ne] 📋 ${log.length} negotiation(s) this session:`);
      for (const entry of log.slice(0, 10)) {
        console.log(`  → ${entry.fromStage}->${entry.toStage} R${entry.round}: ${entry.result?.resolution || 'unknown'}`);
      }
    }

    // Log interface mismatch optimization trigger status
    const mismatchCount = engine.getInterfaceMismatchCount();
    if (mismatchCount > 0) {
      console.log(`[Plugin:ne] 📊 Interface mismatch count: ${mismatchCount}`);
    }
  },

  bridge: {
    subcommand: 'negotiate',
    handler: async (args) => {
      const { from, to, concernType, description, suggestion } = args;

      if (!from || !to || !concernType || !description) {
        return {
          success: false,
          subcommand: 'negotiate',
          error: 'Missing required parameters: from, to, concernType, description',
        };
      }

      try {
        const { NegotiationEngine, ConcernType } = require('../negotiation-engine');
        const engine = new NegotiationEngine({ outputDir: args.outputDir || './output' });

        const result = engine.negotiate({
          fromStage: from,
          toStage: to,
          concernType,
          description,
          suggestion: suggestion || undefined,
        });

        return {
          success: true,
          subcommand: 'negotiate',
          data: {
            resolution: result.resolution,
            action: result.action,
            detail: result.detail,
          },
        };
      } catch (err) {
        return {
          success: false,
          subcommand: 'negotiate',
          error: err.message,
        };
      }
    },
  },
});
