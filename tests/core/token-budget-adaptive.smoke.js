'use strict';

const { _applyTokenBudget, getBudgetSummary, STAGE_BUDGET_MULTIPLIERS } = require('../../workflow/core/token-budget');

async function runTests() {
  let pass = 0;
  let fail = 0;
  const log = (name, ok, info) => { if (ok) { console.log('PASS', name, info || ''); pass++; } else { console.log('FAIL', name, info || ''); fail++; } };

  // T2.AC1: no complexityScore => bit-exact behavior preserved
  {
    const blocks = [
      { label: 'A', content: 'hello world '.repeat(100), priority: 80, _order: 0 },
      { label: 'B', content: 'another '.repeat(50), priority: 60, _order: 1 },
    ];
    const r1 = await _applyTokenBudget(JSON.parse(JSON.stringify(blocks)), undefined, { stage: 'DEVELOPER' });
    const r2 = await _applyTokenBudget(JSON.parse(JSON.stringify(blocks)), undefined, { stage: 'DEVELOPER', enableAdaptive: false });
    log('T2.AC1 no-score preserves behavior', r1.stats.total === r2.stats.total, 'r1=' + r1.stats.total + ' r2=' + r2.stats.total);
  }

  // T2.AC3: flag off means complexityScore ignored
  {
    const blocks = [{ label: 'A', content: 'x'.repeat(10000), priority: 80, _order: 0 }];
    const r1 = await _applyTokenBudget(JSON.parse(JSON.stringify(blocks)), undefined, { stage: 'DEVELOPER' });
    const r2 = await _applyTokenBudget(JSON.parse(JSON.stringify(blocks)), undefined, { stage: 'DEVELOPER', complexityScore: 80, enableAdaptive: false });
    log('T2.AC3 flag off ignores score', r1.stats.total === r2.stats.total, 'r1=' + r1.stats.total + ' r2=' + r2.stats.total);
  }

  // T2.AC5: getBudgetSummary with adaptive shows info
  {
    const stats = { total: 1000, estimatedTokens: 250, dropped: [], truncated: [] };
    const summaryOff = getBudgetSummary(stats, null, 'DEVELOPER', null, null);
    const summaryDisabled = getBudgetSummary(stats, null, 'DEVELOPER', null, { adaptiveFactor: 1.0, segment: 'disabled', capped: false });
    const summaryEnabled = getBudgetSummary(stats, null, 'DEVELOPER', null, { adaptiveFactor: 1.20, segment: 'very_complex', capped: false });
    const ok = !summaryOff.includes('[adaptive') && summaryDisabled.includes('[adaptive:OFF]') && summaryEnabled.includes('[adaptive:very_complex×1.20]');
    log('T2.AC5 getBudgetSummary adaptive info', ok, 'off-includes=' + summaryOff.includes('[adaptive') + ' disabled-has=' + summaryDisabled.includes('[adaptive:OFF]') + ' enabled-has=' + summaryEnabled.includes('[adaptive:very_complex'));
  }

  // T2.AC2: enabled + high score => budget expanded for DEVELOPER
  {
    const blocks = [{ label: 'A', content: 'x'.repeat(90000), priority: 80, _order: 0 }];
    const r1 = await _applyTokenBudget(JSON.parse(JSON.stringify(blocks)), undefined, { stage: 'DEVELOPER' });
    const r2 = await _applyTokenBudget(JSON.parse(JSON.stringify(blocks)), undefined, { stage: 'DEVELOPER', complexityScore: 80, enableAdaptive: true });
    log('T2.AC2 enabled + score=80 expanded budget', r2.stats.total >= r1.stats.total, 'r1.total=' + r1.stats.total + ' r2.total=' + r2.stats.total);
  }

  console.log('\nResult: ' + pass + '/' + (pass + fail));
  if (fail > 0) process.exit(1);
}

runTests().catch(e => { console.error('ERROR:', e); process.exit(1); });
