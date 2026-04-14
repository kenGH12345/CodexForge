const { SocraticChallenger } = require('../core/socratic-challenger.js');

async function main() {
  const c = new SocraticChallenger({ maxQuestions: 5, verbose: false });
  const artifact = `
## Analysis
This artifact discusses architecture design and implementation details.
The system uses a layered approach with clear separation of concerns.
Root cause analysis shows the issue stems from missing validation.
Evidence: test results show 3 failures in edge cases.
The requirement is to fix prefix pollution in socratic questions.
  `;
  const result = await c.challenge('ANALYSE', artifact, { requirement: 'fix prefix pollution in socratic questions' });
  const questions = result.questions || [];

  const badPatterns = [/^\[.+\]\[.+\]/, /^\[What\]/, /^\[Why\]/, /^\[How\]/, /^\[cross_stage\]/, /^\[task:/, /^\[ANALYSE\]/, /^\[CODE\]/, /^\[PLAN\]/];
  let hasBadPrefix = false;

  console.log(`\n=== Questions (${questions.length}) ===`);
  for (const q of questions) {
    const text = typeof q === 'string' ? q : q.question;
    const bad = badPatterns.some(p => p.test(text));
    if (bad) hasBadPrefix = true;
    console.log(`${bad ? '❌ BAD' : '✅ OK '} | ${text.substring(0, 120)}`);
  }

  console.log(`\n=== Result: ${hasBadPrefix ? '❌ FAIL — prefix found' : '✅ PASS — no prefix'} ===`);
  process.exit(hasBadPrefix ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
