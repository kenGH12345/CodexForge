'use strict';

/**
 * Step: Dry-run Report + Optimistic Lock Reset
 *
 * Print dry-run summary and reset file lock manager.
 *
 * Priority: 48
 * After: risk-correlation
 */

const { TeardownStep } = require('../teardown-step');
const { HOOK_EVENTS } = require('../constants');
const path = require('path');

class DryRunAndLockStep extends TeardownStep {
  constructor() {
    super({
      name: 'dryrun-lock',
      description: 'Print dry-run summary and reset optimistic locks',
      priority: 48,
      after: ['risk-correlation'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    // Dry-run: save report and print summary
    if (orch.dryRun && orch.sandbox && orch.sandbox.pendingCount > 0) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`  🧪 DRY-RUN SUMMARY: ${orch.sandbox.pendingCount} pending operation(s)`);
      console.log(`${'─'.repeat(60)}`);
      const reportPath = orch.sandbox.saveReport();
      console.log(`  Report saved to: ${reportPath}`);
      console.log(`  To apply changes: await orchestrator.sandbox.apply()`);
      console.log(`${'─'.repeat(60)}\n`);
      await orch.hooks.emit(HOOK_EVENTS.DRYRUN_REPORT_SAVED, {
        reportPath,
        pendingCount: orch.sandbox.pendingCount,
        ops: orch.sandbox.getPendingOps().map(op => ({ type: op.type, path: op.relPath })),
      });
    }

    // Optimistic lock: report conflicts and reset
    try {
      const { fileLockManager } = require('../file-lock-manager');
      const lockStats = fileLockManager.getStats();
      if (lockStats.conflicts > 0) {
        console.warn(`\n${'─'.repeat(60)}`);
        console.warn(`  🔒 OPTIMISTIC LOCK SUMMARY`);
        console.warn(`  Tracked files: ${lockStats.trackedFiles} | Conflicts: ${lockStats.conflicts}`);
        for (const c of fileLockManager.getConflicts().slice(-5)) {
          console.warn(`  [${c.acquiredBy}→${c.conflictBy}] ${path.basename(c.file)}`);
        }
        console.warn(`${'─'.repeat(60)}\n`);
      }
      fileLockManager.reset();
    } catch (err) {
      console.warn(`[Orchestrator] fileLockManager.reset() failed: ${err.message}`);
    }
  }
}

module.exports = { DryRunAndLockStep };
