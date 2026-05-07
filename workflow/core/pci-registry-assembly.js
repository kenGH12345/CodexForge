'use strict';

const { sha256 } = require('./pci-utils');

function governanceByBlockId(governance) {
  const map = new Map();
  for (const entry of governance?.entries || []) {
    for (const blockId of entry.blockIds || []) {
      map.set(blockId, {
        entryId: entry.id,
        classification: entry.classification,
        action: entry.action,
        confidence: entry.confidence,
        reason: entry.reason,
      });
    }
  }
  return map;
}

function registryEntryFromBlock(block, governanceMap) {
  const governanceDecision = governanceMap.get(block.id) || null;
  return {
    registryId: `pcb.${sha256(block.id).slice(0, 12)}`,
    blockId: block.id,
    type: block.type,
    owner: block.owner,
    source: block.source,
    sourceHash: block.sourceHash,
    version: block.version,
    stage: block.stage,
    role: block.role,
    priority: block.priority,
    dedupeKey: block.dedupeKey,
    dedupePolicy: block.dedupePolicy,
    contentHash: block.contentHash,
    normalizedHash: block.normalizedHash,
    tokenEstimate: block.tokenEstimate,
    charCount: block.charCount,
    preview: block.preview,
    governance: governanceDecision || {
      classification: 'unique-or-unreviewed',
      action: 'keep',
      confidence: null,
      reason: 'No duplicate governance decision applies to this block.',
    },
  };
}

function summarizeRegistryEntries(entries) {
  const byType = {};
  const byOwner = {};
  const byGovernanceClassification = {};
  for (const entry of entries) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;
    byOwner[entry.owner] = (byOwner[entry.owner] || 0) + 1;
    const classification = entry.governance?.classification || 'unknown';
    byGovernanceClassification[classification] = (byGovernanceClassification[classification] || 0) + 1;
  }
  return { byType, byOwner, byGovernanceClassification };
}

function selectAssemblyEntries(entries, predicate, limit = 80) {
  return entries
    .filter(predicate)
    .sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
      if ((a.tokenEstimate || 0) !== (b.tokenEstimate || 0)) return (a.tokenEstimate || 0) - (b.tokenEstimate || 0);
      return a.blockId.localeCompare(b.blockId);
    })
    .slice(0, limit);
}

function assemblyRef(entry, order) {
  return {
    order,
    registryId: entry.registryId,
    blockId: entry.blockId,
    type: entry.type,
    owner: entry.owner,
    source: entry.source,
    priority: entry.priority,
    tokenEstimate: entry.tokenEstimate,
    dedupeKey: entry.dedupeKey,
    governanceClassification: entry.governance?.classification || 'unknown',
  };
}

function buildAssemblyView(id, description, entries) {
  const refs = entries.map((entry, index) => assemblyRef(entry, index + 1));
  return {
    id,
    description,
    blockCount: refs.length,
    estimatedTokens: refs.reduce((sum, ref) => sum + Number(ref.tokenEstimate || 0), 0),
    blocks: refs,
  };
}

function buildPromptContextShadowAssembly(registry) {
  const entries = registry.entries || [];
  const stages = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
  const roles = ['analyst', 'architect', 'planner', 'developer', 'tester'];
  const views = [
    buildAssemblyView('all.priority-order', 'All registry blocks ordered by priority and size. This is a shadow view only.', selectAssemblyEntries(entries, () => true, 120)),
    buildAssemblyView('skills.priority-order', 'Skill blocks ordered by priority and size for future ContextLoader assembly comparison.', selectAssemblyEntries(entries, entry => entry.type === 'skill', 120)),
    buildAssemblyView('runtime-sources.priority-order', 'Runtime prompt/config/source blocks ordered by priority for future prompt assembly diffing.', selectAssemblyEntries(entries, entry => entry.type !== 'skill', 120)),
  ];

  for (const stage of stages) {
    const stageEntries = selectAssemblyEntries(entries, entry => (entry.stage || []).includes(stage), 80);
    if (stageEntries.length > 0) views.push(buildAssemblyView(`stage.${stage}`, `Blocks explicitly tagged for ${stage}.`, stageEntries));
  }
  for (const role of roles) {
    const roleEntries = selectAssemblyEntries(entries, entry => (entry.role || []).includes(role), 80);
    if (roleEntries.length > 0) views.push(buildAssemblyView(`role.${role}`, `Blocks explicitly tagged for role ${role}.`, roleEntries));
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    description: 'Shadow assembly views derived from PromptContextRegistry. These views do not replace buildAgentPrompt, ContextLoader, or workflow-stage runtime assembly.',
    summary: {
      totalViews: views.length,
      totalReferencedBlocks: views.reduce((sum, view) => sum + view.blockCount, 0),
      totalReferencedTokens: views.reduce((sum, view) => sum + view.estimatedTokens, 0),
    },
    views,
  };
}

function buildPromptContextRegistry({ inventory, governance }) {
  const governanceMap = governanceByBlockId(governance);
  const entries = (inventory?.blocks || []).map(block => registryEntryFromBlock(block, governanceMap));
  const summaries = summarizeRegistryEntries(entries);
  const registry = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    projectRoot: inventory?.projectRoot || null,
    sourceArtifacts: {
      inventory: 'output/prompt-context-inventory.json',
      governance: 'output/prompt-context-duplicate-governance.json',
    },
    summary: {
      totalBlocks: entries.length,
      totalEstimatedTokens: entries.reduce((sum, entry) => sum + Number(entry.tokenEstimate || 0), 0),
      totalChars: entries.reduce((sum, entry) => sum + Number(entry.charCount || 0), 0),
      ...summaries,
    },
    entries,
  };
  return {
    registry,
    shadowAssembly: buildPromptContextShadowAssembly(registry),
  };
}

function formatShadowAssemblyReport(shadowAssembly) {
  const lines = [
    '# PromptContextRegistry Shadow Assembly',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${shadowAssembly.changedPromptOutput} |`,
    `| totalViews | ${shadowAssembly.summary.totalViews} |`,
    `| totalReferencedBlocks | ${shadowAssembly.summary.totalReferencedBlocks} |`,
    `| totalReferencedTokens | ${shadowAssembly.summary.totalReferencedTokens} |`,
    '',
    '## Views',
    '',
  ];
  for (const view of shadowAssembly.views) {
    lines.push(`### ${view.id}`);
    lines.push(`- description: ${view.description}`);
    lines.push(`- blockCount: ${view.blockCount}`);
    lines.push(`- estimatedTokens: ${view.estimatedTokens}`);
    for (const block of view.blocks.slice(0, 20)) {
      lines.push(`- ${block.order}. \`${block.blockId}\` — ${block.owner}/${block.type} — ${block.source || '(unknown source)'}`);
    }
    if (view.blocks.length > 20) lines.push(`- ... ${view.blocks.length - 20} more block(s)`);
    lines.push('');
  }
  lines.push('> This registry and assembly report is shadow-only. It does not change existing prompt assembly or LLM output.');
  return lines.join('\n');
}

module.exports = {
  governanceByBlockId,
  registryEntryFromBlock,
  summarizeRegistryEntries,
  selectAssemblyEntries,
  assemblyRef,
  buildAssemblyView,
  buildPromptContextShadowAssembly,
  buildPromptContextRegistry,
  formatShadowAssemblyReport,
};

