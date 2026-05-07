'use strict';

const { normalizeContent } = require('./pci-utils');

function buildDuplicateReport(blocks) {
  const byNormalized = {};
  const byExact = {};
  for (const block of blocks) {
    const normalized = normalizeContent(block.content);
    if (!normalized) continue;
    (byExact[normalized] = byExact[normalized] || []).push(block);
    const truncated = normalized.slice(0, 200);
    (byNormalized[truncated] = byNormalized[truncated] || []).push(block);
  }
  const exactDuplicateGroups = Object.values(byExact).filter(g => g.length > 1);
  const normalizedDuplicateGroups = Object.entries(byNormalized).filter(([, g]) => g.length > 1).map(([hash, blocks]) => ({ hash, count: blocks.length, blocks }));
  const nearDuplicateCandidates = [];
  const normalizedEntries = Object.entries(byNormalized);
  for (let i = 0; i < normalizedEntries.length; i++) {
    for (let j = i + 1; j < normalizedEntries.length; j++) {
      const [h1, b1] = normalizedEntries[i];
      const [h2, b2] = normalizedEntries[j];
      if (h1 === h2) continue;
      const maxLen = Math.max(h1.length, h2.length);
      if (maxLen === 0) continue;
      let matches = 0;
      for (let k = 0; k < Math.min(h1.length, h2.length); k++) {
        if (h1[k] === h2[k]) matches++;
      }
      const score = matches / maxLen;
      if (score >= 0.85) nearDuplicateCandidates.push({ score, blocks: [b1[0], b2[0]] });
    }
  }
  nearDuplicateCandidates.sort((a, b) => b.score - a.score);
  return {
    summary: {
      totalBlocks: blocks.length,
      exactDuplicateGroups: exactDuplicateGroups.length,
      normalizedDuplicateGroups: normalizedDuplicateGroups.length,
      nearDuplicatePairs: nearDuplicateCandidates.length,
      duplicateBlockCount: [...exactDuplicateGroups, ...normalizedDuplicateGroups].reduce((sum, g) => sum + (g.length || g.count), 0),
    },
    exactDuplicates: exactDuplicateGroups,
    normalizedDuplicates: normalizedDuplicateGroups,
    nearDuplicateCandidates: nearDuplicateCandidates.slice(0, 100),
  };
}

function buildPromptContextDuplicateGovernance({ inventory, duplicateReport }) {
  const allowlist = [];
  const mergeSuggestions = [];
  for (const group of duplicateReport.normalizedDuplicates) {
    if (group.count >= 2) {
      mergeSuggestions.push({
        hash: group.hash,
        blocks: group.blocks.map(b => b.id),
        action: 'review-for-merge',
        reason: `${group.count} blocks share normalized prefix`,
      });
    }
  }
  for (const group of duplicateReport.exactDuplicates) {
    if (group.length >= 2) {
      allowlist.push({ ids: group.map(b => b.id), reason: 'exact-duplicate', action: 'keep-first' });
    }
  }
  return {
    schemaVersion: 1,
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      totalAllowlistEntries: allowlist.length,
      totalMergeSuggestions: mergeSuggestions.length,
    },
    allowlist,
    mergeSuggestions,
  };
}

function formatDuplicateReport(report) {
  const lines = [
    '# PromptContextBlock Duplicate Report',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| totalBlocks | ${report.summary.totalBlocks} |`,
    `| exactDuplicateGroups | ${report.summary.exactDuplicateGroups} |`,
    `| normalizedDuplicateGroups | ${report.summary.normalizedDuplicateGroups} |`,
    `| nearDuplicatePairs | ${report.summary.nearDuplicatePairs} |`,
    `| duplicateBlockCount | ${report.summary.duplicateBlockCount} |`,
    '',
    '## Normalized Duplicate Groups',
    '',
  ];
  if (report.normalizedDuplicates.length === 0) lines.push('_No normalized duplicate groups found._');
  for (const group of report.normalizedDuplicates.slice(0, 20)) {
    lines.push(`### ${group.hash.slice(0, 12)} (${group.count} blocks)`);
    for (const block of group.blocks) lines.push(`- \`${block.id}\` — ${block.source || '(unknown source)'}`);
    lines.push('');
  }
  lines.push('## Near Duplicate Candidates', '');
  if (report.nearDuplicateCandidates.length === 0) lines.push('_No near duplicate candidates found._');
  for (const pair of report.nearDuplicateCandidates.slice(0, 20)) {
    lines.push(`- score=${pair.score}: \`${pair.blocks[0].id}\` ↔ \`${pair.blocks[1].id}\``);
  }
  lines.push('');
  lines.push('> This report is shadow-only. It does not change existing prompt assembly or LLM output.');
  return lines.join('\n');
}

function formatMergeSuggestions(governance) {
  const lines = ['# PromptContext Duplicate Merge Suggestions', ''];
  if (governance.mergeSuggestions.length === 0) lines.push('_No merge suggestions._');
  for (const suggestion of governance.mergeSuggestions.slice(0, 40)) {
    lines.push(`- ${suggestion.action}: ${suggestion.blocks.join(', ')} — ${suggestion.reason}`);
  }
  return lines.join('\n');
}

module.exports = {
  buildDuplicateReport,
  buildPromptContextDuplicateGovernance,
  formatDuplicateReport,
  formatMergeSuggestions,
};
