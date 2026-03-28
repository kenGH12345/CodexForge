/**
 * /validate-execution Command — 执行日志验证命令
 *
 * Purpose: 提供命令行接口来运行执行日志验证并与标准流程对比
 *
 * Usage:
 *   /validate-execution [--output-dir path] [--strict] [--verbose]
 *   /validate-execution --latest (validate last workflow execution)
 *   /validate-execution --compare (compare with baseline)
 *
 * Integration: Registers with CommandRouter
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// Command Definition
// ═══════════════════════════════════════════════════════════════════════════

const COMMAND_SPEC = {
  name: 'validate-execution',
  aliases: ['valex', 'check-exec', 'validate'],
  description: 'Validate execution logs against standard workflow flow',
  args: [
    { name: 'output-dir', type: 'string', default: './output', description: 'Output directory to validate' },
    { name: 'strict', type: 'boolean', default: false, description: 'Enable strict validation mode' },
    { name: 'verbose', type: 'boolean', aliases: ['v'], default: false, description: 'Verbose output' },
    { name: 'compare-baseline', type: 'string', description: 'Compare with baseline report' },
    { name: 'generate-baseline', type: 'boolean', default: false, description: 'Generate new baseline' },
  ],
  examples: [
    '/validate-execution',
    '/validate-execution --output-dir ./my-output --strict',
    '/validate-execution --latest --verbose',
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// Command Handler
// ═══════════════════════════════════════════════════════════════════════════

class ValidateExecutionCommand {
  constructor(options = {}) {
    this.outputDir = options.outputDir || path.join(process.cwd(), 'output');
    this.strictMode = options.strict || false;
    this.verbose = options.verbose || false;
  }

  /**
   * Main command execution.
   */
  async execute(args = {}) {
    const startTime = Date.now();

    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║     E X E C U T I O N   L O G   V A L I D A T O R              ║');
    console.log('║     执行日志验证器 - 对比标准流程                                ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

    // Resolve output directory
    const targetDir = args['output-dir'] || this.outputDir;
    const resolvedDir = path.resolve(targetDir);

    if (!fs.existsSync(resolvedDir)) {
      console.error(`❌ Error: Output directory not found: ${resolvedDir}`);
      return { success: false, error: 'Directory not found' };
    }

    console.log(`📁 Validating directory: ${resolvedDir}`);
    console.log(`🔍 Mode: ${args.strict ? 'STRICT' : 'NORMAL'}`);
    console.log('');

    try {
      // Import validator
      const { ExecutionLogValidator } = require('../core/execution-log-validator');

      // Create validator instance
      const validator = new ExecutionLogValidator({
        outputDir: resolvedDir,
        verbose: this.verbose || args.verbose,
        strictMode: this.strictMode || args.strict,
        reportOutputDir: resolvedDir,
      });

      // Run validation
      const result = await validator.validate();

      // Handle baseline operations
      if (args['generate-baseline']) {
        this._generateBaseline(result, resolvedDir);
      }

      if (args['compare-baseline']) {
        await this._compareWithBaseline(result, args['compare-baseline'], resolvedDir);
      }

      // Generate and print summary
      this._printSummary(result);

      const elapsed = Date.now() - startTime;

      return {
        success: result.report.summary.status !== 'failed',
        score: result.report.summary.score,
        status: result.report.summary.status,
        elapsedMs: elapsed,
        reportPaths: result.reportPaths,
      };

    } catch (err) {
      console.error(`\n❌ Validation failed: ${err.message}`);
      if (this.verbose) {
        console.error(err.stack);
      }
      return { success: false, error: err.message };
    }
  }

  /**
   * Prints execution summary.
   */
  _printSummary(result) {
    const { report } = result;

    console.log('\n' + '═'.repeat(64));
    console.log('                    V A L I D A T I O N   R E S U L T');
    console.log('═'.repeat(64));
    console.log('');

    // Overall status
    const statusEmoji = report.summary.status === 'passed' ? '✅' :
                       report.summary.status === 'passed_with_warnings' ? '⚠️' : '❌';
    console.log(`  Overall Status: ${statusEmoji} ${report.summary.status.toUpperCase()}`);
    console.log(`  Quality Score:  ${report.summary.score}/100`);
    console.log('');

    // Stage breakdown
    console.log('  Stage Breakdown:');
    console.log('  ┌─────────────┬────────────┬─────────┬──────────┐');
    console.log('  │ Stage       │ Status     │ Score   │ Warnings │');
    console.log('  ├─────────────┼────────────┼─────────┼──────────┤');

    for (const [stage, validation] of Object.entries(report.stageValidations)) {
      const statusIcon = validation.status === 'passed' ? '✅' :
                        validation.status === 'passed_with_warnings' ? '⚠️' :
                        validation.status === 'failed' ? '❌' : '⏳';
      const statusText = `${statusIcon} ${validation.status.padEnd(7)}`;
      console.log(`  │ ${stage.padEnd(11)} │ ${statusText} │ ${String(validation.score).padStart(3)}/100 │ ${String(validation.warnings.length).padStart(8)} │`);
    }

    console.log('  └─────────────┴────────────┴─────────┴──────────┘');
    console.log('');

    // Flow validation
    if (report.flowValidation) {
      console.log(`  Flow Continuity: ${report.flowValidation.status === 'passed' ? '✅' : '❌'} ${report.flowValidation.status}`);
      if (report.flowValidation.breaks?.length > 0) {
        console.log('  Flow Breaks:');
        for (const break_ of report.flowValidation.breaks) {
          console.log(`    • ${break_.from} → ${break_.to} (${break_.gap} stage(s) skipped)`);
        }
      }
      console.log('');
    }

    // Integrity checks
    if (report.integrityChecks.length > 0) {
      console.log('  Integrity Checks:');
      for (const check of report.integrityChecks) {
        const status = check.passed ? '✅' : '❌';
        const score = check.score !== undefined ? ` (${check.score}%)` : '';
        console.log(`    ${status} ${check.name}${score}`);
      }
      console.log('');
    }

    // Recommendations
    if (report.recommendations.length > 0) {
      console.log('  Recommendations:');
      for (const rec of report.recommendations.slice(0, 5)) {
        const emoji = rec.priority === 'high' ? '🔴' : rec.priority === 'medium' ? '🟡' : '🟢';
        console.log(`    ${emoji} [${rec.priority.toUpperCase()}] ${rec.message}`);
      }
      if (report.recommendations.length > 5) {
        console.log(`    ... and ${report.recommendations.length - 5} more`);
      }
      console.log('');
    }

    // Report location
    console.log('  Reports generated:');
    console.log(`    📄 ${path.basename(result.reportPaths.latestMarkdown)}`);
    console.log(`    📊 ${path.basename(result.reportPaths.latestJson)}`);
    console.log('');
    console.log('═'.repeat(64));
    console.log('');
  }

  /**
   * Generates baseline for future comparisons.
   */
  _generateBaseline(result, outputDir) {
    const baselinePath = path.join(outputDir, 'execution-baseline.json');
    const baseline = {
      generatedAt: new Date().toISOString(),
      score: result.report.summary.score,
      stages: Object.fromEntries(
        Object.entries(result.report.stageValidations).map(([k, v]) => [
          k,
          { score: v.score, status: v.status },
        ])
      ),
      integrity: result.report.integrityChecks.map(c => ({
        name: c.name,
        passed: c.passed,
        score: c.score,
      })),
    };

    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');
    console.log(`\n📊 Baseline generated: ${baselinePath}`);
  }

  /**
   * Compares current result with baseline.
   */
  async _compareWithBaseline(result, baselinePath, outputDir) {
    const fullBaselinePath = path.resolve(outputDir, baselinePath);

    if (!fs.existsSync(fullBaselinePath)) {
      console.warn(`\n⚠️ Baseline not found: ${fullBaselinePath}`);
      return;
    }

    try {
      const baseline = JSON.parse(fs.readFileSync(fullBaselinePath, 'utf-8'));
      const comparison = {
        timestamp: new Date().toISOString(),
        scoreDiff: result.report.summary.score - baseline.score,
        stageComparisons: {},
        improvements: [],
        regressions: [],
      };

      // Compare stage scores
      for (const [stage, current] of Object.entries(result.report.stageValidations)) {
        const baselineStage = baseline.stages[stage];
        if (baselineStage) {
          const scoreDiff = current.score - baselineStage.score;
          comparison.stageComparisons[stage] = {
            baseline: baselineStage.score,
            current: current.score,
            diff: scoreDiff,
          };

          if (scoreDiff > 5) {
            comparison.improvements.push(`${stage}: +${scoreDiff} points`);
          } else if (scoreDiff < -5) {
            comparison.regressions.push(`${stage}: ${scoreDiff} points`);
          }
        }
      }

      // Print comparison
      console.log('\n' + '─'.repeat(64));
      console.log('                    B A S E L I N E   C O M P A R I S O N');
      console.log('─'.repeat(64));
      console.log(`\n  Baseline: ${baselinePath}`);
      console.log(`  Score Change: ${comparison.scoreDiff >= 0 ? '+' : ''}${comparison.scoreDiff} points`);
      console.log(`  Current: ${result.report.summary.score}/100`);
      console.log(`  Baseline: ${baseline.score}/100`);

      if (comparison.improvements.length > 0) {
        console.log('\n  📈 Improvements:');
        for (const imp of comparison.improvements) {
          console.log(`    • ${imp}`);
        }
      }

      if (comparison.regressions.length > 0) {
        console.log('\n  📉 Regressions:');
        for (const reg of comparison.regressions) {
          console.log(`    • ${reg}`);
        }
      }

      // Write comparison report
      const comparisonPath = path.join(outputDir, 'execution-comparison.json');
      fs.writeFileSync(comparisonPath, JSON.stringify(comparison, null, 2), 'utf-8');
      console.log(`\n  Comparison saved: execution-comparison.json`);
      console.log('─'.repeat(64));

    } catch (err) {
      console.warn(`\n⚠️ Failed to compare with baseline: ${err.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Registration Helper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Registers command with CommandRouter.
 */
function registerValidateExecutionCommand(router, options = {}) {
  const command = new ValidateExecutionCommand(options);

  router.register({
    ...COMMAND_SPEC,
    handler: async (args) => command.execute(args),
  });

  return command;
}

// ═══════════════════════════════════════════════════════════════════════════
// Direct CLI Execution
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = arr[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        acc[key] = nextArg;
      } else {
        acc[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      acc[key] = true;
    }
    return acc;
  }, {});

  const command = new ValidateExecutionCommand();
  const result = await command.execute(args);

  process.exit(result.success ? 0 : 1);
}

// Run if executed directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  COMMAND_SPEC,
  ValidateExecutionCommand,
  registerValidateExecutionCommand,
};