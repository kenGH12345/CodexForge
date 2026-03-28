/**
 * ProjectProfiler Renderer
 *
 * Markdown rendering functions for project profile output.
 * Extracted from project-profiler.js to improve maintainability.
 *
 * @module workflow/core/profiler-renderer
 */

'use strict';

// ─── Directory Purpose Inference ──────────────────────────────────────────────

/**
 * Infers human-readable purpose of a directory from its name.
 * Used by P1 fallback baseline profile.
 *
 * @param {string} dirName - Directory name
 * @returns {string} Human-readable purpose
 */
function inferDirPurpose(dirName) {
  const purposes = {
    src: 'Source code',
    lib: 'Library / shared utilities',
    core: 'Core business logic',
    app: 'Application entry / main module',
    pkg: 'Package modules',
    internal: 'Internal / private modules',
    cmd: 'CLI entry points',
    api: 'API layer',
    config: 'Configuration files',
    configs: 'Configuration files',
    tests: 'Test suites',
    test: 'Test suites',
    spec: 'Test specifications',
    docs: 'Documentation',
    scripts: 'Build / utility scripts',
    tools: 'Tooling / dev tools',
    utils: 'Utility functions',
    helpers: 'Helper functions',
    hooks: 'Hooks / plugins / adapters',
    adapters: 'External integrations / adapters',
    middleware: 'Middleware layer',
    services: 'Service layer',
    models: 'Data models',
    views: 'View layer / templates',
    components: 'UI components',
    pages: 'Page components / routes',
    assets: 'Static assets',
    public: 'Public / static files',
    output: 'Generated output / artifacts',
    workflow: 'Workflow engine / pipeline',
    agents: 'Agent definitions',
    commands: 'Command handlers',
    skills: 'Skill knowledge base',
    stages: 'Pipeline stage implementations',
  };
  return purposes[dirName.toLowerCase()] || 'Project module';
}

// ─── Compact Profile Summary ─────────────────────────────────────────────────

/**
 * Generates a compact Markdown summary of the project profile,
 * suitable for injection into AGENTS.md.
 *
 * @param {object} profile - Output of ProjectProfiler.analyze()
 * @returns {string} Compact Markdown section
 */
function renderCompactProfileSummary(profile) {
  if (!profile) return '';

  const lines = [`## Project Architecture Profile`, ``];

  // Frameworks (one-liner)
  if (profile.frameworks && profile.frameworks.length > 0) {
    const fwNames = profile.frameworks.map(f => f.name);
    lines.push(`- **Frameworks**: ${fwNames.join(', ')}`);
  }

  // Architecture
  if (profile.architecture && profile.architecture.pattern) {
    lines.push(`- **Architecture**: ${profile.architecture.pattern}`);
    if (profile.architecture.layers && profile.architecture.layers.length > 0) {
      lines.push(`- **Layers**: ${profile.architecture.layers.join(' → ')}`);
    }
  }

  // Data Layer (one-liner)
  if (profile.dataLayer) {
    const parts = [];
    if (profile.dataLayer.orm && profile.dataLayer.orm.length > 0) parts.push(profile.dataLayer.orm.join(', '));
    if (profile.dataLayer.databases && profile.dataLayer.databases.length > 0) parts.push(profile.dataLayer.databases.join(', '));
    if (parts.length > 0) lines.push(`- **Data Layer**: ${parts.join(' + ')}`);
  }

  // Communication (one-liner)
  if (profile.communication && profile.communication.length > 0) {
    lines.push(`- **Communication**: ${profile.communication.join(', ')}`);
  }

  // Testing (one-liner)
  if (profile.testing && profile.testing.frameworks && profile.testing.frameworks.length > 0) {
    lines.push(`- **Testing**: ${profile.testing.frameworks.join(', ')}`);
  }

  // Infrastructure (one-liner)
  if (profile.infrastructure) {
    const parts = [];
    if (profile.infrastructure.containerized) parts.push('Docker');
    if (profile.infrastructure.ci) parts.push(profile.infrastructure.ci);
    if (profile.infrastructure.orchestration) parts.push(profile.infrastructure.orchestration);
    if (parts.length > 0) lines.push(`- **Infrastructure**: ${parts.join(', ')}`);
  }

  // Monorepo
  if (profile.monorepo && profile.monorepo.isMonorepo) {
    lines.push(`- **Monorepo**: ${profile.monorepo.tool} (${profile.monorepo.packages.length} packages)`);
  }

  // Entry points
  if (profile.entryPoints && profile.entryPoints.length > 0) {
    lines.push(`- **Entry Points**: ${profile.entryPoints.map(e => '`' + e + '`').join(', ')}`);
  }

  // LSP enhancement marker + compact data summary
  if (profile.lspEnhanced) {
    const stats = profile.lspStats || {};
    lines.push(`- **LSP Enhanced**: ${profile.lspServerName || 'auto'} (${stats.symbolsCollected || 0} symbols, ${stats.filesAnalyzed || 0} files)`);

    // Symbol inventory: show top 3 symbol kinds by count
    if (profile.architecture && profile.architecture.symbolInventory) {
      const inv = profile.architecture.symbolInventory;
      const top3 = Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (top3.length > 0) {
        lines.push(`- **Symbol Inventory (top)**: ${top3.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
      }
    }

    // Decorator patterns: one-liner summary
    if (profile.architecture && profile.architecture.decoratorPatterns) {
      const decs = profile.architecture.decoratorPatterns;
      const decEntries = Object.entries(decs);
      if (decEntries.length > 0) {
        lines.push(`- **Decorator Patterns**: ${decEntries.map(([layer, ds]) => `${layer}(${ds.join(', ')})`).join(' | ')}`);
      }
    }

    // Diagnostics: one-liner summary
    if (profile.diagnostics) {
      const diag = profile.diagnostics;
      lines.push(`- **Compiler Diagnostics**: ${diag.errors || 0} errors, ${diag.warnings || 0} warnings`);
    }
  }

  lines.push(``);
  return lines.join('\n');
}

// ─── Full Markdown Report ────────────────────────────────────────────────────

/**
 * Generates a full Markdown report of the project profile.
 *
 * @param {object} profile - Output of ProjectProfiler.analyze()
 * @returns {string} Full Markdown report
 */
function renderFullProfileReport(profile) {
  if (!profile) return '';

  const sections = [];

  // Header
  sections.push(`# Project Profile Report`, ``, `Generated: ${new Date().toISOString()}`, ``);

  // Summary
  sections.push(`## Summary`, ``);
  sections.push(renderCompactProfileSummary(profile));

  // Frameworks
  if (profile.frameworks && profile.frameworks.length > 0) {
    sections.push(`## Frameworks`, ``);
    for (const fw of profile.frameworks) {
      sections.push(`- **${fw.name}** (${fw.category}, ${fw.lang})`);
    }
    sections.push(``);
  }

  // Architecture
  if (profile.architecture) {
    sections.push(`## Architecture`, ``);
    sections.push(`- **Pattern**: ${profile.architecture.pattern || 'Unknown'}`);
    if (profile.architecture.layers && profile.architecture.layers.length > 0) {
      sections.push(`- **Layers**: ${profile.architecture.layers.join(' → ')}`);
    }
    sections.push(``);
  }

  // Data Layer
  if (profile.dataLayer) {
    sections.push(`## Data Layer`, ``);
    if (profile.dataLayer.orm && profile.dataLayer.orm.length > 0) {
      sections.push(`- **ORM**: ${profile.dataLayer.orm.join(', ')}`);
    }
    if (profile.dataLayer.databases && profile.dataLayer.databases.length > 0) {
      sections.push(`- **Databases**: ${profile.dataLayer.databases.join(', ')}`);
    }
    sections.push(``);
  }

  // Testing
  if (profile.testing && profile.testing.frameworks && profile.testing.frameworks.length > 0) {
    sections.push(`## Testing`, ``);
    sections.push(`- **Frameworks**: ${profile.testing.frameworks.join(', ')}`);
    sections.push(``);
  }

  // Infrastructure
  if (profile.infrastructure && Object.keys(profile.infrastructure).length > 0) {
    sections.push(`## Infrastructure`, ``);
    if (profile.infrastructure.containerized) sections.push(`- **Containerized**: Yes`);
    if (profile.infrastructure.ci) sections.push(`- **CI/CD**: ${profile.infrastructure.ci}`);
    if (profile.infrastructure.orchestration) sections.push(`- **Orchestration**: ${profile.infrastructure.orchestration}`);
    if (profile.infrastructure.iac) sections.push(`- **IaC**: ${profile.infrastructure.iac}`);
    sections.push(``);
  }

  // APIs
  if (profile.apis && profile.apis.length > 0) {
    sections.push(`## APIs`, ``);
    for (const api of profile.apis) {
      sections.push(`- ${api}`);
    }
    sections.push(``);
  }

  // Entry Points
  if (profile.entryPoints && profile.entryPoints.length > 0) {
    sections.push(`## Entry Points`, ``);
    for (const ep of profile.entryPoints) {
      sections.push(`- \`${ep}\``);
    }
    sections.push(``);
  }

  return sections.join('\n');
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  inferDirPurpose,
  renderCompactProfileSummary,
  renderFullProfileReport,
};
