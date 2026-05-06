'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildOrUpdateStageDigest,
  selectRelevantDigests,
  formatDigestBlock,
  loadDigestIndex,
} = require('./context-digest-store');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-digest-'));
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

const analysisMd = `# ANALYSE

## 根因
Context is repeatedly injected into LLM prompts.
workflow/tools/ide-workflow-bridge.js line 8957 writes stage decisions.
workflow/core/context-loader.js reads mandatory docs.

## 修改范围
- workflow/core/context-digest-store.js
- workflow/tools/ide-workflow-bridge.js

## 下游消费影响
- output/context-digests/index.json is consumed by workflow-stage.
- output/context-digests/analysis.json is consumed by later stages.

## 风险评估
- P1 stale digest can pollute new tasks.
- P1 over-pruning can drop context.
`;

test('build digest and index', () => {
  const root = sandbox();
  try {
    const p = write(root, 'output/analysis.md', analysisMd);
    const r = buildOrUpdateStageDigest(root, { stage: 'ANALYSE', artifactPath: p, session: 's1', requirement: 'context digest merge' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.reused, false);
    assert.ok(fs.existsSync(path.join(root, 'output/context-digests/analysis.json')));
    const idx = loadDigestIndex(root);
    assert.ok(idx.digests.ANALYSE);
    assert.ok(idx.digests.ANALYSE.sourceHash);
  } finally { cleanup(root); }
});

test('reuses unchanged sourceHash', () => {
  const root = sandbox();
  try {
    const p = write(root, 'output/analysis.md', analysisMd);
    buildOrUpdateStageDigest(root, { stage: 'ANALYSE', artifactPath: p, session: 's1', requirement: 'context digest merge' });
    const second = buildOrUpdateStageDigest(root, { stage: 'ANALYSE', artifactPath: p, session: 's1', requirement: 'context digest merge' });
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.reused, true);
  } finally { cleanup(root); }
});

test('updates when source changes and merges useful arrays', () => {
  const root = sandbox();
  try {
    const p = write(root, 'output/analysis.md', analysisMd);
    buildOrUpdateStageDigest(root, { stage: 'ANALYSE', artifactPath: p, session: 's1', requirement: 'context digest merge' });
    write(root, 'output/analysis.md', `${analysisMd}\n- workflow/core/stage-output-reporter.js\n`);
    const updated = buildOrUpdateStageDigest(root, { stage: 'ANALYSE', artifactPath: p, session: 's1', requirement: 'context digest merge' });
    assert.strictEqual(updated.reused, false);
    assert.ok(updated.digest.content.affectedFiles.includes('workflow/core/context-digest-store.js'));
    assert.ok(updated.digest.content.affectedFiles.includes('workflow/core/stage-output-reporter.js'));
  } finally { cleanup(root); }
});

test('selects relevant digest and skips unrelated', () => {
  const root = sandbox();
  try {
    const p = write(root, 'output/analysis.md', analysisMd);
    buildOrUpdateStageDigest(root, { stage: 'ANALYSE', artifactPath: p, session: 's1', requirement: 'context digest merge' });
    const rel = selectRelevantDigests(root, { stage: 'PLAN', taskText: 'implement context digest merge in workflow/tools/ide-workflow-bridge.js' });
    assert.strictEqual(rel.selected.length, 1);
    assert.ok(rel.safety.requiredSkills.includes('workflow-orchestration'));
    const unrelated = selectRelevantDigests(root, { stage: 'PLAN', taskText: 'render CSS colors for landing page' });
    assert.strictEqual(unrelated.selected.length, 0);
    assert.strictEqual(unrelated.safety.lowConfidence, true);
    assert.ok(unrelated.safety.fallbackArtifacts.includes('output/analysis.md'));
  } finally { cleanup(root); }
});

test('format block includes source refs and safety net', () => {
  const root = sandbox();
  try {
    const p = write(root, 'output/analysis.md', analysisMd);
    buildOrUpdateStageDigest(root, { stage: 'ANALYSE', artifactPath: p, session: 's1', requirement: 'context digest merge' });
    const rel = selectRelevantDigests(root, { stage: 'PLAN', taskText: 'context digest merge' });
    const block = formatDigestBlock(rel.selected, rel.safety);
    assert.ok(block.includes('Context Digests'));
    assert.ok(block.includes('Full source'));
    assert.ok(block.includes('Safety Net'));
    assert.ok(block.includes('workflow-orchestration'));
  } finally { cleanup(root); }
});

if (process.exitCode) process.exit(process.exitCode);
console.log('Result: context-digest-store tests passed');
