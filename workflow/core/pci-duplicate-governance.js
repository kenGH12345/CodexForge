
'use strict';

const { sha256, normalizeContent, estimateTokens } = require('./pci-utils');

function groupBy(blocks, key) {
  const groups = new Map();
  for (const block of blocks) {
    const value = block[key];
    if (!value) continue;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(block);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([hash, items]) => ({
      hash,
      count: items.length,
      blocks: items.map(toDuplicateRef),
    }));
}

function toDuplicateRef(block) {
  return {
    id: block.id,
    type: block.type,
    owner: block.owner,
    source: block.source,
    charCount: block.charCount,
    tokenEstimate: block.tokenEstimate,
    preview: block.preview,
  };
}

function tokenSet(block) {
  const normalized = normalizeContent(block.preview || '');
  return new Set((normalized.match(/[a-z0-9_]{3,}|[\u4e00-\u9fff]{2,}/g) || []).slice(0, 120));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter++;
  return inter / (a.size + b.size - inter);
}

function findNearDuplicates(blocks, threshold = 0.82, maxPairs = 30) {
  const candidates = blocks
    .filter(b => b.charCount >= 80)
    .map(b => ({ block: b, tokens: tokenSet(b) }));
  const pairs = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const score = jaccard(candidates[i].tokens, candidates[j].tokens);
      if (score >= threshold) {
        pairs.push({
          score: Number(score.toFixed(3)),
          blocks: [toDuplicateRef(candidates[i].block), toDuplicateRef(candidates[j].block)],
        });
      }
    }
  }
  return pairs.sort((a, b) => b.score - a.score).slice(0, maxPairs);
}

function buildDuplicateReport(blocks) {
  const exact = groupBy(blocks, 'contentHash');
  const normalized = groupBy(blocks, 'normalizedHash');
  const near = findNearDuplicates(blocks);
  const duplicateBlockIds = new Set();
  for (const group of [...exact, ...normalized]) {
    for (const block of group.blocks) duplicateBlockIds.add(block.id);
  }
  for (const pair of near) {
    for (const block of pair.blocks) duplicateBlockIds.add(block.id);
  }
  return {
    summary: {
      totalBlocks: blocks.length,
      exactDuplicateGroups: exact.length,
      normalizedDuplicateGroups: normalized.length,
      nearDuplicatePairs: near.length,
      duplicateBlockCount: duplicateBlockIds.size,
      potentialSavingsBlocks: Math.max(0, duplicateBlockIds.size - exact.length - normalized.length),
    },
    exactDuplicates: exact,
    normalizedDuplicates: normalized,
    nearDuplicateCandidates: near,
  };
}

function blockMapById(blocks) {
  return new Map((blocks || []).map(block => [block.id, block]));
}

function enrichDuplicateRef(ref, blockMap) {
  const full = blockMap.get(ref.id) || {};
  return {
    ...ref,
    priority: full.priority || 0,
    dedupePolicy: full.dedupePolicy || 'semantic-shadow',
    contentHash: full.contentHash || null,
    normalizedHash: full.normalizedHash || null,
  };
}

function headingFromSource(source) {
  const fragment = String(source || '').split('#')[1] || '';
  return fragment.trim();
}

function hasTemplateScaffold(refs) {
  return refs.some(ref => /<!--\s*PURPOSE:/i.test(ref.preview || ''));
}

function isEvolutionHistory(refs) {
  return refs.every(ref => /#Evolution History$/i.test(ref.source || '') || /^Evolution History$/i.test(headingFromSource(ref.source)));
}

function isGeneratedProjectStandardsMirror(refs) {
  const sources = refs.map(ref => String(ref.source || ''));
  return sources.some(src => src.includes('.workflow/skills/project-standards.md'))
    && sources.some(src => src.includes('.workflow/skills/project-standards-knowledge.md'));
}

function skillNameFromSource(source) {
  const match = String(source || '').match(/(?:^|\/)skills\/([^/#]+)\.md#/);
  return match ? match[1] : '';
}

function isDomainSpecificProjectStructureRepeat(refs) {
  if (!Array.isArray(refs) || refs.length < 3) return false;
  const allStandardStructure = refs.every(ref => /^Standard Project Structure$/i.test(headingFromSource(ref.source)));
  if (!allStandardStructure) return false;

  const skillNames = new Set(refs.map(ref => skillNameFromSource(ref.source)).filter(Boolean));
  if (skillNames.size < 3) return false;

  const knownDomainStructureSkills = new Set([
    'android-dev',
    'flutter-dev',
    'ios-dev',
    'game-architecture',
    'game-ai-patterns',
  ]);
  const allKnownDomainSkills = [...skillNames].every(name => knownDomainStructureSkills.has(name));
  const treeLike = refs.every(ref => /```[\s\S]*(?:project-root|game-project)[\s\S]*(?:├|└)/.test(ref.preview || ''));
  return allKnownDomainSkills && treeLike;
}

function pickCanonicalBlock(refs) {
  return [...refs].sort((a, b) => {
    if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
    if ((b.charCount || 0) !== (a.charCount || 0)) return (b.charCount || 0) - (a.charCount || 0);
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

function estimateTokenSavings(refs, canonical) {
  return refs
    .filter(ref => ref.id !== canonical.id)
    .reduce((sum, ref) => sum + Number(ref.tokenEstimate || 0), 0);
}

function classifyDuplicateEntry(entry, kind, blockMap) {
  const refs = (entry.blocks || []).map(ref => enrichDuplicateRef(ref, blockMap));
  const policies = new Set(refs.map(ref => ref.dedupePolicy));
  if (hasTemplateScaffold(refs) || isEvolutionHistory(refs)) {
    return {
      classification: 'template-noise',
      action: 'allowlist',
      confidence: 0.95,
      reason: '重复内容来自 skill 模板说明、占位结构或演进历史，属于报告噪声；应先过滤或 allowlist，而不是合并业务内容。',
      refs,
    };
  }
  if (isGeneratedProjectStandardsMirror(refs) || policies.has('allowRepeat')) {
    return {
      classification: 'reasonable-repeat',
      action: 'allowlist',
      confidence: 0.9,
      reason: '重复内容来自生成镜像、运行时固定前缀或显式 allowRepeat 策略，短期内保留重复更安全。',
      refs,
    };
  }
  if (isDomainSpecificProjectStructureRepeat(refs)) {
    return {
      classification: 'domain-specific-repeat',
      action: 'allowlist',
      confidence: 0.92,
      reason: '重复内容来自同名项目结构段落和树形目录格式，但各 block 表达 Android、Flutter、iOS、Game ECS、Game AI 等不同领域结构，应保留为 domain-specific project structure，而不是抽取共享模板。',
      refs,
    };
  }
  const exactLike = kind === 'exact' || kind === 'normalized' || Number(entry.score || 0) >= 0.97;
  return {
    classification: exactLike ? 'true-duplicate' : 'reasonable-repeat',
    action: exactLike ? 'merge-suggestion' : 'allowlist',
    confidence: exactLike ? 0.86 : 0.72,
    reason: exactLike
      ? '内容在语义或文本层面高度一致，且未命中模板噪声/合理重复规则，可生成合并建议。'
      : '近似重复但未达到安全自动合并阈值，应先作为合理重复保留并人工复核。',
    refs,
  };
}

function governanceEntryId(kind, entry, index) {
  const base = entry.hash ? entry.hash.slice(0, 12) : sha256((entry.blocks || []).map(b => b.id).join('|')).slice(0, 12);
  return `${kind}.${base}.${index + 1}`;
}

function buildMergeSuggestion(id, kind, entry, decision) {
  const canonical = pickCanonicalBlock(decision.refs);
  const duplicates = decision.refs.filter(ref => ref.id !== canonical.id);
  return {
    id: `merge.${id}`,
    classification: decision.classification,
    groupKind: kind,
    confidence: decision.confidence,
    canonicalBlock: canonical,
    duplicateBlocks: duplicates,
    estimatedTokenSavings: estimateTokenSavings(decision.refs, canonical),
    rationale: decision.reason,
    executableSteps: [
      `人工确认 ${canonical.source || canonical.id} 是否应作为 source-of-truth。`,
      '将 duplicateBlocks 中重复的通用内容抽取到共享 skill section 或删除空洞模板正文。',
      '重新运行 prompt-context-governance，确认 changedPromptOutput=false 且该 group 不再出现在 true-duplicate suggestions 中。',
    ],
    safety: '该建议只描述可执行合并步骤，不会自动修改任何 prompt、skill 或 runtime 输出。',
  };
}

function buildPromptContextDuplicateGovernance({ inventory, duplicateReport }) {
  const blockMap = blockMapById(inventory?.blocks || []);
  const entries = [];
  const mergeSuggestions = [];
  const allowlistEntries = [];
  const byClassification = {};
  const sources = [
    ['exact', duplicateReport?.exactDuplicates || []],
    ['normalized', duplicateReport?.normalizedDuplicates || []],
    ['near', duplicateReport?.nearDuplicateCandidates || []],
  ];

  for (const [kind, groups] of sources) {
    groups.forEach((entry, index) => {
      const id = governanceEntryId(kind, entry, index);
      const decision = classifyDuplicateEntry(entry, kind, blockMap);
      const record = {
        id,
        groupKind: kind,
        hash: entry.hash || null,
        score: entry.score || null,
        classification: decision.classification,
        action: decision.action,
        confidence: decision.confidence,
        reason: decision.reason,
        blockIds: decision.refs.map(ref => ref.id),
        sources: decision.refs.map(ref => ref.source).filter(Boolean),
      };
      entries.push(record);
      byClassification[decision.classification] = (byClassification[decision.classification] || 0) + 1;
      if (decision.action === 'allowlist') {
        allowlistEntries.push({
          id: `allow.${id}`,
          classification: decision.classification,
          match: {
            groupKind: kind,
            hash: entry.hash || null,
            blockIds: record.blockIds,
          },
          reason: decision.reason,
          owner: 'PromptContextGovernance',
          expiresAt: null,
        });
      } else {
        mergeSuggestions.push(buildMergeSuggestion(id, kind, entry, decision));
      }
    });
  }

  const allowlist = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    description: 'Generated allowlist candidates for non-actionable PromptContextBlock duplicate groups.',
    entries: allowlistEntries,
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    rules: [
      {
        id: 'template-scaffold-noise',
        classification: 'template-noise',
        condition: 'preview contains <!-- PURPOSE: --> or source heading is Evolution History',
        action: 'allowlist-or-filter-before-merge',
      },
      {
        id: 'generated-mirror-or-allow-repeat',
        classification: 'reasonable-repeat',
        condition: 'sources are generated project standards mirrors or blocks carry dedupePolicy=allowRepeat',
        action: 'allowlist-with-rationale',
      },
      {
        id: 'domain-specific-project-structure-repeat',
        classification: 'domain-specific-repeat',
        condition: 'same Standard Project Structure heading across known domain skills with tree-style project layouts',
        action: 'allowlist-with-domain-specific-rationale',
      },
      {
        id: 'exact-normalized-domain-duplicate',
        classification: 'true-duplicate',
        condition: 'exact/normalized duplicate not explained by template or allow-repeat rules',
        action: 'emit executable merge suggestion',
      },
    ],
    summary: {
      totalGroupsReviewed: entries.length,
      byClassification,
      allowlistCount: allowlistEntries.length,
      mergeSuggestionCount: mergeSuggestions.length,
      estimatedTokenSavings: mergeSuggestions.reduce((sum, item) => sum + item.estimatedTokenSavings, 0),
    },
    entries,
    allowlist,
    mergeSuggestions,
  };
}

function formatMergeSuggestions(governance) {
  const lines = [
    '# PromptContextBlock Merge Suggestions',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| totalGroupsReviewed | ${governance.summary.totalGroupsReviewed} |`,
    `| templateNoise | ${governance.summary.byClassification['template-noise'] || 0} |`,
    `| reasonableRepeat | ${governance.summary.byClassification['reasonable-repeat'] || 0} |`,
    `| domainSpecificRepeat | ${governance.summary.byClassification['domain-specific-repeat'] || 0} |`,
    `| trueDuplicate | ${governance.summary.byClassification['true-duplicate'] || 0} |`,
    `| allowlistCount | ${governance.summary.allowlistCount} |`,
    `| mergeSuggestionCount | ${governance.summary.mergeSuggestionCount} |`,
    `| estimatedTokenSavings | ${governance.summary.estimatedTokenSavings} |`,
    '',
    '## Merge Suggestions',
    '',
  ];

  if (governance.mergeSuggestions.length === 0) lines.push('_No actionable merge suggestions found._');
  for (const item of governance.mergeSuggestions.slice(0, 30)) {
    lines.push(`### ${item.id}`);
    lines.push(`- classification: ${item.classification}`);
    lines.push(`- confidence: ${item.confidence}`);
    lines.push(`- estimatedTokenSavings: ${item.estimatedTokenSavings}`);
    lines.push(`- canonical: \`${item.canonicalBlock.id}\` — ${item.canonicalBlock.source || '(unknown source)'}`);
    for (const duplicate of item.duplicateBlocks) {
      lines.push(`- duplicate: \`${duplicate.id}\` — ${duplicate.source || '(unknown source)'}`);
    }
    lines.push('- steps:');
    item.executableSteps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
    lines.push('');
  }

  lines.push('## Allowlist Summary');
  lines.push('');
  for (const entry of governance.allowlist.entries.slice(0, 30)) {
    lines.push(`- \`${entry.id}\` — ${entry.classification}: ${entry.reason}`);
  }
  lines.push('');
  lines.push('> This governance report is shadow-only. It does not change existing prompt assembly or LLM output.');
  return lines.join('\n');
}

module.exports = {
  groupBy,
  buildDuplicateReport,
  buildPromptContextDuplicateGovernance,
  formatMergeSuggestions,
};

