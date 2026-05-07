'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ShadowHeartbeatChecker } = require('./shadow-heartbeat');

let passed = 0;
let failed = 0;
const pendingTests = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingTests.push(result
        .then(() => { passed++; console.log(`✓ ${name}`); })
        .catch((err) => { failed++; console.error(`✗ ${name}`); console.error(err.message); }));
      return;
    }
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(err.message);
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-heartbeat-'));
}

function writeJSONL(dir, lines) {
  const fp = path.join(dir, 'test.jsonl');
  fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');
  return fp;
}

test('AC-3.1: verify() reads JSONL last line and validates JSON integrity', async () => {
  const dir = tempDir();
  const fp = writeJSONL(dir, [
    JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), callSite: 'a' }),
    JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), callSite: 'b' }),
  ]);
  const checker = new ShadowHeartbeatChecker({ outputDir: dir });
  const status = await checker.verify(fp, {});
  assert.strictEqual(status.status, 'healthy');
});

test('AC-3.2: Last line JSON.parse succeeds → status: "healthy"', async () => {
  const dir = tempDir();
  const fp = writeJSONL(dir, [JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString() })]);
  const checker = new ShadowHeartbeatChecker({ outputDir: dir });
  const status = await checker.verify(fp, {});
  assert.strictEqual(status.status, 'healthy');
});

test('AC-3.3: Last line JSON.parse fails → status: "degraded"', async () => {
  const dir = tempDir();
  const fp = writeJSONL(dir, ['{broken json']);
  const checker = new ShadowHeartbeatChecker({ outputDir: dir });
  const status = await checker.verify(fp, {});
  assert.strictEqual(status.status, 'degraded');
  assert.ok(status.lastFailureReason.includes('JSON parse'));
});

test('AC-3.4: Missing schemaVersion → degraded', async () => {
  const dir = tempDir();
  const fp = writeJSONL(dir, [JSON.stringify({ generatedAt: new Date().toISOString() })]);
  const checker = new ShadowHeartbeatChecker({ outputDir: dir });
  const status = await checker.verify(fp, {});
  assert.strictEqual(status.status, 'degraded');
  assert.ok(status.lastFailureReason.includes('schemaVersion'));
});

test('AC-3.5: getStatus() returns complete heartbeat object', () => {
  const checker = new ShadowHeartbeatChecker();
  const status = checker.getStatus();
  assert.strictEqual(status.schemaVersion, 1);
  assert.ok(status.lastVerificationAt);
  assert.strictEqual(typeof status.totalVerifications, 'number');
  assert.strictEqual(typeof status.totalFailures, 'number');
  assert.strictEqual(typeof status.status, 'string');
});

test('AC-3.6: Heartbeat writes to output/shadow-heartbeat.json', async () => {
  const dir = tempDir();
  const fp = writeJSONL(dir, [JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString() })]);
  const checker = new ShadowHeartbeatChecker({ outputDir: dir });
  await checker.verify(fp, {});
  const hbPath = path.join(dir, 'shadow-heartbeat.json');
  assert(fs.existsSync(hbPath), 'Heartbeat file should exist');
  const hb = JSON.parse(fs.readFileSync(hbPath, 'utf-8'));
  assert.strictEqual(hb.status, 'healthy');
});

test('AC-3.7: totalVerifications and totalFailures count correctly', async () => {
  const dir = tempDir();
  const fp = writeJSONL(dir, ['{bad}']);
  const checker = new ShadowHeartbeatChecker({ outputDir: dir });
  await checker.verify(fp, {});
  await checker.verify(fp, {});
  const status = checker.getStatus();
  assert.strictEqual(status.totalVerifications, 2);
  assert.strictEqual(status.totalFailures, 2);
});

test('AC-3.8: Uses readline (readline import present)', () => {
  const content = fs.readFileSync(path.join(__dirname, 'shadow-heartbeat.js'), 'utf-8');
  assert(content.includes("require('readline')"), 'Should use readline module');
  assert(!content.includes('readFileSync') || content.includes('statSync'), 'Should not use readFileSync for line reading');
});

Promise.all(pendingTests).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
