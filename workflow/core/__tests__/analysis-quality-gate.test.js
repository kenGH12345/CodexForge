'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateAnalysisQuality, extractUserStories, extractAcceptanceCriteria, extractRiskSummary, CHECK_IDS } = require('../analysis-quality-gate');

const GOOD_ANALYSE_CONTENT = `
# Requirements Analysis

## User Stories
- US-1: As a developer, I want quality gates, so that I can catch issues early.
- US-2: As a project manager, I want automated validation, so that I can ensure consistency.

## Acceptance Criteria
- WHEN the analysis output is generated THEN it must contain user stories
- WHEN the quality gate runs THEN it must report a score

## Functional Requirements
- FR-1: The system shall validate analysis output structure
- FR-2: The system shall compute a quality score from 0-100

## Risk Analysis
- HIGH: Regex-based checks may produce false positives for non-standard formats
- MEDIUM: False positives in validation

## Module Map
| Module | Description |
|--------|-------------|
| Core   | Quality validation engine |

## Technical Constraints
- Must not add external dependencies
- Must support bilingual content (EN/ZH)

## Non-Functional Requirements
- Response time < 200ms for validation
- Coverage >= 80%

## Boundary Definitions
- Scope: Only validates ANALYSE stage output
- Responsibility: Structural completeness only, not semantic accuracy

## Dependency Mapping
- Depends on: output/analysis.md file
- Coupling: Low — standalone module

## Requirements Traceability
- REQ-1 → FR-1, FR-2
`;

const MINIMAL_ANALYSE_CONTENT = `
# Quick Analysis
Some basic text about the project.
`;

const EMPTY_CONTENT = '';

describe('validateAnalysisQuality', () => {
  it('returns high score for well-structured analysis', () => {
    const result = validateAnalysisQuality(GOOD_ANALYSE_CONTENT);
    assert.ok(result.score >= 70);
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, Object.keys(CHECK_IDS).length);
    assert.ok(result.failedChecks.length < result.checks.length);
  });

  it('returns low score for minimal content', () => {
    const result = validateAnalysisQuality(MINIMAL_ANALYSE_CONTENT, { failThreshold: 50 });
    assert.ok(result.score < 50);
    assert.equal(result.passed, false);
    assert.ok(result.criticalFailed.length > 0);
  });

  it('returns 0 score for empty content', () => {
    const result = validateAnalysisQuality(EMPTY_CONTENT);
    assert.equal(result.score, 0);
    assert.equal(result.passed, false);
  });

  it('S1: detects English user stories', () => {
    const result = validateAnalysisQuality('## User Stories\nAs a user, I want feature X, so that I can do Y.');
    const s1 = result.checks.find(c => c.id === 'S1');
    assert.equal(s1.passed, true);
  });

  it('S1: detects Chinese user stories', () => {
    const result = validateAnalysisQuality('## 用户故事\n作为开发者，我希望质量门禁，以便尽早发现问题。');
    const s1 = result.checks.find(c => c.id === 'S1');
    assert.equal(s1.passed, true);
  });

  it('S2: detects WHEN/THEN acceptance criteria', () => {
    const result = validateAnalysisQuality('## Acceptance Criteria\nWHEN input is valid THEN output is correct');
    const s2 = result.checks.find(c => c.id === 'S2');
    assert.equal(s2.passed, true);
  });

  it('S2: detects Chinese acceptance criteria', () => {
    const result = validateAnalysisQuality('## 验收标准\n如果输入有效，那么输出正确');
    const s2 = result.checks.find(c => c.id === 'S2');
    assert.equal(s2.passed, true);
  });

  it('S6: respects custom minLength option', () => {
    const shortContent = 'x'.repeat(100);
    const result1 = validateAnalysisQuality(shortContent, { minLength: 200 });
    const s6_r1 = result1.checks.find(c => c.id === 'S6');
    assert.equal(s6_r1.passed, false);

    const result2 = validateAnalysisQuality(shortContent, { minLength: 50 });
    const s6_r2 = result2.checks.find(c => c.id === 'S6');
    assert.equal(s6_r2.passed, true);
  });

  it('S7: detects EARS pattern', () => {
    const result = validateAnalysisQuality('WHEN the user clicks SHALL the system respond');
    const s7 = result.checks.find(c => c.id === 'S7');
    assert.equal(s7.passed, true);
  });

  it('S8: detects quantified NFR', () => {
    const result = validateAnalysisQuality('Response time < 200ms');
    const s8 = result.checks.find(c => c.id === 'S8');
    assert.equal(s8.passed, true);
  });

  it('summary contains score and status', () => {
    const result = validateAnalysisQuality(GOOD_ANALYSE_CONTENT);
    assert.ok(result.summary.includes('100'));
  });

  it('summary for failed result contains critical gaps', () => {
    const result = validateAnalysisQuality(EMPTY_CONTENT, { failThreshold: 50 });
    assert.ok(result.summary.includes('Critical gaps'));
  });

  it('custom failThreshold changes pass/fail boundary', () => {
    const result = validateAnalysisQuality(MINIMAL_ANALYSE_CONTENT, { failThreshold: 10 });
    assert.equal(result.failThreshold, 10);
  });
});

describe('extractUserStories', () => {
  it('extracts English user stories', () => {
    const content = 'As a developer, I want quality gates, so that I can catch issues early.';
    const stories = extractUserStories(content);
    assert.ok(stories.length >= 1);
    assert.equal(stories[0].actor, 'developer');
    assert.equal(stories[0].lang, 'en');
  });

  it('extracts Chinese user stories', () => {
    const content = '作为开发者，我希望质量门禁，以便尽早发现问题。';
    const stories = extractUserStories(content);
    assert.ok(stories.length >= 1);
    assert.ok(stories[0].actor.includes('开发者'));
    assert.equal(stories[0].lang, 'zh');
  });

  it('returns empty array for no matches', () => {
    const stories = extractUserStories('No user stories here.');
    assert.deepEqual(stories, []);
  });
});

describe('extractAcceptanceCriteria', () => {
  it('extracts WHEN/THEN criteria', () => {
    const content = 'WHEN input is valid THEN output is correct';
    const criteria = extractAcceptanceCriteria(content);
    assert.ok(criteria.length >= 1);
    assert.equal(criteria[0].lang, 'en');
  });

  it('extracts Chinese criteria', () => {
    const content = '如果输入有效，那么输出正确';
    const criteria = extractAcceptanceCriteria(content);
    assert.ok(criteria.length >= 1);
    assert.equal(criteria[0].lang, 'zh');
  });

  it('returns empty array for no matches', () => {
    const criteria = extractAcceptanceCriteria('No criteria here.');
    assert.deepEqual(criteria, []);
  });
});

describe('extractRiskSummary', () => {
  it('extracts risks from risk section', () => {
    const content = '## Risk Analysis\n- HIGH: Performance degradation under load\n- MEDIUM: False positives in validation';
    const risks = extractRiskSummary(content);
    assert.ok(risks.length >= 1);
    assert.equal(risks[0].severity, 'high');
  });

  it('returns empty array when no risk section', () => {
    const content = '## Requirements\nSome requirements text.';
    const risks = extractRiskSummary(content);
    assert.deepEqual(risks, []);
  });
});
