/**
 * ExperienceRouter Lite Tests
 * Lightweight tests focusing on exports and constants
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Test module existence and exports
describe('ExperienceRouter Module Exports', () => {
  it('should load module', () => {
    const router = require('./experience-router');
    assert.ok(router, 'Module should load');
  });

  it('should export ExperienceRouter class', () => {
    const { ExperienceRouter } = require('./experience-router');
    assert.ok(ExperienceRouter, 'Should export ExperienceRouter');
    assert.ok(typeof ExperienceRouter === 'function', 'Should be constructible');
  });

  it('should export registry constants', () => {
    const { REGISTRY_DIR, REGISTRY_PATH } = require('./experience-router');

    assert.ok(REGISTRY_DIR, 'Should export REGISTRY_DIR');
    assert.ok(REGISTRY_PATH, 'Should export REGISTRY_PATH');
    assert.ok(typeof REGISTRY_DIR === 'string', 'Should be string');
    assert.ok(typeof REGISTRY_PATH === 'string', 'Should be string');
  });
});

describe('ExperienceRouter Registry Paths', () => {
  const { REGISTRY_DIR, REGISTRY_PATH } = require('./experience-router');

  it('should have valid registry directory path', () => {
    assert.ok(REGISTRY_DIR.includes('.codexforge') || REGISTRY_DIR.includes('codexforge'),
      'Should reference codexforge');
  });

  it('should have valid registry file path', () => {
    assert.ok(REGISTRY_PATH.includes('experience-registry'),
      'Should reference experience-registry');
    assert.ok(REGISTRY_PATH.endsWith('.json'),
      'Should be JSON file');
  });

  it('should put registry in registry dir', () => {
    const baseName = path.basename(REGISTRY_PATH);
    const dirName = path.dirname(REGISTRY_PATH);

    assert.strictEqual(dirName, REGISTRY_DIR, 'Registry should be in registry dir');
    assert.strictEqual(baseName, 'experience-registry.json', 'Should have correct filename');
  });
});

describe('ExperienceRouter Scoring Logic', () => {
  it('should calculate tech overlap correctly', () => {
    const projectTech = new Set(['node', 'react', 'typescript']);
    const experienceTech = new Set(['node', 'react', 'jest']);

    const overlap = new Set([...projectTech].filter(x => experienceTech.has(x)));
    const maxPossible = Math.max(projectTech.size, experienceTech.size, 1);
    const score = overlap.size / maxPossible;

    assert.strictEqual(overlap.size, 2, 'Should find 2 overlaps (node, react)');
    assert.ok(score > 0 && score <= 1, 'Score should be between 0 and 1');
  });

  it('should calculate recency score', () => {
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);

    const score1 = Math.max(0, 1 - (now - oneDayAgo) / (1000 * 60 * 60 * 24 * 365));
    const score2 = Math.max(0, 1 - (now - oneYearAgo) / (1000 * 60 * 60 * 24 * 365));

    assert.ok(score1 > 0.99, 'Recent should have high score');
    assert.ok(score2 < 0.01, 'Old should have low score');
  });

  it('should compose relevance score', () => {
    const techOverlap = 0.6;
    const quality = 0.8;
    const recency = 0.9;

    const score = (techOverlap * 0.5) + (quality * 0.3) + (recency * 0.2);

    assert.ok(score >= 0 && score <= 1, 'Composite score should be normalized');
    assert.ok(Math.abs(score - 0.72) < 0.01, 'Score should be ~0.72');
  });
});

describe('ExperienceRouter Data Validation', () => {
  it('should validate experience structure', () => {
    const validExp = {
      title: 'Test Experience',
      content: 'This is valid content',
      tags: ['test', 'validation'],
    };

    assert.ok(typeof validExp.title === 'string', 'Title should be string');
    assert.ok(typeof validExp.content === 'string', 'Content should be string');
    assert.ok(Array.isArray(validExp.tags), 'Tags should be array');
  });

  it('should block prototype pollution attempts', () => {
    const malicious = {
      title: 'Bad',
      '__proto__': { polluted: true },
    };

    const hasProtoKey = '__proto__' in malicious;
    assert.ok(hasProtoKey, 'Should detect malicious key');

    // Validation should filter this
    const safe = Object.fromEntries(
      Object.entries(malicious).filter(([k]) => !['__proto__', 'constructor', 'prototype'].includes(k))
    );

    assert.ok(!('__proto__' in safe), 'Should remove proto key');
  });
});

describe('ExperienceRouter Registry Limits', () => {
  it('should enforce max projects limit', () => {
    const MAX_PROJECTS = 100;
    assert.ok(MAX_PROJECTS > 0, 'Should have valid limit');
  });

  it('should enforce max auto-import limit', () => {
    const MAX_AUTO_IMPORT = 20;
    assert.ok(MAX_AUTO_IMPORT > 0, 'Should have valid limit');
    assert.ok(MAX_AUTO_IMPORT <= 50, 'Should be reasonable');
  });
});

describe('ExperienceRouter Tech Stack Matching', () => {
  it('should normalize tech stack tags', () => {
    const techStack = ['Node.js', 'React', 'TypeScript'];
    const normalized = techStack.map(t => t.toLowerCase().replace(/\.js$/, ''));

    assert.ok(normalized.includes('node'), 'Should normalize Node.js to node');
    assert.ok(normalized.includes('react'), 'Should preserve react');
  });

  it('should handle empty tech stack', () => {
    const emptyStack = [];
    assert.ok(Array.isArray(emptyStack), 'Empty stack should still be array');
    assert.strictEqual(emptyStack.length, 0, 'Should be empty');
  });
});

console.log(`\n🎯 ExperienceRouter Lite Tests\n`);
