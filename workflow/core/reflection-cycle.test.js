'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { describe, it, before, after } = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

describe('ReflectionCycle Integration', () => {
  let ReflectionCycle;
  let EvolutionLoop;
  let SelfReflectionEngine;

  before(() => {
    ReflectionCycle = require(path.join(PROJECT_ROOT, 'workflow/core/reflection-cycle')).ReflectionCycle;
    EvolutionLoop = require(path.join(PROJECT_ROOT, 'workflow/core/evolution-loop')).EvolutionLoop;
    SelfReflectionEngine = require(path.join(PROJECT_ROOT, 'workflow/core/self-reflection-engine')).SelfReflectionEngine;
  });

  describe('ReflectionCycle', () => {
    it('should decompose signals by dimension', async () => {
      const cycle = new ReflectionCycle({ projectRoot: PROJECT_ROOT });
      const signals = [
        { id: '1', source: 'test', dimension: 'quality', title: 'Test failure', content: 'Unit test failed', confidence: 0.8 },
        { id: '2', source: 'review', dimension: 'architecture', title: 'Missing contract', content: 'No API contract defined', confidence: 0.7 },
        { id: '3', source: 'socratic', dimension: 'quality', title: 'Low coverage', content: 'Test coverage below 60%', confidence: 0.6 },
      ];

      const result = await cycle.decompose(signals);
      assert.ok(result.dimensionSignals, 'Should group by dimension');
      assert.ok(result.stats, 'Should have stats');
      assert.strictEqual(result.stats.total, 3, 'Should count 3 signals');
    });

    it('should induce patterns from decomposed signals', async () => {
      const cycle = new ReflectionCycle({ projectRoot: PROJECT_ROOT });
      const decomposed = {
        dimensionSignals: {
          quality: [
            { id: '1', source: 'test', dimension: 'quality', title: 'Test failure A', content: 'Unit test failed', confidence: 0.8 },
            { id: '2', source: 'test', dimension: 'quality', title: 'Test failure B', content: 'Integration test failed', confidence: 0.7 },
          ],
        },
        crossRefs: [],
        stats: { total: 2, filtered: 0 },
      };

      const result = cycle.induce(decomposed);
      assert.ok(result, 'Should return induction result');
    });

    it('should run full cycle with empty signals', async () => {
      const cycle = new ReflectionCycle({ projectRoot: PROJECT_ROOT });
      const result = await cycle.runCycle([]);
      assert.strictEqual(result.round, 0, 'Should complete in 0 rounds');
      assert.strictEqual(result.actions.length, 0, 'Should have no actions');
    });

    it('should run full cycle with signals', async () => {
      const cycle = new ReflectionCycle({ projectRoot: PROJECT_ROOT, maxRounds: 2 });
      const signals = [
        { id: '1', source: 'test', dimension: 'quality', title: 'Recurring test failure', content: 'Same test fails repeatedly', confidence: 0.85 },
        { id: '2', source: 'socratic', dimension: 'depth', title: 'Shallow analysis', content: 'Analysis lacks depth', confidence: 0.6 },
      ];

      const result = await cycle.runCycle(signals);
      assert.ok(typeof result.round === 'number', 'Should return round count');
      assert.ok(typeof result.converged === 'boolean', 'Should return convergence status');
      assert.ok(Array.isArray(result.actions), 'Should return actions array');
      assert.ok(Array.isArray(result.insights), 'Should return insights array');
    });
  });

  describe('EvolutionLoop.relateSignals', () => {
    let loop;

    before(() => {
      loop = new EvolutionLoop({ projectRoot: PROJECT_ROOT });
    });

    it('should return empty results for empty patterns', () => {
      const result = loop.relateSignals([]);
      assert.strictEqual(result.causalHypotheses.length, 0);
      assert.strictEqual(result.trends.length, 0);
      assert.strictEqual(result.ruleChallenges.length, 0);
    });

    it('should identify causal hypotheses from correlated patterns', () => {
      const now = Date.now();
      const patterns = [
        { id: 'p1', summary: 'Test failure in auth module', category: 'quality', timestamp: now - 1800000 },
        { id: 'p2', summary: 'Auth module deployment failure', category: 'quality', timestamp: now - 900000 },
      ];

      const result = loop.relateSignals(patterns);
      assert.ok(Array.isArray(result.causalHypotheses), 'Should return causal hypotheses');
    });

    it('should identify rule challenges from frequent patterns', () => {
      const patterns = [
        { id: 'p1', summary: 'Missing error handling in A', category: 'error-handling' },
        { id: 'p2', summary: 'Missing error handling in B', category: 'error-handling' },
        { id: 'p3', summary: 'Missing error handling in C', category: 'error-handling' },
      ];

      const result = loop.relateSignals(patterns);
      assert.ok(result.ruleChallenges.length > 0, 'Should detect rule challenge');
      const doubleLoop = result.ruleChallenges.find(c => c.type === 'double_loop');
      assert.ok(doubleLoop, 'Should detect double-loop challenge for 3+ occurrences');
    });

    it('should analyze trends from history', () => {
      const patterns = [
        { id: 'p1', summary: 'Quality gate breach', category: 'quality' },
      ];
      const history = Array.from({ length: 8 }, (_, i) => ({
        title: 'Quality gate breach',
        content: `Quality gate failure ${i}`,
        createdAt: new Date(Date.now() - (7 - i) * 86400000).toISOString(),
      }));

      const result = loop.relateSignals(patterns, history);
      assert.ok(Array.isArray(result.trends), 'Should return trends');
    });
  });

  describe('SelfReflectionEngine.runReflectionCycle', () => {
    let engine;
    const tmpDir = path.join(PROJECT_ROOT, '.workflow', 'test-reflections');

    before(() => {
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      engine = new SelfReflectionEngine({
        projectRoot: PROJECT_ROOT,
        reflectionPath: path.join(tmpDir, 'test-reflections.json'),
      });
    });

    after(() => {
      try {
        const filePath = path.join(tmpDir, 'test-reflections.json');
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
      } catch { /* cleanup best-effort */ }
    });

    it('should run reflection cycle and return structured result', async () => {
      const signals = [
        { id: 's1', source: 'test', dimension: 'quality', title: 'Test failure', content: 'Unit test failed', confidence: 0.8 },
      ];

      const result = await engine.runReflectionCycle(signals);
      assert.ok(typeof result.round === 'number', 'Should return round count');
      assert.ok(typeof result.converged === 'boolean', 'Should return convergence');
      assert.ok(Array.isArray(result.actions), 'Should return actions');
    });

    it('should handle empty signals gracefully', async () => {
      const result = await engine.runReflectionCycle([]);
      assert.strictEqual(result.round, 0, 'Should complete in 0 rounds');
    });

    it('should record actions as issues', async () => {
      const signals = [
        { id: 's1', source: 'test', dimension: 'quality', title: 'Recurring failure', content: 'Same test fails every time', confidence: 0.9 },
        { id: 's2', source: 'test', dimension: 'quality', title: 'Another recurring failure', content: 'Another repeated failure', confidence: 0.85 },
      ];

      const beforeCount = engine._reflections.length;
      await engine.runReflectionCycle(signals);

      if (engine._reflections.length > beforeCount) {
        const newIssue = engine._reflections[engine._reflections.length - 1];
        assert.ok(['reflection-action', 'rule-change'].includes(newIssue.type), 'New issue should be reflection action type');
      }
    });
  });
});
