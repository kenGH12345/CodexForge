'use strict';

const path = require('path');
const { getConfig } = require('./config-loader');
const { applyConfigGovernance } = require('./config-governance');
const { ProjectProfiler } = require('./project-profiler');

async function runReadOnlyExploration({ projectRoot, requirement = '', noLsp = false, maxFiles = null } = {}) {
  const root = path.resolve(projectRoot || '.');
  const { config: rawConfig } = { config: getConfig(root, true) };
  const { config, report: governanceReport } = applyConfigGovernance(rawConfig);

  const ignoreDirs = config.ignoreDirs || [];
  const customRules = config.customDetectionRules || {};

  const profiler = new ProjectProfiler(root, {
    ignoreDirs,
    customFrameworkRules: customRules.frameworks,
    customDataLayerRules: customRules.dataLayer,
    customTestRules: customRules.testFrameworks,
  });

  const lspConfig = {
    ...((config.mcp && config.mcp.lsp && typeof config.mcp.lsp === 'object') ? config.mcp.lsp : {}),
  };
  if (maxFiles) lspConfig.maxFiles = maxFiles;

  let profile = null;
  let lspUsed = false;
  let lspError = null;

  if (!noLsp) {
    try {
      const lspResult = await profiler.analyzeWithLSP(root, lspConfig);
      profile = lspResult.profile;
      lspUsed = !!profile?.lspEnhanced;
    } catch (err) {
      lspError = err.message;
    }
  }

  if (!profile) {
    profile = profiler.analyze(root);
  }

  const compactSummary = profiler.renderCompactSummary(profile);

  return {
    mode: 'read-only-explorer',
    projectRoot: root,
    requirement,
    lspUsed,
    lspError,
    governanceReport,
    profile,
    compactSummary,
    evidence: {
      generatedAt: new Date().toISOString(),
      readOnlyGuaranteed: true,
      writesAttempted: 0,
      artifactsWritten: [],
    },
  };
}

module.exports = {
  runReadOnlyExploration,
};