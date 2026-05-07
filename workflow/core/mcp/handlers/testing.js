'use strict';

function createTestingHandlers(server) {
  return {
    async _handleTestExecute(args) {
      const projectPath = args.projectPath || server._projectRoot;
      const { pattern, testProfile, testSuites, testFiles } = args;
      const watch = args.watch || false;

      try {
        const { runTestExecute } = require('../../tools/ide-workflow-bridge');
        const result = await runTestExecute({
          projectRoot: projectPath, pattern, watch, testProfile, testSuites, testFiles,
        });

        if (result.success) {
          return server._toolResponse(
            `🧪 **Test Execution Results**\n\n` +
            `**Framework**: ${result.framework || 'auto-detected'}\n` +
            `**Tests**: ${result.testCount || 'N/A'}\n` +
            `**Failures**: ${result.failures || 0}\n` +
            `**Duration**: ${result.duration || 'N/A'}\n\n` +
            (result.output ? `\`\`\`\n${result.output.slice(-2000)}\n\`\`\`` : '')
          );
        }
        return server._toolResponse(
          `❌ **Tests Failed**\n\n` +
          `**Exit Code**: ${result.exitCode}\n\n` +
          (result.output ? `\`\`\`\n${result.output.slice(-2000)}\n\`\`\`` : result.error),
          true
        );
      } catch (err) {
        return server._toolResponse(`❌ **Test Execution Error**: ${err.message}`, true);
      }
    },

    async _handleStalenessCheck(args) {
      const projectPath = args.projectPath || server._projectRoot;

      try {
        const { runStalenessCheck } = require('../../tools/ide-workflow-bridge');
        const result = await runStalenessCheck({ projectRoot: projectPath });

        if (result.success) {
          if (!result.isStale) {
            return server._toolResponse(`✅ **No Staleness Issues**\n\nAll artifacts are up to date.`);
          }
          return server._toolResponse(
            `⚠️ **Staleness Warnings** (${result.warnings?.length || 0})\n\n` +
            (result.warnings || []).map(w => `- **${w.type}**: ${w.message}`).join('\n') + '\n\n' +
            `Run \`workflow_init\` to refresh stale artifacts.`
          );
        }
        return server._toolResponse(`❌ **Staleness Check Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Staleness Check Error**: ${err.message}`, true);
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
          `Error: Invalid stage "${stage}". Valid stages: ${validStages.join(', ')}`,
          true
        );
      }

      const targetRoot = args.projectPath || server._projectRoot;

      try {
        const { QualityGate } = require('../quality-gate');
        const metrics = {
          errors: { count: args.errorCount || 0 },
          totalDurationMs: args.durationMs || 0,
          llm: { totalCalls: args.llmCalls || 0 },
          projectRoot: targetRoot,
        };

        const gate = new QualityGate({
          recordIssue: (opts) => ({ ...opts, timestamp: new Date().toISOString() }),
        });

        const result = gate.validateStage(stage, metrics);

        const gateResults = result.gates.map(g =>
          `${g.passed ? '✅' : '❌'} **${g.name}**: ${g.message}`
        ).join('\n');

        return server._toolResponse(
          `## Quality Gate: Stage Validation (${stage})\n\n` +
          `**Overall**: ${result.passed ? '✅ PASSED' : '❌ FAILED'}\n` +
          `**Mode**: ${result.mode || 'default'}\n\n` +
          `**Gate Results**:\n${gateResults}\n\n` +
          `\`\`\`json\n${JSON.stringify({
            stage, passed: result.passed, mode: result.mode,
            gates: result.gates.map(g => ({
              name: g.name, passed: g.passed, actual: g.actual,
              threshold: g.threshold, message: g.message,
            })),
          }, null, 2)}\n\`\`\``
        );
      } catch (err) {
        return server._toolResponse(`Error: ${err.message}`, true);
      }
    },

    async _handleQualityGateDiagnostics(args) {
      const targetRoot = args.projectPath || server._projectRoot;
      const clear = args.clear || false;

      try {
        const { QualityGate } = require('../quality-gate');
        const gate = new QualityGate({ recordIssue: () => {} });

        const diagnostics = gate.exportDiagnostics ? gate.exportDiagnostics() : {
          mode: 'default',
          stats: { totalRuns: 0, passedRuns: 0, failedRuns: 0 },
          history: [],
          failureRate: 0,
        };

        if (clear && gate.clearDiagnosticHistory) {
          gate.clearDiagnosticHistory();
        }

        const summary = diagnostics.stats || {};
        const historyPreview = (diagnostics.history || []).slice(-5).map(h =>
          `- ${h.timestamp}: ${h.passed ? '✅' : '❌'} (${h.validationType})`
        ).join('\n') || 'No history available';

        return server._toolResponse(
          `## Quality Gate Diagnostics\n\n` +
          `**Mode**: ${diagnostics.mode || 'default'}\n` +
          `**Total Runs**: ${summary.totalRuns || 0}\n` +
          `**Passed**: ${summary.passedRuns || 0} | **Failed**: ${summary.failedRuns || 0}\n` +
          `**Failure Rate**: ${(diagnostics.failureRate * 100 || 0).toFixed(1)}%\n\n` +
          `**Recent History**:\n${historyPreview}\n\n` +
          `${clear ? '✅ History cleared\n\n' : ''}` +
          `\`\`\`json\n${JSON.stringify(diagnostics, null, 2)}\n\`\`\``
        );
      } catch (err) {
        return server._toolResponse(`Error: ${err.message}`, true);
      }
    },
  };
}

module.exports = { createTestingHandlers };