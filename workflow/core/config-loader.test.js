/**
 * Tests for Config Loader — Skill Auto-Discovery
 *
 * Run with: node workflow/core/config-loader.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadConfig, clearConfigCache } = require('./config-loader');

// ─── Test Utilities ─────────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
  }
}

function createTempDir() {
  const tmp = path.join(__dirname, '__tmp_test_' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

function cleanupDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// ─── Unit Tests: Skill Auto-Discovery ───────────────────────────────────────

console.log('\n=== Unit Tests: Skill Auto-Discovery ===\n');

test('silent skip when skills dir does not exist', () => {
  const tmpDir = createTempDir();
  writeFile(path.join(tmpDir, 'workflow.config.js'), 'module.exports = { builtinSkills: [] };');

  clearConfigCache();
  const { config } = loadConfig(tmpDir);

  assert(Array.isArray(config.builtinSkills), 'builtinSkills should be array');
  assert.strictEqual(config.builtinSkills.length, 0, 'should have no skills when dir missing');

  cleanupDir(tmpDir);
});

test('YAML frontmatter extraction with domains array', () => {
  const tmpDir = createTempDir();
  const skillsDir = path.join(tmpDir, 'workflow', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  writeFile(
    path.join(skillsDir, 'code-review.md'),
    `---
name: code-review
domains: [quality, review, security]
description: "Two-stage code review"
---
# Code Review\n`
  );
  writeFile(path.join(tmpDir, 'workflow.config.js'), 'module.exports = { builtinSkills: [] };');

  clearConfigCache();
  const { config } = loadConfig(tmpDir);

  const found = config.builtinSkills.find(s => s.name === 'code-review');
  assert(found, 'code-review should be discovered');
  assert.strictEqual(found.description, 'Two-stage code review');
  assert.deepStrictEqual(found.domains, ['quality', 'review', 'security']);

  cleanupDir(tmpDir);
});

test('YAML frontmatter extraction with domains string', () => {
  const tmpDir = createTempDir();
  const skillsDir = path.join(tmpDir, 'workflow', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  writeFile(
    path.join(skillsDir, 'api-design.md'),
    `---
name: api-design
domains: backend
description: REST API design rules
---
# API Design\n`
  );
  writeFile(path.join(tmpDir, 'workflow.config.js'), 'module.exports = { builtinSkills: [] };');

  clearConfigCache();
  const { config } = loadConfig(tmpDir);

  const found = config.builtinSkills.find(s => s.name === 'api-design');
  assert(found, 'api-design should be discovered');
  assert.deepStrictEqual(found.domains, ['backend']);

  cleanupDir(tmpDir);
});

test('fallback metadata when no YAML frontmatter', () => {
  const tmpDir = createTempDir();
  const skillsDir = path.join(tmpDir, 'workflow', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  writeFile(path.join(skillsDir, 'architecture-design.md'), '# Architecture Design\nSome content.\n');
  writeFile(path.join(tmpDir, 'workflow.config.js'), 'module.exports = { builtinSkills: [] };');

  clearConfigCache();
  const { config } = loadConfig(tmpDir);

  const found = config.builtinSkills.find(s => s.name === 'architecture-design');
  assert(found, 'architecture-design should be discovered');
  assert(found.description.includes('Auto-discovered'), 'description should be fallback');
  assert(found.domains.includes('architecture'), 'domains should be derived from name');

  cleanupDir(tmpDir);
});

test('user-configured skills are not overwritten', () => {
  const tmpDir = createTempDir();
  const skillsDir = path.join(tmpDir, 'workflow', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  writeFile(
    path.join(skillsDir, 'my-skill.md'),
    `---
name: my-skill
description: "File description"
---
# My Skill\n`
  );
  writeFile(
    path.join(tmpDir, 'workflow.config.js'),
    `module.exports = {
      builtinSkills: [
        { name: 'my-skill', description: 'User description', domains: ['user'] }
      ]
    };`
  );

  clearConfigCache();
  const { config } = loadConfig(tmpDir);

  const found = config.builtinSkills.find(s => s.name === 'my-skill');
  assert(found, 'my-skill should exist');
  assert.strictEqual(found.description, 'User description', 'user desc should be preserved');
  assert.deepStrictEqual(found.domains, ['user'], 'user domains should be preserved');

  cleanupDir(tmpDir);
});

test('auto-creates builtinSkills array when missing', () => {
  const tmpDir = createTempDir();
  const skillsDir = path.join(tmpDir, 'workflow', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  writeFile(path.join(skillsDir, 'test-skill.md'), '---\nname: test-skill\n---\n# Test\n');
  writeFile(path.join(tmpDir, 'workflow.config.js'), 'module.exports = {};');

  clearConfigCache();
  const { config } = loadConfig(tmpDir);

  assert(Array.isArray(config.builtinSkills), 'builtinSkills should be auto-created');
  const found = config.builtinSkills.find(s => s.name === 'test-skill');
  assert(found, 'test-skill should be discovered');

  cleanupDir(tmpDir);
});

test('single file parse failure does not block other files', () => {
  const tmpDir = createTempDir();
  const skillsDir = path.join(tmpDir, 'workflow', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  writeFile(path.join(skillsDir, 'good.md'), '---\nname: good\n---\n# Good\n');
  // Create a file that will cause a read error (directory with .md extension)
  fs.mkdirSync(path.join(skillsDir, 'bad-dir.md'), { recursive: true });

  writeFile(path.join(tmpDir, 'workflow.config.js'), 'module.exports = { builtinSkills: [] };');

  clearConfigCache();
  const { config } = loadConfig(tmpDir);

  const found = config.builtinSkills.find(s => s.name === 'good');
  assert(found, 'good should be discovered despite bad-dir.md error');

  cleanupDir(tmpDir);
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passCount}/${testCount} passed`);
console.log(`${'='.repeat(50)}\n`);

process.exit(passCount === testCount ? 0 : 1);
