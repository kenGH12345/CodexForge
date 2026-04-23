'use strict';

function buildCapabilityCatalog({ mode = 'node', capabilities = {} } = {}) {
  const core = [
    { id: 'workflow-sequential', when: 'default', desc: 'Run ANALYSE→ARCHITECT→PLAN→CODE→TEST pipeline' },
    { id: 'quality-gate', when: 'post-stage', desc: 'Validate quality thresholds and detect regressions' },
    { id: 'read-only-explore', when: 'analysis', desc: 'Read-only repository exploration with evidence output' },
    { id: 'experience-store', when: 'reuse', desc: 'Search and reuse historical experiences/skills' },
  ];

  const ideSpecific = [
    { id: 'ide-codebase-search', when: 'navigation', desc: 'Semantic code search in IDE mode' },
    { id: 'ide-view-code-item', when: 'symbol-inspection', desc: 'Symbol-level code definition lookup' },
    { id: 'ide-grep-search', when: 'exact-match', desc: 'Regex/exact text search for fast pinpointing' },
  ];

  const nodeSpecific = [
    { id: 'code-graph', when: 'fallback', desc: 'Self-built symbol graph fallback and offline analysis' },
    { id: 'lsp-adapter', when: 'fallback', desc: 'LSP-backed type and reference analysis fallback' },
  ];

  const list = mode === 'ide'
    ? core.concat(ideSpecific)
    : core.concat(nodeSpecific);

  const dynamic = Object.entries(capabilities || {})
    .filter(([, v]) => !!v)
    .map(([k]) => ({ id: `cap-${k}`, when: 'runtime-detected', desc: `Runtime capability available: ${k}` }));

  const result = list.concat(dynamic);
  // catalog size jumping unexpectedly often masks mode-detection bugs
  console.error(`[capability-catalog] built mode=${mode} total=${result.length} dynamic=${dynamic.length}`);
  return result;
}

function formatCapabilityCatalogForPrompt(catalog = []) {
  const lines = ['## Runtime Capability Catalog', 'Use these capabilities explicitly based on scenario fit:'];
  for (const item of catalog) {
    lines.push(`- ${item.id}: ${item.desc} (when: ${item.when})`);
  }
  return lines.join('\n');
}

module.exports = {
  buildCapabilityCatalog,
  formatCapabilityCatalogForPrompt,
};