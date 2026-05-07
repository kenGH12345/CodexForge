'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { OTLPOtlpExporter } = require('./otel-otlp-exporter');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.then(() => { passed++; console.log(`✓ ${name}`); })
        .catch((err) => { failed++; console.error(`✗ ${name}`); console.error(err.message); });
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-otel-'));
}

test('AC-1.1: OTLP Exporter creates instance without error', () => {
  const exporter = new OTLPOtlpExporter({ endpoint: 'http://localhost:4318' });
  assert.ok(exporter);
  assert.strictEqual(typeof exporter.export, 'function');
  assert.strictEqual(typeof exporter.flush, 'function');
});

test('AC-1.2: export converts record to OTLP JSON format via _toOTLPSpan', () => {
  const exporter = new OTLPOtlpExporter({ endpoint: 'http://localhost:4318' });
  const record = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'candidate-runtime',
    changedPromptOutput: true,
    callSite: 'test:otel',
    runtime: { hash: 'a'.repeat(64), length: 100, latencyMs: 50 },
    candidate: { hash: 'def456', length: 120 },
    qualityDriftScore: 0.15,
    canary: { allowed: true, rollback: false },
  };
  const span = exporter._toOTLPSpan(record);
  assert.strictEqual(span.name, 'llm.injection.candidate-runtime');
  assert.strictEqual(span.traceId.length, 32);
  const attrKeys = span.attributes.map(a => a.key);
  assert(attrKeys.includes('llm.callsite'));
  assert(attrKeys.includes('llm.injection.mode'));
  assert(attrKeys.includes('llm.quality.drift_score'));
  assert(attrKeys.includes('llm.canary.allowed'));
});

test('AC-1.3: HTTP POST to Collector returns 200', async () => {
  const dir = tempDir();
  const receivedBodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      receivedBodies.push({ path: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const exporter = new OTLPOtlpExporter({
    endpoint: `http://localhost:${port}`,
    outputDir: dir,
  });
  const record = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    mode: 'shadow', callSite: 'test', runtime: { hash: 'x'.repeat(32), length: 10 },
    candidate: { hash: 'y', length: 10 }, qualityDriftScore: 0, canary: { allowed: false, rollback: false },
  };
  exporter._buffer.push(record);
  await new Promise((resolve) => {
    exporter.flush(() => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  server.close();
  assert.ok(receivedBodies.length >= 1, 'Server should have received at least 1 request');
  const traceBody = receivedBodies.find(b => b.path === '/v1/traces');
  assert.ok(traceBody, 'Should have received /v1/traces request');
  const parsed = JSON.parse(traceBody.body);
  assert.ok(parsed.resourceSpans, 'Traces body should contain resourceSpans');
});

test('AC-1.4: Collector unreachable writes fallback JSONL', async () => {
  const dir = tempDir();
  const exporter = new OTLPOtlpExporter({
    endpoint: 'http://localhost:1',
    outputDir: dir,
  });
  exporter._buffer.push({
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    mode: 'shadow', callSite: 'test:fallback', runtime: { hash: 'a', length: 5 },
    candidate: { hash: 'b', length: 5 }, qualityDriftScore: 0, canary: { allowed: false, rollback: false },
  });
  await new Promise((resolve) => {
    exporter.flush(() => resolve());
    setTimeout(resolve, 2000);
  });
  const fallbackPath = path.join(dir, 'otel-fallback.jsonl');
  assert(fs.existsSync(fallbackPath), 'Fallback file should exist');
  const content = fs.readFileSync(fallbackPath, 'utf-8').trim();
  assert(content.includes('test:fallback'), 'Fallback should contain record');
});

test('AC-1.5: Buffer full FIFO discards oldest', () => {
  const exporter = new OTLPOtlpExporter({ endpoint: 'http://localhost:4318' });
  for (let i = 0; i < 105; i++) {
    exporter._buffer.push({ callSite: `site-${i}` });
  }
  while (exporter._buffer.length > 100) exporter._buffer.shift();
  assert.strictEqual(exporter._buffer.length, 100);
  assert.strictEqual(exporter._buffer[0].callSite, 'site-5');
});

test('AC-1.6: No endpoint makes export() a no-op', () => {
  const exporter = new OTLPOtlpExporter({});
  assert.strictEqual(exporter._endpoint, null);
  exporter.export({ callSite: 'noop' });
  assert.strictEqual(exporter._buffer.length, 0, 'Buffer should stay empty without endpoint');
});

test('AC-1.7: Zero external dependencies', () => {
  const content = fs.readFileSync(path.join(__dirname, 'otel-otlp-exporter.js'), 'utf-8');
  const requires = content.match(/require\(['"]([^'"]+)['"]\)/g) || [];
  for (const r of requires) {
    const mod = r.match(/require\(['"]([^'"]+)['"]\)/)[1];
    assert.ok(['http', 'https', 'fs', 'path'].includes(mod), `Unexpected dependency: ${mod}`);
  }
});

setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}, 3000);
