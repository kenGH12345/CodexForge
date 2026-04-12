'use strict';

/**
 * Rollback Coordinator Plugin — Declarative lifecycle integration
 *
 * Phase 3 of Lifecycle Plugin Registry migration.
 * Replaces the hand-coded integration in orchestrator-run.js and stage-*.js.
 *
 * Note: RollbackCoordinator is the most deeply integrated module (6+ files).
 * Unlike other plugins, it's activated during INIT and used across stages.
 * The plugin provides the onStage callback for stage-level rollback integration.
 *
 * Verified API (2026-04-11):
 *   - Constructor: (orchestrator) — takes the full Orchestrator instance
 *   - rollback(fromStage, reason) → Promise<void>
 *   - analyseRollbackStrategy(fromStage, reason, failedSubtask?) → RollbackStrategy
 *   - cacheSubtaskResult(stageName, subtaskName, result)
 *   - invalidateSubtaskCache(stageName)
 *
 * IMPORTANT: Stage runners still directly instantiate RollbackCoordinator
 * because they need stage-scoped instances (with the stage's orchestrator context).
 * This plugin primarily manages the INIT-phase registration and Bridge subcommand.
 * Full stage-level migration is a future enhancement.
 */

const { LifecyclePlugin, PluginPriority, PluginPhase } = require('../lifecycle-plugin-registry');

module.exports = new LifecyclePlugin({
  name: 'rollback-coordinator',
  phase: PluginPhase.BOTH,
  priority: PluginPriority.CRITICAL, // Must run first
  description: 'Unified rollback cleanup for all stages — init-phase service registration and Bridge integration',

  async activate(orch) {
    // Register the RollbackCoordinator constructor so stage runners can
    // instantiate it as needed. We store the class reference, not an instance,
    // because each stage needs its own instance with the current orchestrator state.
    const { RollbackCoordinator } = require('../rollback-coordinator');

    // Make the class available via the plugin instance
    return RollbackCoordinator;
  },

  async onStage(stageName, orch) {
    // Currently a no-op — stage runners instantiate RollbackCoordinator directly.
    // Future: could dispatch stage-level rollback events here.
  },

  async deactivate(orch) {
    // No teardown needed — RollbackCoordinator is stateless between runs
  },

  bridge: {
    subcommand: 'rollback-check',
    handler: async (args) => {
      const fs = require('fs');
      const path = require('path');

      const stage = (args.stage || '').toUpperCase();
      const validStages = ['ANALYSE', 'ARCHITECT', 'PLAN', 'CODE', 'TEST'];

      if (!validStages.includes(stage)) {
        return {
          success: false,
          subcommand: 'rollback-check',
          error: `Invalid stage: "${args.stage}". Valid stages: ${validStages.join(', ')}`,
        };
      }

      // Map stage to downstream role
      const stageToDownstreamRole = {
        'ANALYSE': 'architect',
        'ARCHITECT': 'planner',
        'PLAN': 'developer',
        'CODE': 'tester',
      };
      const downstreamRole = stageToDownstreamRole[stage];
      if (!downstreamRole) {
        return {
          success: true,
          subcommand: 'rollback-check',
          data: {
            stage,
            passed: true,
            message: stage === 'TEST'
              ? 'TEST is the final stage — no downstream contract to validate.'
              : `Unknown stage: "${stage}". Valid stages: ${validStages.join(', ')}`,
          },
        };
      }

      // Output file mapping
      const stageOutputFiles = {
        'ANALYSE': 'output/requirement.md',
        'ARCHITECT': 'output/architecture.md',
        'PLAN': 'output/execution-plan.md',
        'CODE': 'output/code.diff',
      };
      const outputFile = args.files?.[0]
        || path.join(args.projectRoot || process.cwd(), stageOutputFiles[stage] || '');

      // Downstream contracts
      const DOWNSTREAM_CONTRACTS = {
        architect: {
          requiredSections: [
            '## Requirements', '## Functional', '## Feature', '# Requirements', 'requirements',
            '## 需求', '## 功能', '## 功能需求', '## 用户故事', '## 特性', '需求', '功能需求',
          ],
          minLength: 100,
          description: 'requirements.md for ArchitectAgent',
        },
        planner: {
          requiredSections: [
            '## Architecture', '## Component', '## Design', '## System', '# Architecture', 'architecture',
            '## 架构', '## 系统架构', '## 组件', '## 模块', '## 设计', '## 技术栈', '架构设计', '技术栈',
          ],
          minLength: 200,
          description: 'architecture.md for PlannerAgent',
        },
        developer: {
          requiredSections: [
            '## Architecture', '## Component', '## Design', '## System', '# Architecture', 'architecture',
            '## 架构', '## 系统架构', '## 组件', '## 模块', '## 设计', '## 技术栈', '架构设计', '技术栈',
          ],
          minLength: 200,
          description: 'architecture.md for DeveloperAgent (via PlannerAgent)',
        },
        tester: {
          requiredSections: [
            'diff --git', '--- a/', '+++ b/', '@@', '.js', '.ts', '.py',
            '.java', '.go', '.cs', '.lua', '.rb',
          ],
          minLength: 50,
          description: 'code.diff for TesterAgent',
        },
      };

      const contract = DOWNSTREAM_CONTRACTS[downstreamRole];
      if (!contract) {
        return {
          success: true,
          subcommand: 'rollback-check',
          data: { stage, passed: true, message: `No contract defined for downstream role: ${downstreamRole}` },
        };
      }

      const failures = [];

      if (!fs.existsSync(outputFile)) {
        failures.push({
          check: 'file-exists',
          detail: `Output file not found: ${outputFile}`,
        });
      } else {
        const content = fs.readFileSync(outputFile, 'utf-8');
        if (content.length < contract.minLength) {
          failures.push({
            check: 'min-length',
            detail: `File is too short (${content.length} chars < ${contract.minLength} required).`,
          });
        }
        const hasRequiredSection = contract.requiredSections.some(s => content.includes(s));
        if (!hasRequiredSection) {
          failures.push({
            check: 'required-sections',
            detail: `None of the required section headings found. Expected at least one of: ${contract.requiredSections.slice(0, 5).join(', ')}...`,
          });
        }
      }

      const passed = failures.length === 0;
      const rollbackTargets = {
        'ANALYSE': null,
        'ARCHITECT': 'ANALYSE',
        'PLAN': 'ARCHITECT',
        'CODE': 'PLAN',
      };

      return {
        success: true,
        subcommand: 'rollback-check',
        data: {
          stage,
          downstreamRole,
          outputFile: path.relative(args.projectRoot || process.cwd(), outputFile),
          contractDescription: contract.description,
          passed,
          failures,
          rollbackRecommendation: passed ? null : {
            shouldRollback: true,
            rollbackTo: rollbackTargets[stage],
            reason: `${stage} output does not satisfy ${downstreamRole}'s input contract: ${failures.map(f => f.detail).join('; ')}`,
            action: rollbackTargets[stage]
              ? `Re-execute the ${rollbackTargets[stage]} stage to produce a valid output for ${downstreamRole}.`
              : `Re-execute the ${stage} stage to produce a valid output.`,
          },
        },
      };
    },
  },
});
