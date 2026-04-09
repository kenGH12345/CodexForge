'use strict';

const path = require('path');

function normalizeRunCategory(value) {
  const v = String(value || 'prod').trim().toLowerCase();
  return ['prod', 'test', 'diag'].includes(v) ? v : 'prod';
}

function resolveHealthPaths({ outputDir, runCategory }) {
  const normalized = normalizeRunCategory(runCategory);
  const healthDir = path.join(path.resolve(outputDir || 'output'), 'health', normalized);

  return {
    runCategory: normalized,
    healthDir,
    tracePath: path.join(healthDir, 'workflow-trace.jsonl'),
    healthReportPath: path.join(healthDir, 'health-report.md'),
    evolutionLogPath: path.join(healthDir, 'evolution-log.json'),
    qualityReportPath: path.join(healthDir, 'quality-report.md'),
    healthHistoryPath: path.join(healthDir, 'health-history.jsonl'),
    evidenceJsonPath: path.join(healthDir, 'verification-evidence.json'),
  };
}

module.exports = {
  normalizeRunCategory,
  resolveHealthPaths,
};