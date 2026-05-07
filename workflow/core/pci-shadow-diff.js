'use strict';

const { normalizeContent, sha256, safeRead, sourceHash } = require('./pci-utils');
const { splitMarkdownHeadingBlocks } = require('./pci-scanners');
const path = require('path');

function textTokens(value) {
  return (normalizeContent(value).match(/[a-z0-9_]{3,}|[\u4e00-\u9fff]{2,}/g) || []).slice(0, 2000);
}

function comparePromptTexts(candidatePrompt, runtimePrompt) {
  const candidateTokens = new Set(textTokens(candidatePrompt));
  const runtimeTokens = new Set(textTokens(runtimePrompt));
  let common = 0;
  for (const token of candidateTokens) if (runtimeTokens.has(token)) common++;
  const union = candidateTokens.size + runtimeTokens.size - common;
  const candidateOnly = [...candidateTokens].filter(token => !runtimeTokens.has(token)).slice(0, 30);
  const runtimeOnly = [...runtimeTokens].filter(token => !candidateTokens.has(token)).slice(0, 30);
  return {
    candidateChars: String(candidatePrompt || '').length,
    runtimeChars: String(runtimePrompt || '').length,
    candidateTokenCount: candidateTokens.size,
    runtimeTokenCount: runtimeTokens.size,
    commonTokenCount: common,
    jaccardSimilarity: union > 0 ? Number((common / union).toFixed(4)) : 0,
    candidateOnlyTop: candidateOnly,
    runtimeOnlyTop: runtimeOnly,
  };
}

function viewById(shadowAssembly, id) {
  return (shadowAssembly?.views || []).find(view => view.id === id) || null;
}

function registryEntryMap(registry) {
  return new Map((registry?.entries || []).map(entry => [entry.registryId, entry]));
}

function mergeAssemblyRefs(shadowAssembly, viewIds, maxBlocks = 60) {
  const seen = new Set();
  const refs = [];
  for (const viewId of viewIds) {
    const view = viewById(shadowAssembly, viewId);
    for (const ref of view?.blocks || []) {
      if (seen.has(ref.registryId)) continue;
      seen.add(ref.registryId);
      refs.push({ ...ref, sourceView: viewId });
      if (refs.length >= maxBlocks) return refs;
    }
  }
  return refs;
}

function refFromEntry(entry, sourceView, order = 1) {
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
    sourceView,
  };
}

function rolePrefixEntry(role, entryMap) {
  for (const entry of entryMap.values()) {
    if (entry.blockId === `prompt-agent-prefix.${role}`) return entry;
  }
  return null;
}

function selectRoleSpecificRefs(role, shadowAssembly, entryMap) {
  const refs = [];
  const seen = new Set();
  const addRef = (ref) => {
    if (!ref || seen.has(ref.registryId)) return;
    seen.add(ref.registryId);
    refs.push({ ...ref, order: refs.length + 1 });
  };

  const prefix = rolePrefixEntry(role, entryMap);
  if (prefix) addRef(refFromEntry(prefix, `role-prefix.${role}`));

  const roleView = viewById(shadowAssembly, `role.${role}`);
  for (const ref of roleView?.blocks || []) {
    if (refs.length >= 6) break;
    if (ref.blockId === `prompt-agent-prefix.${role}`) continue;
    addRef({ ...ref, sourceView: `role.${role}` });
  }

  if (refs.length === 0) {
    mergeAssemblyRefs(shadowAssembly, ['runtime-sources.priority-order'], 4).forEach(addRef);
  }
  return refs;
}

function extractMarkdownSection(content, heading) {
  const sections = splitMarkdownHeadingBlocks(content);
  const found = sections.find(section => section.heading === heading);
  return found ? found.content : '';
}

function resolveFullBlockContent(projectRoot, entry) {
  if (!entry) return '';
  const roleMatch = String(entry.blockId || '').match(/^prompt-agent-prefix\.(.+)$/);
  if (roleMatch) {
    try {
      const prefixesPath = path.join(projectRoot || process.cwd(), 'workflow', 'core', 'prompt-agent-prefixes.js');
      delete require.cache[require.resolve(prefixesPath)];
      const { AGENT_FIXED_PREFIXES } = require(prefixesPath);
      return AGENT_FIXED_PREFIXES?.[roleMatch[1]] || String(entry.preview || '');
    } catch {
      return String(entry.preview || '');
    }
  }

  const source = String(entry.source || '');
  const [sourcePath, heading] = source.split('#');
  if (sourcePath && heading && sourcePath.endsWith('.md')) {
    const content = safeRead(path.join(projectRoot || process.cwd(), sourcePath));
    const section = extractMarkdownSection(content, heading);
    if (section) return section;
  }
  return String(entry.preview || '');
}

function renderCandidatePrompt(role, refs, entryMap, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const lines = [
    `# Shadow Candidate Prompt — ${role}`,
    '<!-- shadow-only: diagnostic candidate, not runtime output -->',
    '',
  ];
  refs.forEach((ref, index) => {
    const entry = entryMap.get(ref.registryId) || {};
    lines.push(`<!-- block:${index + 1} ${ref.blockId} sourceView=${ref.sourceView} -->`);
    lines.push(resolveFullBlockContent(projectRoot, entry).trim());
    lines.push('');
  });
  return lines.join('\n').trim() + '\n';
}

function loadRuntimePromptSnapshots(projectRoot, requestedRoles) {
  const prefixesPath = path.join(projectRoot || process.cwd(), 'workflow', 'core', 'prompt-agent-prefixes.js');
  try {
    delete require.cache[require.resolve(prefixesPath)];
    const { AGENT_FIXED_PREFIXES } = require(prefixesPath);
    const roles = requestedRoles?.length ? requestedRoles : Object.keys(AGENT_FIXED_PREFIXES || {});
    return roles
      .filter(role => AGENT_FIXED_PREFIXES && AGENT_FIXED_PREFIXES[role])
      .map(role => ({
        role,
        source: 'workflow/core/prompt-agent-prefixes.js',
        runtimePromptHash: sha256(AGENT_FIXED_PREFIXES[role]),
        runtimePromptLength: AGENT_FIXED_PREFIXES[role].length,
        runtimePrompt: AGENT_FIXED_PREFIXES[role],
      }));
  } catch (err) {
    return [{
      role: 'unknown',
      source: 'workflow/core/prompt-agent-prefixes.js',
      error: err.message,
      runtimePromptHash: null,
      runtimePromptLength: 0,
      runtimePrompt: '',
    }];
  }
}

function buildPromptContextAssemblerShadowDiff({ registry, shadowAssembly, runtimePrompts }) {
  const entryMap = registryEntryMap(registry);
  const snapshots = runtimePrompts?.length ? runtimePrompts : loadRuntimePromptSnapshots(registry?.projectRoot || process.cwd());
  const candidatePrompts = [];
  const roleDiffs = [];

  for (const snapshot of snapshots) {
    const role = snapshot.role;
    const refs = selectRoleSpecificRefs(role, shadowAssembly, entryMap);
    const candidatePrompt = renderCandidatePrompt(role, refs, entryMap, { projectRoot: registry?.projectRoot });
    const comparison = comparePromptTexts(candidatePrompt, snapshot.runtimePrompt || '');
    const runtimeLength = Number(snapshot.runtimePromptLength || 0);
    const candidateLength = candidatePrompt.length;
    const candidate = {
      role,
      mode: 'shadow-only',
      changedPromptOutput: false,
      selectionStrategy: 'role-specific-prefix-first',
      sourceViews: [...new Set(refs.map(ref => ref.sourceView))],
      blockCount: refs.length,
      estimatedTokens: refs.reduce((sum, ref) => sum + Number(ref.tokenEstimate || 0), 0),
      candidatePromptHash: sha256(candidatePrompt),
      candidatePromptLength: candidateLength,
      runtimePrefixCoverage: comparison.runtimeTokenCount > 0
        ? Number((comparison.commonTokenCount / comparison.runtimeTokenCount).toFixed(4))
        : 0,
      lengthRatioToRuntime: runtimeLength > 0 ? Number((candidateLength / runtimeLength).toFixed(4)) : null,
      candidatePrompt,
      blocks: refs,
    };
    candidatePrompts.push(candidate);
    roleDiffs.push({
      role,
      runtimePromptSource: snapshot.source,
      runtimePromptHash: snapshot.runtimePromptHash,
      runtimePromptLength: snapshot.runtimePromptLength,
      candidatePromptHash: candidate.candidatePromptHash,
      candidatePromptLength: candidate.candidatePromptLength,
      sourceViews: candidate.sourceViews,
      selectionStrategy: candidate.selectionStrategy,
      blockCount: candidate.blockCount,
      estimatedTokens: candidate.estimatedTokens,
      runtimePrefixCoverage: candidate.runtimePrefixCoverage,
      lengthRatioToRuntime: candidate.lengthRatioToRuntime,
      comparison,
      interpretation: 'Shadow candidate uses role-specific full prefix content first, then minimal registry refs. It is still diagnostic only and must not be used as runtime output.',
    });
  }

  const averageSimilarity = roleDiffs.length
    ? Number((roleDiffs.reduce((sum, diff) => sum + diff.comparison.jaccardSimilarity, 0) / roleDiffs.length).toFixed(4))
    : 0;
  const averageRuntimePrefixCoverage = roleDiffs.length
    ? Number((roleDiffs.reduce((sum, diff) => sum + Number(diff.runtimePrefixCoverage || 0), 0) / roleDiffs.length).toFixed(4))
    : 0;
  const averageLengthRatioToRuntime = roleDiffs.length
    ? Number((roleDiffs.reduce((sum, diff) => sum + Number(diff.lengthRatioToRuntime || 0), 0) / roleDiffs.length).toFixed(4))
    : 0;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      rolesCompared: roleDiffs.length,
      candidatePromptCount: candidatePrompts.length,
      averageJaccardSimilarity: averageSimilarity,
      averageRuntimePrefixCoverage,
      averageLengthRatioToRuntime,
      totalCandidateBlocks: candidatePrompts.reduce((sum, candidate) => sum + candidate.blockCount, 0),
      totalCandidateEstimatedTokens: candidatePrompts.reduce((sum, candidate) => sum + candidate.estimatedTokens, 0),
    },
    candidatePrompts,
    roleDiffs,
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
    `| candidatePromptCount | ${diff.summary.candidatePromptCount} |`,
    `| averageJaccardSimilarity | ${diff.summary.averageJaccardSimilarity} |`,
    `| averageRuntimePrefixCoverage | ${diff.summary.averageRuntimePrefixCoverage} |`,
    `| averageLengthRatioToRuntime | ${diff.summary.averageLengthRatioToRuntime} |`,
    `| totalCandidateBlocks | ${diff.summary.totalCandidateBlocks} |`,
    `| totalCandidateEstimatedTokens | ${diff.summary.totalCandidateEstimatedTokens} |`,
    '',
    '## Role Diffs',
    '',
  ];
  for (const item of diff.roleDiffs) {
    lines.push(`### ${item.role}`);
    lines.push(`- runtimePromptLength: ${item.runtimePromptLength}`);
    lines.push(`- candidatePromptLength: ${item.candidatePromptLength}`);
    lines.push(`- selectionStrategy: ${item.selectionStrategy}`);
    lines.push(`- blockCount: ${item.blockCount}`);
    lines.push(`- estimatedTokens: ${item.estimatedTokens}`);
    lines.push(`- jaccardSimilarity: ${item.comparison.jaccardSimilarity}`);
    lines.push(`- runtimePrefixCoverage: ${item.runtimePrefixCoverage}`);
    lines.push(`- lengthRatioToRuntime: ${item.lengthRatioToRuntime}`);
    lines.push(`- sourceViews: ${item.sourceViews.join(', ') || '(none)'}`);
    lines.push(`- runtimeOnlyTop: ${item.comparison.runtimeOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    lines.push(`- candidateOnlyTop: ${item.comparison.candidateOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    lines.push('');
  }
  lines.push('> This shadow diff is diagnostic only. It does not replace buildAgentPrompt, ContextLoader, workflow-stage, or any runtime prompt output.');
  return lines.join('\n');
}

function sourceBase(source) {
  return String(source || '')
    .split('#')[0]
    .replace(/\s+\([^)]*sections? for [^)]+\)$/i, '')
    .replace(/\s+\(summary, overlap=[^)]+\)$/i, '')
    .replace(/\\/g, '/')
    .trim();
}

function dynamicContextRegistryEntries(registry) {
  const dynamicTypes = new Set([
    'skill',
    'stage-digest',
    'context-loader-source',
    'context-loader-doc',
    'context-loader-artifact',
    'mandatory-doc-map',
    'constraint-section-map',
    'skill-keyword-map',
    'skill-role-filter',
    'risk-skill-pack',
    'project-rule',
  ]);
  return (registry?.entries || []).filter(entry => dynamicTypes.has(entry.type) || entry.owner === 'ContextLoader');
}

function tokenOverlapScore(a, b) {
  const aTokens = new Set(textTokens(a));
  const bTokens = new Set(textTokens(b));
  if (aTokens.size === 0 || bTokens.size === 0) return { score: 0, covered: 0, total: aTokens.size };
  let common = 0;
  for (const token of aTokens) if (bTokens.has(token)) common++;
  return {
    score: Number((common / aTokens.size).toFixed(4)),
    covered: common,
    total: aTokens.size,
  };
}

function bestRegistryMatchForContextSection(section, entries, projectRoot) {
  const sectionSource = sourceBase(section.source);
  let best = null;
  for (const entry of entries) {
    const entrySource = sourceBase(entry.source);
    const sourceBoost = sectionSource && entrySource && (sectionSource === entrySource || entrySource.endsWith(sectionSource) || sectionSource.endsWith(entrySource)) ? 0.35 : 0;
    const content = resolveFullBlockContent(projectRoot, entry);
    const overlap = tokenOverlapScore(section.content || '', content || entry.preview || '');
    const score = Math.min(1, overlap.score + sourceBoost);
    if (!best || score > best.score) {
      best = {
        score,
        tokenCoverage: overlap.score,
        coveredTokens: overlap.covered,
        totalTokens: overlap.total,
        registryId: entry.registryId,
        blockId: entry.blockId,
        type: entry.type,
        owner: entry.owner,
        source: entry.source,
        governanceClassification: entry.governance?.classification || 'unknown',
      };
    }
  }
  return best;
}

function buildPromptContextDynamicContextShadowDiff({ registry, injectedContexts, projectRoot }) {
  const entries = dynamicContextRegistryEntries(registry);
  const contexts = injectedContexts || [];
  const roleDiffs = [];
  let totalSections = 0;
  let matchedSections = 0;
  let coverageSum = 0;

  for (const context of contexts) {
    const sectionDiffs = [];
    for (const section of context.sections || []) {
      totalSections++;
      const match = bestRegistryMatchForContextSection(section, entries, projectRoot || registry?.projectRoot || process.cwd());
      const matched = Boolean(match && match.score >= 0.35);
      if (matched) matchedSections++;
      coverageSum += match ? match.score : 0;
      sectionDiffs.push({
        index: section.index,
        source: section.source,
        charCount: String(section.content || '').length,
        matched,
        match,
      });
    }
    const covered = sectionDiffs.filter(item => item.matched).length;
    roleDiffs.push({
      stage: context.stage,
      role: context.role,
      taskText: context.taskText,
      injectedSections: sectionDiffs.length,
      matchedSections: covered,
      sectionCoverage: sectionDiffs.length ? Number((covered / sectionDiffs.length).toFixed(4)) : 0,
      averageMatchScore: sectionDiffs.length ? Number((sectionDiffs.reduce((sum, item) => sum + (item.match?.score || 0), 0) / sectionDiffs.length).toFixed(4)) : 0,
      tokenCount: context.tokenCount || 0,
      sources: context.sources || [],
      sectionDiffs,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      contextsCompared: contexts.length,
      registryCandidateBlocks: entries.length,
      totalInjectedSections: totalSections,
      matchedInjectedSections: matchedSections,
      sectionCoverage: totalSections ? Number((matchedSections / totalSections).toFixed(4)) : 0,
      averageMatchScore: totalSections ? Number((coverageSum / totalSections).toFixed(4)) : 0,
    },
    roleDiffs,
  };
}

function formatDynamicContextShadowDiffReport(diff) {
  const lines = [
    '# PromptContextAssembler Dynamic Context Shadow Diff',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${diff.changedPromptOutput} |`,
    `| contextsCompared | ${diff.summary.contextsCompared} |`,
    `| registryCandidateBlocks | ${diff.summary.registryCandidateBlocks} |`,
    `| totalInjectedSections | ${diff.summary.totalInjectedSections} |`,
    `| matchedInjectedSections | ${diff.summary.matchedInjectedSections} |`,
    `| sectionCoverage | ${diff.summary.sectionCoverage} |`,
    `| averageMatchScore | ${diff.summary.averageMatchScore} |`,
    '',
    '## Context Diffs',
    '',
  ];
  for (const item of diff.roleDiffs) {
    lines.push(`### ${item.stage}/${item.role}`);
    lines.push(`- injectedSections: ${item.injectedSections}`);
    lines.push(`- matchedSections: ${item.matchedSections}`);
    lines.push(`- sectionCoverage: ${item.sectionCoverage}`);
    lines.push(`- averageMatchScore: ${item.averageMatchScore}`);
    lines.push(`- tokenCount: ${item.tokenCount}`);
    lines.push(`- sources: ${item.sources.slice(0, 8).join(', ') || '(none)'}`);
    for (const section of item.sectionDiffs.slice(0, 12)) {
      lines.push(`  - section[${section.index}] ${section.matched ? 'MATCH' : 'MISS'} source=${section.source || '(unknown)'} match=${section.match?.blockId || '(none)'} score=${section.match?.score ?? 0}`);
    }
    if (item.sectionDiffs.length > 12) lines.push(`  - ... ${item.sectionDiffs.length - 12} more section(s)`);
    lines.push('');
  }
  lines.push('> This dynamic context diff is diagnostic only. It does not replace ContextLoader, buildAgentPrompt, workflow-stage, or any runtime prompt output.');
  return lines.join('\n');
}

const DEFAULT_SELECTION_BUDGET = {
  perRoleMaxBlocks: 6,
  perRoleMaxTokens: 900,
  globalMaxBlocks: 32,
  globalMaxTokens: 4200,
  minMatchScore: 0.65,
  warnMatchScore: 0.75,
};

function isContextLoaderDocArtifact(type) {
  return type === 'context-loader-doc' || type === 'context-loader-artifact';
}

function buildSelectionRef(section, entry) {
  return {
    registryId: entry.registryId,
    blockId: entry.blockId,
    type: entry.type,
    source: entry.source,
    sourceHash: entry.sourceHash,
    tokenEstimate: Number(entry.tokenEstimate || 0),
    charCount: Number(entry.charCount || 0),
    matchScore: section.match?.score || 0,
    tokenCoverage: section.match?.tokenCoverage || 0,
    injectedSource: section.source,
    injectedCharCount: section.charCount,
  };
}

function buildPromptContextSelectionBudget({ registry, dynamicContextDiff, budget }) {
  const effectiveBudget = { ...DEFAULT_SELECTION_BUDGET, ...(budget || {}) };
  const entryMap = registryEntryMap(registry);
  const roleBudgets = [];
  const driftAlerts = [];
  let globalBlocks = 0;
  let globalTokens = 0;

  if ((dynamicContextDiff?.summary?.sectionCoverage || 0) < 1) {
    driftAlerts.push({
      severity: 'high',
      type: 'coverage-drop',
      message: `Dynamic context sectionCoverage is ${dynamicContextDiff?.summary?.sectionCoverage || 0}; inspect misses before any runtime migration.`,
    });
  }

  for (const roleDiff of dynamicContextDiff?.roleDiffs || []) {
    const selectedBlocks = [];
    const omittedBlocks = [];
    const seen = new Set();
    let roleTokens = 0;

    for (const section of roleDiff.sectionDiffs || []) {
      if (!section.matched) {
        driftAlerts.push({
          severity: 'high',
          type: 'unmatched-injection',
          stage: roleDiff.stage,
          role: roleDiff.role,
          source: section.source,
          message: 'Injected ContextLoader section is not covered by PromptContextRegistry.',
        });
        continue;
      }
      if (!isContextLoaderDocArtifact(section.match?.type)) continue;
      const entry = entryMap.get(section.match.registryId);
      if (!entry || seen.has(entry.registryId)) continue;
      seen.add(entry.registryId);
      const ref = buildSelectionRef(section, entry);
      const wouldExceedRole = selectedBlocks.length >= effectiveBudget.perRoleMaxBlocks
        || roleTokens + ref.tokenEstimate > effectiveBudget.perRoleMaxTokens;
      const wouldExceedGlobal = globalBlocks >= effectiveBudget.globalMaxBlocks
        || globalTokens + ref.tokenEstimate > effectiveBudget.globalMaxTokens;

      if ((section.match.score || 0) < effectiveBudget.warnMatchScore) {
        driftAlerts.push({
          severity: (section.match.score || 0) < effectiveBudget.minMatchScore ? 'medium' : 'low',
          type: 'low-match-score',
          stage: roleDiff.stage,
          role: roleDiff.role,
          source: section.source,
          match: section.match.blockId,
          score: section.match.score,
          message: 'Matched registry block is below preferred confidence threshold; keep as diagnostic until reviewed.',
        });
      }
      if (!entry.sourceHash) {
        driftAlerts.push({
          severity: 'low',
          type: 'missing-source-hash',
          stage: roleDiff.stage,
          role: roleDiff.role,
          source: entry.source,
          message: 'Selected registry block has no sourceHash; drift detection may be weaker.',
        });
      }

      if (wouldExceedRole || wouldExceedGlobal) {
        omittedBlocks.push({ ...ref, reason: wouldExceedGlobal ? 'global-budget-exceeded' : 'role-budget-exceeded' });
        driftAlerts.push({
          severity: 'info',
          type: 'budget-omission',
          stage: roleDiff.stage,
          role: roleDiff.role,
          source: entry.source,
          message: `${entry.blockId} omitted from shadow selection because ${wouldExceedGlobal ? 'global' : 'role'} budget would be exceeded.`,
        });
        continue;
      }

      selectedBlocks.push(ref);
      roleTokens += ref.tokenEstimate;
      globalBlocks++;
      globalTokens += ref.tokenEstimate;
    }

    roleBudgets.push({
      stage: roleDiff.stage,
      role: roleDiff.role,
      injectedSections: roleDiff.injectedSections,
      selectedBlocks: selectedBlocks.length,
      selectedEstimatedTokens: roleTokens,
      omittedBlocks: omittedBlocks.length,
      budget: {
        maxBlocks: effectiveBudget.perRoleMaxBlocks,
        maxTokens: effectiveBudget.perRoleMaxTokens,
      },
      blocks: selectedBlocks,
      omissions: omittedBlocks,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    description: 'Shadow selection budget for context-loader-doc/artifact registry blocks. This report is diagnostic only and does not change runtime prompt output.',
    budget: effectiveBudget,
    summary: {
      rolesCompared: roleBudgets.length,
      selectedBlocks: roleBudgets.reduce((sum, item) => sum + item.selectedBlocks, 0),
      selectedEstimatedTokens: roleBudgets.reduce((sum, item) => sum + item.selectedEstimatedTokens, 0),
      omittedBlocks: roleBudgets.reduce((sum, item) => sum + item.omittedBlocks, 0),
      driftAlertCount: driftAlerts.length,
      highDriftAlertCount: driftAlerts.filter(alert => alert.severity === 'high').length,
    },
    roleBudgets,
    driftAlerts,
  };
}

module.exports = {
  textTokens,
  comparePromptTexts,
  viewById,
  registryEntryMap,
  mergeAssemblyRefs,
  refFromEntry,
  rolePrefixEntry,
  selectRoleSpecificRefs,
  extractMarkdownSection,
  resolveFullBlockContent,
  renderCandidatePrompt,
  loadRuntimePromptSnapshots,
  buildPromptContextAssemblerShadowDiff,
  formatAssemblerShadowDiffReport,
  sourceBase,
  dynamicContextRegistryEntries,
  tokenOverlapScore,
  bestRegistryMatchForContextSection,
  buildPromptContextDynamicContextShadowDiff,
  formatDynamicContextShadowDiffReport,
  isContextLoaderDocArtifact,
  buildSelectionRef,
  buildPromptContextSelectionBudget,
};

