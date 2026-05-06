'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  evaluateFeatureAdoption,
  evaluateSkillQuality,
  evaluateSkillRegression,
  evaluateCompletionMechanisms,
} = require('./feature-adoption-gate');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-adoption-gate-'));
  fs.mkdirSync(path.join(root, 'workflow', 'core'), { recursive: true });
  fs.mkdirSync(path.join(root, '.workflow', 'skills', 'wepop', 'references'), { recursive: true });
  fs.mkdirSync(path.join(root, 'old', 'references'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'core', 'consumer.js'), 'loadLayeredCodeGraph(); new UnityModuleClassifier();', 'utf8');
  fs.writeFileSync(path.join(root, 'output.txt'), 'UICtrl Systems Core LiteCore TDR XLuaWork', 'utf8');
  fs.writeFileSync(path.join(root, '.workflow', 'skills', 'wepop', 'SKILL.md'), [
    '---',
    'name: wepop-trunk',
    'llmPowered: true',
    '---',
    '# WePop',
    'UICtrl Systems Core LiteCore Framework TDR XLuaWork lifecycle state event persistence',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, '.workflow', 'skills', 'wepop', 'references', 'd1-structure.md'), 'UICtrl Systems Core LiteCore Framework', 'utf8');
  fs.writeFileSync(path.join(root, '.workflow', 'skills', 'wepop', 'references', 'd2-behavior.md'), 'lifecycle state event', 'utf8');
  fs.writeFileSync(path.join(root, '.workflow', 'skills', 'wepop', 'references', 'd3-communication.md'), 'event data flow', 'utf8');
  fs.writeFileSync(path.join(root, '.workflow', 'skills', 'wepop', 'references', 'd4-contract.md'), 'TDR persistence error handling', 'utf8');
  fs.writeFileSync(path.join(root, 'old', 'SKILL.md'), 'WePop UICtrl Systems Core LiteCore TDR XLuaWork lifecycle state event persistence', 'utf8');
  fs.writeFileSync(path.join(root, 'old', 'references', 'd1-structure.md'), 'UICtrl Systems Core LiteCore Framework', 'utf8');
  return root;
}

(() => {
  const root = makeRoot();
  try {
    const adoption = evaluateFeatureAdoption(root, {
      mustUse: [{ file: 'workflow/core/consumer.js', contains: ['loadLayeredCodeGraph', 'UnityModuleClassifier'] }],
      mustAppearInOutput: [{ files: ['output.txt'], terms: ['UICtrl', 'TDR'] }],
      downstreamConsumers: [{ name: 'SkillGenerator', evidence: ['workflow/core/consumer.js'] }],
    });
    assert.strictEqual(adoption.passed, true);

    const quality = evaluateSkillQuality(root, {
      skillDir: '.workflow/skills/wepop',
      forbiddenSkillNames: ['library'],
      requiredTerms: ['UICtrl', 'Systems', 'Core', 'LiteCore', 'TDR', 'XLuaWork'],
      forbiddenEntryPatterns: ['Library/PackageCache'],
      minReferenceFiles: 4,
      forbidFallback: true,
    });
    assert.strictEqual(quality.passed, true);

    const regression = evaluateSkillRegression(root, {
      newSkillDir: '.workflow/skills/wepop',
      oldSkillDir: 'old',
      minRatio: 0.8,
      requiredTerms: ['UICtrl', 'Systems', 'Core', 'LiteCore', 'TDR', 'XLuaWork'],
      forbiddenPatterns: ['Library/PackageCache'],
    });
    assert.strictEqual(regression.passed, true);

    const combined = evaluateCompletionMechanisms(root, {
      featureAdoption: {
        mustUse: [{ file: 'workflow/core/consumer.js', contains: 'loadLayeredCodeGraph' }],
      },
      downstreamConsumers: [{ name: 'CapabilityMapper', evidence: ['workflow/core/consumer.js'] }],
      semanticQuality: {
        skillDir: '.workflow/skills/wepop',
        forbiddenSkillNames: ['library'],
        requiredTerms: ['UICtrl', 'Systems', 'Core', 'LiteCore'],
        minReferenceFiles: 4,
      },
      fallbackPolicy: { forbidFallback: true },
    });
    assert.strictEqual(combined.passed, true);

    const bad = evaluateSkillQuality(root, {
      skillDir: '.workflow/skills/wepop',
      requiredTerms: ['DefinitelyMissingTerm'],
    });
    assert.strictEqual(bad.passed, false);

    console.log('PASS feature-adoption-gate tests');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
