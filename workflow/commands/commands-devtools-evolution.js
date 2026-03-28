/**
 * DevTools Commands - Audit & Evolution (deep-audit, evolve)
 *
 * Split from commands-devtools.js for maintainability (ADR-33 Phase 3).
 *
 * @module workflow/commands/commands-devtools-evolution
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../core/constants');

/**
 * Registers evolution devtools commands.
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 */
function registerEvolutionCommands(registerCommand) {
registerCommand(
  'deep-audit',
  'Run a comprehensive deep audit across all system dimensions (logic, config, architecture, coupling, knowledge, performance). Usage: /deep-audit [--dimension <name>] [--verbose]',
  async (args, context) => {
    const { DeepAuditOrchestrator, AuditCategory } = require('../core/deep-audit-orchestrator');

    // Parse arguments
    const parts = (args || '').trim().split(/\s+/).filter(Boolean);
    const verbose = parts.includes('--verbose');
    let dimensions = null;

    const dimIdx = parts.indexOf('--dimension');
    if (dimIdx !== -1 && parts[dimIdx + 1]) {
      const dimName = parts[dimIdx + 1].toLowerCase().replace(/-/g, '_');
      const dimMap = {
        'logic': AuditCategory.LOGIC,
        'config': AuditCategory.CONFIG,
        'function': AuditCategory.FUNCTION,
        'coupling': AuditCategory.COUPLING,
        'architecture': AuditCategory.ARCHITECTURE,
        'performance': AuditCategory.PERFORMANCE,
        'knowledge': AuditCategory.KNOWLEDGE,
      };
      if (dimMap[dimName]) {
        dimensions = [dimMap[dimName]];
      } else {
        return `❌ Unknown dimension: "${parts[dimIdx + 1]}". Available: ${Object.keys(dimMap).join(', ')}`;
      }
    }

    const orchestrator = context.orchestrator || null;
    const audit = new DeepAuditOrchestrator({
      orchestrator,
      verbose,
    });

    const result = await audit.run({ dimensions: dimensions || undefined });

    const lines = [
      `## 🔍 Deep Audit Report`,
      ``,
      `**Duration**: ${(result.elapsedMs / 1000).toFixed(1)}s`,
      `**Total findings**: ${result.findings.length}`,
      ``,
      `| Severity | Count |`,
      `|----------|-------|`,
      `| 🔴 Critical | ${result.stats.critical} |`,
      `| 🟠 High | ${result.stats.high} |`,
      `| 🟡 Medium | ${result.stats.medium} |`,
      `| 🟢 Low | ${result.stats.low} |`,
      `| ℹ️ Info | ${result.stats.info} |`,
      ``,
    ];

    if (result.findings.length > 0) {
      // Show top priority findings inline
      const topPriority = result.findings.filter(f =>
        f.severity === 'critical' || f.severity === 'high'
      );
      if (topPriority.length > 0) {
        lines.push(`### 🔴 Top Priority`);
        lines.push(``);
        for (const f of topPriority) {
          lines.push(`- **[${f.severity.toUpperCase()}]** ${f.title}`);
          lines.push(`  ${f.description.slice(0, 200)}${f.description.length > 200 ? '...' : ''}`);
          if (f.suggestion) lines.push(`  > 💡 ${f.suggestion}`);
          lines.push(``);
        }
      }

      // Summary of other findings
      const others = result.findings.filter(f =>
        f.severity !== 'critical' && f.severity !== 'high'
      );
      if (others.length > 0) {
        lines.push(`### Other Findings (${others.length})`);
        lines.push(``);
        for (const f of others.slice(0, 10)) {
          lines.push(`- **[${f.severity}]** ${f.title}`);
        }
        if (others.length > 10) {
          lines.push(`- ... and ${others.length - 10} more (see full report)`);
        }
      }

      lines.push(``, `> 📄 Full report: \`output/deep-audit-report.md\``);
      lines.push(`> 📊 Machine-readable: \`output/deep-audit-report.json\``);
    } else {
      lines.push(`### ✅ All Clear`, ``, `No issues found across all audit dimensions. System health is excellent!`);
    }

    return lines.join('\n');
  }
);


registerCommand(
  'evolve',
  'One-click self-evolution: runs DeepAudit + Stale Skill Refresh + ArticleScout + Health Audit + Auto-Deploy. Usage: /evolve [--quick] [--dry-run] [--verbose]',
  async (args, context) => {
    const parts = (args || '').trim().split(/\s+/).filter(Boolean);
    const quick   = parts.includes('--quick');
    const dryRun  = parts.includes('--dry-run');
    const verbose = parts.includes('--verbose');

    if (!context.orchestrator) {
      return `❌ No orchestrator in context. Cannot run evolution (needs LLM + services).`;
    }

    const orch = context.orchestrator;
    const startTime = Date.now();
    const report = {
      steps: [],
      totalFindings: 0,
      staleSkillsRefreshed: 0,
      articlesEvaluated: 0,
      knowledgeInjected: 0,
      healthFindings: 0,
    };

    const log = (msg) => {
      console.log(`[Evolve] ${msg}`);
    };

    // ── P2b: Capture baseline BEFORE any evolution steps ──────────────────
    let baseline = null;
    let regressionGuard = null;
    try {
      const { RegressionGuard } = require('../core/regression-guard');
      regressionGuard = new RegressionGuard({ outputDir: PATHS.OUTPUT_DIR, verbose });
      baseline = regressionGuard.captureBaseline();
      log(`📸 Baseline captured: ${Object.keys(baseline.metrics).length} metrics, ${Object.keys(baseline.skillVersions).length} skills`);
    } catch (err) {
      log(`⚠️ Baseline capture failed (non-fatal): ${err.message}`);
    }

    log(`🧬 Self-evolution started ${quick ? '(quick mode)' : '(full mode)'}${dryRun ? ' [DRY RUN]' : ''}`);

    // ── P3d: Incremental Mode — only full-audit changed files ─────────────
    const lastRunPath = path.join(PATHS.OUTPUT_DIR, 'evolve-last-run.json');
    let lastEvolveTime = 0;
    let incrementalMode = false;
    try {
      if (fs.existsSync(lastRunPath)) {
        const lastRun = JSON.parse(fs.readFileSync(lastRunPath, 'utf-8'));
        lastEvolveTime = new Date(lastRun.timestamp).getTime() || 0;
      }
    } catch (_) { /* first run */ }

    // Check if any core files changed since last evolve
    let changedCoreFiles = 0;
    if (lastEvolveTime > 0) {
      const coreDirs = [
        path.join(orch?.projectRoot || process.cwd(), 'workflow', 'core'),
        path.join(orch?.projectRoot || process.cwd(), 'workflow', 'skills'),
        path.join(orch?.projectRoot || process.cwd(), 'workflow', 'commands'),
      ];
      for (const dir of coreDirs) {
        if (!fs.existsSync(dir)) continue;
        try {
          const files = fs.readdirSync(dir);
          for (const f of files) {
            const fullPath = path.join(dir, f);
            try {
              const stat = fs.statSync(fullPath);
              if (stat.isFile() && stat.mtimeMs > lastEvolveTime) {
                changedCoreFiles++;
              }
            } catch (_) { /* skip */ }
          }
        } catch (_) { /* skip */ }
      }
      incrementalMode = changedCoreFiles === 0;
      if (incrementalMode) {
        log(`⚡ Incremental mode: 0 core files changed since last evolve — skipping Deep Audit`);
      } else {
        log(`📝 ${changedCoreFiles} core file(s) changed since last evolve — full audit`);
      }
    }


    // ── P2a: MAPE Closed-Loop Analysis ────────────────────────────────────
    let mapeReport = null;
    try {
      const { MAPEEngine } = require('../core/mape-engine');
      const mape = new MAPEEngine({ orchestrator: orch, verbose });
      mapeReport = await mape.runCycle({ dryRun, maxActions: 5 });

      report.steps.push({
        name: 'MAPE Analysis',
        icon: mapeReport.phases.plan.actionCount > 0 ? '🔄' : '✅',
        status: 'done',
        summary: `${mapeReport.phases.monitor.signalCount} signals → ${mapeReport.phases.analyze.rootCauses} root causes → ${mapeReport.phases.plan.actionCount} actions (ROI: ${mapeReport.phases.plan.estimatedROI})`,
        mape: mapeReport,
      });
      log(`🔄 MAPE: ${mapeReport.phases.monitor.signalCount} signals, ${mapeReport.phases.plan.actionCount} planned actions`);
    } catch (err) {
      report.steps.push({ name: 'MAPE Analysis', icon: '⚠️', status: 'error', summary: err.message });
      log(`⚠️ MAPE analysis failed (non-fatal): ${err.message}`);
    }

    // ── MAPE Micro-Loop: Hypothesize → Execute → Measure → Keep/Rollback ──
    let microLoopReport = null;
    if (!dryRun && mapeReport && mapeReport.phases.plan.actionCount > 0) {
      try {
        const { MAPEEngine: MAPEMicro } = require('../core/mape-engine');
        const microMape = new MAPEMicro({ orchestrator: orch, verbose, microLoopMaxIter: 3 });
        microLoopReport = await microMape.runMicroLoop({ maxIterations: 3, degradationThreshold: 0.1 });

        report.steps.push({
          name: 'MAPE Micro-Loop',
          icon: microLoopReport.rolledBack > 0 ? '↩️' : '✅',
          status: 'done',
          summary: `${microLoopReport.iterations.length} iteration(s): ${microLoopReport.kept} kept, ${microLoopReport.rolledBack} rolled back${microLoopReport.stopped ? ' (stopped early)' : ''}`,
          microLoop: microLoopReport,
        });
        log(`🔄 Micro-Loop: ${microLoopReport.kept} kept, ${microLoopReport.rolledBack} rolled back`);
      } catch (err) {
        report.steps.push({ name: 'MAPE Micro-Loop', icon: '⚠️', status: 'error', summary: err.message });
        log(`⚠️ MAPE Micro-Loop failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 1: Deep Audit (skip in incremental mode if no changes) ─────
    const totalSteps = quick ? 4 : 5;
    if (incrementalMode) {
      report.steps.push({
        name: 'Deep Audit',
        icon: '⚡',
        status: 'skipped-incremental',
        summary: 'Skipped (no core files changed since last evolve)',
      });
      log(`Step 1/${totalSteps}: ⚡ Deep Audit skipped (incremental — 0 changes)`);
    } else {
      log(`Step 1/${totalSteps}: 🔬 Deep Audit...`);
    try {
      const { DeepAuditOrchestrator } = require('../core/deep-audit-orchestrator');
      const audit = new DeepAuditOrchestrator({ orchestrator: orch, verbose });
      const auditResult = await audit.run();
      const critical = auditResult.stats.critical || 0;
      const high     = auditResult.stats.high || 0;
      const medium   = auditResult.stats.medium || 0;
      const low      = auditResult.stats.low || 0;
      const info     = auditResult.stats.info || 0;
      const total    = auditResult.findings.length;
      report.totalFindings += total;

      report.steps.push({
        name: 'Deep Audit',
        icon: critical > 0 ? '🔴' : high > 0 ? '🟠' : '✅',
        status: 'done',
        summary: `${total} findings (🔴${critical} 🟠${high} 🟡${medium} 🟢${low} ℹ️${info})`,
        details: auditResult.findings.filter(f => f.severity === 'critical' || f.severity === 'high'),
      });
      log(`  → ${total} findings`);
    } catch (err) {
      report.steps.push({ name: 'Deep Audit', icon: '❌', status: 'error', summary: err.message });
      log(`  → Error: ${err.message}`);
    }
    } // end: incremental mode else

    // ── Step 2 + 3: Parallel Execution (P3c) ──────────────────────────────
    // Step 2 (Skill Refresh) and Step 3 (Article Scout) are independent —
    // they don't share mutable state, so run them in parallel for ~50% speedup.
    log(`Step 2-3/${totalSteps}: 📦🌐 Stale Skill Refresh + Article Scout (parallel)...`);

    const step2Promise = (async () => {
      try {
        const STALE_DAYS = 90;
        const now = Date.now();
        const refreshCandidates = [];
        const staleDetails = [];

        if (orch.skillEvolution) {
          for (const meta of orch.skillEvolution.registry.values()) {
            if (meta.retiredAt) continue;
            const lastEvolved = meta.lastEvolvedAt ? new Date(meta.lastEvolvedAt).getTime() : 0;
            const created = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
            const latestActivity = Math.max(lastEvolved, created);
            const daysSince = latestActivity > 0 ? (now - latestActivity) / (24 * 60 * 60 * 1000) : Infinity;

            if (daysSince > STALE_DAYS) {
              refreshCandidates.push(meta.name);
              staleDetails.push({ name: meta.name, daysSince: Math.round(daysSince), usageCount: meta.usageCount || 0 });
            }
          }
        }

        // Also detect hollow skills (low fill-rate)
        const { SkillEvolutionEngine } = require('../core/skill-evolution');
        const skillsDir = PATHS.SKILLS_DIR;
        const hollowSkills = [];
        const skills = orch.skillEvolution ? orch.skillEvolution.listSkills() : [];
        for (const s of skills) {
          if (s.retiredAt) continue;
          if (fs.existsSync(s.filePath)) {
            const content = fs.readFileSync(s.filePath, 'utf-8');
            const expectedSections = ['Rules', 'Anti-Patterns', 'Gotchas', 'Best Practices', 'Context Hints'];
            let filled = 0;
            for (const sec of expectedSections) {
              const secRegex = new RegExp(`^##\\s+.*${sec.replace(/-/g, '[- ]')}`, 'im');
              const secMatch = content.match(secRegex);
              if (secMatch) {
                const secIdx = content.indexOf(secMatch[0]);
                const afterHeader = content.slice(secIdx + secMatch[0].length, secIdx + secMatch[0].length + 200);
                const sectionContent = afterHeader.split(/^##\s/m)[0].trim();
                const sectionWords = sectionContent.split(/\s+/).filter(w => w.length > 1 && !w.startsWith('_No')).length;
                if (sectionWords >= 10) filled++;
              }
            }
            const fillRate = filled / expectedSections.length;
            if (fillRate < 0.4) {
              hollowSkills.push({ name: s.name, fillRate: Math.round(fillRate * 100) });
              if (!refreshCandidates.includes(s.name)) refreshCandidates.push(s.name);
            }
          }
        }

        // Refresh (up to 5 in evolve mode, more than the default 3)
        const maxRefresh = quick ? 3 : 5;
        const toRefresh = refreshCandidates.slice(0, maxRefresh);
        const refreshResults = [];

        if (toRefresh.length > 0 && !dryRun) {
          const { enrichSkillFromExternalKnowledge } = require('../core/context-budget-manager');
          for (const skillName of toRefresh) {
            try {
              const r = await enrichSkillFromExternalKnowledge(orch, skillName, {
                maxSearchResults: 3,
                maxFetchPages: 2,
                dryRun,
              });
              if (r.success) {
                refreshResults.push({ name: skillName, sectionsAdded: r.sectionsAdded });
                report.staleSkillsRefreshed++;
              }
            } catch (_) { /* non-fatal */ }
          }
        }

        report.steps.push({
          name: 'Stale Skill Refresh',
          icon: refreshCandidates.length > 0 ? '🔄' : '✅',
          status: 'done',
          summary: `${refreshCandidates.length} stale/hollow skill(s) found, ${dryRun ? '0 (dry run)' : refreshResults.length} refreshed`,
          staleDetails,
          hollowSkills,
          refreshResults,
        });
        log(`  → [Step 2] ${refreshCandidates.length} stale, ${refreshResults.length} refreshed`);
      } catch (err) {
        report.steps.push({ name: 'Stale Skill Refresh', icon: '❌', status: 'error', summary: err.message });
        log(`  → [Step 2] Error: ${err.message}`);
      }
    })();

    const step3Promise = (async () => {
      if (!quick) {
        try {
          const { ArticleScout } = require('../core/article-scout');
          const scout = new ArticleScout({ orchestrator: orch, verbose });
          const scoutResult = await scout.run({ dryRun });

          report.articlesEvaluated = scoutResult.evaluations.length;
          report.knowledgeInjected = scoutResult.injectedCount || 0;

          const highValue = scoutResult.evaluations.filter(e => e.compositeScore >= 0.55);
          report.steps.push({
            name: 'Article Scout',
            icon: highValue.length > 0 ? '⭐' : 'ℹ️',
            status: 'done',
            summary: `${scoutResult.evaluations.length} articles evaluated, ${highValue.length} high-value, ${scoutResult.injectedCount || 0} knowledge entries${dryRun ? ' (dry run)' : ''}`,
            highValue: highValue.map(e => ({ title: e.title, score: e.compositeScore })),
          });
          log(`  → [Step 3] ${scoutResult.evaluations.length} articles, ${highValue.length} high-value`);
        } catch (err) {
          report.steps.push({ name: 'Article Scout', icon: '❌', status: 'error', summary: err.message });
          log(`  → [Step 3] Error: ${err.message}`);
        }
      } else {
        report.steps.push({ name: 'Article Scout', icon: '⏭️', status: 'skipped', summary: 'Skipped (quick mode)' });
        log(`  → [Step 3] Article Scout skipped (quick mode)`);
      }
    })();

    // Wait for both to complete (parallel execution)
    await Promise.all([step2Promise, step3Promise]);

    // ── Step 4: Self-Reflection Health Audit ──────────────────────────────
    log(`Step 4/${totalSteps}: 🩺 Self-Reflection Health Audit...`);
    try {
      if (orch._selfReflection) {
        const auditResult = orch._selfReflection.auditHealth();
        report.healthFindings = auditResult.findings ? auditResult.findings.length : 0;

        report.steps.push({
          name: 'Health Audit',
          icon: report.healthFindings === 0 ? '✅' : '🟡',
          status: 'done',
          summary: `${report.healthFindings} finding(s) from ${auditResult.sessionCount || 0} session(s)`,
          findings: (auditResult.findings || []).slice(0, 5),
        });
        log(`  → ${report.healthFindings} findings`);
      } else {
        report.steps.push({ name: 'Health Audit', icon: '⚠️', status: 'skipped', summary: 'SelfReflectionEngine not available' });
        log('  → SelfReflectionEngine not available, skipped');
      }
    } catch (err) {
      report.steps.push({ name: 'Health Audit', icon: '❌', status: 'error', summary: err.message });
      log(`  → Error: ${err.message}`);
    }

    // ── Step 5: Staged Auto-Deploy (P1 ADR-34) ───────────────────────────
    log(`Step 5/${totalSteps}: 🚀 Staged Auto-Deploy...`);
    let deployReport = null;
    try {
      if (orch.autoDeployer) {
        // Collect GREEN changes from previous steps
        const greenChanges = [];
        if (report.staleSkillsRefreshed > 0) {
          greenChanges.push({
            type: 'skill-content-update',
            description: `Refreshed ${report.staleSkillsRefreshed} stale skill(s)`,
          });
        }
        if (report.knowledgeInjected > 0) {
          greenChanges.push({
            type: 'experience-store-update',
            description: `Injected ${report.knowledgeInjected} knowledge entries from article scout`,
          });
        }

        // Get adaptive strategy for YELLOW tier
        const Obs = require('../core/observability');
        const cfgAutoFix = (orch._config && orch._config.autoFixLoop) || {};
        const strategy = Obs.deriveStrategy(PATHS.OUTPUT_DIR, {
          maxFixRounds:    cfgAutoFix.maxFixRounds    ?? 2,
          maxReviewRounds: cfgAutoFix.maxReviewRounds ?? 2,
          maxExpInjected:  cfgAutoFix.maxExpInjected  ?? 5,
          projectId:       orch.projectId,
        });

        // Get audit findings for RED tier
        const auditStep = report.steps.find(s => s.name === 'Deep Audit');
        const auditFindings = auditStep && auditStep.status === 'done'
          ? { findings: auditStep.details || [] }
          : null;

        deployReport = await orch.autoDeployer.runFullDeploy({
          adaptiveStrategy: strategy,
          greenChanges,
          auditFindings,
          dryRun,
        });

        const totalChanges = deployReport.green.count + deployReport.yellow.count;
        const statusIcon = deployReport.red.prGenerated ? '🔴' : totalChanges > 0 ? '🟡' : '✅';
        const summary = [
          `🟢${deployReport.green.count} GREEN`,
          `🟡${deployReport.yellow.count} YELLOW${deployReport.yellow.applied ? ' (applied)' : ''}`,
          `🔴${deployReport.red.count} RED${deployReport.red.prGenerated ? ' (PR generated)' : ''}`,
        ].join(', ');

        report.steps.push({
          name: 'Auto-Deploy',
          icon: statusIcon,
          status: 'done',
          summary,
          deploy: deployReport,
        });
        log(`  → ${summary}`);
      } else {
        report.steps.push({ name: 'Auto-Deploy', icon: '⚠️', status: 'skipped', summary: 'AutoDeployer not available' });
        log('  → AutoDeployer not available, skipped');
      }
    } catch (err) {
      report.steps.push({ name: 'Auto-Deploy', icon: '❌', status: 'error', summary: err.message });
      log(`  → Error: ${err.message}`);
    }

    // ── Generate unified evolution report ─────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`🧬 Self-evolution complete in ${elapsed}s`);

    // Save JSON report
    try {
      const reportPath = path.join(PATHS.OUTPUT_DIR, 'evolve-report.json');
      if (!fs.existsSync(PATHS.OUTPUT_DIR)) {
        fs.mkdirSync(PATHS.OUTPUT_DIR, { recursive: true });
      }
      fs.writeFileSync(reportPath, JSON.stringify({ ...report, elapsed, timestamp: new Date().toISOString() }, null, 2));
    } catch (_) { /* non-fatal */ }

    // ── P2b: Compare with baseline (Before/After) ─────────────────────────
    let comparison = null;
    if (regressionGuard && baseline) {
      try {
        comparison = regressionGuard.compareWithBaseline();
        // Record the evolution outcome for long-term trend analysis
        regressionGuard.recordOutcome(report, comparison, mapeReport);
        log(`📊 Before/After: ${comparison.improved.length} improved, ${comparison.degraded.length} degraded, ${comparison.regressions.length} regression(s)`);
      } catch (err) {
        log(`⚠️ Regression comparison failed (non-fatal): ${err.message}`);
      }
    }

    // ── P3d: Save evolve timestamp for incremental mode ─────────────────
    if (!dryRun) {
      try {
        fs.writeFileSync(lastRunPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          changedCoreFiles,
          incrementalMode,
          stepsRun: report.steps.map(s => s.name),
        }, null, 2), 'utf-8');
      } catch (_) { /* non-fatal */ }
    }

    // Build markdown output
    const lines = [
      `## 🧬 Self-Evolution Report${dryRun ? ' (Dry Run)' : ''}`,
      ``,
      `**Mode**: ${quick ? '⚡ Quick' : '🔬 Full'}${incrementalMode ? ' ⚡ Incremental' : ''} | **Duration**: ${elapsed}s`,
      ``,
      `### Pipeline Summary`,
      ``,
      `| Step | Status | Summary |`,
      `|------|--------|---------|`,
    ];

    for (const step of report.steps) {
      lines.push(`| ${step.icon} ${step.name} | ${step.status} | ${step.summary} |`);
    }
    lines.push(``);

    // Deep Audit highlights
    const auditStep = report.steps.find(s => s.name === 'Deep Audit');
    if (auditStep && auditStep.details && auditStep.details.length > 0) {
      lines.push(`### 🔴 Critical / High Priority Findings`);
      lines.push(``);
      for (const f of auditStep.details.slice(0, 5)) {
        lines.push(`- **[${f.severity.toUpperCase()}]** ${f.title}`);
        if (f.suggestion) lines.push(`  > 💡 ${f.suggestion}`);
      }
      lines.push(``);
    }

    // Stale skill details
    const staleStep = report.steps.find(s => s.name === 'Stale Skill Refresh');
    if (staleStep && staleStep.staleDetails && staleStep.staleDetails.length > 0) {
      lines.push(`### 📦 Stale Skills`);
      lines.push(`| Skill | Days Since Update | Usage Count |`);
      lines.push(`|-------|-------------------|-------------|`);
      for (const s of staleStep.staleDetails.slice(0, 10)) {
        lines.push(`| ${s.name} | ${s.daysSince}d | ${s.usageCount} |`);
      }
      if (staleStep.hollowSkills && staleStep.hollowSkills.length > 0) {
        lines.push(``);
        lines.push(`**Hollow Skills** (low fill-rate):`);
        for (const h of staleStep.hollowSkills) {
          lines.push(`- ${h.name}: ${h.fillRate}% filled`);
        }
      }
      if (staleStep.refreshResults && staleStep.refreshResults.length > 0) {
        lines.push(``);
        lines.push(`**Refreshed**:`);
        for (const r of staleStep.refreshResults) {
          lines.push(`- ✅ ${r.name}: +${r.sectionsAdded} entries`);
        }
      }
      lines.push(``);
    }

    // Article Scout highlights
    const scoutStep = report.steps.find(s => s.name === 'Article Scout');
    if (scoutStep && scoutStep.highValue && scoutStep.highValue.length > 0) {
      lines.push(`### ⭐ High-Value Articles`);
      for (const a of scoutStep.highValue.slice(0, 3)) {
        lines.push(`- **${a.title}** (score: ${a.score.toFixed(2)})`);
      }
      lines.push(``);
    }

    // Health audit highlights
    const healthStep = report.steps.find(s => s.name === 'Health Audit');
    if (healthStep && healthStep.findings && healthStep.findings.length > 0) {
      lines.push(`### 🩺 Health Findings`);
      for (const f of healthStep.findings) {
        lines.push(`- **[${f.severity || 'info'}]** ${f.title || f.message || JSON.stringify(f).slice(0, 100)}`);
      }
      lines.push(``);
    }

    // Auto-Deploy details
    const deployStep = report.steps.find(s => s.name === 'Auto-Deploy');
    if (deployStep && deployStep.deploy) {
      const d = deployStep.deploy;
      lines.push(`### 🚀 Auto-Deploy (ADR-34)`);
      lines.push(``);
      if (d.green.count > 0) {
        lines.push(`**🟢 GREEN** (${d.green.count} change(s) recorded):`);
        for (const desc of d.green.changes) {
          lines.push(`- ${desc}`);
        }
        lines.push(``);
      }
      if (d.yellow.count > 0) {
        lines.push(`**🟡 YELLOW** (${d.yellow.count} config param(s)${d.yellow.applied ? ' — auto-applied' : ' — recommended'}):`);
        for (const c of d.yellow.changes) {
          lines.push(`- \`${c.param}\`: ${c.oldValue} → ${c.newValue} _(${c.reason})_`);
        }
        lines.push(``);
      }
      if (d.red.prGenerated) {
        lines.push(`**🔴 RED** (${d.red.count} structural change(s) — PR generated):`);
        if (d.red.prFile) lines.push(`- PR description: \`${d.red.prFile}\``);
        lines.push(``);
      }
    }

    // MAPE Analysis highlights (P2a)
    const mapeStep = report.steps.find(s => s.name === 'MAPE Analysis');
    if (mapeStep && mapeStep.mape) {
      const m = mapeStep.mape;
      lines.push(`### 🔄 MAPE Closed-Loop Analysis (P2a)`);
      lines.push(``);
      lines.push(`| Phase | Result |`);
      lines.push(`|-------|--------|`);
      lines.push(`| Monitor | ${m.phases.monitor.signalCount} signal(s) collected |`);
      lines.push(`| Analyze | ${m.phases.analyze.rootCauses} root cause(s), ${m.phases.analyze.correlations} correlation(s) |`);
      lines.push(`| Plan | ${m.phases.plan.actionCount} action(s), est. ROI: ${m.phases.plan.estimatedROI} |`);
      lines.push(`| Execute | ${m.phases.execute.executed} executed, ${m.phases.execute.skipped} skipped |`);
      lines.push(``);

      if (m.phases.plan.plan && m.phases.plan.plan.actions.length > 0) {
        lines.push(`**Planned Actions:**`);
        for (const a of m.phases.plan.plan.actions.slice(0, 5)) {
          const prioLabel = ['🔴 CRITICAL', '🟠 HIGH', '🟡 MEDIUM', '🟢 LOW'][a.priority] || '⚪';
          lines.push(`- ${prioLabel}: ${a.title} _(effort: ${a.estimatedEffort}, impact: ${a.estimatedImpact})_`);
        }
        lines.push(``);
      }
    }

    // Before/After comparison (P2b + P2d)
    if (comparison && !comparison.error) {
      lines.push(`### 📊 Evolution Effectiveness (Before/After)`);
      lines.push(``);

      if (Object.keys(comparison.delta).length > 0) {
        lines.push(`| Metric | Before | After | Δ | Status |`);
        lines.push(`|--------|--------|-------|---|--------|`);
        for (const [key, d] of Object.entries(comparison.delta)) {
          const icon = comparison.improved.includes(key) ? '✅' :
                       comparison.degraded.includes(key)  ? '❌' : '➖';
          const sign = d.diff > 0 ? '+' : '';
          lines.push(`| ${key} | ${d.before} | ${d.after} | ${sign}${d.diff} (${sign}${d.pctChange}%) | ${icon} |`);
        }
        lines.push(``);
      }

      if (comparison.regressions.length > 0) {
        lines.push(`**⚠️ Skill Regressions Detected:**`);
        for (const r of comparison.regressions) {
          lines.push(`- \`${r.skillName}\`: ${r.reason} (action: ${r.action})`);
        }
        lines.push(``);
      }

      // Target Gap Analysis — show metrics that haven't reached targets
      if (comparison.targetGaps && comparison.targetGaps.length > 0) {
        lines.push(`**🎯 Target Gap Analysis (metrics below target):**`);
        lines.push(`| Metric | Current | Target | Direction | Gap |`);
        lines.push(`|--------|---------|--------|-----------|-----|`);
        for (const g of comparison.targetGaps.slice(0, 7)) {
          const arrow = g.direction === 'minimize' ? '↓' : '↑';
          lines.push(`| ${g.metric} | ${g.current} | ${g.target} | ${arrow} ${g.direction} | ${g.gapPct}% |`);
        }
        lines.push(``);
      }

      // MAPE Micro-Loop results
      if (microLoopReport && microLoopReport.iterations.length > 0) {
        lines.push(`**🔄 MAPE Micro-Loop (Hypothesize → Execute → Measure → Keep/Rollback):**`);
        lines.push(`| # | Action | Status | Improved | Degraded |`);
        lines.push(`|---|--------|--------|----------|----------|`);
        for (const it of microLoopReport.iterations) {
          const statusIcon = it.status === 'kept' ? '✅' : it.status === 'rolled-back' ? '↩️' : '❌';
          const improved = it.delta?.improved?.join(', ') || '-';
          const degraded = it.delta?.degraded?.join(', ') || '-';
          lines.push(`| ${it.iteration} | ${it.action.slice(0, 50)} | ${statusIcon} ${it.status} | ${improved} | ${degraded} |`);
        }
        lines.push(``);
      }

      // P2d: Evolution ROI from history
      if (regressionGuard) {
        try {
          const trend = regressionGuard.getTrend();
          if (trend.cycles > 0) {
            lines.push(`**Evolution Trend:** ${trend.cycles} cycle(s) | Avg ROI: ${trend.avgROI} | Direction: ${trend.trend === 'improving' ? '📈 Improving' : trend.trend === 'degrading' ? '📉 Degrading' : '➡️ Stable'}`);
            if (trend.recentROI.length > 0) {
              lines.push(`Recent ROI: ${trend.recentROI.map(r => r.toFixed(1)).join(' → ')}`);
            }
            lines.push(``);
          }
        } catch (_) { /* non-fatal */ }
      }
    }

    // Footer
    lines.push(`---`);
    lines.push(`📄 Full report: \`output/evolve-report.json\``);
    if (dryRun) {
      lines.push(`> 💡 This was a dry run. Run \`/evolve\` without --dry-run to apply changes.`);
    } else {
      lines.push(`> 🔄 Next evolution: run \`/evolve\` again anytime, or it auto-triggers via \`_finalizeWorkflow()\` on each workflow run.`);
    }

    return lines.join('\n');
  }
);


}

module.exports = { registerEvolutionCommands };
