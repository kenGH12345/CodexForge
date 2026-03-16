'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./constants');

/**
 * TestCaseGenerator – Pre-test planning module.
 *
 * Generates a structured test-cases.md BEFORE the TesterAgent runs.
 * This "test-first" approach forces explicit coverage planning and
 * significantly improves test report quality by:
 *  1. Deriving test cases directly from acceptance criteria (no guesswork)
 *  2. Ensuring every requirement has at least one corresponding test case
 *  3. Providing the TesterAgent with a concrete execution checklist
 *  4. Making coverage gaps visible before the report is written
 *
 * Output: output/test-cases.md
 */
class TestCaseGenerator {
  /**
   * @param {Function} llmCall  - Raw LLM call function (prompt: string) => Promise<string>
   * @param {object}   opts
   * @param {boolean}  [opts.verbose=false]
   * @param {string}   [opts.outputDir]
   */
  constructor(llmCall, opts = {}) {
    this._llmCall  = llmCall;
    this._verbose  = opts.verbose ?? false;
    this._outputDir = opts.outputDir || PATHS.OUTPUT_DIR;
  }

  /**
   * Generates test-cases.md from requirements + architecture + code diff.
   *
   * @returns {Promise<{ path: string, caseCount: number, skipped: boolean }>}
   */
  async generate() {
    const requirementsPath = path.join(this._outputDir, 'requirements.md');
    const architecturePath = path.join(this._outputDir, 'architecture.md');
    const codeDiffPath     = path.join(this._outputDir, 'code.diff');
    const outputPath       = path.join(this._outputDir, 'test-cases.md');

    // Skip if no requirements available
    if (!fs.existsSync(requirementsPath)) {
      if (this._verbose) {
        console.log(`[TestCaseGenerator] ⏭️  Skipped: requirements.md not found.`);
      }
      return { path: null, caseCount: 0, skipped: true };
    }

    const requirementsContent = fs.readFileSync(requirementsPath, 'utf-8');
    const architectureContent = fs.existsSync(architecturePath)
      ? fs.readFileSync(architecturePath, 'utf-8')
      : null;
    const codeDiffContent = fs.existsSync(codeDiffPath)
      ? fs.readFileSync(codeDiffPath, 'utf-8').slice(0, 6000) // cap to avoid token overflow
      : null;

    const archSection = architectureContent
      ? `\n## Architecture Document\n${architectureContent}\n`
      : '';
    const diffSection = codeDiffContent
      ? `\n## Code Diff (for context)\n\`\`\`diff\n${codeDiffContent}\n\`\`\`\n`
      : '';

    const prompt = `You are a **Test Planning Agent**. Your task is to design a comprehensive test suite BEFORE testing begins.

## Your Goal
Analyse the requirements and architecture documents, then produce a structured test plan in Markdown.
This test plan will be handed to the QA agent to execute – so it must be precise, complete, and actionable.

## Output Format
Produce a Markdown document with the following structure:

# Test Cases

## Summary
- Total test cases: N
- Coverage: list of requirement IDs covered
- Risk areas: list of high-risk areas identified

## Functional Test Cases

| ID | Category | Description | Preconditions | Steps | Expected Result | Priority |
|----|----------|-------------|---------------|-------|-----------------|----------|
| TC-001 | Functional | ... | ... | 1. ... 2. ... | ... | High |

## Edge Case Tests

| ID | Category | Description | Input | Expected Result | Priority |
|----|----------|-------------|-------|-----------------|----------|
| TC-0XX | Edge Case | ... | ... | ... | Medium |

## Negative / Error Path Tests

| ID | Category | Description | Input | Expected Result | Priority |
|----|----------|-------------|-------|-----------------|----------|
| TC-0XX | Negative | ... | ... | ... | High |

## Integration Tests (if applicable)

| ID | Category | Description | Components | Expected Result | Priority |
|----|----------|-------------|------------|-----------------|----------|
| TC-0XX | Integration | ... | ... | ... | Medium |

## Acceptance Criteria Coverage Matrix

| Requirement ID / Criterion | Test Case IDs | Coverage Status |
|---------------------------|---------------|-----------------|
| AC-001: ... | TC-001, TC-002 | ✅ Covered |
| AC-002: ... | TC-003 | ✅ Covered |
| AC-003: ... | – | ❌ Not covered |

## Rules
1. Every acceptance criterion in requirements.md MUST appear in the coverage matrix.
2. Each test case must have a unique ID (TC-001, TC-002, ...).
3. Priority: High = must pass for release, Medium = important, Low = nice to have.
4. Be specific: "click Submit button" not "interact with form".
5. Include at least 2 negative/error path tests.
6. Include at least 1 edge case per major feature.

## Requirements Document
${requirementsContent}
${archSection}${diffSection}
## Instructions
Generate the test-cases.md now. Be thorough and systematic.
Aim for complete acceptance criteria coverage. Output ONLY the Markdown document.`;

    if (this._verbose) {
      console.log(`[TestCaseGenerator] 🧪 Generating test cases from requirements...`);
    }

    let response;
    try {
      response = await this._llmCall(prompt);
    } catch (err) {
      console.warn(`[TestCaseGenerator] ⚠️  LLM call failed (non-fatal): ${err.message}`);
      return { path: null, caseCount: 0, skipped: true };
    }

    if (!response || !response.trim()) {
      console.warn(`[TestCaseGenerator] ⚠️  LLM returned empty response. Skipping.`);
      return { path: null, caseCount: 0, skipped: true };
    }

    // Count test cases (rows in tables starting with | TC-)
    const caseCount = (response.match(/\|\s*TC-\d+/g) || []).length;

    fs.writeFileSync(outputPath, response, 'utf-8');

    if (this._verbose) {
      console.log(`[TestCaseGenerator] ✅ Generated ${caseCount} test case(s) → ${outputPath}`);
    }

    return { path: outputPath, caseCount, skipped: false };
  }
}

module.exports = { TestCaseGenerator };
