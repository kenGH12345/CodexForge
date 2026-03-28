/**
 * DevTools Commands - Code Analysis & Intelligence (graph, trends, article-scout, techradar)
 *
 * Split from commands-devtools.js for maintainability (ADR-33 Phase 3).
 *
 * @module workflow/commands/commands-devtools-analysis
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../core/constants');

/**
 * Registers analysis devtools commands.
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 */
function registerAnalysisCommands(registerCommand) {
registerCommand(
  'graph',
  'Build or query the structured code graph. Usage: /graph [build] [search <keyword>] [file <path>] [calls <symbol>] [hotspot [N]] [reusable]',
  async (args, context) => {
    const { CodeGraph } = require('../core/code-graph');
    const { PATHS }     = require('../core/constants');
    const projectRoot   = context.orchestrator?.projectRoot || path.resolve(__dirname, '..', '..');
    const cfg           = context.orchestrator?._config || {};

    // P0 optimisation: reuse the orchestrator's shared CodeGraph instance for queries.
    // Only create a new instance for build commands (which need fresh config).
    const graph = context.orchestrator?.codeGraph || new CodeGraph({
      projectRoot,
      outputDir:      PATHS.OUTPUT_DIR,
      extensions:     cfg.sourceExtensions,
      ignoreDirs:     cfg.ignoreDirs,
      scopeDirs:      cfg.codeGraph?.scopeDirs,
    });

    // /graph build – rebuild the index (supports --force for full rebuild)
    if (!args || args.trim() === '' || args.includes('build')) {
      const forceRebuild = args && args.includes('--force');
      const result = await graph.build({ incremental: !forceRebuild, force: forceRebuild });
      const modeLabel = result.incremental
        ? `🔄 Incremental (${result.changedFiles} changed)`
        : '🔨 Full rebuild';
      return [
        `✅ **Code Graph Built**`,
        ``,
        `- Mode:            **${modeLabel}**`,
        `- Symbols indexed: **${result.symbolCount}**`,
        `- Files scanned:   **${result.fileCount}**`,
        `- Call edges:      **${result.edgeCount}**`,
        ``,
        `📄 Index: \`output/code-graph.json\``,
        `📄 Summary: \`output/code-graph.md\``,
        ``,
        `> Use \`/graph search <keyword>\` to query the index.`,
        `> Use \`/graph hotspot\` to view hotspot analysis.`,
        `> Use \`/graph reusable\` to see recommended reusable symbols.`,
        `> Use \`/graph build --force\` to force a full rebuild.`,
      ].join('\n');
    }

    // Load existing graph from disk for queries.
    // P1 optimisation: use _loadFromDisk() which benefits from process-level cache,
    // instead of manually reading and parsing the JSON file (which bypassed the cache).
    const loadGraph = () => {
      if (graph._symbols.size > 0) return true;  // Already loaded (e.g. from orchestrator instance)
      graph._loadFromDisk();
      return graph._symbols.size > 0 ? true : null;
    };

    // /graph search <keyword>
    const searchMatch = args.match(/search\s+(.+)/);
    if (searchMatch) {
      const data = loadGraph();
      if (!data) return '❌ No code graph found. Run `/graph build` first.';
      const results = graph.search(searchMatch[1].trim(), { limit: 15 });
      if (results.length === 0) return `No symbols found matching "${searchMatch[1]}".`;
      const lines = [`## 🔍 Code Graph Search: "${searchMatch[1]}" (${results.length} results)\n`];
      for (const s of results) {
        // search() now auto-enriches results (P2 hardening), no manual call needed
        // P1: Check LSP cache for compiler-accurate type info
        const lspData = graph._lspCache?.get(s.id);
        const calls = (graph._callEdges.get(s.id) || []).length;
        const sig = s.signature ? ` \`${s.signature}\`` : '';
        const ctorSig = s._constructorSignature ? ` 🔨 \`${s._constructorSignature}\`` : '';
        const ext = s._extends && s._extends.length > 0 ? ` ← ${s._extends.join(', ')}` : '';
        const summary = s.summary ? `\n  > ${s.summary}` : (s._inferredSummary ? `\n  > _${s._inferredSummary}_` : '');
        const lspType = lspData?.typeInfo ? `\n  > 🔬 **LSP**: \`${lspData.typeInfo}\`` : '';
        // P0: Show importance weight badge for highly-referenced symbols
        const iw = graph.getImportanceWeight ? graph.getImportanceWeight(s.id) : 0;
        const iwBadge = iw > 0.3 ? ` ⭐${Math.round(iw * 100)}%` : '';
        lines.push(`- \`${s.kind}\` **${s.name}**${sig}${ctorSig} in \`${s.file}\`:${s.line}${ext}${iwBadge}${calls ? ` → ${calls} call(s)` : ''}${summary}${lspType}`);
      }
      return lines.join('\n');
    }

    // /graph file <path>
    const fileMatch = args.match(/file\s+(.+)/);
    if (fileMatch) {
      const data = loadGraph();
      if (!data) return '❌ No code graph found. Run `/graph build` first.';
      const results = graph.getFileSymbols(fileMatch[1].trim());
      if (results.length === 0) return `No symbols found in files matching "${fileMatch[1]}".`;
      const lines = [`## 📄 Symbols in \`${fileMatch[1]}\` (${results.length})\n`];
      for (const s of results) {
        lines.push(`- \`${s.kind}\` **${s.name}**${s.signature ? `(${s.signature})` : ''} :${s.line}${s.summary ? ` // ${s.summary}` : ''}`);
      }
      return lines.join('\n');
    }

    // /graph calls <symbol>
    const callsMatch = args.match(/calls\s+(.+)/);
    if (callsMatch) {
      const data = loadGraph();
      if (!data) return '❌ No code graph found. Run `/graph build` first.';
      const { calls, calledBy } = graph.getCallGraph(callsMatch[1].trim());
      const lines = [`## 📞 Call Graph: \`${callsMatch[1]}\`\n`];
      lines.push(`**Calls** (${calls.length}): ${calls.length ? calls.join(', ') : '_none_'}`);
      lines.push(`**Called by** (${calledBy.length}): ${calledBy.length ? calledBy.join(', ') : '_none_'}`);
      return lines.join('\n');
    }

    // /graph hotspot [N] – show hotspot analysis (top referenced symbols)
    const hotspotMatch = args.match(/hotspot(?:\s+(\d+))?/);
    if (hotspotMatch) {
      const data = loadGraph();
      if (!data) return '❌ No code graph found. Run `/graph build` first.';
      const topN = hotspotMatch[1] ? parseInt(hotspotMatch[1], 10) : 20;
      return graph.hotspotsAsMarkdown(topN);
    }

    // /graph reusable – show reusable symbol recommendations
    const reusableMatch = args.match(/reusable|reuse/);
    if (reusableMatch) {
      const data = loadGraph();
      if (!data) return '❌ No code graph found. Run `/graph build` first.';
      const digest = graph.getReusableSymbolsDigest({ maxItems: 20 });
      if (!digest) return '_No reusable symbols found. Build the graph with more files._';
      return digest;
    }

    return `Usage: \`/graph build\` | \`/graph search <keyword>\` | \`/graph file <path>\` | \`/graph calls <symbol>\` | \`/graph hotspot [N]\` | \`/graph reusable\``;
  }
);


registerCommand(
  'trends',
  'Show cross-session metrics trends from metrics-history.jsonl',
  async (_args, _context) => {
    const { Observability } = require('../core/observability');
    const { PATHS }         = require('../core/constants');

    const history = Observability.loadHistory(PATHS.OUTPUT_DIR);
    if (history.length === 0) {
      return `No history found. Run at least one workflow session to generate \`output/metrics-history.jsonl\`.`;
    }

    const trends = Observability.computeTrends(history);
    const trendIcon = (t) => t === 'increasing' ? '📈' : t === 'decreasing' ? '📉' : '➡️ ';

    const lines = [
      `## 📊 Cross-Session Metrics Trends`,
      ``,
      `> Based on **${trends.sessionCount}** sessions | Last: ${trends.lastSession?.slice(0, 10) || '–'}`,
      ``,
      `| Metric | Average | Trend |`,
      `|--------|---------|-------|`,
      `| Duration | ${(trends.avgDurationMs / 1000).toFixed(1)}s | ${trendIcon(trends.durationTrend)} ${trends.durationTrend} |`,
      `| Tokens (est.) | ~${trends.avgTokensEst.toLocaleString()} | ${trendIcon(trends.tokenTrend)} ${trends.tokenTrend} |`,
      `| Errors | ${trends.avgErrorCount} | ${trendIcon(trends.errorTrend)} ${trends.errorTrend} |`,
      `| Entropy violations | ${trends.avgEntropyViolations} | ${trendIcon(trends.entropyTrend)} ${trends.entropyTrend} |`,
    ];

    if (trends.ciSuccessRate != null) {
      lines.push(`| CI Success Rate | ${(trends.ciSuccessRate * 100).toFixed(0)}% | – |`);
    }

    lines.push('');
    lines.push(`### Recent Sessions (last 5)`);
    lines.push(`| Session | Date | Duration | Tokens | Errors | CI |`);
    lines.push(`|---------|------|----------|--------|--------|----|`);
    for (const h of history.slice(0, 5)) {
      const dur = h.totalDurationMs ? `${(h.totalDurationMs / 1000).toFixed(1)}s` : '–';
      const ci  = h.ciStatus ? (h.ciStatus === 'success' ? '✅' : '❌') : '–';
      lines.push(`| \`${h.sessionId?.slice(-12) || '?'}\` | ${h.startedAt?.slice(0, 10) || '–'} | ${dur} | ~${(h.tokensEst || 0).toLocaleString()} | ${h.errorCount || 0} | ${ci} |`);
    }

    return lines.join('\n');
  }
);


registerCommand(
  'article-scout',
  'Search, evaluate, and extract knowledge from AI/Agent articles. Usage: /article-scout [--topic <custom topic>] [--dry-run] [--verbose]',
  async (args, context) => {
    const { ArticleScout } = require('../core/article-scout');

    // Parse arguments
    const parts = (args || '').trim().split(/\\s+/).filter(Boolean);
    const verbose = parts.includes('--verbose');
    const dryRun = parts.includes('--dry-run');

    let customTopics = null;
    const topicIdx = parts.indexOf('--topic');
    if (topicIdx !== -1) {
      const topicQuery = parts.slice(topicIdx + 1).filter(p => !p.startsWith('--')).join(' ');
      if (topicQuery) {
        customTopics = [{ query: topicQuery, label: `Custom: ${topicQuery.slice(0, 50)}` }];
      }
    }

    const orchestrator = context.orchestrator || null;
    const scout = new ArticleScout({ orchestrator, verbose });

    const scoutOpts = { dryRun };
    if (customTopics) scoutOpts.topics = customTopics;

    const result = await scout.run(scoutOpts);

    const lines = [
      `## 🔍 Article Scout Report`,
      ``,
      `**Duration**: ${(result.elapsedMs / 1000).toFixed(1)}s`,
      `**Articles evaluated**: ${result.evaluations.length}`,
      `**High-value articles**: ${result.highValueCount}`,
      `**Knowledge entries injected**: ${result.injectedCount}${dryRun ? ' (dry run)' : ''}`,
      ``,
    ];

    if (result.evaluations.length > 0) {
      lines.push(`| Article | Score | Relevance | Novelty | Actionability | System Fit | Cost |`);
      lines.push(`|---------|-------|-----------|---------|---------------|------------|------|`);
      for (const e of result.evaluations.sort((a, b) => b.compositeScore - a.compositeScore)) {
        const flag = e.compositeScore >= 0.55 ? '⭐' : '⚪';
        lines.push(`| ${flag} ${e.title.slice(0, 40)} | **${e.compositeScore.toFixed(2)}** | ${e.scores.relevance} | ${e.scores.novelty} | ${e.scores.actionability} | ${e.scores.systemFit} | ${e.implementationCost} |`);
      }
      lines.push(``);

      // Show recommendations from high-value articles
      const highValue = result.evaluations.filter(e => e.compositeScore >= 0.55);
      if (highValue.length > 0 && highValue[0].summary) {
        lines.push(`### Top Article Summary`);
        lines.push(`> ${highValue[0].summary}`);
        lines.push(``);
        if (highValue[0].crossDomainValue) {
          lines.push(`**Cross-domain value**: ${highValue[0].crossDomainValue}`);
        }
        if (highValue[0].riskAssessment) {
          lines.push(`**Risk**: ${highValue[0].riskAssessment}`);
        }
        lines.push(``);
      }
    } else {
      lines.push(`### ℹ️ No Articles Found`);
      lines.push(`No articles retrieved. This may be due to API rate limiting or network issues.`);
    }

    lines.push(`> 📄 Full report: \`output/article-scout-report.md\``);
    if (dryRun) {
      lines.push(`> 💡 This was a dry run. Run \`/article-scout\` without --dry-run to inject knowledge.`);
    }

    return lines.join('\n');
  }
);


registerCommand(
  'techradar',
  'Scan for new AI/Agent techniques and evaluate upgrade opportunities. Usage: /techradar [--topic <custom topic>] [--inject] [--verbose]',
  async (args, context) => {
    const { TechRadar } = require('../core/techradar');

    // Parse arguments
    const parts = (args || '').trim().split(/\s+/).filter(Boolean);
    const verbose = parts.includes('--verbose');
    const autoInject = parts.includes('--inject');

    let customTopics = null;
    const topicIdx = parts.indexOf('--topic');
    if (topicIdx !== -1) {
      const topicQuery = parts.slice(topicIdx + 1).filter(p => !p.startsWith('--')).join(' ');
      if (topicQuery) {
        customTopics = [{ query: topicQuery, label: `Custom: ${topicQuery.slice(0, 50)}`, category: 'custom' }];
      }
    }

    const orchestrator = context.orchestrator || null;
    const radar = new TechRadar({ orchestrator, verbose });

    const radarOpts = { autoInject };
    if (customTopics) radarOpts.topics = customTopics;

    const result = await radar.run(radarOpts);

    const lines = [
      `## 📡 TechRadar Report`,
      ``,
      `**Duration**: ${(result.elapsedMs / 1000).toFixed(1)}s`,
      `**Techniques evaluated**: ${result.evaluations.length}`,
      `**Adoptable techniques**: ${result.adoptableCount}`,
      `**Knowledge entries injected**: ${result.injectedCount}${!autoInject ? ' (use --inject to enable)' : ''}`,
      ``,
    ];

    if (result.evaluations.length > 0) {
      lines.push(`| Technique | Score | Relevance | Novelty | Actionability | Urgency | Effort |`);
      lines.push(`|-----------|-------|-----------|---------|---------------|---------|--------|`);
      for (const e of result.evaluations.sort((a, b) => b.adoptScore - a.adoptScore)) {
        const flag = e.adoptScore >= 0.50 ? '✅' : '⚪';
        lines.push(`| ${flag} ${e.title.slice(0, 35)} | **${e.adoptScore.toFixed(2)}** | ${e.scores.relevance} | ${e.scores.novelty} | ${e.scores.actionability} | ${e.scores.upgradeUrgency} | ${e.implementationEffort} |`);
      }
      lines.push(``);

      // Show top recommendation
      const adoptable = result.evaluations.filter(e => e.adoptScore >= 0.50);
      if (adoptable.length > 0 && adoptable[0].summary) {
        lines.push(`### Top Recommendation`);
        lines.push(`> ${adoptable[0].summary}`);
        lines.push(``);
        if (adoptable[0].recommendation) {
          lines.push(`**Action**: ${adoptable[0].recommendation}`);
        }
        if (adoptable[0].relatedModules && adoptable[0].relatedModules.length > 0) {
          lines.push(`**Related Modules**: ${adoptable[0].relatedModules.join(', ')}`);
        }
        lines.push(``);
      }
    } else {
      lines.push(`### ℹ️ No Techniques Found`);
      lines.push(`No techniques retrieved. This may be due to API rate limiting or network issues.`);
    }

    lines.push(`> 📄 Full report: \`output/techradar-report.md\``);

    return lines.join('\n');
  }
);



}

module.exports = { registerAnalysisCommands };
