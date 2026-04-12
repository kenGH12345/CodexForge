/**
 * ADR-51 Test: Weighted Scoring Trigger for SocraticChallenger
 * Validates that the new weighted scoring system replaces the old binary count >= 2 threshold.
 */
'use strict';

const { SocraticChallenger } = require('../core/socratic-challenger');

const c = new SocraticChallenger({ verbose: false });
let pass = 0;
let fail = 0;

function test(name, args, expectChallenge) {
  const r = c._decideChallengeTrigger(args);
  const ok = r.shouldChallenge === expectChallenge;
  const status = ok ? '✅' : '❌';
  console.log(`${status} ${name}: shouldChallenge=${r.shouldChallenge} score=${r.triggerScore}/${r.triggerThreshold} reasons=${JSON.stringify(r.reasons)}`);
  if (ok) pass++;
  else { fail++; console.log(`   EXPECTED: shouldChallenge=${expectChallenge}`); }
}

const baseArgs = {
  stageName: 'PLAN',
  claims: [],
  blindSpots: [],
  confidence: 0.75,
  confidenceStatus: 'ok',
  evidenceBreakdown: { coveredClaims: 3, claimCount: 3 },
  dimensionScores: { LOGIC: 0.8, FIRST_PRINCIPLES: 0.7, EVIDENCE: 0.7 },
  taskFingerprint: {},
  context: {},
};

console.log('\n=== ADR-51: Weighted Scoring Trigger Tests ===\n');

// T1: No reasons -> no trigger
test('T1: 0 reasons (no trigger)', { ...baseArgs }, false);

// T2: 1 high reason (low_confidence=0.35) on low-risk stage (PLAN, bonus=0.06) -> 0.35+0.06=0.41 -> trigger
test('T2: low_confidence on PLAN (borderline trigger)', {
  ...baseArgs,
  confidence: 0.50,
}, true);

// T3: 1 high + 1 low on ARCHITECT -> definitely trigger
test('T3: low_confidence + low_logic on ARCHITECT', {
  ...baseArgs,
  stageName: 'ARCHITECT',
  confidence: 0.50,
  dimensionScores: { LOGIC: 0.5, FIRST_PRINCIPLES: 0.7, EVIDENCE: 0.7 },
}, true);

// T4: claim_gap alone on ARCHITECT (0.40 + 0.08 = 0.48) -> trigger
test('T4: claim_gap alone on ARCHITECT', {
  ...baseArgs,
  stageName: 'ARCHITECT',
  evidenceBreakdown: { coveredClaims: 1, claimCount: 3 },
}, true);

// T5: 3 low reasons (0.15+0.15+0.12=0.42 + PLAN bonus 0.06 = 0.48) -> trigger
test('T5: 3 low reasons accumulate to trigger', {
  ...baseArgs,
  dimensionScores: { LOGIC: 0.5, FIRST_PRINCIPLES: 0.5, EVIDENCE: 0.5 },
}, true);

// T6: 1 low reason alone (0.15 + 0.06 = 0.21) -> no trigger
test('T6: 1 low reason alone (no trigger)', {
  ...baseArgs,
  dimensionScores: { LOGIC: 0.5, FIRST_PRINCIPLES: 0.7, EVIDENCE: 0.7 },
}, false);

// T7: explicit_skip overrides everything
test('T7: explicit_skip overrides', {
  ...baseArgs,
  confidence: 0.10,
  context: { skipChallenge: true },
}, false);

// T8: explicit_force overrides everything
test('T8: explicit_force overrides', {
  ...baseArgs,
  context: { forceChallenge: true },
}, true);

// T9: Return value has triggerScore and triggerThreshold
const r9 = c._decideChallengeTrigger(baseArgs);
const hasScore = typeof r9.triggerScore === 'number' && typeof r9.triggerThreshold === 'number';
console.log(`${hasScore ? '✅' : '❌'} T9: Return includes triggerScore=${r9.triggerScore} and triggerThreshold=${r9.triggerThreshold}`);
if (hasScore) pass++; else fail++;

// T10: Return value has scoredReasons array
const hasScoredReasons = Array.isArray(r9.scoredReasons);
console.log(`${hasScoredReasons ? '✅' : '❌'} T10: Return includes scoredReasons array (length=${(r9.scoredReasons || []).length})`);
if (hasScoredReasons) pass++; else fail++;

// T11: Test advisory questions flow via challenge()
console.log('\n=== Advisory Questions Flow Tests ===\n');

async function testAdvisoryFlow() {
  const challenger = new SocraticChallenger({ verbose: false, maxQuestions: 3 });
  
  // Use a simple content that will generate some questions but not trigger challenge
  const content = `# Analysis\n## Root Cause\nThe issue is caused by a missing validation check.\n## Affected Files\n- src/main.js\n## Change Scope\nModify the validation logic.\n## Risk Assessment\nLow risk change.`;
  
  const result = await challenger.challenge('ANALYSE', content, {
    rawRequirement: 'Fix validation bug',
    requirement: 'Fix validation bug',
    stage: 'ANALYSE',
    llmSource: 'mock',
    isMockLlm: true,
  });
  
  // T11: advisoryQuestions should exist in result
  const hasAdvisory = Array.isArray(result.advisoryQuestions);
  console.log(`${hasAdvisory ? '✅' : '❌'} T11: Result has advisoryQuestions array`);
  if (hasAdvisory) pass++; else fail++;
  
  // T12: When not challenged, advisoryQuestions should have the generated questions
  if (!result.challenged) {
    const advisoryHasContent = result.advisoryQuestions.length > 0;
    console.log(`${advisoryHasContent ? '✅' : '❌'} T12: Not challenged -> advisoryQuestions has ${result.advisoryQuestions.length} question(s) (previously would be 0)`);
    if (advisoryHasContent) pass++; else fail++;
  } else {
    // If challenged, questions should be in questions array
    const questionsHasContent = result.questions.length > 0;
    console.log(`${questionsHasContent ? '✅' : '❌'} T12: Challenged -> questions has ${result.questions.length} question(s)`);
    if (questionsHasContent) pass++; else fail++;
  }
  
  // T13: triggerScore and triggerThreshold in result
  const hasScoreInResult = result.triggerScore !== undefined && result.triggerThreshold !== undefined;
  console.log(`${hasScoreInResult ? '✅' : '❌'} T13: Result has triggerScore=${result.triggerScore} triggerThreshold=${result.triggerThreshold}`);
  if (hasScoreInResult) pass++; else fail++;
  
  // T14: advisoryBlindSpots should exist
  const hasAdvisoryBS = Array.isArray(result.advisoryBlindSpots);
  console.log(`${hasAdvisoryBS ? '✅' : '❌'} T14: Result has advisoryBlindSpots array`);
  if (hasAdvisoryBS) pass++; else fail++;
  
  // T15: revisionSummary should have advisoryQuestionCount
  const hasAdvisoryCount = result.revisionSummary?.advisoryQuestionCount !== undefined;
  console.log(`${hasAdvisoryCount ? '✅' : '❌'} T15: revisionSummary has advisoryQuestionCount=${result.revisionSummary?.advisoryQuestionCount}`);
  if (hasAdvisoryCount) pass++; else fail++;
  
  console.log(`\n=== Summary: ${pass}/${pass + fail} passed ===`);
  if (fail > 0) process.exit(1);
}

testAdvisoryFlow().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
