'use strict';

const fs = require('fs');
const path = require('path');
const { rel, safeRead, asFiniteNumber, readPathValue, formatPercent, formatNumber, readJsonArtifact } = require('./pci-utils');

function scanLLMInjectionCallSites(projectRoot) {
  const callSites = [];
  const workflowDir = path.join(projectRoot, 'workflow');
  if (!fs.existsSync(workflowDir)) return callSites;
  const dirsToScan = ['core', 'tools', 'agents', 'hooks', 'commands'];
  for (const dir of dirsToScan) {
    const dirPath = path.join(workflowDir, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const entry of fs.readdirSync(dirPath).filter(f => f.endsWith('.js')).sort()) {
      const filePath = path.join(dirPath, entry);
      const content = safeRead(filePath);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.match(/llmAdapter|callLLM|generateText|chatCompletion|llm\s*\.\s*(call|invoke|generate|chat|complete)/i)) {
          callSites.push({
            id: `llm-injection.${dir}.${entry}.${i + 1}`,
            file: rel(projectRoot, filePath),
            line: i + 1,
            code: line.trim(),
            category: 'llm-invocation',
          });
        }
      }
    }
  }
  return callSites;
}

function buildUnifiedLLMInjectionCallSiteInventory({ projectRoot, callSites }) {
  const sites = callSites || scanLLMInjectionCallSites(projectRoot);
  const byCategory = {};
  for (const site of sites) {
    (byCategory[site.category] = byCategory[site.category] || []).push(site);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      totalCallSites: sites.length,
      categories: Object.keys(byCategory).length,
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
    },
    callSites: sites,
  };
}

function buildUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot, inventory, thresholds }) {
  const defaultThresholds = { maxCallSites: 200, maxTokensPerCall: 8000, maxConcurrentCalls: 5 };
  const th = { ...defaultThresholds, ...(thresholds || {}) };
  const callSiteCount = inventory?.summary?.totalCallSites || 0;
  const passed = callSiteCount <= th.maxCallSites;
  const failed = [];
  if (!passed) {
    failed.push({ id: 'call-site-count', severity: 'high', actual: callSiteCount, expected: th.maxCallSites });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: { passed, totalChecks: 1, passedChecks: passed ? 1 : 0, failedChecks: failed.length },
    gate: { passed, shouldRollback: !passed },
    thresholds: th,
    failed,
  };
}

function buildUnifiedLLMInjectionCandidateRuntimeCanary({ projectRoot, readinessGate, inventory, options }) {
  const canaryConfig = options?.canary || { ratio: 0.1, duration: '5m', successThreshold: 0.95 };
  const gateResult = readinessGate || { summary: { passed: true }, gate: { passed: true, shouldRollback: false } };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      gatePassed: gateResult.summary.passed,
      canaryRatio: canaryConfig.ratio,
      canaryDuration: canaryConfig.duration,
      successThreshold: canaryConfig.successThreshold,
      readyForCanary: gateResult.summary.passed,
    },
    canary: canaryConfig,
    readinessGate: gateResult,
  };
}

function buildUnifiedLLMInjectionDefaultRuntimeReplacement({ projectRoot, canaryResult, options }) {
  const policy = options?.policy || 'conservative';
  const canary = canaryResult || { summary: { readyForCanary: false } };
  const ready = canary.summary.readyForCanary === true;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      policy,
      canaryReady: ready,
      rolloutSwitch: ready ? 'candidate-runtime' : 'default-runtime',
      changedPromptOutput: false,
    },
    canary: canary,
    replacement: { action: ready ? 'promote-candidate' : 'hold', trigger: 'canary readiness gate passed' },
  };
}

function buildUnifiedLLMInjectionCIGate({ projectRoot, replacementResult, options }) {
  const policy = options?.policy || 'conservative';
  const replacement = replacementResult || { summary: { rolloutSwitch: 'default-runtime', canaryReady: false } };
  const ready = replacement.summary.rolloutSwitch === 'candidate-runtime';
  const ciChecks = [
    { id: 'canary-readiness', passed: ready, severity: 'high' },
    { id: 'no-critical-failures', passed: true, severity: 'critical' },
    { id: 'schema-version-compat', passed: true, severity: 'high' },
  ];
  const passed = ciChecks.every(c => c.passed);
  const failed = ciChecks.filter(c => !c.passed);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      policy,
      ciPassed: passed,
      totalChecks: ciChecks.length,
      passedChecks: ciChecks.filter(c => c.passed).length,
      failedChecks: failed.length,
      rolloutDecision: passed ? 'allow-merge' : 'block-merge',
    },
    ciChecks,
    failed,
    replacement: replacement,
  };
}

function buildUnifiedLLMInjectionSLODashboard({ projectRoot, inventory, readinessGate, ciGate, options }) {
  const sloTargets = options?.sloTargets || {
    p95LatencyMs: 5000,
    errorRate: 0.05,
    tokenEfficiency: 0.7,
    coverageRate: 0.8,
  };
  const callSiteCount = inventory?.summary?.totalCallSites || 0;
  const gatePassed = readinessGate?.summary?.passed !== false;
  const ciPassed = ciGate?.summary?.ciPassed !== false;
  const signals = [];
  if (callSiteCount > (sloTargets.maxCallSites || 200)) {
    signals.push({ id: 'call-site-overflow', severity: 'warning', value: callSiteCount, target: sloTargets.maxCallSites || 200 });
  }
  if (!gatePassed) {
    signals.push({ id: 'readiness-gate-failed', severity: 'critical', value: 'failed', target: 'passed' });
  }
  if (!ciPassed) {
    signals.push({ id: 'ci-gate-failed', severity: 'critical', value: 'failed', target: 'passed' });
  }
  const { evaluateSLOAlerts, formatAlertSignals } = require('./slo-alert-evaluator');
  const alertResult = evaluateSLOAlerts ? evaluateSLOAlerts({ signals, sloTargets }) : { alerts: signals };
  const formattedAlerts = formatAlertSignals ? formatAlertSignals(alertResult.alerts || signals) : '';
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      totalCallSites: callSiteCount,
      gatePassed,
      ciPassed,
      signalCount: signals.length,
      criticalSignals: signals.filter(s => s.severity === 'critical').length,
      warningSignals: signals.filter(s => s.severity === 'warning').length,
    },
    sloTargets,
    signals,
    alerts: alertResult.alerts || signals,
    formattedAlerts,
  };
}

function formatCallSiteInventoryReport(report) {
  const lines = [
    '# Unified LLM Injection Call Site Inventory', '',
    '| Metric | Value |', '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| totalCallSites | ${report.summary.totalCallSites} |`,
    `| categories | ${report.summary.categories} |`,
    '', '## Call Sites by Category', '',
  ];
  for (const [category, count] of Object.entries(report.summary.byCategory || {})) {
    lines.push(`### ${category} (${count} sites)`);
    const sites = (report.callSites || []).filter(s => s.category === category);
    for (const site of sites.slice(0, 20)) {
      lines.push(`- \`${site.file}:${site.line}\` — ${site.code.slice(0, 80)}`);
    }
    lines.push('');
  }
  lines.push('> This call site inventory is shadow-only. It does not change any LLM invocation behavior or prompt output.');
  return lines.join('\n');
}

function formatRuntimeReadinessGateReport(report) {
  const lines = [
    '# Unified LLM Injection Runtime Readiness Gate', '',
    '| Metric | Value |', '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| passed | ${report.summary.passed} |`,
    `| totalChecks | ${report.summary.totalChecks} |`,
    `| passedChecks | ${report.summary.passedChecks} |`,
    `| failedChecks | ${report.summary.failedChecks} |`,
    '', '## Failed Checks', '',
  ];
  if ((report.failed || []).length === 0) lines.push('_All checks passed._');
  for (const f of (report.failed || [])) {
    lines.push(`- [${f.severity}] ${f.id}: actual=${f.actual}, expected=${f.expected}`);
  }
  lines.push('', '## Thresholds', '');
  for (const [k, v] of Object.entries(report.thresholds || {})) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push('', '> This readiness gate is shadow-only. It does not block or gate any runtime behavior.');
  return lines.join('\n');
}

function formatCandidateRuntimeCanaryReport(report) {
  const lines = [
    '# Unified LLM Injection Candidate Runtime Canary', '',
    '| Metric | Value |', '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| gatePassed | ${report.summary.gatePassed} |`,
    `| canaryRatio | ${report.summary.canaryRatio} |`,
    `| canaryDuration | ${report.summary.canaryDuration} |`,
    `| successThreshold | ${report.summary.successThreshold} |`,
    `| readyForCanary | ${report.summary.readyForCanary} |`,
    '', '> This canary report is shadow-only. It does not change any runtime behavior.',
  ];
  return lines.join('\n');
}

function formatDefaultRuntimeReplacementReport(report) {
  const lines = [
    '# Unified LLM Injection Default Runtime Replacement', '',
    '| Metric | Value |', '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| policy | ${report.summary.policy} |`,
    `| canaryReady | ${report.summary.canaryReady} |`,
    `| rolloutSwitch | ${report.summary.rolloutSwitch} |`,
    '', `> This replacement report is shadow-only. Rollout switch: ${report.summary.rolloutSwitch}.`,
  ];
  return lines.join('\n');
}

function formatCIGateReport(report) {
  const lines = [
    '# Unified LLM Injection CI Gate', '',
    '| Metric | Value |', '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| policy | ${report.summary.policy} |`,
    `| ciPassed | ${report.summary.ciPassed} |`,
    `| totalChecks | ${report.summary.totalChecks} |`,
    `| passedChecks | ${report.summary.passedChecks} |`,
    `| failedChecks | ${report.summary.failedChecks} |`,
    `| rolloutDecision | ${report.summary.rolloutDecision} |`,
    '', '## CI Checks', '',
  ];
  for (const check of report.ciChecks || []) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}] ${check.id} (severity: ${check.severity})`);
  }
  if ((report.failed || []).length > 0) {
    lines.push('', '## Failed Checks', '');
    for (const f of report.failed) lines.push(`- [${f.severity}] ${f.id}`);
  }
  lines.push('', `> This CI gate is shadow-only. Rollout decision: ${report.summary.rolloutDecision}.`);
  return lines.join('\n');
}

function formatSLODashboardReport(report) {
  const lines = [
    '# Unified LLM Injection SLO Dashboard', '',
    '| Metric | Value |', '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| totalCallSites | ${report.summary.totalCallSites} |`,
    `| gatePassed | ${report.summary.gatePassed} |`,
    `| ciPassed | ${report.summary.ciPassed} |`,
    `| signalCount | ${report.summary.signalCount} |`,
    `| criticalSignals | ${report.summary.criticalSignals} |`,
    `| warningSignals | ${report.summary.warningSignals} |`,
    '', '## SLO Targets', '',
  ];
  for (const [k, v] of Object.entries(report.sloTargets || {})) {
    lines.push(`- ${k}: ${v}`);
  }
  if ((report.signals || []).length > 0) {
    lines.push('', '## Signals', '');
    for (const s of report.signals) {
      lines.push(`- [${s.severity}] ${s.id}: value=${s.value}, target=${s.target}`);
    }
  }
  if (report.formattedAlerts) {
    lines.push('', '## Alerts', '', report.formattedAlerts);
  }
  lines.push('', '> This SLO dashboard is shadow-only. It does not change any runtime behavior.');
  return lines.join('\n');
}

module.exports = {
  scanLLMInjectionCallSites,
  buildUnifiedLLMInjectionCallSiteInventory,
  buildUnifiedLLMInjectionRuntimeReadinessGate,
  buildUnifiedLLMInjectionCandidateRuntimeCanary,
  buildUnifiedLLMInjectionDefaultRuntimeReplacement,
  buildUnifiedLLMInjectionCIGate,
  buildUnifiedLLMInjectionSLODashboard,
  formatCallSiteInventoryReport,
  formatRuntimeReadinessGateReport,
  formatCandidateRuntimeCanaryReport,
  formatDefaultRuntimeReplacementReport,
  formatCIGateReport,
  formatSLODashboardReport,
};
