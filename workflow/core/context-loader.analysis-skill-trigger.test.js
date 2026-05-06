/*
 * Post-analysis skill trigger tests.
 *
 * Verifies that ContextLoader can auto-inject project expert skills using
 * analysis/project/code signals, not only raw user query keywords.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { loadConfig, clearConfigCache } = require('./config-loader');
const { ContextLoader } = require('./context-loader');

let testCount = 0;
let passCount = 0;

function test(name, fn) {
  testCount++;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passCount++;
      console.log(`✅ ${name}`);
    })
    .catch(err => {
      console.error(`❌ ${name}`);
      console.error(`   ${err.message}`);
      if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    });
}

function createTempProject(name = 'WePop_trunk') {
  const root = path.join(__dirname, '__tmp_analysis_skill_' + Date.now() + Math.random().toString(36).slice(2, 6), name);
  fs.mkdirSync(path.join(root, 'workflow', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(root, '.workflow', 'skills', 'wepop_trunk'), { recursive: true });
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow.config.js'), 'module.exports = {};', 'utf8');
  return root;
}

function cleanupDir(root) {
  const base = path.dirname(root);
  if (fs.existsSync(base)) fs.rmSync(base, { recursive: true, force: true });
}

function writeWePopSkill(root) {
  fs.writeFileSync(path.join(root, '.workflow', 'skills', 'wepop_trunk', 'SKILL.md'),
    '---\n' +
    'name: wepop_trunk\n' +
    'version: 1.0.0\n' +
    'type: project-expert-skill\n' +
    'description: WePop project expert skill for MVVM data flow and UI binding.\n' +
    'domains: [wepop, unity-csharp, mvvm]\n' +
    'triggers:\n' +
    '  keywords:\n' +
    '    - WePop\n' +
    '    - wepop_trunk\n' +
    '    - MVVM\n' +
    '    - CommonModel\n' +
    '    - ServerProxy\n' +
    '    - ModelViewBehaviour\n' +
    '  roles:\n' +
    '    - developer\n' +
    'load_level: session\n' +
    'max_tokens: 2000\n' +
    '---\n\n' +
    '# WePop Expert\n\n## Usage\n\nUse CommonModel and ServerProxy conventions for UI data binding.\n',
    'utf8');
}

async function resolveWithProject(root, taskText) {
  clearConfigCache();
  const { config } = loadConfig(root);
  const loader = new ContextLoader({
    workflowRoot: path.join(root, 'workflow'),
    projectRoot: root,
    registeredSkills: config.builtinSkills || [],
  });
  return loader.resolve(taskText, 'developer', { modelTier: 'large', stage: 'DEVELOP' });
}

async function runAll() {
  console.log('\n=== Post-analysis Skill Trigger Tests ===\n');

  await test('analysis.md symbol triggers project expert skill even when task text has no project keyword', async () => {
    const root = createTempProject('GenericUnityProject');
    try {
      writeWePopSkill(root);
      fs.writeFileSync(path.join(root, 'output', 'analysis.md'),
        '# Analysis\n\nAffected symbols: CommonModel, ServerProxy, ModelViewBehaviour.\nAffected path: Assets/Scripts/UI/LoginView.cs\n',
        'utf8');

      const result = await resolveWithProject(root, '修复 UI 数据绑定问题');
      assert(result.sources.some(s => s.includes('wepop_trunk')), `sources should include wepop_trunk, got: ${result.sources.join(', ')}`);
      assert(result.sections.some(s => s.includes('WePop Expert')), 'sections should include skill content');
    } finally {
      cleanupDir(root);
    }
  });

  await test('projectRoot basename participates in skill query and ranking', async () => {
    const root = createTempProject('WePop_trunk');
    try {
      writeWePopSkill(root);
      clearConfigCache();
      const { config } = loadConfig(root);
      const loader = new ContextLoader({
        workflowRoot: path.join(root, 'workflow'),
        projectRoot: root,
        registeredSkills: config.builtinSkills || [],
      });
      const query = loader._buildSkillMatchQuery('修复 UI 数据绑定问题', {});
      assert(/wepop_trunk/i.test(query), `query should include projectRoot basename, got: ${query}`);
      const matched = await loader._matchSkillsAsync(query, 'developer');
      assert(matched.includes('wepop_trunk'), `ranked skills should include wepop_trunk, got: ${matched.join(', ')}`);
    } finally {
      cleanupDir(root);
    }
  });

  await test('business-logic.json signal participates in skill matching', async () => {
    const root = createTempProject('GenericProject');
    try {
      writeWePopSkill(root);
      fs.writeFileSync(path.join(root, 'output', 'business-logic.json'), JSON.stringify({
        patterns: {
          businessFlows: [{ name: 'UI data flow', description: 'ServerProxy updates CommonModel for views' }],
          coreServices: [{ name: 'ServerProxy' }],
        },
      }), 'utf8');

      clearConfigCache();
      const { config } = loadConfig(root);
      const loader = new ContextLoader({
        workflowRoot: path.join(root, 'workflow'),
        projectRoot: root,
        registeredSkills: config.builtinSkills || [],
      });
      const query = loader._buildSkillMatchQuery('修复 UI 数据绑定问题', {});
      assert(query.includes('ServerProxy') || query.includes('CommonModel'), `query should include business logic symbols, got: ${query}`);
      const matched = await loader._matchSkillsAsync(query, 'developer');
      assert(matched.includes('wepop_trunk'), `ranked skills should include wepop_trunk, got: ${matched.join(', ')}`);
    } finally {
      cleanupDir(root);
    }
  });

  await test('registeredSkills are included in SkillRanker corpus', async () => {
    const root = createTempProject('WePop_trunk');
    try {
      writeWePopSkill(root);
      clearConfigCache();
      const { config } = loadConfig(root);
      const loader = new ContextLoader({
        workflowRoot: path.join(root, 'workflow'),
        projectRoot: root,
        registeredSkills: config.builtinSkills || [],
      });
      const query = loader._buildSkillMatchQuery('修复 UI 数据绑定问题', {});
      assert(query.includes('WePop_trunk') || query.includes('wepop_trunk'), `query should include project root signal, got: ${query}`);
      loader._rebuildSkillRankerCorpus();
      const stats = loader._skillRanker.getStats();
      assert(stats.corpusSize >= 1, `corpus should include registered skills, got ${stats.corpusSize}`);
    } finally {
      cleanupDir(root);
    }
  });

  console.log('\n==================================================');
  console.log(`Results: ${passCount}/${testCount} passed`);
  console.log('==================================================\n');
  if (passCount !== testCount) process.exit(1);
}

runAll();
