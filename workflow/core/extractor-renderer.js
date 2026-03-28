/**
 * Business Logic Extractor Renderer
 *
 * Visualization and output formatting functions.
 * Extracted from business-logic-extractor.js for maintainability.
 *
 * @module workflow/core/extractor-renderer
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Mermaid Diagram Generator ────────────────────────────────────────────────

/**
 * Generates a Mermaid flowchart from business logic patterns.
 *
 * @param {object} analysis - Analysis result from BusinessLogicExtractor
 * @param {object} options - Rendering options
 * @returns {string} Mermaid diagram source
 */
function renderMermaidDiagram(analysis, options = {}) {
  const {
    maxNodes = 30,
    showLayers = true,
    direction = 'TD', // TD (top-down) or LR (left-right)
  } = options;

  if (!analysis || !analysis.patterns) {
    return '```mermaid\ngraph TD\n  NoData[No patterns found]\n```';
  }

  const lines = [`\`\`\`mermaid`, `graph ${direction}`];

  // Define subgraphs for layers
  if (showLayers && analysis.layers) {
    for (const [layer, symbols] of Object.entries(analysis.layers)) {
      if (symbols.length === 0) continue;
      lines.push(`  subgraph ${layer}["${layer.toUpperCase()}"]`);
      for (const sym of symbols.slice(0, 10)) {
        const safeId = sanitizeMermaidId(sym.id || sym.name);
        const label = truncateLabel(sym.name || sym.id, 20);
        lines.push(`    ${safeId}["${label}"]`);
      }
      lines.push('  end');
    }
  } else {
    // Flat node list
    const nodes = (analysis.patterns.entryPoints || [])
      .concat(analysis.patterns.coreServices || [])
      .slice(0, maxNodes);

    for (const node of nodes) {
      const safeId = sanitizeMermaidId(node.id || node.name);
      const label = truncateLabel(node.name || node.id, 20);
      const shape = node.isEntry ? `([${label}])` : `[${label}]`;
      lines.push(`  ${safeId}${shape}`);
    }
  }

  // Add edges (call relationships)
  if (analysis.callGraph) {
    const edges = analysis.callGraph.edges || [];
    for (const edge of edges.slice(0, 50)) {
      const from = sanitizeMermaidId(edge.from);
      const to = sanitizeMermaidId(edge.to);
      lines.push(`  ${from} --> ${to}`);
    }
  }

  lines.push('```');
  return lines.join('\n');
}

/**
 * Sanitizes a string for use as a Mermaid node ID.
 */
function sanitizeMermaidId(id) {
  if (!id) return 'node';
  return id
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30) || 'node';
}

/**
 * Truncates a label to fit within diagram constraints.
 */
function truncateLabel(label, maxLen = 20) {
  if (!label) return 'unnamed';
  const escaped = label.replace(/"/g, "'");
  if (escaped.length <= maxLen) return escaped;
  return escaped.slice(0, maxLen - 3) + '...';
}

// ─── JSON Report Generator ────────────────────────────────────────────────────

/**
 * Generates a structured JSON report from analysis.
 *
 * @param {object} analysis - Analysis result
 * @param {object} options - Output options
 * @returns {object} Structured report object
 */
function generateJsonReport(analysis, options = {}) {
  const {
    includeCallGraph = true,
    includeMetrics = true,
    prettyPrint = false,
  } = options;

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      extractorVersion: '2.0.0',
    },
    summary: {
      totalPatterns: 0,
      entryPoints: 0,
      coreServices: 0,
      flows: 0,
    },
    patterns: {},
    layers: {},
  };

  if (!analysis) return report;

  // Populate summary
  if (analysis.patterns) {
    report.patterns = analysis.patterns;
    report.summary.entryPoints = (analysis.patterns.entryPoints || []).length;
    report.summary.coreServices = (analysis.patterns.coreServices || []).length;
    report.summary.flows = (analysis.patterns.businessFlows || []).length;
    report.summary.totalPatterns = report.summary.entryPoints + report.summary.coreServices;
  }

  // Populate layers
  if (analysis.layers) {
    report.layers = analysis.layers;
  }

  // Include call graph
  if (includeCallGraph && analysis.callGraph) {
    report.callGraph = {
      nodes: analysis.callGraph.nodes || [],
      edges: (analysis.callGraph.edges || []).map(e => ({
        from: e.from,
        to: e.to,
        weight: e.weight || 1,
      })),
    };
  }

  // Include metrics
  if (includeMetrics && analysis.metrics) {
    report.metrics = analysis.metrics;
  }

  return report;
}

// ─── Markdown Report Generator ────────────────────────────────────────────────

/**
 * Generates a human-readable Markdown report.
 *
 * @param {object} analysis - Analysis result
 * @param {object} options - Rendering options
 * @returns {string} Markdown document
 */
function generateMarkdownReport(analysis, options = {}) {
  const { includeDiagram = true } = options;

  const sections = [];

  // Header
  sections.push('# Business Logic Analysis Report', '');
  sections.push(`Generated: ${new Date().toISOString()}`, '');

  if (!analysis) {
    sections.push('## No Analysis Data', '', 'No analysis data available.');
    return sections.join('\n');
  }

  // Summary
  sections.push('## Summary', '');
  if (analysis.patterns) {
    const entryCount = (analysis.patterns.entryPoints || []).length;
    const coreCount = (analysis.patterns.coreServices || []).length;
    const flowCount = (analysis.patterns.businessFlows || []).length;
    sections.push(`- **Entry Points**: ${entryCount}`);
    sections.push(`- **Core Services**: ${coreCount}`);
    sections.push(`- **Business Flows**: ${flowCount}`);
  }
  sections.push('');

  // Entry Points
  if (analysis.patterns?.entryPoints?.length > 0) {
    sections.push('## Entry Points', '');
    for (const ep of analysis.patterns.entryPoints.slice(0, 20)) {
      sections.push(`### ${ep.name || ep.id}`);
      if (ep.file) sections.push(`- **File**: \`${ep.file}\``);
      if (ep.category) sections.push(`- **Category**: ${ep.category}`);
      if (ep.layer) sections.push(`- **Layer**: ${ep.layer}`);
      sections.push('');
    }
  }

  // Core Services
  if (analysis.patterns?.coreServices?.length > 0) {
    sections.push('## Core Services', '');
    for (const svc of analysis.patterns.coreServices.slice(0, 20)) {
      sections.push(`### ${svc.name || svc.id}`);
      if (svc.file) sections.push(`- **File**: \`${svc.file}\``);
      if (svc.category) sections.push(`- **Category**: ${svc.category}`);
      if (svc.calledByCount) sections.push(`- **Called By**: ${svc.calledByCount} symbols`);
      sections.push('');
    }
  }

  // Business Flows
  if (analysis.patterns?.businessFlows?.length > 0) {
    sections.push('## Business Flows', '');
    for (const flow of analysis.patterns.businessFlows.slice(0, 10)) {
      sections.push(`### ${flow.name || 'Unnamed Flow'}`);
      if (flow.chain && flow.chain.length > 0) {
        sections.push('**Call Chain**:', '');
        sections.push('```');
        sections.push(flow.chain.join(' → '));
        sections.push('```');
      }
      sections.push('');
    }
  }

  // Mermaid Diagram
  if (includeDiagram) {
    sections.push('## Architecture Diagram', '');
    sections.push(renderMermaidDiagram(analysis, { maxNodes: 20 }));
    sections.push('');
  }

  return sections.join('\n');
}

// ─── File Output Utilities ─────────────────────────────────────────────────────

/**
 * Writes analysis results to files.
 *
 * @param {string} outputDir - Output directory path
 * @param {object} analysis - Analysis result
 * @param {object} options - Output options
 * @returns {object} { json: string, md: string }
 */
function writeAnalysisOutput(outputDir, analysis, options = {}) {
  const {
    jsonFile = 'business-logic.json',
    mdFile = 'business-logic.md',
  } = options;

  const outputPath = path.resolve(outputDir);

  // Ensure output directory exists
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }

  const jsonPath = path.join(outputPath, jsonFile);
  const mdPath = path.join(outputPath, mdFile);

  // Generate and write JSON
  const jsonReport = generateJsonReport(analysis, { includeCallGraph: true });
  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf-8');

  // Generate and write Markdown
  const mdReport = generateMarkdownReport(analysis, { includeDiagram: true });
  fs.writeFileSync(mdPath, mdReport, 'utf-8');

  return { json: jsonPath, md: mdPath };
}

// ─── Console Summary ──────────────────────────────────────────────────────────

/**
 * Prints a compact summary to console.
 *
 * @param {object} analysis - Analysis result
 */
function printConsoleSummary(analysis) {
  if (!analysis) {
    console.log('No analysis data available.');
    return;
  }

  console.log('\n📊 Business Logic Analysis Summary\n');
  console.log('─'.repeat(40));

  if (analysis.patterns) {
    const entries = analysis.patterns.entryPoints || [];
    const cores = analysis.patterns.coreServices || [];
    const flows = analysis.patterns.businessFlows || [];

    console.log(`Entry Points:     ${entries.length}`);
    console.log(`Core Services:    ${cores.length}`);
    console.log(`Business Flows:   ${flows.length}`);
  }

  if (analysis.metrics) {
    console.log(`Files Analyzed:   ${analysis.metrics.filesAnalyzed || 0}`);
    console.log(`Symbols Found:    ${analysis.metrics.symbolsFound || 0}`);
    console.log(`Call Relations:   ${analysis.metrics.callRelations || 0}`);
  }

  console.log('─'.repeat(40));
  console.log('');
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Mermaid
  renderMermaidDiagram,
  sanitizeMermaidId,
  truncateLabel,

  // Reports
  generateJsonReport,
  generateMarkdownReport,
  writeAnalysisOutput,

  // Console
  printConsoleSummary,
};
