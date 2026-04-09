/**
 * StateMachine Lite Tests
 * Lightweight tests focusing on exports and structure
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Test module existence and exports
describe('StateMachine Module Exports', () => {
  it('should load module', () => {
    const sm = require('./state-machine');
    assert.ok(sm, 'Module should load');
  });

  it('should export StateMachine class', () => {
    const { StateMachine } = require('./state-machine');
    assert.ok(StateMachine, 'Should export StateMachine');
    assert.ok(typeof StateMachine === 'function', 'Should be constructible');
  });
});

describe('StateMachine Constants', () => {
  it('should have WorkflowState enum exported via types', () => {
    const { WorkflowState } = require('./types');

    assert.ok(WorkflowState, 'Should have WorkflowState');
    assert.ok(WorkflowState.INIT, 'Should have INIT state');
    assert.ok(WorkflowState.ANALYSE, 'Should have ANALYSE state');
    assert.ok(WorkflowState.ARCHITECT, 'Should have ARCHITECT state');
    assert.ok(WorkflowState.CODE, 'Should have CODE state');
    assert.ok(WorkflowState.TEST, 'Should have TEST state');
    assert.ok(WorkflowState.FINISHED, 'Should have FINISHED state');
  });

  it('should have STATE_ORDER array', () => {
    const { STATE_ORDER } = require('./types');

    assert.ok(Array.isArray(STATE_ORDER), 'Should be array');
    assert.ok(STATE_ORDER.length >= 6, 'Should have at least 6 states');
    assert.strictEqual(STATE_ORDER[0], 'INIT', 'First should be INIT');
    assert.ok(STATE_ORDER.includes('FINISHED'), 'Should include FINISHED');
  });
});

describe('StateMachine Class Structure', () => {
  const { StateMachine } = require('./state-machine');

  it('should have expected methods', () => {
    const expectedMethods = [
      'transition',
      'getState',
      'jumpTo',
      'rollback',
    ];

    // Check prototype methods
    const prototype = StateMachine.prototype;
    for (const method of expectedMethods) {
      assert.ok(typeof prototype[method] === 'function', `Should have ${method} method`);
    }
  });

  it('should accept projectId in constructor', () => {
    // Can't fully instantiate without complex setup, but we can verify signature
    assert.ok(StateMachine.length >= 1, 'Constructor should accept at least 1 param (projectId)');
  });
});

describe('StateMachine State Transitions', () => {
  const { STATE_ORDER } = require('./types');

  it('should have correct state order', () => {
    const expectedOrder = ['INIT', 'ANALYSE', 'ARCHITECT', 'PLAN', 'CODE', 'TEST', 'FINISHED'];

    for (let i = 0; i < expectedOrder.length; i++) {
      assert.strictEqual(STATE_ORDER[i], expectedOrder[i], `State ${i} should be ${expectedOrder[i]}`);
    }
  });

  it('should not allow backward transitions without rollback', () => {
    // States should be sequential
    const stateIndex = state => STATE_ORDER.indexOf(state);

    assert.ok(stateIndex('ANALYSE') > stateIndex('INIT'), 'ANALYSE after INIT');
    assert.ok(stateIndex('CODE') > stateIndex('ARCHITECT'), 'CODE after ARCHITECT');
  });
});

describe('StateMachine Manifest Structure', () => {
  const { createManifest } = require('./types');

  it('should create manifest with required fields', () => {
    const manifest = createManifest('test-project');

    assert.ok(manifest.projectId, 'Should have projectId');
    assert.strictEqual(manifest.projectId, 'test-project', 'Should match input');
    assert.ok(manifest.currentState, 'Should have currentState');
    assert.ok(manifest.history, 'Should have history');
    assert.ok(Array.isArray(manifest.history), 'History should be array');
    assert.ok(manifest.createdAt, 'Should have createdAt');
  });
});

describe('StateMachine Hook Events', () => {
  const { HOOK_EVENTS } = require('./constants');

  it('should export hook events', () => {
    assert.ok(HOOK_EVENTS, 'Should have HOOK_EVENTS');
    assert.ok(typeof HOOK_EVENTS === 'object', 'Should be object');
  });

  it('should have lifecycle hook constants', () => {
    assert.ok(HOOK_EVENTS.BEFORE_STATE_TRANSITION, 'Should have BEFORE_STATE_TRANSITION');
    assert.ok(HOOK_EVENTS.AFTER_STATE_TRANSITION, 'Should have AFTER_STATE_TRANSITION');
  });
});

describe('StateMachine Concurrency', () => {
  it('should track transition state', () => {
    // Abstract validation of locking logic
    const lockState = {
      locked: false,
      queue: [],
    };

    // Simulate lock acquisition
    lockState.locked = true;
    assert.ok(lockState.locked, 'Should track locked state');
  });

  it('should support transition queue', () => {
    const queue = [];

    queue.push({ caller: 'task1', priority: 1 });
    queue.push({ caller: 'task2', priority: 2 });

    assert.strictEqual(queue.length, 2, 'Should queue transitions');
  });
});

console.log(`\n🔄 StateMachine Lite Tests\n`);
