'use strict';

const { getAdaptiveMultiplier } = require('../../workflow/core/token-budget');

const tests = [
  { name: 'AC3 simple DEVELOPER', stage: 'DEVELOPER', score: 10, opts: { enabled: true }, expect: { adaptiveFactor: 0.7, segment: 'simple' } },
  { name: 'AC4 very_complex DEVELOPER', stage: 'DEVELOPER', score: 80, opts: { enabled: true }, expect: { adaptiveFactor: 1.20, segment: 'very_complex' } },
  { name: 'AC5 ANALYSE tightening', stage: 'ANALYSE', score: 80, opts: { enabled: true }, expect: { adaptiveFactor: 1.0, segment: 'very_complex' } },
  { name: 'AC6 ENTROPY skipped', stage: 'ENTROPY', score: 80, opts: { enabled: true }, expect: { adaptiveFactor: 1.0, segment: 'skipped' } },
  { name: 'AC7 disabled default', stage: 'DEVELOPER', score: null, opts: {}, expect: { adaptiveFactor: 1.0, segment: 'disabled' } },
  { name: 'AC8 negative clamp', stage: 'DEVELOPER', score: -5, opts: { enabled: true }, expect: { adaptiveFactor: 0.7, segment: 'simple' } },
  { name: 'AC1 medium DEVELOPER', stage: 'DEVELOPER', score: 40, opts: { enabled: true }, expect: { adaptiveFactor: 1.0, segment: 'medium' } },
  { name: 'AC2 complex DEVELOPER', stage: 'DEVELOPER', score: 60, opts: { enabled: true }, expect: { adaptiveFactor: 1.10, segment: 'complex' } },
  { name: 'AC edge boundary 25', stage: 'DEVELOPER', score: 25, opts: { enabled: true }, expect: { adaptiveFactor: 0.7, segment: 'simple' } },
  { name: 'AC edge boundary 50', stage: 'DEVELOPER', score: 50, opts: { enabled: true }, expect: { adaptiveFactor: 1.0, segment: 'medium' } },
  { name: 'AC over-100 clamp', stage: 'DEVELOPER', score: 150, opts: { enabled: true }, expect: { adaptiveFactor: 1.20, segment: 'very_complex' } },
  { name: 'AC non-finite', stage: 'DEVELOPER', score: NaN, opts: { enabled: true }, expect: { adaptiveFactor: 1.0, segment: 'disabled' } },
  { name: 'AC PLAN tightening very_complex', stage: 'PLAN', score: 90, opts: { enabled: true }, expect: { adaptiveFactor: 1.0, segment: 'very_complex' } },
  { name: 'AC CI skipped', stage: 'CI', score: 10, opts: { enabled: true }, expect: { adaptiveFactor: 1.0, segment: 'skipped' } },
];

let pass = 0;
let fail = 0;
for (const t of tests) {
  const r = getAdaptiveMultiplier(t.stage, t.score, t.opts);
  let ok = true;
  const mismatch = [];
  for (const k of Object.keys(t.expect)) {
    const exp = t.expect[k];
    const got = r[k];
    if (typeof exp === 'number' && typeof got === 'number') {
      if (Math.abs(got - exp) > 0.001) { ok = false; mismatch.push(k + ': expected ' + exp + ', got ' + got); }
    } else if (got !== exp) {
      ok = false;
      mismatch.push(k + ': expected ' + exp + ', got ' + got);
    }
  }
  if (ok) {
    console.log('PASS', t.name, '=>', JSON.stringify(r));
    pass++;
  } else {
    console.log('FAIL', t.name, 'mismatch:', mismatch.join('; '), 'full result:', JSON.stringify(r));
    fail++;
  }
}
console.log('Result: ' + pass + '/' + (pass + fail));
if (fail > 0) process.exit(1);
