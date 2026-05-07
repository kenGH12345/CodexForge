'use strict';

const assert = require('assert');
const { evaluateSLOAlerts, formatAlertSignals } = require('./slo-alert-evaluator');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(err.message);
  }
}

test('AC-2.1: evaluate() returns alert signals array', () => {
  const dashboard = {
    checks: [
      { id: 'test-check', passed: false, severity: 'high', actual: 3, expected: 0 },
    ],
  };
  const signals = evaluateSLOAlerts(dashboard);
  assert(Array.isArray(signals));
  assert.strictEqual(signals.length, 1);
});

test('AC-2.2: All passed checks return empty array', () => {
  const dashboard = {
    checks: [
      { id: 'check-1', passed: true },
      { id: 'check-2', passed: true },
    ],
  };
  const signals = evaluateSLOAlerts(dashboard);
  assert.strictEqual(signals.length, 0);
});

test('AC-2.3: Critical severity generates severity: "critical"', () => {
  const dashboard = {
    checks: [
      { id: 'leak', passed: false, severity: 'critical', actual: 5, expected: 0 },
    ],
  };
  const signals = evaluateSLOAlerts(dashboard);
  assert.strictEqual(signals[0].severity, 'critical');
  assert.strictEqual(signals[0].action, 'Stop rollout, inspect leak');
});

test('AC-2.4: Alert signals contain all required fields', () => {
  const dashboard = {
    checks: [
      { id: 'drift', passed: false, severity: 'high', actual: 0.8, expected: 0.3 },
    ],
  };
  const signals = evaluateSLOAlerts(dashboard);
  const s = signals[0];
  assert.ok('severity' in s);
  assert.ok('checkId' in s);
  assert.ok('actual' in s);
  assert.ok('expected' in s);
  assert.ok('message' in s);
  assert.ok('action' in s);
});

test('AC-2.5: formatAlertSignals() outputs standard JSON structure', () => {
  const signals = [{ severity: 'high', checkId: 'x', actual: 1, expected: 0, message: 'x failed', action: 'Investigate' }];
  const result = formatAlertSignals(signals);
  assert.strictEqual(result.schemaVersion, 1);
  assert.ok(result.generatedAt);
  assert.strictEqual(result.health, 'unhealthy');
  assert.strictEqual(result.signals.length, 1);
  assert.strictEqual(result.webhookDispatched, false);
});

test('AC-2.6: Webhook POST when sloAlertWebhook configured', () => {
  const signals = [{ severity: 'critical', checkId: 'y', actual: 2, expected: 0, message: 'y failed', action: 'Stop rollout' }];
  const result = formatAlertSignals(signals, { sloAlertWebhook: 'http://localhost:9999/hook' });
  assert.strictEqual(result.webhookDispatched, true);
});

test('AC-2.7: No failed checks means no webhook dispatch', () => {
  const result = formatAlertSignals([], {});
  assert.strictEqual(result.webhookDispatched, false);
  assert.strictEqual(result.health, 'healthy');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
