/**
 * MCP Handlers - Quality & Audit Tools
 * Extracted from mcp-server.js (Step 2 Refactoring)
 *
 * Handlers: workflow_quality_check, workflow_quality_gate,
 *           workflow_deep_audit, workflow_rollback_check,
 *           workflow_quality_gate_validate_stage, workflow_quality_gate_diagnostics
 */

'use strict';

function createQualityHandlers(server) {
  return {
    async _handleQualityCheck(args) {
      const projectPath = args.projectPath || server._projectRoot;
      const files = args.files;

      try {
const { runQualityCheck } = require('../../../tools/ide-workflow-bridge');
        const result = await runQualityCheck({ projectRoot: projectPath, files });

        if (result.success) {
          const violations = result.violations || [];
          if (violations.length === 0) {
            return server._toolResponse(`✅ **Quality Check Passed**\n\nAll checks passed for ${(result.filesChecked || []).length} file(s).`);
          }

          return server._toolResponse(
            `⚠️ **Quality Check: ${violations.length} Violation(s)**\n\n` +
            `**Files Checked**: ${(result.filesChecked || []).join(', ') || 'N/A'}\n\n` +
            violations.map((v, i) =>
              `**${i + 1}. [${v.severity?.toUpperCase()}] ${v.rule}**\n- File: ${v.file}\n- Message: ${v.message}`
            ).join('\n\n')
          );
        }
        return server._toolResponse(`❌ **Quality Check Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Quality Check Error**: ${err.message}`, true);
      }
    },

    async _handleQualityGate(args) {
      const projectPath = args.projectPath || server._projectRoot;
      const stage = args.stage;

      try {
const { runQualityGate } = require('../../../tools/ide-workflow-bridge');
        const result = await runQualityGate({ projectRoot: projectPath, stage });

        if (result.success) {
          const checks = result.checks || [];
          const failed = checks.filter(c => !c.passed);

          if (failed.length === 0) {
            return server._toolResponse(
              `✅ **Quality Gate Passed**\n\n**Stage**: ${result.stage || 'N/A'}\n` +
              `**All ${checks.length} Checks**: PASSED`
            );
          }

          return server._toolResponse(
            `❌ **Quality Gate Failed** (${failed.length}/${checks.length})\n\n` +
            `**Stage**: ${result.stage || 'N/A'}\n\n` +
            failed.map(c => `- **${c.name}**: ${c.message} (threshold: ${c.threshold}, actual: ${c.actual})`).join('\n')
          );
        }
        return server._toolResponse(`❌ **Quality Gate Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Quality Gate Error**: ${err.message}`, true);
      }
    },

    async _handleDeepAudit(args) {
      const projectPath = args.projectPath || server._projectRoot;
      const format = args.format || 'markdown';

      try {
const { runDeepAudit } = require('../../../tools/ide-workflow-bridge');
        const result = await runDeepAudit({ projectRoot: projectPath, format });

        if (result.success) {
          if (format === 'json') {
            return server._toolResponse(`\`\`\`json\n${JSON.stringify(result.dimensions, null, 2)}\n\`\`\``);
          }

          return server._toolResponse(
            `🔍 **Deep Audit Results**\n\n` +
            (result.summary ? `**Overall**: ${result.summary}\n\n` : '') +
            Object.entries(result.dimensions || {}).map(([dim, data]) => {
              const status = data.score >= 80 ? '✅' : data.score >= 60 ? '⚠️' : '❌';
              return `${status} **${dim}**: ${data.score}/100 (${data.status})`;
            }).join('\n')
          );
        }
        return server._toolResponse(`❌ **Audit Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Audit Error**: ${err.message}`, true);
      }
    },

    async _handleRollbackCheck(args) {
      const { stage } = args;
      const projectPath = args.projectPath || server._projectRoot;

      if (!stage) {
        return server._toolResponse('Error: stage is required', true);
      }

      try {
const { runRollbackCheck } = require('../../../tools/ide-workflow-bridge');
        const result = await runRollbackCheck({ projectRoot: projectPath, stage });

        if (result.success) {
          const blocking = result.contractViolations?.filter(v => v.severity === 'blocking') || [];
          const warnings = result.contractViolations?.filter(v => v.severity === 'warning') || [];

          if (blocking.length === 0 && warnings.length === 0) {
            return server._toolResponse(`✅ **Rollback Check Passed**\n\nStage ${stage} outputs are compatible with downstream inputs.`);
          }

          return server._toolResponse(
            `${blocking.length > 0 ? '❌' : '⚠️'} **Rollback Check Issues**\n\n` +
            `**Blocking**: ${blocking.length}\n**Warnings**: ${warnings.length}\n\n` +
            blocking.map(v => `🚫 **${v.rule}**: ${v.message}`).join('\n') + '\n' +
            warnings.map(v => `⚠️ **${v.rule}**: ${v.message}`).join('\n')
          );
        }
        return server._toolResponse(`❌ **Rollback Check Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Rollback Check Error**: ${err.message}`, true);
      }
    },

    async _handleQualityGateValidateStage(args) {
      const { stage } = args;
      if (!stage) {
        return server._toolResponse('Error: stage parameter is required', true);
      }

      const validStages = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST'];
      if (!validStages.includes(stage)) {
        return server._toolResponse(
          `Error: Invalid stage "${stage}". Valid stages: ${validStages.join(', ')}`, true
        );
      }

      const targetRoot = args.projectPath || server._projectRoot;

      try {
const { QualityGate } = require('../../quality-gate');
        const metrics = {
          errors: { count: args.errorCount || 0 },
          totalDurationMs: args.durationMs || 0,
          llm: { totalCalls: args.llmCalls || 0 },
          projectRoot: targetRoot,
        };

        const gate = new QualityGate({ recordIssue: (opts) => ({ ...opts, timestamp: new Date().toISOString() }) });
        const result = gate.validateStage(stage, metrics);

        const gateResults = result.gates.map(g => `${g.passed ? '✅' : '❌'} **${g.name}**: ${g.message}`).join('\n');

        return server._toolResponse(
          `## Quality Gate: Stage Validation (${stage})\n\n` +
          `**Overall**: ${result.passed ? '✅ PASSED' : '❌ FAILED'}\n**Mode**: ${result.mode || 'default'}\n\n` +
          `**Gate Results**:\n${gateResults}\n\n` +
          `\`\`\`json\n${JSON.stringify({ stage, passed: result.passed, mode: result.mode, gates: result.gates.map(g => ({ name: g.name, passed: g.passed, actual: g.actual, threshold: g.threshold, message: g.message })) }, null, 2)}\n\`\`\``
        );
      } catch (err) {
        return server._toolResponse(`Error: ${err.message}`, true);
      }
    },

    async _handleQualityGateDiagnostics(args) {
      const targetRoot = args.projectPath || server._projectRoot;
      const clear = args.clear || false;

      try {
const { QualityGate } = require('../../quality-gate');
        const gate = new QualityGate({ recordIssue: () => {} });
        const diagnostics = gate.exportDiagnostics ? gate.exportDiagnostics() : { mode: 'default', stats: { totalRuns: 0, passedRuns: 0, failedRuns: 0 }, history: [], failureRate: 0 };

        if (clear && gate.clearDiagnosticHistory) {
          gate.clearDiagnosticHistory();
        }

        const summary = diagnostics.stats || {};
        const historyPreview = (diagnostics.history || []).slice(-5).map(h =>
          `- ${h.timestamp}: ${h.passed ? '✅' : '❌'} (${h.validationType})`
        ).join('\n') || 'No history available';

        return server._toolResponse(
          `## Quality Gate Diagnostics\n\n**Mode**: ${diagnostics.mode || 'default'}\n` +
          `**Total Runs**: ${summary.totalRuns || 0}\n**Passed**: ${summary.passedRuns || 0} | **Failed**: ${summary.failedRuns || 0}\n` +
          `**Failure Rate**: ${(diagnostics.failureRate * 100 || 0).toFixed(1)}%\n\n` +
          `**Recent History**:\n${historyPreview}\n\n${clear ? '✅ History cleared\n\n' : ''}` +
          `\`\`\`json\n${JSON.stringify(diagnostics, null, 2)}\n\`\`\``
        );
      } catch (err) {
        return server._toolResponse(`Error: ${err.message}`, true);
      }
    },
  };
}

module.exports = { createQualityHandlers };
