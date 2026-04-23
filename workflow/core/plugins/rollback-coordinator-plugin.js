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

  // ── T-2: Programmatic validation API for StageCompletionHook integration ──
  validate(input) {
    const fs = require('fs');
    const path = require('path');

    const { stage, projectRoot, outputFile, outputSummary } = input;

    // Map stage to downstream role
    const stageToDownstreamRole = {
      'ANALYSE': 'architect',
      'ARCHITECT': 'planner',
      'PLAN': 'developer',
      'CODE': 'tester',
    };
    const downstreamRole = stageToDownstreamRole[stage];

    // No downstream for TEST or unknown stages
    if (!downstreamRole) {
      return {
        passed: true,
        skipped: true,
        message: stage === 'TEST'
          ? 'TEST is the final stage — no downstream contract to validate.'
          : `Unknown stage: "${stage}"`,
      };
    }

    // Default output file mapping
    const stageOutputFiles = {
      'ANALYSE': 'output/analysis.md',
      'ARCHITECT': 'output/architecture.md',
      'PLAN': 'output/execution-plan.md',
      'CODE': 'output/code.diff',
    };
    const actualOutputFile = outputFile
      || path.join(projectRoot || process.cwd(), stageOutputFiles[stage] || '');

    // Downstream contracts (same as bridge handler)
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
          '"tasks"', '"phases"', '"dependencies"', '"moduleGrouping"',
          '## Tasks', '## Phases', '## Dependencies', '# Tasks', '# Phases', '# Dependencies',
          '## 任务', '## 阶段', '## 依赖', '## 任务分解', '## 实施阶段',
          'tasks', 'phases', 'dependencies', 'Tasks', 'Phases', 'Dependencies',
        ],
        minLength: 200,
        description: 'execution-plan.md for DeveloperAgent (via PlannerAgent)',
      },
      tester: {
        requiredSections: [
          '## Test Results', '## Coverage', '## Test', '# Test', 'test results',
          '## 测试结果', '## 覆盖率', '## 测试报告', '## 测试用例', '测试结果', '测试覆盖',
        ],
        minLength: 100,
        description: 'test-report.md for TesterAgent',
      },
    };

    const contract = DOWNSTREAM_CONTRACTS[downstreamRole];
    if (!contract) {
      return {
        passed: true,
        skipped: true,
        message: `No contract defined for downstreamRole="${downstreamRole}"`,
      };
    }

    const failures = [];

    if (!fs.existsSync(actualOutputFile)) {
      failures.push({
        check: 'file-exists',
        detail: `Output file not found: ${actualOutputFile}`,
      });
    } else {
      const content = fs.readFileSync(actualOutputFile, 'utf-8');
      if (content.length < contract.minLength) {
        failures.push({
          check: 'min-length',
          detail: `File is too short (${content.length} chars < ${contract.minLength} required).`,
        });
      }

      // Smart section detection: support both Markdown headings and JSON block fields
      let hasRequiredSection = contract.requiredSections.some(s => content.includes(s));

      // For execution-plan.md, also check JSON block structure
      if (!hasRequiredSection && stage === 'PLAN') {
        try {
          // Extract JSON block (content between ```json and ```)
          // Support both LF and CRLF line endings
          const jsonMatch = content.match(/```json\r?\n([\s\S]*?)\r?\n```/);
          if (jsonMatch) {
            const jsonContent = jsonMatch[1];
            const parsed = JSON.parse(jsonContent);
            // Check for essential execution plan fields
            hasRequiredSection = (
              (parsed.tasks && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) ||
              (parsed.phases && Array.isArray(parsed.phases) && parsed.phases.length > 0) ||
              (parsed.dependencies && Array.isArray(parsed.dependencies))
            );
          }
        } catch (e) {
          // JSON parse failed, rely on string matching only
        }
      }

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
      passed,
      skipped: false,
      stage,
      downstreamRole,
      outputFile: path.relative(projectRoot || process.cwd(), actualOutputFile),
      contractDescription: contract.description,
      failures,
      suggestions: passed ? [] : [
        `Ensure the output file contains one of: ${contract.requiredSections.slice(0, 3).join(', ')}...`,
        `Minimum file length: ${contract.minLength} characters`,
      ],
      metrics: {
        checksRun: failures.length + (passed ? 1 : 0),
        failuresCount: failures.length,
      },
      rollbackRecommendation: passed ? null : {
        shouldRollback: true,
        rollbackTo: rollbackTargets[stage],
        reason: `${stage} output does not satisfy ${downstreamRole}'s input contract: ${failures.map(f => f.detail).join('; ')}`,
        action: rollbackTargets[stage]
          ? `Re-execute the ${rollbackTargets[stage]} stage to produce a valid output for ${downstreamRole}.`
          : `Re-execute the ${stage} stage to produce a valid output.`,
      },
    };
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
            'tasks', 'phases', 'dependencies', 'Tasks', 'Phases', 'Dependencies',
            '## Tasks', '## Phases', '## Dependencies', '# Tasks', '# Phases', '# Dependencies',
            '## 任务', '## 阶段', '## 依赖', '## 任务分解', '## 实施阶段',
            '"tasks"', '"phases"', '"dependencies"', '"moduleGrouping"',
          ],
          minLength: 200,
          description: 'execution-plan.md for DeveloperAgent (via PlannerAgent)',
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

        // Smart section detection: support both Markdown headings and JSON block fields
        let hasRequiredSection = contract.requiredSections.some(s => content.includes(s));

        // For execution-plan.md, also check JSON block structure
        if (!hasRequiredSection && stage === 'PLAN') {
          try {
            // Extract JSON block (content between ```json and ```)
            // Support both LF and CRLF line endings
            const jsonMatch = content.match(/```json\r?\n([\s\S]*?)\r?\n```/);
            if (jsonMatch) {
              const jsonContent = jsonMatch[1];
              const parsed = JSON.parse(jsonContent);
              // Check for essential execution plan fields
              hasRequiredSection = (
                (parsed.tasks && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) ||
                (parsed.phases && Array.isArray(parsed.phases) && parsed.phases.length > 0) ||
                (parsed.dependencies && Array.isArray(parsed.dependencies))
              );
            }
          } catch (e) {
            // JSON parse failed, rely on string matching only
          }
        }

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
