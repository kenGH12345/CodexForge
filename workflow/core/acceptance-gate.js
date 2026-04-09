'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ACCEPTANCE_GATE = {
  enabled: true,
  strict: false,
  requireArtifacts: ['requirement.md', 'architecture.md', 'execution-plan.md', 'code.diff', 'test-report.md'],
};

function createAcceptanceGate(config = {}) {
  const userCfg = config.acceptanceGate && typeof config.acceptanceGate === 'object'
    ? config.acceptanceGate
    : {};
  return {
    ...DEFAULT_ACCEPTANCE_GATE,
    ...userCfg,
  };
}

async function runAcceptanceGate({ outputDir, config = {}, executionResults = [] }) {
  const gate = createAcceptanceGate(config);
  if (!gate.enabled) {
    return { passed: true, skipped: true, gate, issues: [] };
  }

  const issues = [];
  const checkedArtifacts = [];

  for (const file of gate.requireArtifacts || []) {
    const fullPath = path.join(outputDir || 'output', file);
    const exists = fs.existsSync(fullPath);
    checkedArtifacts.push({ file, exists });
    if (!exists) {
      issues.push(`Missing required artifact: ${file}`);
    }
  }

  const stageFailures = (executionResults || []).filter(r => r && r.success === false);
  if (stageFailures.length > 0) {
    issues.push(`Stage failures detected: ${stageFailures.map(s => s.stage).join(', ')}`);
  }

  const passed = issues.length === 0;
  return {
    passed,
    gate,
    issues,
    checkedArtifacts,
    verifier: 'independent-acceptance-gate',
  };
}

module.exports = {
  DEFAULT_ACCEPTANCE_GATE,
  createAcceptanceGate,
  runAcceptanceGate,
};