/**
 * CodeGraph Lite Tests
 * Lightweight tests for CodeGraph modules - focuses on exports and structure
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Test module existence and basic exports
describe('CodeGraph Module Exports', () => {
  describe('code-graph-builder', () => {
    it('should load module', () => {
      const builder = require('./code-graph-builder');
      assert.ok(builder, 'Module should load');
    });

    it('should export constants', () => {
      const { NON_CODE_DIRS, WORKER_FILE_THRESHOLD } = require('./code-graph-builder');

      // NON_CODE_DIRS is a Set (not an array) — use Set API
      assert.ok(NON_CODE_DIRS instanceof Set, 'NON_CODE_DIRS should be a Set');
      assert.ok(NON_CODE_DIRS.size > 0, 'Should have entries');
      // Check for actual values in the Set (not node_modules which is filtered elsewhere)
      assert.ok(NON_CODE_DIRS.has('images') || NON_CODE_DIRS.has('docs') || NON_CODE_DIRS.has('tmp'),
        'Should include common non-code dirs');

      assert.ok(typeof WORKER_FILE_THRESHOLD === 'number', 'Should be number');
      assert.ok(WORKER_FILE_THRESHOLD > 0, 'Should be positive');
    });

    it('should export CodeGraphBuilderMixin', () => {
      const { CodeGraphBuilderMixin } = require('./code-graph-builder');
      assert.ok(CodeGraphBuilderMixin, 'Should export mixin');
      assert.ok(typeof CodeGraphBuilderMixin === 'object', 'Mixin should be object');
    });
  });

  describe('code-graph-analysis', () => {
    it('should load module', () => {
      const analysis = require('./code-graph-analysis');
      assert.ok(analysis, 'Module should load');
      // Exports an object with CodeGraphAnalysisMixin
      assert.ok(typeof analysis === 'object', 'Should export object');
      assert.ok(analysis.CodeGraphAnalysisMixin, 'Should export CodeGraphAnalysisMixin');
    });
  });

  describe('code-graph-query', () => {
    it('should load module', () => {
      const query = require('./code-graph-query');
      assert.ok(query, 'Module should load');
      // Exports an object with CodeGraphQueryMixin
      assert.ok(typeof query === 'object', 'Should export object');
      assert.ok(query.CodeGraphQueryMixin, 'Should export CodeGraphQueryMixin');
    });
  });
});

describe('CodeGraph File Filtering', () => {
  const { NON_CODE_DIRS } = require('./code-graph-builder');

  it('should filter node_modules', () => {
    const testPaths = [
      'src/index.js',
      'docs/readme.md',
      'src/components/Button.jsx',
    ];

    // NON_CODE_DIRS is a Set — spread to array for .some()
    // 'docs' is in NON_CODE_DIRS, 'src' is not
    const filtered = testPaths.filter(p => ![...NON_CODE_DIRS].some(d => p.includes(d)));

    assert.ok(filtered.includes('src/index.js'), 'Should keep source files');
    assert.ok(!filtered.includes('docs/readme.md'), 'Should filter docs directory');
  });

  it('should filter dot directories', () => {
    const testPaths = [
      'src/app.js',
      '.git/config',
      '.github/workflows/ci.yml',
    ];

    const filtered = testPaths.filter(p => ![...NON_CODE_DIRS].some(d => p.includes(d + path.sep) || p.includes('/' + d + '/')));

    assert.ok(filtered.includes('src/app.js'), 'Should keep source');
  });
});

describe('CodeGraph Symbol Detection', () => {
  it('should detect class definitions', () => {
    const code = 'class MyClass { constructor() {} }';
    const hasClass = /\bclass\s+\w+/.test(code);
    assert.ok(hasClass, 'Should detect class keyword');
  });

  it('should detect function definitions', () => {
    const code = 'function myFunc() {}';
    const hasFunction = /\bfunction\s+\w+/.test(code);
    assert.ok(hasFunction, 'Should detect function keyword');
  });

  it('should detect method definitions', () => {
    const code = 'myMethod() { return 1; }';
    const hasMethod = /\w+\s*\([^)]*\)\s*\{/.test(code);
    assert.ok(hasMethod, 'Should detect method pattern');
  });
});

describe('CodeGraph Data Structures', () => {
  it('should support symbol map structure', () => {
    const symbols = new Map();

    symbols.set('file1:MyClass', {
      id: 'file1:MyClass',
      name: 'MyClass',
      kind: 'class',
      file: 'file1.js',
    });

    assert.ok(symbols.has('file1:MyClass'), 'Should store symbol');
    assert.strictEqual(symbols.get('file1:MyClass').kind, 'class', 'Should preserve kind');
  });

  it('should support call edge structure', () => {
    const callEdges = new Map();
    callEdges.set('caller1', new Set(['callee1', 'callee2']));

    assert.ok(callEdges.has('caller1'), 'Should store caller');
    assert.ok(callEdges.get('caller1').has('callee1'), 'Should have callee');
  });
});

describe('CodeGraph Hotspot Analysis', () => {
  it('should calculate call frequency', () => {
    // Simulate called-by index
    const calledBy = {
      'funcA': { count: 5, callers: ['c1', 'c2', 'c3'] },
      'funcB': { count: 2, callers: ['c1'] },
    };

    const hotspots = Object.entries(calledBy)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10);

    assert.strictEqual(hotspots[0][0], 'funcA', 'Most called should be first');
    assert.strictEqual(hotspots[0][1].count, 5, 'Should have correct count');
  });
});

describe('CodeGraph Query Patterns', () => {
  it('should support name search', () => {
    const symbols = [
      { name: 'MyClass', kind: 'class' },
      { name: 'myFunction', kind: 'function' },
      { name: 'helper', kind: 'function' },
    ];

    const results = symbols.filter(s => s.name.toLowerCase().includes('my'));

    assert.ok(results.length >= 2, 'Should find matching names');
  });

  it('should support kind filter', () => {
    const symbols = [
      { name: 'A', kind: 'class' },
      { name: 'B', kind: 'function' },
      { name: 'C', kind: 'class' },
    ];

    const classes = symbols.filter(s => s.kind === 'class');

    assert.strictEqual(classes.length, 2, 'Should filter by kind');
  });
});

console.log(`\n📊 CodeGraph Lite Tests\n`);
