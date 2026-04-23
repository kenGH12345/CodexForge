/**
 * B++ Slot-based Validator Integration Test
 *
 * Directly exercises _validateArtifact via __testHooks, avoiding the CLI
 * session guard. Verifies slot-based semantic validation correctly replaces
 * brittle exact-string matching for ANALYSE/ARCHITECT artifacts.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { __testHooks } = require(path.resolve(__dirname, '..', 'tools', 'ide-workflow-bridge.js'));
const { ARTIFACT_SCHEMA, _matchSlot, _validateArtifact } = __testHooks;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-'));
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  return root;
}

function writeArtifact(root, file, content) {
  fs.writeFileSync(path.join(root, 'output', file), content, 'utf-8');
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

function run(label, fn) {
  try {
    fn();
    console.log(`  PASS: ${label}`);
    return true;
  } catch (err) {
    console.error(`  FAIL: ${label}`);
    console.error(`    ${err.message}`);
    return false;
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ANALYSE_PASS = [
  '# analysis',
  '',
  '## 根因',
  '问题出在字符串硬匹配上。',
  '具体表现为中文锚点 \\b 失效。',
  '根本原因是 Node.js 正则引擎不支持 CJK word-boundary。',
  '',
  '## 受影响位置',
  '- workflow/tools/ide-workflow-bridge.js L7253',
  '',
  '## 修改范围',
  '新增 requiredSlots 字段。',
  '实现 _matchSlot 辅助函数。',
  '插入 slot 校验分支。',
  '',
  '## 风险评估',
  '- P1: 正则误匹配',
  '- P2: 测试回归',
  ''
].join('\n');

const ARCHITECT_PASS = [
  '# architecture',
  '',
  '## Architecture Scorecard',
  'Decision Justification: PASS',
  'Reliability: PASS',
  'Consistency: PASS',
  '',
  '## Failure Model',
  'F1: slot match fails',
  'F2: regex fatigue',
  'F3: unbounded content',
  '',
  '## Migration Safety Case',
  'Backward compatible via fallback to requiredSections.',
  'Rollback: revert two files.',
  'Contract evidence: dogfooding.',
  '',
  '## Scenario Coverage',
  'Scenario 1: projection drift handled.',
  'Scenario 2: rollback boundary covered.',
  'Scenario 3: recovery path grounded.',
  ''
].join('\n');

function main() {
  console.log('B++ Slot-Based Validator Integration Test');
  console.log('─────────────────────────────────────────');

  let passed = 0;
  let total = 0;

  total += 1;
  if (run('Static: ARTIFACT_SCHEMA.ANALYSE has 3 requiredSlots', () => {
    expect(Array.isArray(ARTIFACT_SCHEMA.ANALYSE.requiredSlots), 'ANALYSE.requiredSlots missing');
    expect(ARTIFACT_SCHEMA.ANALYSE.requiredSlots.length === 3, `expected 3 slots, got ${ARTIFACT_SCHEMA.ANALYSE.requiredSlots.length}`);
    const ids = ARTIFACT_SCHEMA.ANALYSE.requiredSlots.map(s => s.id).sort();
    expect(JSON.stringify(ids) === JSON.stringify(['change_scope', 'risk_assessment', 'root_cause']), `unexpected slot ids: ${ids}`);
  })) passed += 1;

  total += 1;
  if (run('Static: ARTIFACT_SCHEMA.ARCHITECT has 4 requiredSlots', () => {
    expect(Array.isArray(ARTIFACT_SCHEMA.ARCHITECT.requiredSlots), 'ARCHITECT.requiredSlots missing');
    expect(ARTIFACT_SCHEMA.ARCHITECT.requiredSlots.length === 4, `expected 4 slots, got ${ARTIFACT_SCHEMA.ARCHITECT.requiredSlots.length}`);
  })) passed += 1;

  total += 1;
  if (run('_matchSlot: Chinese heading + 3 content lines matches and passes minLines', () => {
    const slot = { aliases: [/^##\s*根因(?:\s|$|[（(\/、])/im], minContentLines: 3 };
    const r = _matchSlot('## 根因\n\nl1\nl2\nl3\n\n## other', slot);
    expect(r.matched === true, 'should match');
    expect(r.contentLines === 3, `contentLines=${r.contentLines}`);
    expect(r.passedMinLines === true, 'should pass min');
  })) passed += 1;

  total += 1;
  if (run('_matchSlot: Chinese heading with only 1 content line fails minLines', () => {
    const slot = { aliases: [/^##\s*根因(?:\s|$|[（(\/、])/im], minContentLines: 3 };
    const r = _matchSlot('## 根因\n只有一行\n## other', slot);
    expect(r.matched === true, 'should match heading');
    expect(r.contentLines === 1, `contentLines=${r.contentLines}`);
    expect(r.passedMinLines === false, 'should fail min');
  })) passed += 1;

  total += 1;
  if (run('_matchSlot: no matching heading returns matched=false', () => {
    const slot = { aliases: [/^##\s*根因(?:\s|$|[（(\/、])/im], minContentLines: 3 };
    const r = _matchSlot('## unrelated heading\ncontent', slot);
    expect(r.matched === false, 'should not match');
    expect(r.contentLines === 0, 'no lines counted');
  })) passed += 1;

  total += 1;
  if (run('_validateArtifact: ANALYSE with all 3 Chinese slots filled PASSES slot check', () => {
    const root = sandbox();
    writeArtifact(root, 'analysis.md', ANALYSE_PASS);
    const r = _validateArtifact('ANALYSE', root);
    cleanup(root);
    if (!r.valid) {
      const err = r.error || 'unknown';
      if (err.includes('[SLOT_MISSING]') || err.includes('[SLOT_TOO_THIN]')) {
        throw new Error(`unexpected slot failure: ${err}`);
      }
    }
  })) passed += 1;

  total += 1;
  if (run('_validateArtifact: ANALYSE missing change_scope FAILS with SLOT_MISSING', () => {
    const root = sandbox();
    const content = ANALYSE_PASS.replace(/## 修改范围[\s\S]*?(?=\n## )/, '');
    writeArtifact(root, 'analysis.md', content);
    const r = _validateArtifact('ANALYSE', root);
    cleanup(root);
    expect(r.valid === false, 'should fail');
    expect(r.error && r.error.includes('[SLOT_MISSING]'), `expected SLOT_MISSING, got: ${r.error}`);
  })) passed += 1;

  total += 1;
  if (run('_validateArtifact: ANALYSE with thin 根因 (1 line) FAILS with SLOT_TOO_THIN', () => {
    const root = sandbox();
    const content = ANALYSE_PASS.replace(
      /## 根因\n问题出在字符串硬匹配上。\n具体表现为中文锚点 \\b 失效。\n根本原因是 Node\.js 正则引擎不支持 CJK word-boundary。/,
      '## 根因\n只有一行'
    );
    writeArtifact(root, 'analysis.md', content);
    const r = _validateArtifact('ANALYSE', root);
    cleanup(root);
    expect(r.valid === false, 'should fail');
    expect(r.error && r.error.includes('[SLOT_TOO_THIN]'), `expected SLOT_TOO_THIN, got: ${r.error}`);
  })) passed += 1;

  total += 1;
  if (run('_validateArtifact: ANALYSE with English aliases accepted', () => {
    const root = sandbox();
    const content = ANALYSE_PASS
      .replace('## 根因', '## Root Cause')
      .replace('## 修改范围', '## Change Scope')
      .replace('## 风险评估', '## Risk Assessment');
    writeArtifact(root, 'analysis.md', content);
    const r = _validateArtifact('ANALYSE', root);
    cleanup(root);
    if (!r.valid) {
      const err = r.error || 'unknown';
      if (err.includes('[SLOT_MISSING]') || err.includes('[SLOT_TOO_THIN]')) {
        throw new Error(`unexpected slot failure: ${err}`);
      }
    }
  })) passed += 1;

  total += 1;
  if (run('_validateArtifact: ARCHITECT with 4 slots filled PASSES slot check', () => {
    const root = sandbox();
    writeArtifact(root, 'architecture.md', ARCHITECT_PASS);
    const r = _validateArtifact('ARCHITECT', root);
    cleanup(root);
    if (!r.valid) {
      const err = r.error || 'unknown';
      if (err.includes('[SLOT_MISSING]') || err.includes('[SLOT_TOO_THIN]')) {
        throw new Error(`unexpected slot failure: ${err}`);
      }
    }
  })) passed += 1;

  total += 1;
  if (run('_validateArtifact: PLAN schema without requiredSlots still works via fallback', () => {
    const root = sandbox();
    writeArtifact(root, 'execution-plan.md', '# plan\n\n## T1 task\n- workflow/tools/ide-workflow-bridge.js\nstep 1\nstep 2\nstep 3\n');
    const r = _validateArtifact('PLAN', root);
    cleanup(root);
    if (!r.valid) {
      const err = r.error || 'unknown';
      if (err.includes('[ARTIFACT_SCHEMA_FAILED]') || err.includes('[SLOT_MISSING]')) {
        throw new Error(`PLAN fallback broke: ${err}`);
      }
    }
  })) passed += 1;

  console.log('─────────────────────────────────────────');
  console.log(`Result: ${passed}/${total} tests passed`);
  if (passed !== total) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { main };