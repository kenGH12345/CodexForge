'use strict';

const { loadLayeredCodeGraph } = require('./code-graph-layered-reader');
const { CapabilityMapper } = require('./capability-mapper');

class SemanticCodeGraphAdapter {
  constructor(projectRoot, options = {}) {
    this.projectRoot = projectRoot || '.';
    this.options = options;
    this._codeGraph = null;
    this._mapped = null;
  }

  load(options = {}) {
    if (!this._codeGraph) {
      this._codeGraph = loadLayeredCodeGraph(this.projectRoot, {
        includeTopShards: true,
        maxShards: 12,
        maxSymbols: 50000,
        ...this.options,
        ...options,
      });
    }
    if (!this._mapped) {
      this._mapped = new CapabilityMapper().mapCapabilities({ codeGraph: this._codeGraph });
    }
    return this;
  }

  toCapabilityCodeGraph() {
    this.load();
    return this._codeGraph;
  }

  getMappedCapabilities() {
    this.load();
    return this._mapped;
  }

  getArchitectureSummary(options = {}) {
    const mapped = this.getMappedCapabilities();
    const maxModules = options.maxModules || 20;
    const maxHotspots = options.maxHotspots || 20;
    return {
      symbolCount: this._codeGraph.symbolCount || mapped._symbolCount || 0,
      modules: (mapped.architecture && mapped.architecture.modules || []).slice(0, maxModules).map(m => ({
        dir: m.name,
        files: m.fileCount || 0,
        classes: m.classCount || 0,
        functions: m.functionCount || m.symbolCount || 0,
        layer: m.layer || 'unknown',
        role: m.role || '',
      })),
      externalModules: (mapped.architecture && mapped.architecture.externalModules || []).slice(0, 10).map(m => ({
        dir: m.name,
        files: m.fileCount || 0,
        functions: m.symbolCount || 0,
        layer: 'external',
      })),
      hotspots: (mapped.highValueSymbols || []).slice(0, maxHotspots).map(s => ({
        name: s.name,
        refs: s.weight || s.refs || 0,
        calls: s.calls || 0,
        category: s.kind || s.category || '',
        file: s.file || '',
      })),
      semanticConsumption: mapped.semanticConsumption || null,
    };
  }

  getSkillSignalTerms(limit = 120) {
    const mapped = this.getMappedCapabilities();
    const terms = [];
    const push = value => {
      if (!value) return;
      if (Array.isArray(value)) return value.forEach(push);
      if (typeof value === 'object') return Object.values(value).forEach(push);
      const matches = String(value).match(/[A-Za-z_][A-Za-z0-9_]{2,}|[\w.-]+\.(?:js|ts|jsx|tsx|cs|cpp|h|lua|proto|md)|[\u4e00-\u9fff]{2,}/g) || [];
      for (const m of matches) {
        const cleaned = m.replace(/["'`,:;()\[\]{}]/g, '').trim();
        if (cleaned.length > 1) terms.push(cleaned);
      }
    };

    push(mapped.scaffold && mapped.scaffold.projectName);
    push(mapped.scaffold && mapped.scaffold.projectType);
    push((mapped.architecture && mapped.architecture.modules || []).map(m => [m.name, m.layer, m.role]));
    push((mapped.highValueSymbols || []).map(s => [s.name, s.file]));
    push(mapped.triggers && mapped.triggers.keywords);
    push(mapped.designPatterns && mapped.designPatterns.allPatterns);
    return Array.from(new Set(terms)).slice(0, limit);
  }
}

function loadSemanticCodeGraph(projectRoot, options = {}) {
  return new SemanticCodeGraphAdapter(projectRoot, options).load();
}

module.exports = { SemanticCodeGraphAdapter, loadSemanticCodeGraph };
