'use strict';

const fs = require('fs');
const path = require('path');
const { rel, safeRead } = require('./pci-utils');

function buildPromptContextAssemblerShadowDiff({ registry, shadowAssembly }) {
  const candidatePrompts = {};
  const roleDiffs = [];
  for (const assembly of shadowAssembly.roleAssemblies) {
    const key = `${assembly.stage}/${assembly.role}`;
    const candidateBlocks = assembly.blocks.map(b => b.id);
    candidatePrompts[key] = candidateBlocks;
    roleDiffs.push({
      stage: assembly.stage,
      role: assembly.role,
      candidateBlockCount: candidateBlocks.length,
      candidateEstimatedTokens: assembly.selectedTokens,
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      rolesCompared: roleDiffs.length,
      totalCandidateBlocks: roleDiffs.reduce((sum, d) => sum + d.candidateBlockCount, 0),
      totalCandidateTokens: roleDiffs.reduce((sum, d) => sum + d.candidateEstimatedTokens, 0),
    },
    candidatePrompts,
    roleDiffs,
  };
}

async function resolveContextLoaderSnapshots(projectRoot, requirement) {
  const ContextLoader = require('./context-loader').ContextLoader || require('./context-loader');
  const configPath = path.join(projectRoot, 'workflow.config.js');
  let config = {};
  try {
    delete require.cache[require.resolve(configPath)];
    if (fs.existsSync(configPath)) config = require(configPath);
  } catch { config = {}; }
  const loader = new ContextLoader({
    workflowRoot: path.join(projectRoot, 'workflow'),
    projectRoot,
    skillKeywords: config.skillKeywords || {},
    alwaysLoadSkills: config.alwaysLoadSkills || [],
    globalSkills: config.globalSkills || [],
    projectSkills: config.projectSkills || [],
    registeredSkills: config.builtinSkills || [],
  });
  const stageRoles = [
    ['ANALYSE', 'analyst'],
    ['ARCHITECT', 'architect'],
    ['PLAN', 'planner'],
    ['DEVELOP', 'developer'],
    ['TEST', 'test-report'],
  ];
  const contexts = [];
  for (const [stage, role] of stageRoles) {
    const resolved = await loader.resolve(requirement || 'PromptContextAssembler dynamic context shadow diff', role, { stage });
    const sources = resolved.sources || [];
    contexts.push({
      stage,
      role,
      taskText: requirement || '',
      tokenCount: resolved.tokenCount || 0,
      sources,
      sections: (resolved.sections || []).map((content, index) => ({
        index,
        source: sources[index] || 'unknown',
        content,
      })),
    });
  }
  return contexts;
}

function buildPromptContextDynamicContextShadowDiff({ registry, injectedContexts, projectRoot }) {
  const roleDiffs = [];
  let totalRuntimeTokens = 0;
  let totalCandidateTokens = 0;
  let totalRuntimeLength = 0;
  let totalCandidateLength = 0;
  for (const ctx of injectedContexts) {
    const key = `${ctx.stage}/${ctx.role}`;
    const runtimeTokens = ctx.tokenCount || 0;
    const runtimeSections = ctx.sections || [];
    const runtimeContent = runtimeSections.map(s => s.content).join('\n');
    totalRuntimeTokens += runtimeTokens;
    totalRuntimeLength += runtimeContent.length;
    roleDiffs.push({
      stage: ctx.stage,
      role: ctx.role,
      runtimeTokenCount: runtimeTokens,
      runtimeSectionCount: runtimeSections.length,
      runtimeContentLength: runtimeContent.length,
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      rolesCompared: injectedContexts.length,
      totalRuntimeTokens,
      totalCandidateTokens,
      totalRuntimeLength,
      totalCandidateLength,
    },
    roleDiffs,
  };
}

function buildPromptContextSelectionBudget({ registry, dynamicContextDiff, budget }) {
  const maxBlocks = budget?.maxBlocks || 15;
  const maxTokens = budget?.maxTokens || 12000;
  const roleBudgets = (dynamicContextDiff.roleDiffs || []).map(diff => ({
    stage: diff.stage,
    role: diff.role,
    budget: { maxBlocks, maxTokens },
    selectedBlocks: Math.min(diff.runtimeSectionCount || 0, maxBlocks),
    selectedEstimatedTokens: Math.min(diff.runtimeTokenCount || 0, maxTokens),
    omittedBlocks: Math.max(0, (diff.runtimeSectionCount || 0) - maxBlocks),
    blocks: [],
  }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      rolesCompared: roleBudgets.length,
      selectedBlocks: roleBudgets.reduce((sum, rb) => sum + rb.selectedBlocks, 0),
      selectedEstimatedTokens: roleBudgets.reduce((sum, rb) => sum + rb.selectedEstimatedTokens, 0),
      omittedBlocks: roleBudgets.reduce((sum, rb) => sum + rb.omittedBlocks, 0),
      driftAlertCount: 0,
      highDriftAlertCount: 0,
    },
    roleBudgets,
    driftAlerts: [],
  };
}

function formatAssemblerShadowDiffReport(diff) {
  const lines = [
    '# PromptContextAssembler Shadow Diff',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${diff.changedPromptOutput} |`,
    `| rolesCompared | ${diff.summary.rolesCompared} |`,
    `| totalCandidateBlocks | ${diff.summary.totalCandidateBlocks} |`,
    `| totalCandidateTokens | ${diff.summary.totalCandidateTokens} |`,
    '',
    '## Role Diffs', '',
  ];
  for (const d of diff.roleDiffs) {
    lines.push(`### ${d.stage}/${d.role}`);
    lines.push(`- candidateBlockCount: ${d.candidateBlockCount}`);
    lines.push(`- candidateEstimatedTokens: ${d.candidateEstimatedTokens}`);
    lines.push('');
  }
  lines.push('> This shadow diff is shadow-only. It does not replace ContextLoader or runtime prompt output.');
  return lines.join('\n');
}

function formatDynamicContextShadowDiffReport(diff) {
  const lines = [
    '# PromptContextAssembler Dynamic Context Shadow Diff',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${diff.changedPromptOutput} |`,
    `| rolesCompared | ${diff.summary.rolesCompared} |`,
    `| totalRuntimeTokens | ${diff.summary.totalRuntimeTokens} |`,
    `| totalRuntimeLength | ${diff.summary.totalRuntimeLength} |`,
    '',
    '## Role Diffs', '',
  ];
  for (const d of diff.roleDiffs) {
    lines.push(`### ${d.stage}/${d.role}`);
    lines.push(`- runtimeTokenCount: ${d.runtimeTokenCount}`);
    lines.push(`- runtimeSectionCount: ${d.runtimeSectionCount}`);
    lines.push(`- runtimeContentLength: ${d.runtimeContentLength}`);
    lines.push('');
  }
  lines.push('> This dynamic context diff is shadow-only. It does not replace runtime prompt output.');
  return lines.join('\n');
}

function formatSelectionBudgetReport(report) {
  const lines = [
    '# PromptContextRegistry Selection Budget',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| rolesCompared | ${report.summary.rolesCompared} |`,
    `| selectedBlocks | ${report.summary.selectedBlocks} |`,
    `| selectedEstimatedTokens | ${report.summary.selectedEstimatedTokens} |`,
    `| omittedBlocks | ${report.summary.omittedBlocks} |`,
    `| driftAlertCount | ${report.summary.driftAlertCount} |`,
    `| highDriftAlertCount | ${report.summary.highDriftAlertCount} |`,
    '',
    '## Role Budgets', '',
  ];
  for (const rb of report.roleBudgets) {
    lines.push(`### ${rb.stage}/${rb.role}`);
    lines.push(`- selectedBlocks: ${rb.selectedBlocks}/${rb.budget.maxBlocks}`);
    lines.push(`- selectedEstimatedTokens: ${rb.selectedEstimatedTokens}/${rb.budget.maxTokens}`);
    lines.push(`- omittedBlocks: ${rb.omittedBlocks}`);
    lines.push('');
  }
  lines.push('> This selection budget is shadow-only. It does not replace ContextLoader, buildAgentPrompt, workflow-stage, or any runtime prompt output.');
  return lines.join('\n');
}

module.exports = {
  buildPromptContextAssemblerShadowDiff,
  resolveContextLoaderSnapshots,
  buildPromptContextDynamicContextShadowDiff,
  buildPromptContextSelectionBudget,
  formatAssemblerShadowDiffReport,
  formatDynamicContextShadowDiffReport,
  formatSelectionBudgetReport,
};
