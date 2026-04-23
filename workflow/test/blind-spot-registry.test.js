'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const BlindSpotRegistry = require('../core/blind-spot-registry');

const TMP = path.join(os.tmpdir(), `bs-registry-test-${Date.now()}`);

describe('BlindSpotRegistry', () => {
  let registry;

  beforeEach(() => {
    fs.mkdirSync(TMP, { recursive: true });
    registry = new BlindSpotRegistry(TMP);
  });

  afterEach(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  it('register — creates entry with auto-generated id', () => {
    const entry = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'missing boundary check', dimension: 'BOUNDARY', detectedAt: '2026-01-01T00:00:00Z' });
    assert.ok(entry);
    assert.match(entry.id, /^BS-ANALYSE-001$/);
    assert.equal(entry.stage, 'ANALYSE');
    assert.equal(entry.evidence, 'missing boundary check');
    assert.equal(entry.dimension, 'BOUNDARY');
    assert.equal(entry.severity, 'HIGH');
    assert.equal(entry.status, 'OPEN');
  });

  it('register — deduplicates by evidence + sessionId', () => {
    const e1 = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'dup evidence' });
    const e2 = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'dup evidence' });
    assert.equal(e1.id, e2.id);
    assert.equal(registry._entries.length, 1);
  });

  it('register — skips entries without evidence', () => {
    const result = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: '' });
    assert.equal(result, null);
  });

  it('register — infers dimension from evidence text', () => {
    const entry = registry.register({ sessionId: 's1', stage: 'PLAN', evidence: '边界条件缺失' });
    assert.equal(entry.dimension, 'BOUNDARY');
  });

  it('register — assigns severity from DIMENSION_SEVERITY_MAP', () => {
    const entry = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'test', dimension: 'EVIDENCE' });
    assert.equal(entry.severity, 'HIGH');
  });

  it('register — assigns verificationTargets from STAGE_VERIFICATION_MAP', () => {
    const entry = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'test' });
    assert.deepEqual(entry.verificationTargets, ['ARCHITECT', 'PLAN']);
  });

  it('register — increments sequence per stage', () => {
    registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'a1' });
    registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'a2' });
    const e3 = registry.register({ sessionId: 's1', stage: 'PLAN', evidence: 'p1' });
    assert.equal(registry._entries[0].id, 'BS-ANALYSE-001');
    assert.equal(registry._entries[1].id, 'BS-ANALYSE-002');
    assert.equal(e3.id, 'BS-PLAN-001');
  });

  it('getPendingForStage — returns OPEN entries targeting the given stage', () => {
    registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'a1' });
    registry.register({ sessionId: 's1', stage: 'PLAN', evidence: 'p1' });
    const pending = registry.getPendingForStage('ARCHITECT');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 'BS-ANALYSE-001');
  });

  it('getPendingForStage — excludes RESOLVED and DEFERRED entries', () => {
    const e = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'a1' });
    registry.resolve(e.id, { note: 'fixed' });
    const pending = registry.getPendingForStage('ARCHITECT');
    assert.equal(pending.length, 0);
  });

  it('resolve — marks entry as RESOLVED', () => {
    const e = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'a1' });
    const ok = registry.resolve(e.id, { note: 'addressed in ARCHITECT' });
    assert.equal(ok, true);
    assert.equal(registry._entries[0].status, 'RESOLVED');
    assert.equal(registry._entries[0].resolution.note, 'addressed in ARCHITECT');
  });

  it('resolve — returns false for unknown id', () => {
    assert.equal(registry.resolve('BS-UNKNOWN-999', {}), false);
  });

  it('defer — marks entry as DEFERRED', () => {
    const e = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'a1' });
    registry.defer(e.id, 'low priority');
    assert.equal(registry._entries[0].status, 'DEFERRED');
    assert.equal(registry._entries[0].resolution.reason, 'low priority');
  });

  it('autoResolveCheck — resolves MEDIUM/LOW entries with keyword match >50%', () => {
    const e = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: '缺少边界条件检查 for login flow', dimension: 'CLARITY' });
    const count = registry.autoResolveCheck('ARCHITECT', 'We added boundary condition checks for the login flow and edge cases');
    assert.equal(count, 1);
    assert.equal(registry._entries[0].status, 'RESOLVED');
  });

  it('autoResolveCheck — does NOT auto-resolve HIGH severity', () => {
    registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'missing boundary check', dimension: 'BOUNDARY' });
    const count = registry.autoResolveCheck('ARCHITECT', 'We added boundary checks');
    assert.equal(count, 0);
    assert.equal(registry._entries[0].status, 'OPEN');
  });

  it('exportReport — returns summary with correct counts', () => {
    const e1 = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'a1' });
    registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'a2' });
    registry.resolve(e1.id, {});
    const report = registry.exportReport();
    assert.equal(report.totalBlindSpots, 2);
    assert.equal(report.resolved, 1);
    assert.equal(report.open, 1);
    assert.equal(report.resolvedPercent, 50);
  });

  it('cleanup — removes old RESOLVED entries', () => {
    const e = registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'a1', detectedAt: new Date(Date.now() - 10 * 86400000).toISOString() });
    registry.resolve(e.id, {});
    const removed = registry.cleanup(7);
    assert.equal(removed, 1);
    assert.equal(registry._entries.length, 0);
  });

  it('cleanup — keeps OPEN entries regardless of age', () => {
    registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'a1', detectedAt: new Date(Date.now() - 10 * 86400000).toISOString() });
    const removed = registry.cleanup(7);
    assert.equal(removed, 0);
    assert.equal(registry._entries.length, 1);
  });

  it('persistence — survives re-instantiation', () => {
    registry.register({ sessionId: 's1', stage: 'ANALYSE', evidence: 'persist test' });
    const registry2 = new BlindSpotRegistry(TMP);
    assert.equal(registry2._entries.length, 1);
    assert.equal(registry2._entries[0].evidence, 'persist test');
  });

  it('persistence — handles corrupt file gracefully', () => {
    const outputDir = path.join(TMP, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'blind-spot-registry.json'), 'not valid json{{{', 'utf8');
    const registry2 = new BlindSpotRegistry(TMP);
    assert.equal(registry2._entries.length, 0);
  });
});

describe('BlindSpotRegistry statics', () => {
  it('BS_STATUS has OPEN/RESOLVED/DEFERRED', () => {
    assert.equal(BlindSpotRegistry.BS_STATUS.OPEN, 'OPEN');
    assert.equal(BlindSpotRegistry.BS_STATUS.RESOLVED, 'RESOLVED');
    assert.equal(BlindSpotRegistry.BS_STATUS.DEFERRED, 'DEFERRED');
  });

  it('DIMENSION_SEVERITY_MAP maps known dimensions', () => {
    assert.equal(BlindSpotRegistry.DIMENSION_SEVERITY_MAP.BOUNDARY, 'HIGH');
    assert.equal(BlindSpotRegistry.DIMENSION_SEVERITY_MAP.CLARITY, 'MEDIUM');
    assert.equal(BlindSpotRegistry.DIMENSION_SEVERITY_MAP.RELEVANCE, 'LOW');
  });

  it('STAGE_VERIFICATION_MAP defines downstream targets', () => {
    assert.deepEqual(BlindSpotRegistry.STAGE_VERIFICATION_MAP.ANALYSE, ['ARCHITECT', 'PLAN']);
    assert.deepEqual(BlindSpotRegistry.STAGE_VERIFICATION_MAP.DEPLOY, []);
  });
});
