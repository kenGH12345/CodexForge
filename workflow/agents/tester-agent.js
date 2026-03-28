/**
 * TesterAgent – Quality Testing Agent
 *
 * Domain Expert: Gerald Weinberg (author of "The Psychology of Computer Programming", pioneer of software testing as a human activity)
 * Philosophy: "Testing is not just about finding bugs—it's about understanding systems, managing risk, and improving the human processes that create software."
 *
 * Role: Independent auditor.
 * Input:  output/code.diff  (file path passed by orchestrator)
 * Output: output/test-report.md
 *
 * Constraints:
 *  - MUST operate as a black-box tester (no knowledge of internal implementation)
 *  - MUST NOT modify any source files, requirement.md, or architecture.md
 *  - MUST produce an objective, evidence-based test report
 *  - Context is intentionally isolated from the developer agent's context
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');
const { PATHS } = require('../core/constants');
const { buildJsonBlockInstruction, extractJsonBlock, validateJsonBlock } = require('../core/agent-output-schema');

class TesterAgent extends BaseAgent {
  constructor(llmCall, hookEmitter, opts = {}) {
    super(AgentRole.TESTER, llmCall, hookEmitter, opts);
    // P2 fix: Load coverage threshold from config
    this._coverageThreshold = opts.coverageThreshold ?? 80;
  }

  /**
   * Builds the tester prompt.
   * Input content is the code diff to be reviewed.
   * Black-box approach: tester evaluates observable behaviour, not internals.
   *
   * @param {string} inputContent - Content of code.diff
   * @param {string|null} expContext - Experience context block from ExperienceStore (optional)
   * @returns {string}
   */
  buildPrompt(inputContent, expContext = null) {
    const expSection = expContext
      ? `\n## Accumulated Experience (Reference Before Testing)\n${expContext}\n`
      : '';
    // P0-NEW-1: inject structured JSON output instruction
    const jsonInstruction = buildJsonBlockInstruction('tester');

    // Inject requirements.md and architecture.md so the tester can verify
    // acceptance criteria coverage and architecture compliance – without these,
    // the "Coverage Analysis" section would be based on guesswork.
    const requirementsPath = path.join(this._outputDir, 'requirements.md');
    const architecturePath = path.join(this._outputDir, 'architecture.md');

    const requirementsContent = fs.existsSync(requirementsPath)
      ? fs.readFileSync(requirementsPath, 'utf-8')
      : null;
    const architectureContent = fs.existsSync(architecturePath)
      ? fs.readFileSync(architecturePath, 'utf-8')
      : null;

    const requirementsSection = requirementsContent
      ? `\n## Requirements Document (for Coverage Verification)\n${requirementsContent}\n`
      : '';
    const architectureSection = architectureContent
      ? `\n## Architecture Document (for Compliance Verification)\n${architectureContent}\n`
      : '';

    // Inject pre-generated test cases if available
    // Cap at 12000 chars to avoid token overflow (large test suites can be very long)
    const TEST_CASES_TOKEN_CAP = 12000;
    
    // P1-ENHANCEMENT: Try detailed test cases first, fallback to basic
    const detailedTestCasesPath = path.join(this._outputDir, 'test-cases-detailed.md');
    const basicTestCasesPath = path.join(this._outputDir, 'test-cases.md');
    
    let testCasesPath = null;
    let testCasesRaw = null;
    let isDetailedDoc = false;
    
    if (fs.existsSync(detailedTestCasesPath)) {
      testCasesPath = detailedTestCasesPath;
      testCasesRaw = fs.readFileSync(detailedTestCasesPath, 'utf-8');
      isDetailedDoc = true;
    } else if (fs.existsSync(basicTestCasesPath)) {
      testCasesPath = basicTestCasesPath;
      testCasesRaw = fs.readFileSync(basicTestCasesPath, 'utf-8');
    }
    
    const testCasesContent = testCasesRaw && testCasesRaw.length > TEST_CASES_TOKEN_CAP
      ? testCasesRaw.slice(0, TEST_CASES_TOKEN_CAP) + `\n\n> ⚠️ [Truncated at ${TEST_CASES_TOKEN_CAP} chars to fit context window. Full file: output/${path.basename(testCasesPath)}]`
      : testCasesRaw;
    
    const testCasesSection = testCasesContent
      ? (isDetailedDoc
        ? `\n## Detailed Test Plan (Execute ALL test cases per this document)\n> This is a comprehensive test document generated from code.diff analysis.\n> It contains: Feature Scope, Detailed Test Cases, Boundary/Edge Analysis, Test Data Sets.\n> \n> **CRITICAL**: Execute EVERY test case listed in Section 2.\n> For each test case, verify against the exact \`test_data\` provided in Section 4.\n> Report results using the \`case_id\` format (TC_XXXX_XXX).\n>\n> Sections included:\n> - Section 1: Feature Scope Analysis\n> - Section 2: Detailed Test Cases (with steps, expected results, test data)\n> - Section 3: Boundary & Edge Case Analysis\n> - Section 4: Test Data Sets\n> - Section 5: Coverage Matrix\n> - Section 6: Execution Instructions\n> - Section 7: Machine-Readable JSON\n\n${testCasesContent}\n`
        : `\n## Pre-Planned Test Cases (Execute ALL of these)\n> These test cases were designed from the requirements BEFORE testing began.\n> The JSON array below contains automation-ready test cases with concrete test data.\n> You MUST execute every test case and report its result using the same \`case_id\`.\n\n${testCasesContent}\n`)
      : '';

    // Check if real execution results are already available in the experience context
    // (injected by orchestrator as "Real Test Execution Results" block)
    const hasRealExecutionResults = expContext && expContext.includes('Real Test Execution Results');

    const testCasesInstruction = testCasesContent
      ? hasRealExecutionResults
        ? `\n**IMPORTANT**: Real execution results are provided in the context above (marked with ⚡).\n` +
          `These are ACTUAL test run results – not simulated. You MUST:\n` +
          `1. Use the real PASS/FAIL/BLOCKED statuses as ground truth in your report.\n` +
          `2. Do NOT contradict or override the real execution results.\n` +
          `3. For BLOCKED cases (could not determine status), perform your own code-diff analysis.\n` +
          `4. Add any additional test cases you discover beyond the pre-planned ones (use IDs like TC_EXTRA_001).\n` +
          `5. The Coverage Analysis must reference the pre-planned \`case_id\` values.\n`
        : (isDetailedDoc
          ? `\n**DETAILED TEST PLAN PROVIDED**\nA comprehensive test document was generated from code.diff analysis. You MUST:\n` +
            `1. **Execute ALL test cases from Section 2** – Each test case includes step-by-step instructions and exact test data.\n` +
            `2. **Verify boundary conditions from Section 3** – Test min/max boundaries, empty values, null inputs as specified.\n` +
            `3. **Use exact test data from Section 4** – Do NOT invent test data; use the concrete JSON values provided.\n` +
            `4. **Reference code locations from \`code_reference\`** – Verify the actual implementation matches expectations.\n` +
            `5. **Report format** – ID must be \`case_id\` | Title: \`title\` | Expected: \`expected\` | Status: PASS/FAIL/BLOCKED\n` +
            `6. **Add exploratory tests** – Beyond Section 2, use your expertise to find additional edge cases (ID: TC_EXTRA_001, etc.)\n` +
            `7. **Coverage Analysis** – Map each feature from Section 1 to your test results\n\n` +
            `If a pre-planned case FAILS but the code looks correct, investigate: Is the expected result outdated?\n` +
            `If a pre-planned case PASSES but you suspect issues, perform deeper analysis (it's your job to investigate).\n`
          : `\n**IMPORT:ANT**: A pre-planned test suite (JSON format) is provided in the "Pre-Planned Test Cases" section. You MUST:\n1. Execute EVERY test case in the JSON array – use the \`case_id\` as the ID column in your report table.\n2. For each case: verify the \`steps\` against the code diff, check if \`expected\` result is satisfied.\n3. Report results in the "Test Cases Executed" table with columns: case_id | title | expected | actual | status (PASS/FAIL/BLOCKED).\n4. Add any additional test cases you discover beyond the pre-planned ones (use IDs like TC_EXTRA_001).\n5. The Coverage Analysis must reference the pre-planned \`case_id\` values.\n`)
      : '';

    return `You are **Gerald Weinberg** – author of *The Psychology of Computer Programming* (the first book to treat software testing as a human activity), *An Introduction to General Systems Thinking*, and *Quality Software Management* series.
You have spent five decades teaching that testing is not just about finding bugs—it's about understanding systems, managing risk, and improving the human processes that create software.
Your hallmark: you look beyond the code to the systemic context, you treat every test as an experiment with a hypothesis, and you understand that "quality" is value to some person.
You are acting as the **Quality Testing Agent** for this workflow.

## Your Role
- Review the provided code diff from a BLACK-BOX perspective.
- Evaluate correctness, completeness, edge cases, and potential defects.
- Verify that the code satisfies ALL acceptance criteria in the requirements document.
- Verify that the code complies with the architecture design.
- Do NOT modify any source files, requirement documents, or architecture documents.
- Be objective and evidence-based: cite specific lines from the diff when reporting issues.
- If accumulated experience is provided below, apply proven test patterns and avoid known pitfalls.
${testCasesInstruction}
## Output Format
Produce a Markdown test report with the following sections:
1. **Test Summary** – Overall pass/fail verdict with confidence score (0-100%)
2. **Test Cases Executed** – Table with columns: ID | Description | Input | Expected | Actual | Status
3. **Defects Found** – Numbered list with: Severity (Critical/High/Medium/Low) | Location | Description | Reproduction Steps
4. **Coverage Analysis** – Map each acceptance criterion from requirements.md to: ✅ Covered / ❌ Missing / ⚠️ Partial
5. **Architecture Compliance** – Verify each component/interface from architecture.md is correctly implemented
6. **Risk Assessment** – Areas of the code that carry the highest risk of failure
7. **Recommendations** – Specific, actionable fixes for each defect found
8. **Regression Checklist** – Items to verify after fixes are applied
9. **Architecture Design** *(mandatory)* – The testing strategy and design decisions made for this test run:
   - Which testing approach was chosen (black-box / white-box / boundary analysis / equivalence partitioning)
   - Which risk areas were prioritised and why
   - How the test cases map to the architecture components
   - What testing gaps exist and why they could not be covered
   - ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.
10. **Execution Plan** *(mandatory)* – The ordered sequence of testing activities performed:
    - Step 1: [what was tested first and why]
    - Step 2: [what was tested next]
    - ... (continue for all significant testing steps)
    - What was intentionally deferred or left untested and why
    - ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.

## Severity Definitions
- **Critical**: System crash, data loss, security vulnerability
- **High**: Core feature broken, no workaround
- **Medium**: Feature partially broken, workaround exists
- **Low**: Minor UI/UX issue, cosmetic defect
${testCasesSection}${requirementsSection}${architectureSection}
${jsonInstruction}

## Code Diff to Review
\`\`\`diff
${inputContent}
\`\`\`
${expSection}
## Instructions
First output the JSON metadata block (as instructed above), then write the full test report.
Be thorough, objective, and cite evidence from the diff.
Pay special attention to Coverage Analysis – every acceptance criterion must be explicitly verified.
**CRITICAL**: Sections 9 (Architecture Design) and 10 (Execution Plan) are MANDATORY. Do not omit them.`;
  }

  /**
   * Parses the LLM response.
   * Validates that the report contains required sections.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // P0-NEW-1: validate JSON block presence (imports hoisted to file top – P1-1 fix)
    const jsonBlock = extractJsonBlock(llmResponse);
    if (!jsonBlock) {
      console.warn(`[TesterAgent] ⚠️  No structured JSON block found in output. Downstream agents will use regex-based extraction (degraded mode).`);
    } else {
      const check = validateJsonBlock(jsonBlock, 'tester');
      if (!check.valid) {
        console.warn(`[TesterAgent] ⚠️  JSON block validation failed: ${check.reason}`);
      } else {
        console.log(`[TesterAgent] ✅ Structured JSON block validated (${Object.keys(jsonBlock).length} fields).`);
      }
    }

    // P1-4: bilingual section name support
    const requiredSections = [
      { en: 'Test Summary', zh: '测试总结' },
      { en: 'Defects Found', zh: '发现的缺陷' },
      { en: 'Recommendations', zh: '建议' },
    ];
    const missingSections = requiredSections.filter(s => !llmResponse.includes(s.en) && !llmResponse.includes(s.zh));
    if (missingSections.length > 0) {
      console.warn(`[TesterAgent] WARNING: Test report missing sections: ${missingSections.map(s => s.en).join(', ')}`);
    }

    // ── Mandatory section compliance check (P1-4: bilingual support) ─────────
    // TesterAgent's mandatory sections are test-report specific
    const mandatorySections = [
      { en: 'Test Summary', zh: '测试总结' },
      { en: 'Defects Found', zh: '发现的缺陷' },
      { en: 'Recommendations', zh: '建议' },
    ];
    const missingMandatory = mandatorySections.filter(s => !llmResponse.includes(s.en) && !llmResponse.includes(s.zh));
    if (missingMandatory.length > 0) {
      console.warn(`[TesterAgent] ⚠️  COMPLIANCE: Missing mandatory section(s): ${missingMandatory.map(s => s.en).join(', ')}. The agent output specification requires these sections.`);
    } else {
      console.log(`[TesterAgent] ✅ Mandatory sections present: Architecture Design, Execution Plan.`);
    }

    // Verify that pre-planned test case IDs appear in the report
    // This catches cases where the LLM ignored the test cases checklist
    // P1-2 fix: use top-level fs/path imports; P0-1 fix: use this._outputDir
    const verifyTestCasesPath = path.join(this._outputDir, 'test-cases.md');
    if (fs.existsSync(verifyTestCasesPath)) {
      const testCasesContent = fs.readFileSync(verifyTestCasesPath, 'utf-8');
      const plannedIds = (testCasesContent.match(/"case_id"\s*:\s*"([^"]+)"/g) || [])
        .map(m => m.match(/"([^"]+)"$/)[1]);
      if (plannedIds.length > 0) {
        const coveredIds = plannedIds.filter(id => llmResponse.includes(id));
        const coverageRate = Math.round((coveredIds.length / plannedIds.length) * 100);
        // P2 fix: Use configurable threshold
        if (coverageRate < this._coverageThreshold) {
          console.warn(`[TesterAgent] WARNING: Only ${coveredIds.length}/${plannedIds.length} pre-planned test case IDs (${coverageRate}%) appear in the report. Threshold: ${this._coverageThreshold}%. The tester may have ignored the test checklist.`);
        } else {
          console.log(`[TesterAgent] ✅ Test case coverage: ${coveredIds.length}/${plannedIds.length} IDs referenced in report (${coverageRate}%). Threshold: ${this._coverageThreshold}%.`);
        }
      }
    }

    return llmResponse;
  }
}

module.exports = { TesterAgent };
