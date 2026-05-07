'use strict';

const fs = require('fs');
const path = require('path');
const { SCHEMA_VERSION, rel, safeRead } = require('./pci-utils');

function buildPromptContextRegistry({ inventory, governance }) {
  const dedupedBlocks = [];
  const allowlistIds = new Set();
  for (const entry of governance.allowlist) {
    for (const id of entry.ids.slice(1)) allowlistIds.add(id);
  }
  for (const block of inventory.blocks) {
    if (allowlistIds.has(block.id)) continue;
    dedupedBlocks.push(block);
  }
  const budgetByType = {
    'static-source': { maxBlocks: 10, maxTokens: 8000 },
    'context-loader-config': { maxBlocks: 2, maxTokens: 4000 },
    'skill': { maxBlocks: 6, maxTokens: 6000 },
    'context-digest': { maxBlocks: 4, maxTokens: 6000 },
    'stage-context': { maxBlocks: 1, maxTokens: 4000 },
  };
  const registry = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    budgetByType,
    blocks: dedupedBlocks.map(b => ({
      id: b.id,
      type: b.type,
      owner: b.owner,
      source: b.source,
      priority: b.priority,
      dedupePolicy: b.dedupePolicy,
      tokenEstimate: b.tokenEstimate,
    })),
  };
  return { registry, dedupedBlocks };
}

function buildPromptContextShadowAssembly({ registry }) {
  const roles = [
    { stage: 'ANALYSE', role: 'analyst', types: ['context-loader-config', 'context-digest', 'skill', 'stage-context', 'static-source'] },
    { stage: 'ARCHITECT', role: 'architect', types: ['context-loader-config', 'context-digest', 'skill', 'static-source'] },
    { stage: 'PLAN', role: 'planner', types: ['context-loader-config', 'skill', 'static-source'] },
    { stage: 'DEVELOP', role: 'developer', types: ['context-loader-config', 'skill', 'static-source', 'stage-context'] },
    { stage: 'TEST', role: 'test-report', types: ['context-loader-config', 'context-digest', 'skill', 'static-source'] },
  ];
  const roleAssemblies = roles.map(({ stage, role, types }) => {
    const budget = { maxBlocks: 15, maxTokens: 12000 };
    const blocks = registry.blocks
      .filter(b => types.includes(b.type))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, budget.maxBlocks);
    const selectedTokens = blocks.reduce((sum, b) => sum + b.tokenEstimate, 0);
    return { stage, role, blocks, selectedTokens, budget };
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    roleAssemblies,
  };
}

function formatShadowAssemblyReport(shadowAssembly) {
  const lines = ['# PromptContextRegistry Shadow Assembly', ''];
  for (const assembly of shadowAssembly.roleAssemblies) {
    lines.push(`## ${assembly.stage}/${assembly.role}`);
    lines.push(`- blocks: ${assembly.blocks.length}/${assembly.budget.maxBlocks}`);
    lines.push(`- estimatedTokens: ${assembly.selectedTokens}/${assembly.budget.maxTokens}`);
    for (const block of assembly.blocks) {
      lines.push(`  - \`${block.id}\` — ${block.type} — tokens=${block.tokenEstimate}`);
    }
    lines.push('');
  }
  lines.push('> This shadow assembly is shadow-only. It does not replace ContextLoader or runtime prompt output.');
  return lines.join('\n');
}

module.exports = {
  buildPromptContextRegistry,
  buildPromptContextShadowAssembly,
  formatShadowAssemblyReport,
};
