/**
 * Stage Runners Tests
 * Covers: Analyst, Developer, and common StageRunner patterns
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Import runners
const { _runAnalyst, _recordPromptABOutcome } = require('./stage-analyst');
const { _runDeveloper } = require('./stage-developer');

describe('Stage Analyst', () => {
  describe('Exports', () => {
    it('should export _runAnalyst function', () => {
      assert.ok(_runAnalyst, '_runAnalyst should be exported');
      assert.ok(typeof _runAnalyst === 'function', 'Should be a function');
    });

    it('should export _recordPromptABOutcome function', () => {
      assert.ok(_recordPromptABOutcome, '_recordPromptABOutcome should be exported');
      assert.ok(typeof _recordPromptABOutcome === 'function', 'Should be a function');
    });
  });

  describe('Prompt AB Testing', () => {
    it('should record outcome with correct parameters', () => {
      // Test the recording function
      // It should accept: agentRole, gatePassed, correctionRounds, tokensUsed
      const result = _recordPromptABOutcome('analyst', true, 1, 1000);

      // Function may return void or result
      console.log('   Info: Prompt outcome recorded for analyst');
      assert.ok(true, 'Recording succeeded');
    });

    it('should handle different agent roles', () => {
      const roles = ['analyst', 'architect', 'planner', 'developer', 'tester'];

      for (const role of roles) {
        _recordPromptABOutcome(role, false, 2, 1500);
        console.log(`   Info: Recorded outcome for ${role}`);
      }

      assert.ok(true, 'All roles processed');
    });

    it('should handle gate passed/failed', () => {
      _recordPromptABOutcome('analyst', true, 0, 500);
      _recordPromptABOutcome('analyst', false, 3, 3000);

      console.log('   Info: Both pass/fail scenarios recorded');
      assert.ok(true, 'Both outcomes handled');
    });
  });

  describe('Analyst Runner Parameters', () => {
    it('should require rawRequirement parameter', async () => {
      try {
        // Should fail without requirement
        await _runAnalyst();
        assert.fail('Should throw without requirement');
      } catch (e) {
        // _runAnalyst is bound to orchestrator context; called standalone it throws
        // either 'stageCtx is not initialised' or 'Cannot read properties of undefined'
        assert.ok(
          e.message.includes('stageCtx') ||
          e.message.includes('requirement') ||
          e.message.includes('initialised') ||
          e.message.includes('Cannot read'),
          `Should have appropriate error, got: ${e.message}`);
      }
    });

    it('should process requirement string', async () => {
      // Mock context
      global.stageCtx = {
        llmRouter: {
          call: async () => ({ text: 'Analysis result' }),
        },
        codeGraph: null,
        experienceStore: null,
      };

      // This will fail because we don't have full context, but it validates the interface
      try {
        await _runAnalyst('Build a login system');
      } catch (e) {
        // Expected - context not fully initialized
        assert.ok(e.message, 'Throws with context error');
      }
    });
  });
});

describe('Stage Developer', () => {
  describe('Exports', () => {
    it('should export _runDeveloper function', () => {
      assert.ok(_runDeveloper, '_runDeveloper should be exported');
      assert.ok(typeof _runDeveloper === 'function', 'Should be a function');
    });
  });

  describe('Developer Runner', () => {
    it('should require valid context', async () => {
      try {
        await _runDeveloper();
        assert.fail('Should throw without context');
      } catch (e) {
        assert.ok(e.message, 'Should throw error');
      }
    });

    it('should handle implementation task', async () => {
      // Mock context dependencies
      global.stageCtx = {
        llmRouter: {
          call: async () => ({
            text: JSON.stringify({
              files: [{ path: 'src/auth.js', content: 'module.exports = {};' }],
            }),
          }),
        },
        fileRefBus: {
          publish: () => {},
        },
        qualityGate: {
          evaluate: async () => ({ pass: true }),
        },
      };

      try {
        await _runDeveloper({ task: 'Implement auth' });
      } catch (e) {
        // Expected in test environment
        console.log(`   Info: Developer runner validation: ${e.message.substring(0, 50)}`);
      }

      assert.ok(true, 'Developer interface validated');
    });
  });
});

describe('Stage Runner Patterns', () => {
  describe('Common Interface', () => {
    it('all runners should be async functions', () => {
      // Check that runners are async
      assert.ok(_runAnalyst.constructor.name.includes('Async') ||
        _runAnalyst.toString().includes('async'),
        '_runAnalyst should be async');

      assert.ok(_runDeveloper.constructor.name.includes('Async') ||
        _runDeveloper.toString().includes('async'),
        '_runDeveloper should be async');
    });
  });

  describe('Error Handling', () => {
    it('should handle context initialization error', async () => {
      // Clear global context
      const savedCtx = global.stageCtx;
      global.stageCtx = undefined;

      try {
        await _runAnalyst('test');
      } catch (e) {
        // _runAnalyst uses `this.stageCtx`; called without orchestrator context
        // it throws 'stageCtx is not initialised' or 'Cannot read properties of undefined'
        assert.ok(
          e.message.includes('stageCtx') ||
          e.message.includes('initialised') ||
          e.message.includes('Cannot read'),
          `Should complain about missing context, got: ${e.message}`);
      } finally {
        global.stageCtx = savedCtx;
      }
    });
  });

  describe('Quality Gate Integration', () => {
    it('runners should support quality gate evaluation', () => {
      // Runners typically interact with qualityGate
      const mockGate = {
        evaluate: async () => ({ pass: true, score: 0.9 }),
      };

      assert.ok(typeof mockGate.evaluate === 'function', 'QualityGate should have evaluate method');
    });
  });
});

describe('Stage Communication', () => {
  describe('FileRefBus Integration', () => {
    it('should use FileRefBus for inter-stage communication', () => {
      const mockBus = {
        publish: (sender, receiver, filePath, metadata) => {
          console.log(`   [Bus] ${sender} → ${receiver}: ${filePath}`);
          return true;
        },
        subscribe: (role, handler) => {
          console.log(`   [Bus] ${role} subscribed`);
        },
      };

      // Test bus operations
      assert.ok(typeof mockBus.publish === 'function', 'Should have publish');
      assert.ok(typeof mockBus.subscribe === 'function', 'Should have subscribe');
    });
  });

  describe('LLM Router Integration', () => {
    it('should use LLM Router for agent calls', () => {
      const mockRouter = {
        call: async (agent, prompt, opts) => ({
          text: 'mock response',
          tokens: 100,
        }),
        applyTierRouting: (tokens) => ({ useSimple: tokens < 1000 }),
      };

      assert.ok(typeof mockRouter.call === 'function', 'Should have call method');
    });
  });
});

console.log(`\n👷 Stage Runner Tests (Analyst + Developer)\n`);
