/**
 * ProjectProfiler
 *
 * Deep project architecture inference engine.
 * Scans project structure, dependencies, and patterns to produce a structured profile
 * that can guide AI agents in understanding codebase architecture.
 *
 * Refactored (ADR-41): Split into modular components for maintainability:
 * - profiler-helpers.js: File system utilities and caching
 * - profiler-detection.js: Detection rules and functions
 * - profiler-renderer.js: Markdown rendering
 *
 * @module workflow/core/project-profiler
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Import refactored modules
const {
  clearFileContentCache,
  readDependencies,
  gatherConfigContent,
} = require('./profiler-helpers');

const {
  detectFrameworks,
  detectDataLayer,
  detectDatabases,
  detectTestFrameworks,
  detectArchitecture,
  detectCommunication,
  detectInfrastructure,
  detectMonorepo,
  detectAPIs,
  detectEntryPoints,
  FRAMEWORK_RULES,
  DATA_LAYER_RULES,
  DATABASE_INDICATORS,
  TEST_FRAMEWORK_RULES,
  ARCHITECTURE_PATTERNS,
} = require('./profiler-detection');

const {
  inferDirPurpose,
  renderCompactProfileSummary,
  renderFullProfileReport,
} = require('./profiler-renderer');

// Re-export for backward compatibility
const { fileExists, dirExists, hasExt, readFileContent } = require('./profiler-helpers');

// ─── ProjectProfiler Class ───────────────────────────────────────────────────

class ProjectProfiler {
  /**
   * @param {string} [projectRoot] - Project root directory (can also be passed to analyze())
   * @param {object} [options] - Configuration options
   * @param {string[]} [options.ignoreDirs] - Directories to skip during analysis
   * @param {object[]} [options.customFrameworkRules] - Custom framework detection rules
   * @param {object[]} [options.customDataLayerRules] - Custom data layer detection rules
   * @param {object[]} [options.customTestRules] - Custom test framework detection rules
   */
  constructor(projectRoot, options = {}) {
    this.name = 'ProjectProfiler';
    this._projectRoot = projectRoot || null;
    this._options = options;
  }

  /**
   * Analyzes a project and produces a structured profile.
   *
   * @param {string} [rootPath] - Project root path (defaults to constructor projectRoot)
   * @param {object} options - Analysis options
   * @param {boolean} options.lspEnhance - Whether to enhance with LSP data (future feature)
   * @returns {object} Project profile
   */
  analyze(rootPath, options = {}) {
    const startTime = Date.now();

    // Clear per-analysis cache
    clearFileContentCache();

    // Resolve root path (fallback to constructor projectRoot)
    const root = path.resolve(rootPath || this._projectRoot || process.cwd());

    // 1. Read dependencies
    const deps = readDependencies(root);

    // 2. Detect frameworks
    const frameworks = detectFrameworks(root, deps);

    // 3. Detect data layer
    const dataLayer = detectDataLayer(root, deps);
    dataLayer.databases = detectDatabases(root, deps);

    // 4. Detect testing
    const testing = {
      frameworks: detectTestFrameworks(root, deps),
    };

    // 5. Detect architecture
    const architecture = detectArchitecture(root);

    // 6. Detect communication patterns
    const communication = detectCommunication(root, deps);

    // 7. Detect infrastructure
    const infrastructure = detectInfrastructure(root);

    // 8. Detect monorepo
    const monorepo = detectMonorepo(root, deps);

    // 9. Detect APIs
    const apis = detectAPIs(root);

    // 10. Detect entry points
    const entryPoints = detectEntryPoints(root);

    // 11. Determine primary language (from detected frameworks or file extensions)
    const primaryLang = this._inferPrimaryLanguage(root, frameworks);

    // Build profile
    const profile = {
      root,
      primaryLanguage: primaryLang,
      frameworks,
      architecture,
      dataLayer,
      testing,
      communication,
      infrastructure,
      monorepo,
      apis,
      entryPoints,
      analyzedAt: new Date().toISOString(),
      analysisMs: Date.now() - startTime,
    };

    // LSP enhancement (future feature)
    if (options.lspEnhance) {
      // TODO: Integrate with LSP adapter for symbol inventory
      profile.lspEnhanced = false;
      profile.lspMessage = 'LSP enhancement not yet implemented';
    }

    return profile;
  }

  /**
   * Analyze the project and write the full report to project-profile.md.
   * Convenience method used by init-project.js.
   *
   * @returns {{ profile: object, mdPath: string }} The profile and path to the written markdown file
   */
  analyzeAndWrite() {
    const root = this._projectRoot || process.cwd();
    const profile = this.analyze(root);
    const outputDir = path.join(root, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const mdPath = path.join(outputDir, 'project-profile.md');
    const report = this.renderFullReport(profile);
    fs.writeFileSync(mdPath, report, 'utf-8');
    return { profile, mdPath };
  }

  /**
   * Analyze with LSP enhancement (future feature).
   * Currently throws to trigger the fallback path in init-project.js.
   *
   * @param {string} [rootPath] - Project root path
   * @param {object} [lspConfig] - LSP configuration
   * @returns {Promise<{ profile: object, mdPath: string }>}
   */
  async analyzeWithLSP(rootPath, lspConfig = {}) {
    // LSP enhancement is not yet implemented.
    // Throwing here causes init-project.js to fall back to analyzeAndWrite().
    throw new Error('LSP enhancement not yet implemented');
  }

  /**
   * Infers primary language from frameworks or file extensions.
   * @private
   */
  _inferPrimaryLanguage(root, frameworks) {
    // First, check detected frameworks
    if (frameworks.length > 0) {
      // Prioritize backend frameworks
      const backend = frameworks.find(f => f.category === 'backend');
      if (backend) return backend.lang;

      // Then frontend
      const frontend = frameworks.find(f => f.category === 'frontend');
      if (frontend) return frontend.lang;

      // Then any
      return frameworks[0].lang;
    }

    // Fallback: scan file extensions
    const langExtensions = {
      javascript: ['.js', '.jsx', '.mjs', '.cjs'],
      typescript: ['.ts', '.tsx'],
      python: ['.py'],
      java: ['.java'],
      go: ['.go'],
      rust: ['.rs'],
      csharp: ['.cs'],
      cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.h'],
      php: ['.php'],
      ruby: ['.rb'],
      swift: ['.swift'],
      kotlin: ['.kt', '.kts'],
      scala: ['.scala'],
      elixir: ['.ex', '.exs'],
      dart: ['.dart'],
      gdscript: ['.gd'],
    };

    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const extCounts = {};

      function scanDir(dir, depth = 0) {
        if (depth > 2) return;
        try {
          const items = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            if (item.isDirectory()) {
              if (!item.name.startsWith('.') && item.name !== 'node_modules' && item.name !== 'vendor') {
                scanDir(path.join(dir, item.name), depth + 1);
              }
            } else {
              const ext = path.extname(item.name).toLowerCase();
              extCounts[ext] = (extCounts[ext] || 0) + 1;
            }
          }
        } catch { /* ignore */ }
      }

      scanDir(root);

      // Find best match
      let bestLang = 'unknown';
      let bestCount = 0;

      for (const [lang, exts] of Object.entries(langExtensions)) {
        let count = 0;
        for (const ext of exts) {
          count += extCounts[ext] || 0;
        }
        if (count > bestCount) {
          bestCount = count;
          bestLang = lang;
        }
      }

      return bestLang;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Generates a compact summary for injection into AGENTS.md.
   * @param {object} profile - Profile from analyze()
   * @returns {string} Markdown section
   */
  renderCompactSummary(profile) {
    return renderCompactProfileSummary(profile);
  }

  /**
   * Generates a full Markdown report.
   * @param {object} profile - Profile from analyze()
   * @returns {string} Markdown report
   */
  renderFullReport(profile) {
    return renderFullProfileReport(profile);
  }
}

// ─── Convenience Functions ───────────────────────────────────────────────────

/**
 * Quick analysis - returns compact summary string.
 * @param {string} rootPath - Project root path
 * @returns {string} Compact Markdown summary
 */
function quickProfile(rootPath) {
  const profiler = new ProjectProfiler();
  const profile = profiler.analyze(rootPath);
  return profiler.renderCompactSummary(profile);
}

/**
 * Full analysis - returns complete profile object.
 * @param {string} rootPath - Project root path
 * @param {object} options - Analysis options
 * @returns {object} Complete profile
 */
function fullProfile(rootPath, options = {}) {
  const profiler = new ProjectProfiler();
  return profiler.analyze(rootPath, options);
}

// ─── P1 Baseline Profile (Fallback) ──────────────────────────────────────────
// Used when deep analysis fails or for simple projects

/**
 * Generates a baseline profile from directory structure only.
 * Simpler and faster than full analysis.
 *
 * @param {string} rootPath - Project root path
 * @returns {object} Baseline profile
 */
function generateBaselineProfile(rootPath) {
  const root = path.resolve(rootPath);
  const dirs = [];

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'vendor') {
        dirs.push({
          name: e.name,
          purpose: inferDirPurpose(e.name),
        });
      }
    }
  } catch { /* ignore */ }

  return {
    root,
    architecture: {
      pattern: 'Unknown',
      layers: dirs.map(d => d.name),
      confidence: 0,
    },
    directories: dirs,
    primaryLanguage: 'unknown',
    frameworks: [],
    dataLayer: { orm: [], databases: [], configFiles: [] },
    testing: { frameworks: [] },
    communication: [],
    infrastructure: {},
    monorepo: { isMonorepo: false, tool: null, packages: [] },
    apis: [],
    entryPoints: [],
    baseline: true,
    analyzedAt: new Date().toISOString(),
  };
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Main class
  ProjectProfiler,

  // Convenience functions
  quickProfile,
  fullProfile,

  // Baseline profile
  generateBaselineProfile,

  // Renderers
  renderCompactProfileSummary,
  renderFullProfileReport,

  // Detection functions (for direct use)
  detectFrameworks,
  detectDataLayer,
  detectDatabases,
  detectTestFrameworks,
  detectArchitecture,
  detectCommunication,
  detectInfrastructure,
  detectMonorepo,
  detectAPIs,
  detectEntryPoints,

  // Rule arrays (for extension)
  FRAMEWORK_RULES,
  DATA_LAYER_RULES,
  DATABASE_INDICATORS,
  TEST_FRAMEWORK_RULES,
  ARCHITECTURE_PATTERNS,

  // Helpers (for backward compatibility)
  fileExists,
  dirExists,
  hasExt,
  readFileContent,
  readDependencies,
  clearFileContentCache,
  gatherConfigContent,
  inferDirPurpose,
};
