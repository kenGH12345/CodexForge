/**
 * T-4 Experience Layer-Aware Freshness — unit tests
 *
 * Verifies calculateFreshnessScore pure function:
 *   AC-1: PLATFORM=180d, DOMAIN=60d, PRACTICE=14d half-lives
 *   AC-2: hit-recency boost decays over 30d
 *   AC-3: hitCount boost is log-dampened (cannot dominate)
 *   AC-5: malformed input → 1.0 (NaN guard)
 */

'use strict';

const assert = require('assert');
const {
  calculateFreshnessScore,
  DEFAULT_HALF_LIFE_MAP,
} = require('../core/experience-query');

const DAY = 86400_000;
const NOW = 1700000000000;

function approx(actual, expected, tolerance, label) {
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff < tolerance,
    `${label}: expected ~${expected} (±${tolerance}), got ${actual} (diff=${diff.toFixed(4)})`
  );
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('AC-1a: PLATFORM category at 180d → freshness ≈ 0.5', () => {
  const exp = {
    category: 'framework_limit',
    updatedAt: new Date(NOW - 180 * DAY).toISOString(),
  };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  approx(f, 0.5, 0.05, 'PLATFORM/180d');
});

test('AC-1b: DOMAIN category at 60d → freshness ≈ 0.5', () => {
  const exp = {
    category: 'architecture',
    updatedAt: new Date(NOW - 60 * DAY).toISOString(),
  };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  approx(f, 0.5, 0.05, 'DOMAIN/60d');
});

test('AC-1c: PRACTICE category at 14d → freshness ≈ 0.5', () => {
  const exp = {
    category: 'pitfall',
    updatedAt: new Date(NOW - 14 * DAY).toISOString(),
  };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  approx(f, 0.5, 0.05, 'PRACTICE/14d');
});

test('AC-1d: unknown category falls back to PRACTICE (14d default)', () => {
  // getLayerForCategory returns PRACTICE for unknown categories.
  const exp = {
    category: '__nonexistent_xyz__',
    updatedAt: new Date(NOW - 14 * DAY).toISOString(),
  };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  approx(f, 0.5, 0.05, 'unknown-category/14d (PRACTICE fallback)');
});

test('AC-2a: hit-recency 7d → recencyBoost ≥ 1.2', () => {
  const exp = {
    category: 'pitfall',
    updatedAt: new Date(NOW).toISOString(),
    lastHitAt: new Date(NOW - 7 * DAY).toISOString(),
    hitCount: 0,
  };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  // decay=1 (0 age), countBoost=1 (hitCount=0), so f = recencyBoost.
  // recencyBoost = 1 + 1.4 * 0.5^(7/30) ≈ 1 + 1.4 * 0.851 ≈ 2.19
  assert.ok(f >= 1.2, `expected recencyBoost ≥ 1.2, got ${f}`);
});

test('AC-2b: hit-recency 30d → recencyBoost ≈ 1 + 1.4*0.5 = 1.7', () => {
  const exp = {
    category: 'pitfall',
    updatedAt: new Date(NOW).toISOString(),
    lastHitAt: new Date(NOW - 30 * DAY).toISOString(),
    hitCount: 0,
  };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  approx(f, 1.7, 0.05, 'hit-recency 30d');
});

test('AC-2c: no lastHitAt → recencyBoost = 1 (neutral)', () => {
  const exp = {
    category: 'pitfall',
    updatedAt: new Date(NOW).toISOString(),
  };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  approx(f, 1.0, 0.01, 'no lastHitAt (decay=1, countBoost=1)');
});

test('AC-3: hitCount=100 is log-dampened, total freshness < 2.5', () => {
  const exp = {
    category: 'pitfall',
    updatedAt: new Date(NOW).toISOString(),
    hitCount: 100,
  };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  // decay=1, recencyBoost=1, countBoost = 1 + log2(101)*0.15 ≈ 1 + 6.66*0.15 ≈ 2.0
  assert.ok(f < 2.5, `expected countBoost dampened < 2.5, got ${f}`);
  assert.ok(f > 1.5, `expected countBoost measurable > 1.5, got ${f}`);
});

test('AC-5a: malformed exp (null) → 1.0 neutral', () => {
  assert.strictEqual(calculateFreshnessScore(null), 1.0);
  assert.strictEqual(calculateFreshnessScore(undefined), 1.0);
});

test('AC-5b: missing updatedAt AND createdAt → 1.0 neutral', () => {
  const exp = { category: 'pitfall' };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  assert.strictEqual(f, 1.0);
});

test('AC-5c: invalid timestamp string → 1.0 neutral (NaN guard)', () => {
  const exp = { category: 'pitfall', updatedAt: 'not-a-date' };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  assert.strictEqual(f, 1.0);
});

test('AC-5d: createdAt fallback when updatedAt absent', () => {
  const exp = {
    category: 'pitfall',
    createdAt: new Date(NOW - 14 * DAY).toISOString(),
  };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  approx(f, 0.5, 0.05, 'createdAt fallback/14d');
});

test('DEFAULT_HALF_LIFE_MAP exports correct values', () => {
  assert.strictEqual(DEFAULT_HALF_LIFE_MAP.platform, 180);
  assert.strictEqual(DEFAULT_HALF_LIFE_MAP.domain, 60);
  assert.strictEqual(DEFAULT_HALF_LIFE_MAP.practice, 14);
});

// ─── T-5: Layer-Aware Half-Life Config Wiring ────────────────────────────────

test('T-5.1: EXPERIENCE.HALF_LIFE_MAP returns picked {platform,domain,practice} from config', () => {
  const { EXPERIENCE } = require('../core/constants');
  const m = EXPERIENCE.HALF_LIFE_MAP;
  // Current workflow.config.js ships all three keys; verify they flow through.
  assert.ok(m, 'expected HALF_LIFE_MAP to be populated from workflow.config.js');
  assert.strictEqual(m.platform, 180);
  assert.strictEqual(m.domain, 60);
  assert.strictEqual(m.practice, 14);
  assert.ok(Object.isFrozen(m), 'HALF_LIFE_MAP should be frozen to prevent tampering');
});

test('T-5.2: opts.halfLifeMap takes priority over config and defaults', () => {
  // Age = 5 days, custom halfLife=5 → decay=0.5. No lastHitAt, hitCount=0 → boosts=1.0.
  const exp = {
    category: 'pitfall',
    createdAt: new Date(NOW - 5 * DAY).toISOString(),
  };
  const f = calculateFreshnessScore(exp, {
    nowMs: NOW,
    halfLifeMap: { practice: 5 },
  });
  approx(f, 0.5, 0.05, 'opts.halfLifeMap override/5d');
});

test('T-5.3: config values round-trip through calculateFreshnessScore (PLATFORM=180d)', () => {
  // PLATFORM layer at half-life (180d) → decay≈0.5. Category 'engine_api' maps to PLATFORM.
  const exp = {
    category: 'engine_api',
    createdAt: new Date(NOW - 180 * DAY).toISOString(),
  };
  const f = calculateFreshnessScore(exp, { nowMs: NOW });
  approx(f, 0.5, 0.05, 'PLATFORM 180d half-life from config');
});

(async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ❌ ${name}`);
      console.log(`     ${err.message}`);
      failed++;
      failures.push({ name, error: err.message });
    }
  }
  const total = passed + failed;
  console.log(`\n[experience-freshness] ${passed}/${total} tests passed`);
  if (failed > 0) {
    console.log(`\nFailures:`);
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
