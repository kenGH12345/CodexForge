'use strict';

/**
 * Step: Observability Dashboard Print + Reports
 *
 * Print dashboard, generate HTML report, cross-session trends,
 * and integrated dashboard. Must run AFTER metrics flush.
 *
 * Priority: 40
 * After: obs-flush
 * Before: risk-correlation
 */

const { TeardownStep } = require('../teardown-step');
const { PATHS } = require('../constants');
const { generateDashboard } = require('../dashboard-integration');

class ObsDashboardStep extends TeardownStep {
  constructor() {
    super({
      name: 'obs-dashboard',
      description: 'Print observability dashboard and generate HTML/visual reports',
      priority: 40,
      after: ['obs-flush'],
      before: ['risk-correlation'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    // Print Observability dashboard
    try {
      orch.obs.printDashboard();
    } catch (dashErr) {
      console.warn(`[Orchestrator] ⚠️  Observability dashboard failed (non-fatal): ${dashErr.message}`);
    }

    // Generate HTML report
    try {
      const reportPath = orch.obs.generateHTMLReport();
      console.log(`[Orchestrator] 📊 HTML session report: ${reportPath}`);
    } catch (htmlErr) {
      console.warn(`[Orchestrator] ⚠️  HTML report generation failed (non-fatal): ${htmlErr.message}`);
    }

    // Cross-session trends report
    try {
      const ObsStrategy = require('../observability-strategy');
      const history = ObsStrategy.loadHistory(PATHS.OUTPUT_DIR);
      const trendsPath = ObsStrategy.generateTrendsReport(history, PATHS.OUTPUT_DIR);
      if (trendsPath) {
        console.log(`[Orchestrator] 📈 Cross-session trends report: ${trendsPath}`);
      }
    } catch (trendsErr) {
      console.warn(`[Orchestrator] ⚠️  Trends report generation failed (non-fatal): ${trendsErr.message}`);
    }

    // Dashboard Integration – Visual analytics and feedback reporting
    try {
      const dashboardPath = generateDashboard({
        outputDir: orch._outputDir || PATHS.OUTPUT,
      });
      if (dashboardPath) {
        console.log(`[Orchestrator] 📊 Integrated Dashboard generated: ${dashboardPath}`);
      }
    } catch (dashErr) {
      console.warn(`[Orchestrator] ⚠️  Dashboard integration failed (non-fatal): ${dashErr.message}`);
    }
  }
}

module.exports = { ObsDashboardStep };
