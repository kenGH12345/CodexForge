'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSessionSummary, __testHooks } = require('../tools/ide-workflow-bridge');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function makeTempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-retro-'));
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
  return root;
}

const retroTable = [
  '## 复盘 / Retrospective',
  '',
  '| Layer | Question | Answer |',
  '|-------|----------|--------|',
  '| **Prevention** (预防层) | How did this problem arise? | 早期没有把复盘表格接入机器信号，导致结论停留在 Markdown 展示层。 |',
  '| **Capability** (能力层) | What pattern did you learn? | 可通过 Retrospective table parser 将三层复盘映射为 EvolutionLoop signals。 |',
  '| **Efficiency** (效率层) | What slowed you down? | 自动解析并显示 signal ids 能减少人工追踪经验是否落库的时间。 |',
].join('\n');

test('extractRetrospectiveFromMarkdown parses three-layer table', () => {
  const parsed = __testHooks._extractRetrospectiveFromMarkdown(retroTable);
  assert.strictEqual(parsed.found, true);
  assert(parsed.prevention.includes('Markdown 展示层'));
  assert(parsed.capability.includes('EvolutionLoop signals'));
  assert(parsed.efficiency.includes('signal ids'));
});

test('runSessionSummary injects retrospective and reports ids', () => {
  const root = makeTempProject();
  fs.writeFileSync(path.join(root, 'output', 'session-summary.md'), retroTable, 'utf-8');

  const result = runSessionSummary({
    projectRoot: root,
    requirement: 'retro closure test',
    session: 'retro-test-session',
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.retrospective.signalsProcessed, 3);
  assert(result.data.retrospective.experienceIds.length >= 3);
  assert(result.data.retrospective.promptFeedbackIds.length >= 1);

  const summary = fs.readFileSync(path.join(root, 'output', 'session-summary.md'), 'utf-8');
  assert(summary.includes('## ♻️ Retrospective Signals'));
  assert(summary.includes('signalsProcessed | 3'));
  assert(summary.includes('experienceIds'));
  assert(summary.includes('promptFeedbackIds'));

  const second = runSessionSummary({
    projectRoot: root,
    requirement: 'retro closure test',
    session: 'retro-test-session',
  });
  assert.strictEqual(second.success, true);
  assert.strictEqual(second.data.retrospective.signalsProcessed, 3);
  assert.strictEqual(second.data.retrospective.reused, true);
  assert.deepStrictEqual(second.data.retrospective.experienceIds, result.data.retrospective.experienceIds);
  assert.deepStrictEqual(second.data.retrospective.promptFeedbackIds, result.data.retrospective.promptFeedbackIds);
});

if (process.exitCode) process.exit(process.exitCode);
