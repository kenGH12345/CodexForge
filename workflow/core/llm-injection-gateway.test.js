'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LLMInjectionGateway, MODES, resolveGatewayMode, prepareGatewayPrompt } = require('./llm-injection-gateway');

const pendingTests = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingTests.push(result
        .then(() => console.log(`✓ ${name}`))
        .catch((err) => {
          console.error(`✗ ${name}`);
          console.error(err.stack || err.message);
          process.exitCode = 1;
        }));
      return;
    }
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-llm-gateway-'));
}

test('resolveGatewayMode defaults to candidate-runtime replacement', () => {
  const mode = resolveGatewayMode({});
  assert.strictEqual(mode.mode, MODES.CANDIDATE_RUNTIME);
  assert.strictEqual(mode.changedPromptOutput, true);
  assert.strictEqual(mode.shouldSendCandidate, true);
  assert.strictEqual(mode.rollbackMode, 'WF_LLM_INJECTION_GATEWAY_MODE=shadow');
});

test('prepare returns the original runtime payload in shadow mode', () => {
  const outputDir = tempDir();
  const runtimePayload = { system: 'system', user: 'secret-user-prompt' };
  const candidatePayload = { system: 'system', user: 'candidate prompt' };
  const gateway = new LLMInjectionGateway({ outputDir, mode: MODES.SHADOW });
  const prepared = gateway.prepare({
    callSite: 'test:shadow',
    role: 'tester',
    stage: 'TEST',
    runtimePrompt: runtimePayload,
    candidatePrompt: candidatePayload,
    metadata: { category: 'direct-chat-api', apiKey: 'must-not-appear' },
  });
  assert.strictEqual(prepared.promptToSend, runtimePayload);
  assert.strictEqual(prepared.changedPromptOutput, false);
  const jsonl = fs.readFileSync(path.join(outputDir, 'unified-llm-injection-shadow.jsonl'), 'utf-8');
  assert(!jsonl.includes('secret-user-prompt'));
  assert(!jsonl.includes('candidate prompt'));
  assert(!jsonl.includes('must-not-appear'));
  const record = JSON.parse(jsonl.trim());
  assert.strictEqual(record.callSite, 'test:shadow');
  assert.strictEqual(record.runtime.length > 0, true);
  assert.strictEqual(record.candidate.length > 0, true);
});

test('default candidate-runtime sends candidate for governed categories', () => {
  const outputDir = tempDir();
  const runtimePrompt = 'runtime prompt';
  const candidatePrompt = 'candidate prompt';
  const gateway = new LLMInjectionGateway({ outputDir, env: {} });
  const prepared = gateway.prepare({ runtimePrompt, candidatePrompt, callSite: 'test:candidate', metadata: { category: 'llm-lite-call' } });
  assert.strictEqual(prepared.promptToSend, candidatePrompt);
  assert.strictEqual(prepared.changedPromptOutput, true);
  assert.strictEqual(prepared.canary.defaultReplacement, true);
});

test('default candidate-runtime rolls back when rollback switch is active', () => {
  const outputDir = tempDir();
  const runtimePrompt = 'runtime prompt';
  const candidatePrompt = 'candidate prompt';
  const gateway = new LLMInjectionGateway({ outputDir, env: { WF_LLM_INJECTION_CANARY_ROLLBACK: 'true' } });
  const prepared = gateway.prepare({ runtimePrompt, candidatePrompt, callSite: 'test:candidate', metadata: { category: 'llm-lite-call' } });
  assert.strictEqual(prepared.promptToSend, runtimePrompt);
  assert.strictEqual(prepared.changedPromptOutput, false);
  assert(prepared.canary.reasons.includes('rollback-active'));
});

test('candidate-runtime sends candidate only with approval, allowlist, percent, and low-risk category', () => {
  const outputDir = tempDir();
  const runtimePrompt = 'runtime prompt';
  const candidatePrompt = 'candidate prompt';
  const env = {
    WF_LLM_INJECTION_GATEWAY_MODE: MODES.CANDIDATE_RUNTIME,
    WF_LLM_INJECTION_CANARY_APPROVED: 'true',
    WF_LLM_INJECTION_CANARY_ALLOWLIST: 'test:candidate',
    WF_LLM_INJECTION_CANARY_PERCENT: '100',
  };
  const gateway = new LLMInjectionGateway({ outputDir, env });
  const prepared = gateway.prepare({ runtimePrompt, candidatePrompt, callSite: 'test:candidate', metadata: { category: 'llm-lite-call' } });
  assert.strictEqual(prepared.promptToSend, candidatePrompt);
  assert.strictEqual(prepared.changedPromptOutput, true);
  assert.strictEqual(prepared.canary.allowed, true);
});

test('prepare records non-sensitive outcome telemetry when deferred', () => {
  const outputDir = tempDir();
  const gateway = new LLMInjectionGateway({ outputDir, env: {} });
  const prepared = gateway.prepare({
    runtimePrompt: 'runtime prompt',
    candidatePrompt: 'candidate prompt with more context',
    callSite: 'test:outcome',
    metadata: { category: 'llm-lite-call', rawPrompt: 'must-not-appear' },
    deferAppend: true,
  });
  prepared.recordOutcome({ status: 'ok', runtimeLatencyMs: 120, candidateLatencyMs: 132, qualityDriftScore: 0.05 });
  const jsonl = fs.readFileSync(path.join(outputDir, 'unified-llm-injection-shadow.jsonl'), 'utf-8');
  assert(!jsonl.includes('runtime prompt'));
  assert(!jsonl.includes('candidate prompt with more context'));
  assert(!jsonl.includes('must-not-appear'));
  const record = JSON.parse(jsonl.trim());
  assert.strictEqual(record.status, 'ok');
  assert.strictEqual(record.runtime.latencyMs, 120);
  assert.strictEqual(record.candidate.latencyMs, 132);
  assert.strictEqual(record.qualityDriftScore, 0.05);
});

test('prepare fails open when outputDir cannot be used', () => {
  const filePath = path.join(tempDir(), 'not-a-dir');
  fs.writeFileSync(filePath, 'x');
  const gateway = new LLMInjectionGateway({ outputDir: filePath, mode: MODES.SHADOW });
  const payload = 'runtime prompt';
  const prepared = gateway.prepare({ runtimePrompt: payload, callSite: 'test:fail-open' });
  assert.strictEqual(prepared.promptToSend, payload);
  assert(prepared.record.telemetryError);
});

test('prepareGatewayPrompt reuses owner gateway and returns runtime payload', () => {
  const outputDir = tempDir();
  const owner = { llmInjectionGateway: new LLMInjectionGateway({ outputDir, mode: MODES.SHADOW }) };
  const payload = ['runtime', { role: 'user', content: 'private helper prompt' }];
  const promptToSend = prepareGatewayPrompt(owner, {
    callSite: 'test:helper',
    role: 'helper',
    stage: 'TEST',
    runtimePrompt: payload,
    candidatePrompt: 'candidate helper prompt',
  });
  assert.strictEqual(promptToSend, payload);
  const jsonl = fs.readFileSync(path.join(outputDir, 'unified-llm-injection-shadow.jsonl'), 'utf-8');
  assert(!jsonl.includes('private helper prompt'));
  assert(!jsonl.includes('candidate helper prompt'));
});

Promise.all(pendingTests).then(() => {
  if (process.exitCode) process.exit(process.exitCode);
});
