/**
 * Capability Mapper — Refines raw CodeGraph signals into high-quality design primitives.
 * Transforms symbols, callEdges, hotspots, and categoryStats into actionable scaffold data.
 *
 * Input:  raw CodeGraph (symbols[], filePaths[], callEdges{}, hotspots[], categoryStats{})
 * Output: { scaffold: {...}, designPatterns: {...}, architecture: {...}, codingStandards: {...} }
 */

const path = require('path');

const GENERIC_NAMES = new Set([
  'parse', 'entries', 'filter', 'lines', 'line', 'process', 'summary', 'score',
  'projectRoot', 'outputDir', 'resolve', 'total', 'passed', 'failed', 'results',
  'entry', 'error', 'data', 'name', 'type', 'value', 'res', 'err', 'next', 'done',
  'start', 'end', 'init', 'load', 'save', 'get', 'set', 'run', 'exec', 'handle',
  'create', 'update', 'delete', 'find', 'list', 'send', 'receive', 'build', 'format',
  'log', 'debug', 'info', 'warn', 'assert', 'test', 'mock', 'spy', 'stub',
  'expect', 'should', 'equal', 'deepEqual', 'callback', 'fn', 'func', 'cb',
  'options', 'config', 'settings', 'params', 'args', 'result', 'response', 'request',
  'constructor', 'prototype', 'module', 'exports', 'require', 'default', 'index',
  'main', 'utils', 'helpers', 'common', 'shared', 'constants', 'types', 'interfaces',
  'toString', 'valueOf', 'then', 'catch', 'finally', 'map', 'reduce', 'forEach',
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'split',
  'replace', 'match', 'search', 'trim', 'toLowerCase', 'toUpperCase', 'charAt',
  'substr', 'substring', 'indexOf', 'lastIndexOf', 'includes', 'startsWith',
  'endsWith', 'repeat', 'padStart', 'padEnd', 'codePointAt', 'fromCodePoint',
  'raw', 'length', 'concat', 'every', 'some', 'find', 'findIndex', 'filter',
  'flat', 'flatMap', 'fill', 'sort', 'reverse', 'keys', 'values', 'entries',
  'hasOwnProperty', 'propertyIsEnumerable', 'isPrototypeOf',
  'toLocaleString', 'toFixed', 'toExponential', 'toPrecision', 'isFinite', 'isNaN',
  'parseFloat', 'parseInt', 'encodeURI', 'decodeURI', 'encodeURIComponent',
  'decodeURIComponent', 'escape', 'unescape', 'eval', 'isSafeInteger',
  'MAX_VALUE', 'MIN_VALUE', 'POSITIVE_INFINITY', 'NEGATIVE_INFINITY',
  'NaN', 'EPSILON', 'apply', 'call', 'bind', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'caller', 'arguments', 'callee'
]);

// ── Signal extraction helpers ───────────────────────────

function isGenericName(name) {
  return GENERIC_NAMES.has(name) || GENERIC_NAMES.has(name.toLowerCase());
}

function inferModule(relPath) {
  const parts = relPath.split(/[\\/]/);
  if (parts.length >= 2) {
    const skipRoots = new Set(['src', 'lib', 'app', 'packages', 'components']);
    let idx = 0;
    if (skipRoots.has(parts[0])) idx = 1;
    if (idx < parts.length) {
      // Use 2-level depth for richer grouping: dir1/dir2
      const seg1 = parts[idx];
      const seg2 = parts[idx + 1] || '';
      if (seg2 && !seg2.includes('.')) return `${seg1}/${seg2}`;
      return seg1;
    }
  }
  return parts[0] || 'root';
}

function inferLayer(relPath) {
  const rp = relPath.toLowerCase().replace(/\\/g, '/');
  if (rp.includes('/commands/') || rp.endsWith('/commands')) return 'entry';
  if (rp.includes('/agents/') || rp.endsWith('/agents')) return 'orchestration';
  if (rp.includes('/core/') || rp.endsWith('/core')) return 'core';
  if (rp.includes('/tools/') || rp.endsWith('/tools')) return 'utility';
  if (rp.includes('/hooks/') || rp.includes('/adapters/')) return 'integration';
  if (rp.includes('/tests/') || rp.includes('/test/') || rp.includes('.test.') || rp.includes('.spec.')) return 'test';
  if (rp.includes('/docs/') || rp.includes('/doc/')) return 'doc';
  return 'other';
}

function detectPatternFromName(name) {
  const n = name.toLowerCase();
  const patterns = [];
  if (n.includes('factory') || /^create/.test(n) || /^make/.test(n) || /^build/.test(n)) patterns.push('Factory');
  if (n.includes('adapter') || /^adapt/.test(n) || /^wrap/.test(n)) patterns.push('Adapter');
  if (n.includes('observer') || /^on[A-Z]/.test(name) || /^emit/.test(n) || /^subscribe/.test(n) || /^unsubscribe/.test(n) || n.includes('event') || n.includes('listener')) patterns.push('Observer');
  if (n.includes('singleton') || n.includes('getinstance') || n.includes('single')) patterns.push('Singleton');
  if (n.includes('strategy') || n.includes('policy') || n.includes('algorithm')) patterns.push('Strategy');
  if (n.includes('decorator') || n.includes('wrapper') || n.includes('mixin')) patterns.push('Decorator');
  if (n.includes('proxy') || n.includes('intercept') || n.includes('middleware')) patterns.push('Proxy');
  if (n.includes('command') || n.includes('action') || n.includes('handler')) patterns.push('Command');
  if (n.includes('state') && (n.includes('machine') || n.includes('transition'))) patterns.push('State Machine');
  if (n.includes('pipeline') || n.includes('chain') || n.includes('flow') || n.includes('stage') || n.includes('step')) patterns.push('Pipeline');
  if (n.includes('registry') || n.includes('repository') || n.includes('catalog')) patterns.push('Registry');
  if (n.includes('router') || n.includes('route') || n.includes('dispatch')) patterns.push('Router');
  if (n.includes('queue') || n.includes('batch') || n.includes('buffer')) patterns.push('Queue');
  if (n.includes('cache') || n.includes('memoiz') || n.includes('store') || n.includes('storage')) patterns.push('Cache');
  if (n.includes('validator') || n.includes('validate') || n.includes('verify') || n.includes('check')) patterns.push('Validator');
  if (n.includes('serializer') || n.includes('deserialize') || n.includes('serialize')) patterns.push('Serializer');
  if (n.includes('compress') || n.includes('decompress') || n.includes('encode') || n.includes('decode')) patterns.push('Compressor');
  return patterns;
}

function extractFileNameConvention(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  if (base.includes('.') || base.includes('-')) return 'kebab/dot-case';
  if (/^[A-Z]/.test(base)) return 'PascalCase';
  if (/^[a-z]/.test(base)) return 'camelCase/snake_case';
  return 'mixed';
}

// ── Core signal extraction ──────────────────────────────

function extractModuleSignals({ symbols, filePaths }) {
  const modules = new Map();
  for (const sym of symbols) {
    const fp = filePaths[sym.f] || 'unknown';
    const mod = inferModule(fp);
    if (!modules.has(mod)) modules.set(mod, { symbols: [], classes: [], functions: [], files: new Set(), layer: inferLayer(fp) });
    const m = modules.get(mod);
    m.symbols.push(sym);
    m.files.add(fp);
    if (sym.k === 'class') m.classes.push(sym);
    if (sym.k === 'function' || sym.k === 'method') m.functions.push(sym);
  }

  const result = [];
  for (const [name, data] of modules) {
    result.push({
      name,
      layer: data.layer,
      symbolCount: data.symbols.length,
      classCount: data.classes.length,
      functionCount: data.functions.length,
      fileCount: data.files.size,
      keySymbols: data.symbols
        .filter(s => !isGenericName(s.n) && (s.w || 0) > 0.05)
        .sort((a, b) => (b.w || 0) - (a.w || 0))
        .slice(0, 8)
        .map(s => ({ name: s.n, kind: s.k, line: s.l, signature: s.s, weight: s.w }))
    });
  }
  return result.sort((a, b) => b.symbolCount - a.symbolCount);
}

function extractArchitectureLayers({ symbols, filePaths }) {
  const layers = { entry: [], core: [], orchestration: [], utility: [], integration: [], test: [], doc: [], other: [] };
  for (const sym of symbols) {
    const fp = filePaths[sym.f] || 'unknown';
    const layer = inferLayer(fp);
    if (layers[layer]) {
      layers[layer].push({ ...sym, filePath: fp });
    }
  }
  const result = {};
  for (const [layer, syms] of Object.entries(layers)) {
    if (syms.length === 0) continue;
    const uniqueFiles = new Set(syms.map(s => s.filePath)).size;
    const keySymbols = syms
      .filter(s => !isGenericName(s.n))
      .sort((a, b) => (b.w || 0) - (a.w || 0))
      .slice(0, 10)
      .map(s => ({ name: s.n, kind: s.k, file: s.filePath, line: s.l }));
    result[layer] = { symbolCount: syms.length, fileCount: uniqueFiles, keySymbols };
  }
  return result;
}

function extractDesignPatterns({ symbols, filePaths }) {
  const patternMap = new Map();
  for (const sym of symbols) {
    const patterns = detectPatternFromName(sym.n);
    for (const p of patterns) {
      if (!patternMap.has(p)) patternMap.set(p, []);
      const fp = filePaths[sym.f] || 'unknown';
      patternMap.get(p).push({ name: sym.n, kind: sym.k, file: fp, line: sym.l });
    }
  }
  const result = [];
  for (const [pattern, instances] of patternMap) {
    result.push({
      pattern,
      instanceCount: instances.length,
      evidence: instances.slice(0, 6).map(i => `${i.name} (${i.kind}) in ${i.file}:${i.line}`),
      confidence: Math.min(0.3 + instances.length * 0.05, 0.95)
    });
  }
  return result.sort((a, b) => b.instanceCount - a.instanceCount);
}

function extractModuleRelations({ symbols, filePaths, callEdges }) {
  const moduleCallCounts = new Map();
  const symbolToModule = new Map();

  for (const sym of symbols) {
    const fp = filePaths[sym.f] || 'unknown';
    const mod = inferModule(fp);
    symbolToModule.set(`${sym.f}::${sym.n}`, mod);
    symbolToModule.set(sym.n, mod);
  }

  for (const [callerKey, callees] of Object.entries(callEdges)) {
    const callerMod = symbolToModule.get(callerKey) || symbolToModule.get(callerKey.split('::').pop());
    if (!callerMod) continue;
    for (const calleeKey of callees) {
      const calleeMod = symbolToModule.get(calleeKey) || symbolToModule.get(calleeKey.split('::').pop());
      if (!calleeMod || calleeMod === callerMod) continue;
      const pair = `${callerMod} -> ${calleeMod}`;
      moduleCallCounts.set(pair, (moduleCallCounts.get(pair) || 0) + 1);
    }
  }

  const relations = [];
  for (const [pair, count] of moduleCallCounts) {
    const [from, to] = pair.split(' -> ');
    relations.push({ from, to, callCount: count });
  }
  return relations.sort((a, b) => b.callCount - a.callCount);
}

function extractHighValueSymbols({ symbols, filePaths, categoryStats }) {
  const hubs = symbols.filter(s => {
    if (isGenericName(s.n)) return false;
    if (s.w && s.w > 0.15) return true;
    if (s.k === 'class') return true;
    return false;
  });

  return hubs
    .sort((a, b) => (b.w || 0) - (a.w || 0))
    .slice(0, 30)
    .map(s => ({
      name: s.n,
      kind: s.k,
      file: filePaths[s.f] || 'unknown',
      line: s.l,
      weight: s.w || 0,
      signature: s.s || ''
    }));
}

function extractCodingConventions({ filePaths, symbols }) {
  const conventions = [];

  // File naming convention
  const namingStyles = new Map();
  for (const fp of filePaths) {
    const style = extractFileNameConvention(fp);
    namingStyles.set(style, (namingStyles.get(style) || 0) + 1);
  }
  const dominantStyle = [...namingStyles.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dominantStyle) {
    conventions.push({
      type: 'file-naming',
      convention: `Files use ${dominantStyle[0]} naming convention`,
      evidence: `${dominantStyle[1]} of ${filePaths.length} files follow this style`,
      confidence: 0.85
    });
  }

  // Test file convention
  const testFiles = filePaths.filter(fp => fp.includes('.test.') || fp.includes('.spec.') || fp.includes('/tests/') || fp.includes('/test/'));
  if (testFiles.length > 0) {
    conventions.push({
      type: 'test-location',
      convention: `Tests are co-located or in dedicated test directories`,
      evidence: `${testFiles.length} test-related files found`,
      confidence: 0.8
    });
  }

  // Directory depth / organization
  const dirDepths = filePaths.map(fp => fp.split(/[\\/]/).length);
  const avgDepth = dirDepths.reduce((a, b) => a + b, 0) / dirDepths.length;
  conventions.push({
    type: 'directory-organization',
    convention: avgDepth > 4 ? 'Deeply nested directory structure (modular)' : 'Flat directory structure',
    evidence: `Average directory depth: ${avgDepth.toFixed(1)} levels`,
    confidence: 0.75
  });

  // Class vs function ratio
  const classCount = symbols.filter(s => s.k === 'class').length;
  const funcCount = symbols.filter(s => s.k === 'function' || s.k === 'method').length;
  const ratio = classCount / (funcCount || 1);
  conventions.push({
    type: 'paradigm',
    convention: ratio > 0.3 ? 'Class-heavy OOP style' : (ratio > 0.1 ? 'Mixed OOP + functional style' : 'Functional/Procedural style'),
    evidence: `${classCount} classes vs ${funcCount} functions/methods (${(ratio * 100).toFixed(1)}% class ratio)`,
    confidence: 0.8
  });

  // Export convention guess
  const hasExport = filePaths.some(fp => {
    const fpSyms = symbols.filter(s => filePaths[s.f] === fp);
    return fpSyms.some(s => s.k === 'class' || s.k === 'function');
  });
  if (hasExport) {
    conventions.push({
      type: 'module-exports',
      convention: 'Modules export classes or functions as primary API surface',
      evidence: `Symbols exported across ${new Set(symbols.map(s => s.f)).size} files`,
      confidence: 0.7
    });
  }

  return conventions;
}

function extractTriggerKeywords({ modules, patterns, highValueSymbols, codingStandards }) {
  const keywords = new Set();

  // Module-based keywords
  for (const mod of modules.slice(0, 10)) {
    const tokens = mod.name.split(/[\/_-]/).filter(t => t.length > 1);
    for (const t of tokens) keywords.add(t.toLowerCase());
  }

  // Pattern-based keywords
  for (const p of patterns.slice(0, 8)) {
    keywords.add(p.pattern.toLowerCase().replace(/\s+/g, '-'));
  }

  // High-value symbol keywords (non-generic only)
  for (const sym of highValueSymbols.slice(0, 10)) {
    if (isGenericName(sym.name)) continue;
    const tokens = sym.name.split(/(?=[A-Z])|[_-]/).filter(t => t.length > 2);
    for (const t of tokens) keywords.add(t.toLowerCase());
  }

  // Paradigm / convention keywords
  const paradigm = codingStandards.paradigm || '';
  if (paradigm.includes('OOP')) { keywords.add('class'); keywords.add('object'); }
  if (paradigm.includes('functional')) { keywords.add('function'); keywords.add('pure'); }
  if (paradigm.includes('async')) { keywords.add('async'); keywords.add('promise'); }

  return [...keywords].filter(k => k.length >= 2).slice(0, 20);
}

function extractTriggerRoles({ architecture }) {
  const roles = ['developer'];

  const layerNames = Object.keys(architecture.layers || {});
  if (layerNames.includes('entry')) roles.push('entry-integrator');
  if (layerNames.includes('orchestration')) roles.push('architect');
  if (layerNames.includes('core')) roles.push('core-developer');
  if (layerNames.includes('integration')) roles.push('integration-specialist');
  if (layerNames.includes('test')) roles.push('tester');

  return [...new Set(roles)];
}

function mapToLegacyScaffold({ modules, layers, patterns, highValueSymbols, codingConventions, moduleRelations }) {
  return {
    projectType: modules.length > 0 ? modules[0].layer === 'entry' ? 'cli' : 'library' : 'unknown',
    modules: modules.map(m => m.name),
    entryPoints: layers.entry ? layers.entry.keySymbols.map(s => s.file) : [],
    coreServices: layers.core ? layers.core.keySymbols.map(s => s.name) : [],
    reusableComponents: highValueSymbols.slice(0, 15).map(s => s.name),
    dataModels: modules
      .filter(m => m.name.includes('model') || m.name.includes('entity') || m.name.includes('schema'))
      .map(m => m.name),
    designPatterns: patterns.map(p => p.pattern),
    architecture: layers.core ? 'layered' : 'flat',
    projectRoot: null,
    estimatedLinesOfCode: null
  };
}

// ── Public API ─────────────────────────────────────────

class CapabilityMapper {
  mapCapabilities(capabilityData) {
    const codeGraph = capabilityData.codeGraph || capabilityData;
    const safe = (k) => codeGraph[k] || (k === 'modules' ? {} : (k === 'reusableSymbols' || k === 'edges' || k === 'hotspots' ? [] : undefined));

    const symbols = safe('symbols') || [];
    const filePaths = safe('filePaths') || [];
    const callEdges = safe('callEdges') || {};
    const hotspots = safe('hotspots') || [];
    const categoryStats = safe('categoryStats') || {};

    if (symbols.length === 0 && filePaths.length === 0) {
      return this.buildFallback(capabilityData);
    }

    const modules = extractModuleSignals({ symbols, filePaths });
    const layers = extractArchitectureLayers({ symbols, filePaths });
    const patterns = extractDesignPatterns({ symbols, filePaths });
    const highValueSymbols = extractHighValueSymbols({ symbols, filePaths, categoryStats });
    const conventions = extractCodingConventions({ filePaths, symbols });
    const relations = extractModuleRelations({ symbols, filePaths, callEdges });

    const scaffold = mapToLegacyScaffold({ modules, layers, patterns, highValueSymbols, codingConventions: conventions, moduleRelations: relations });

    const triggerKeywords = extractTriggerKeywords({ modules, patterns, highValueSymbols, codingStandards: { paradigm: conventions.find(c => c.type === 'paradigm')?.convention || '' } });
    const triggerRoles = extractTriggerRoles({ architecture: { layers } });

    return {
      scaffold,
      triggers: {
        keywords: triggerKeywords,
        roles: triggerRoles
      },
      architecture: {
        modules: modules.slice(0, 15),
        layers,
        moduleRelations: relations.slice(0, 20)
      },
      designPatterns: {
        detected: patterns,
        allPatterns: patterns.map(p => p.pattern),
        confidence: patterns.length > 0 ? patterns.reduce((s, p) => s + p.confidence, 0) / patterns.length : 0
      },
      codingStandards: {
        conventions,
        namingStyle: conventions.find(c => c.type === 'file-naming')?.convention || 'unknown',
        paradigm: conventions.find(c => c.type === 'paradigm')?.convention || 'unknown'
      },
      highValueSymbols,
      categoryStats
    };
  }

  buildFallback(capabilityData) {
    const codeGraph = capabilityData.codeGraph || capabilityData;
    return {
      scaffold: {
        projectType: 'unknown',
        modules: Object.keys(codeGraph.modules || {}),
        entryPoints: (codeGraph.reusableSymbols || []).map(s => s.file || s.location || ''),
        coreServices: [],
        reusableComponents: (codeGraph.reusableSymbols || []).map(s => s.name || ''),
        dataModels: [],
        designPatterns: [],
        architecture: 'unknown',
        estimatedLinesOfCode: null
      },
      architecture: {
        modules: [],
        layers: {},
        moduleRelations: []
      },
      designPatterns: { detected: [], allPatterns: [], confidence: 0 },
      triggers: { keywords: [], roles: ['developer'] },
      codingStandards: { conventions: [], namingStyle: 'unknown', paradigm: 'unknown' },
      highValueSymbols: [],
      categoryStats: {}
    };
  }
}

module.exports = { CapabilityMapper, mapCapabilities: (data) => new CapabilityMapper().mapCapabilities(data) };
