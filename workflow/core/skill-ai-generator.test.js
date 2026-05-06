'use strict';

const assert = require('assert');
const {
  buildPrompt,
  generateSkillFromPackaged,
  buildFallbackSkill,
  buildFallbackReferenceFiles,
} = require('./skill-ai-generator');
const {
  parseShardedOutput,
  validateSharding,
  SHARDING_FILE_WHITELIST,
} = require('./skill-sharding');

function minimalMapped() {
  return {
    scaffold: { projectType: 'DemoProject', architecture: 'modular', entryPoints: ['src/index.js'], coreServices: ['run'] },
    architecture: {
      modules: [{ name: 'core', symbolCount: 2, fileCount: 1 }],
      layers: { core: { symbolCount: 2, fileCount: 1, keySymbols: [] } },
      moduleRelations: [{ from: 'core', to: 'utils', callCount: 3 }],
    },
    designPatterns: { detected: [{ pattern: 'Pipeline', instanceCount: 2, confidence: 0.8, evidence: ['src/index.js'] }] },
    codingStandards: { conventions: [{ type: 'module-name', convention: 'kebab-case', evidence: 'files' }] },
    highValueSymbols: [{ name: 'run', kind: 'function', file: 'src/index.js', line: 1, signature: '()' }],
    triggers: { keywords: ['DemoProject', 'run', 'pipeline'], roles: ['developer'] },
  };
}

function longShardedOutput() {
  const filler = Array.from({ length: 80 }, (_, i) => `- Evidence line ${i}: src/file${i}.js`).join('\n');
  return [
    '=== FILE: SKILL.md ===',
    '---',
    'name: demo-project',
    'description: Demo project expert skill for testing sharded output.',
    'triggers:',
    '  keywords: [DemoProject, run, pipeline]',
    '  roles: [developer]',
    '---',
    '# Demo Project',
    '## §1 项目概览',
    filler,
    '=== FILE: references/d1-structure.md ===',
    '# D1', filler,
    '=== FILE: references/d2-behavior.md ===',
    '# D2', filler,
    '=== FILE: references/d3-communication.md ===',
    '# D3', filler,
    '=== FILE: references/d4-contract.md ===',
    '# D4', filler,
  ].join('\n');
}

(async () => {
  const prompt = buildPrompt(minimalMapped(), { contextString: '', modules: [] });
  assert(prompt.includes('=== FILE: SKILL.md ==='));
  assert(prompt.includes('references/d1-structure.md'));
  assert(prompt.includes('references/d4-contract.md'));
  assert(prompt.includes('Section homes'));

  const parsed = parseShardedOutput(longShardedOutput());
  assert.strictEqual(parsed.parseMode, 'sharded');
  assert.strictEqual(parsed.files.has('SKILL.md'), true);
  assert.strictEqual(parsed.files.has('references/d1-structure.md'), true);
  assert.strictEqual(validateSharding(parsed.files).valid, true);

  const single = parseShardedOutput('# Only Skill');
  assert.strictEqual(single.parseMode, 'single');
  assert.strictEqual(single.files.get('SKILL.md'), '# Only Skill');

  for (const file of ['SKILL.md', 'references/d1-structure.md', 'references/d2-behavior.md', 'references/d3-communication.md', 'references/d4-contract.md']) {
    assert(SHARDING_FILE_WHITELIST.has(file));
  }

  const fallbackMain = buildFallbackSkill(minimalMapped());
  const fallbackRefs = buildFallbackReferenceFiles(minimalMapped());
  assert(fallbackMain.startsWith('---'));
  assert.strictEqual(Object.keys(fallbackRefs).length, 4);

  const aiResult = await generateSkillFromPackaged({ modules: [], contextString: '' }, {}, {
    projectName: 'DemoProject',
    cheapLlmCall: async () => longShardedOutput(),
  });
  assert.strictEqual(aiResult.shardingMode, 'sharded');
  assert.strictEqual(Object.keys(aiResult.referenceFiles).length, 4);
  assert.strictEqual(aiResult.metadata.referenceFileCount, 4);

  const fallbackResult = await generateSkillFromPackaged({ modules: [], contextString: '' }, {}, {
    projectName: 'DemoProject',
    cheapLlmCall: async () => 'too short',
  });
  assert.strictEqual(fallbackResult.shardingMode, 'fallback-sharded');
  assert.strictEqual(Object.keys(fallbackResult.referenceFiles).length, 4);

  console.log('PASS skill-ai-generator sharding tests');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
