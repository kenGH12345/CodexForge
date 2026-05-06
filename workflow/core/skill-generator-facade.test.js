'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generate } = require('./skill-generator-facade');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-facade-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo-facade' }), 'utf8');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'function run() { return true; }\nmodule.exports = { run };\n', 'utf8');
  return root;
}

function shardedOutput() {
  const body = Array.from({ length: 90 }, (_, i) => `- concrete line ${i}: src/index.js`).join('\n');
  return [
    '=== FILE: SKILL.md ===',
    '---',
    'name: demo-facade',
    'description: Demo facade project expert skill with sharded references.',
    'triggers:',
    '  keywords: [demo-facade, index, run]',
    '  roles: [developer]',
    '---',
    '# Demo Facade',
    '## §1 项目概览',
    body,
    '=== FILE: references/d1-structure.md ===', '# D1', body,
    '=== FILE: references/d2-behavior.md ===', '# D2', body,
    '=== FILE: references/d3-communication.md ===', '# D3', body,
    '=== FILE: references/d4-contract.md ===', '# D4', body,
  ].join('\n');
}

(async () => {
  const root = makeRoot();
  try {
    const result = await generate(root, {
      fileList: ['src/index.js'],
      cheapLlmCall: async () => shardedOutput(),
      force: true,
    });

    assert.ifError(result.error);
    const skillDirName = path.basename(root).toLowerCase();
    assert(result.skillPath.endsWith(path.join(skillDirName, 'SKILL.md')));
    assert(fs.existsSync(result.skillPath), 'SKILL.md should be written');
    assert(fs.existsSync(path.join(root, '.workflow', 'skills', skillDirName, 'references', 'd1-structure.md')));
    assert(fs.existsSync(path.join(root, '.workflow', 'skills', skillDirName, 'references', 'd4-contract.md')));
    assert.strictEqual(result.referencePaths.length, 4);
    assert.strictEqual(result.shardingMode, 'sharded');

    const dryRoot = makeRoot();
    try {
      const dry = await generate(dryRoot, {
        fileList: ['src/index.js'],
        cheapLlmCall: async () => shardedOutput(),
        dryRun: true,
      });
      assert.ifError(dry.error);
      assert.strictEqual(fs.existsSync(dry.skillPath), false, 'dryRun should not write SKILL.md');
    } finally {
      fs.rmSync(dryRoot, { recursive: true, force: true });
    }

    console.log('PASS skill-generator-facade sharding write tests');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
