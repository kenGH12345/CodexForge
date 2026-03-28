'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./constants');
const { translateMdFile } = require('./i18n-translator');

/**
 * TestCaseGenerator – Pre-test planning module.
 *
 * Generates a structured test-cases.md BEFORE the TesterAgent runs.
 * This "test-first" approach forces explicit coverage planning and
 * significantly improves test report quality by:
 *  1. Deriving test cases directly from acceptance criteria (no guesswork)
 *  2. Ensuring every requirement has at least one corresponding test case
 *  3. Providing the TesterAgent with a concrete, executable checklist
 *  4. Making coverage gaps visible before the report is written
 *
 * Output format: output/test-cases.md
 *   - Part 1: JSON array of test cases (machine-readable, automation-ready)
 *   - Part 2: Acceptance criteria coverage matrix (human-readable)
 */
class TestCaseGenerator {
  /**
   * @param {Function} llmCall  - Raw LLM call function (prompt: string) => Promise<string>
   * @param {object}   opts
   * @param {boolean}  [opts.verbose=false]
   * @param {string}   [opts.outputDir]
   */
  constructor(llmCall, opts = {}) {
    this._llmCall   = llmCall;
    this._verbose   = opts.verbose ?? false;
    this._outputDir = opts.outputDir || PATHS.OUTPUT_DIR;
  }

  /**
   * Generates test-cases.md from requirements + architecture + code diff.
   *
   * @returns {Promise<{ path: string, caseCount: number, skipped: boolean }>}
   */
  async generate() {
    const requirementsPath = path.join(this._outputDir, 'requirement.md');
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
      ? `\n### Architecture Document\n${architectureContent}\n`
      : '';
    const diffSection = codeDiffContent
      ? `\n### Code Diff (for context)\n\`\`\`diff\n${codeDiffContent}\n\`\`\`\n`
      : '';

    const prompt = `## Role
You are **Boris Beizer** – author of *Software Testing Techniques* (2nd ed.) and *Black-Box Testing*, and the engineer who gave the industry its vocabulary for test design: equivalence partitioning, boundary value analysis, cause-effect graphing, and state-transition testing.
Your hallmark: you design test cases that find bugs, not test cases that confirm the code works. You never write a test case that cannot fail.
You are a senior test engineer producing a complete, executable test suite from the requirements below.

## Input
I will provide a requirements document describing the features to be tested.
Based on this, generate a comprehensive set of test cases.

### Requirements Document
${requirementsContent}
${archSection}${diffSection}
## Output Requirements
Output TWO sections in sequence:

### SECTION 1 – Test Cases (JSON)
Output a JSON array. Each object must contain exactly these fields:
- \`case_id\`: string, format: TC_<FEATURE>_<NNN> (e.g. TC_LOGIN_001, TC_REG_002)
- \`title\`: string, concise test title in format "Verify [condition] when [action]"
- \`precondition\`: string, the required initial state before the test starts
- \`steps\`: array of strings, each string is ONE atomic action (no compound steps)
- \`expected\`: string, specific and assertable expected result (e.g. "Page URL changes to /dashboard", "Error message 'Invalid password' appears")
- \`test_data\`: object, concrete key-value pairs of all test data used (NEVER use vague terms like "valid data" – always give actual values)
- \`automation_type\`: string, MUST be one of: \`"auto"\` (can be automated) or \`"manual"\` (requires human interaction, e.g. UI visual checks, hardware-dependent, captcha, OAuth flows). Default to \`"auto"\` unless the test genuinely cannot be automated.
Output the JSON array between these exact markers:
\`\`\`json
[
  { ... }
]
\`\`\`

### SECTION 2 – Coverage Matrix (Markdown)
After the JSON block, output a Markdown table mapping every acceptance criterion to test case IDs:

## Acceptance Criteria Coverage Matrix

| Requirement / Criterion | Test Case IDs | Coverage Status |
|------------------------|---------------|-----------------|
| AC-001: ... | TC_XXX_001, TC_XXX_002 | ✅ Covered |
| AC-002: ... | – | ❌ Not covered |

## Test Design Principles
Apply ALL of the following methods when generating test cases:
1. **Equivalence Partitioning** – valid class, invalid class for each input field
2. **Boundary Value Analysis** – min, max, min-1, max+1 for numeric/length constraints
3. **Error Guessing** – SQL injection, XSS, special characters, null/empty, whitespace-only
4. **Scenario Flow** – happy path end-to-end, then each failure branch
5. **Coverage Rule** – every acceptance criterion must have ≥1 test case; every input field must have ≥1 negative test

## Quality Rules
- Steps must be atomic: "Click the Submit button" ✅ / "Fill in the form and submit" ❌
- Expected results must be observable and assertable: "Toast message 'Saved successfully' appears" ✅ / "Operation succeeds" ❌
- test_data must contain real values: \`{"username": "testuser", "password": "Pass123!"}\` ✅ / \`{"username": "valid username"}\` ❌
- Include at least: 1 happy-path case, 2 negative/error cases, 1 boundary case per major feature
- Priority field is NOT required in the JSON (keep schema minimal)

## Few-Shot Examples (follow this format exactly)

### Example Input (fragment):
"User registration: username must be alphanumeric, 6–20 characters. If username already exists, show 'Username already taken'."

### Example Output (fragment):
\`\`\`json
[
  {
    "case_id": "TC_REG_001",
    "title": "Verify successful registration with valid username",
    "precondition": "Registration page is open; username 'testuser123' does not exist in the system",
    "steps": [
      "Enter 'testuser123' in the username field",
      "Enter 'Pass1234!' in the password field",
      "Click the Register button"
    ],
    "expected": "Page redirects to /register-success, or displays toast 'Registration successful, please log in'",
    "test_data": {"username": "testuser123", "password": "Pass1234!"},
    "automation_type": "auto"
  },
  {
    "case_id": "TC_REG_002",
    "title": "Verify registration fails when username already exists",
    "precondition": "Registration page is open; username 'existing' already exists in the system",
    "steps": [
      "Enter 'existing' in the username field",
      "Enter 'Pass1234!' in the password field",
      "Click the Register button"
    ],
    "expected": "Error message 'Username already taken' is displayed; page does not redirect",
    "test_data": {"username": "existing", "password": "Pass1234!"},
    "automation_type": "auto"
  },
  {
    "case_id": "TC_REG_003",
    "title": "Verify registration fails when username is shorter than 6 characters (boundary)",
    "precondition": "Registration page is open",
    "steps": [
      "Enter 'abc' in the username field",
      "Enter 'Pass1234!' in the password field",
      "Click the Register button"
    ],
    "expected": "Inline validation error 'Username must be 6–20 characters' is displayed",
    "test_data": {"username": "abc", "password": "Pass1234!"},
    "automation_type": "auto"
  },
  {
    "case_id": "TC_REG_004",
    "title": "Verify registration fails when username contains special characters",
    "precondition": "Registration page is open",
    "steps": [
      "Enter 'user@name!' in the username field",
      "Enter 'Pass1234!' in the password field",
      "Click the Register button"
    ],
    "expected": "Inline validation error 'Username must contain only letters and numbers' is displayed",
    "test_data": {"username": "user@name!", "password": "Pass1234!"},
    "automation_type": "auto"
  }
]
\`\`\`

## Final Instructions
Now generate the complete test suite for the requirements provided above.
- Output ONLY the two sections described (JSON block + Coverage Matrix).
- Do NOT add any explanation, preamble, or commentary outside these two sections.
- Ensure every acceptance criterion appears in the Coverage Matrix.`;

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

    // P2-4 fix: count test cases by parsing the JSON block instead of regex matching
    // on "case_id" strings. The previous regex approach over-counted when the LLM
    // included "case_id" in Coverage Matrix examples or commentary text.
    let caseCount = 0;
    try {
      const jsonMatch2 = response.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch2) {
        const parsed = JSON.parse(jsonMatch2[1].trim());
        caseCount = Array.isArray(parsed) ? parsed.length : 0;
      }
    } catch {
      // Fallback to regex if JSON parse fails
      caseCount = (response.match(/"case_id"\s*:/g) || []).length;
    }

    // Wrap output in a titled Markdown document
    const finalContent = `# Test Cases\n\n> Auto-generated by TestCaseGenerator before the test stage.\n> The JSON block below is automation-ready. The Coverage Matrix follows.\n\n${response}`;

    // P2-1 fix: backup existing test-cases.md before overwriting.
    // Previously: writeFileSync always overwrote the file, destroying any
    // _annotateResults() execution statuses appended by TestCaseExecutor.
    // If the workflow rolls back to CODE and re-runs, the historical execution
    // results (PASS/FAIL/BLOCKED statuses) are permanently lost.
    // Fix: rename the existing file to test-cases.v{N}.md before writing the new one.
    if (fs.existsSync(outputPath)) {
      try {
        let version = 1;
        let backupPath;
        do {
          backupPath = outputPath.replace(/\.md$/, `.v${version}.md`);
          version++;
        } while (fs.existsSync(backupPath));
        fs.renameSync(outputPath, backupPath);
        if (this._verbose) {
          console.log(`[TestCaseGenerator] 📦 Backed up previous test-cases.md → ${require('path').basename(backupPath)}`);
        }
      } catch (backupErr) {
        console.warn(`[TestCaseGenerator] ⚠️  Could not backup test-cases.md (non-fatal): ${backupErr.message}`);
      }
    }

    fs.writeFileSync(outputPath, finalContent, 'utf-8');

    if (this._verbose) {
      console.log(`[TestCaseGenerator] ✅ Generated ${caseCount} test case(s) → ${outputPath}`);
    }

    // Async Chinese translation – non-blocking, does not affect main flow
    translateMdFile(outputPath, this._llmCall).catch((err) => {
      console.warn(`[TestCaseGenerator] ⚠️  Chinese translation failed (non-fatal): ${err.message}`);
    });

    return { path: outputPath, caseCount, skipped: false };
  }

  /**
   * 【增强版】基于代码改动生成详细测试用例文档
   * 
   * 分析 code.diff 中的实际改动，提取功能点，生成包含以下内容的测试文档：
   * 1. 功能范围说明
   * 2. 每个功能点的详细测试步骤
   * 3. 预期结果
   * 4. 边界条件用例
   * 5. 测试数据
   * 
   * 输出格式: output/test-cases-detailed.md
   * 
   * @returns {Promise<{ path: string, caseCount: number, skipped: boolean, features: string[] }>}
   */
  async generateAdvanced() {
    const codeDiffPath = path.join(this._outputDir, 'code.diff');
    const requirementsPath = path.join(this._outputDir, 'requirement.md');
    const architecturePath = path.join(this._outputDir, 'architecture.md');
    const outputPath = path.join(this._outputDir, 'test-cases-detailed.md');

    // 必须提供 code.diff
    if (!fs.existsSync(codeDiffPath)) {
      if (this._verbose) {
        console.log(`[TestCaseGenerator] ⏭️  Advanced mode requires code.diff.`);
      }
      // 降级到基础模式
      return { ...await this.generate(), features: [] };
    }

    const codeDiffContent = fs.readFileSync(codeDiffPath, 'utf-8');
    const requirementsContent = fs.existsSync(requirementsPath)
      ? fs.readFileSync(requirementsPath, 'utf-8')
      : null;
    const architectureContent = fs.existsSync(architecturePath)
      ? fs.readFileSync(architecturePath, 'utf-8')
      : null;

    // 构建输入提示
    const reqSection = requirementsContent
      ? `\n## Requirements Document\n${requirementsContent}\n`
      : '';
    const archSection = architectureContent
      ? `\n## Architecture Document\n${architectureContent}\n`
      : '';

    const prompt = `## Role
You are **Boris Beizer** – author of *Software Testing Techniques* (2nd ed.) and *Black-Box Testing*, 
and **Cem Kaner** – author of *Testing Computer Software*.

Your task is to analyze the CODE DIFF and generate a comprehensive, detailed test case document.
UNLIKE traditional test case generation from requirements, you derive test cases DIRECTLY from the ACTUAL CODE CHANGES.

## Analysis Approach
1. First, identify ALL functionality changes, API modifications, and behavioral changes in the diff
2. For each changed function/method, identify: inputs, outputs, side effects, error handling
3. Look for: new functions, modified functions, deleted functions, changed control flow
4. Extract specific validation logic, constraints, and boundary conditions from the code

## Input

### Code Diff (ACTUAL CHANGES TO TEST)
\`\`\`diff
${codeDiffContent.slice(0, 8000)}
\`\`\`
${reqSection}${archSection}

## Output Requirements

You MUST output a structured Markdown document with the following sections:

---

# Section 1: Feature Scope Analysis

Analyze and list ALL features/functions affected by the code changes:

## 1.1 New Features Added
| Feature ID | Feature Description | Files Modified | Functions/Methods |
|------------|---------------------|----------------|-------------------|
| FEAT-001 | [Brief description of new feature] | [file paths] | [function names] |
| ... | ... | ... | ... |

## 1.2 Existing Features Modified
| Feature ID | Original Behavior | New Behavior | Impact Level |
|------------|-------------------|--------------|--------------|
| MOD-001 | [What it did before] | [What it does now] | High/Medium/Low |
| ... | ... | ... | ... |

## 1.3 Features Removed/Deprecated
| Feature ID | Description | Migration Path |
|------------|-------------|----------------|
| DEP-001 | [What was removed] | [How to replace] |

---

# Section 2: Detailed Test Cases

For EACH feature identified above, provide detailed test cases.

## Feature: [FEAT-001] [Feature Name]

### 2.1 Test Summary
- **Feature**: [Brief description]
- **Test Priority**: P0 (Critical) / P1 (High) / P2 (Medium) / P3 (Low)
- **Risk Level**: High / Medium / Low
- **Automation Feasibility**: High / Medium / Low

### 2.2 Test Cases

#### Test Case: TC_[FEAT-001]_001
| Field | Value |
|-------|-------|
| **Test ID** | TC_[FEAT-001]_001 |
| **Title** | [Concise, action-oriented title] |
| **Test Type** | Functional / Integration / Unit / E2E / Regression / Security / Performance |
| **Preconditions** | [Required state before test] |
| **Test Steps** | 1. [Step 1] <br> 2. [Step 2] <br> 3. [Step 3] |
| **Expected Result** | [Specific, measurable outcome] |
| **Actual Implementation Code Reference** | [File:Line from diff] |
| **Test Data** | \`\`\`json\n{ "key": "specific_value", "number": 42 }\n\`\`\` |
| **Automation Type** | auto / manual |

[REPEAT for each test case: at least 1 happy path, 2 negative cases, 1 boundary case per feature]

---

# Section 3: Boundary & Edge Case Analysis

## 3.1 Input Boundary Values
| Feature | Input Field | Boundary Type | Test Value | Expected Behavior |
|---------|-------------|---------------|------------|-------------------|
| FEAT-001 | [field name] | Min Boundary | [value] | [expected] |
| FEAT-001 | [field name] | Max Boundary | [value] | [expected] |
| FEAT-001 | [field name] | Empty/Null | null/"" | [expected] |
| ... | ... | ... | ... | ... |

## 3.2 Error Scenarios
| Scenario ID | Error Condition | Expected Error Message | HTTP Status / Error Code |
|-------------|-----------------|------------------------|-------------------------|
| ERR-001 | [What triggers the error] | [Exact error message] | [Status code] |
| ... | ... | ... | ... |

## 3.3 State Transition Tests
| Current State | Action | Expected New State | Guard Conditions |
|---------------|--------|-------------------|------------------|
| [State A] | [Action] | [State B] | [Conditions that must be true] |
| ... | ... | ... | ... |

---

# Section 4: Test Data Sets

## 4.1 Valid Test Data
| Test Data ID | Description | Test Data Object | Expected to Pass |
|--------------|-------------|------------------|------------------|
| VALID-001 | [Description] | \`\`\`json\n{...}\n\`\`\` | ✅ Yes |
| ... | ... | ... | ... |

## 4.2 Invalid Test Data
| Test Data ID | Description | Test Data Object | Expected Error |
|--------------|-------------|------------------|----------------|
| INVALID-001 | [Description] | \`\`\`json\n{...}\n\`\`\` | [Expected error] |
| ... | ... | ... | ... |

---

# Section 5: Coverage Matrix

## 5.1 Code Coverage Targets
| File | Functions/Methods | Test Cases Covering | Coverage % |
|------|-------------------|---------------------|------------|
| [file path] | [function names] | [TC IDs] | [estimated] |
| ... | ... | ... | ... |

## 5.2 Requirement Coverage (if requirements provided)
| Requirement ID | Description | Covered By Test Cases | Status |
|----------------|-------------|----------------------|--------|
| REQ-001 | [Description] | TC_XXX_001, TC_XXX_002 | ✅ Covered |
| ... | ... | ... | ... |

---

# Section 6: Execution Instructions

## 6.1 Recommended Execution Order
1. [First test group - why]
2. [Second test group - why]
3. ...

## 6.2 Environment Setup
- [Required setup steps]
- [Dependencies to install]
- [Configuration files to prepare]

## 6.3 Manual Test Instructions (if any)
[For tests marked as "manual", provide step-by-step manual testing instructions]

---

# Section 7: Machine-Readable Test Cases (JSON)

Output the complete test case suite as a JSON array for automated execution:

\`\`\`json
[
  {
    "case_id": "TC_FEAT001_001",
    "feature_id": "FEAT-001",
    "title": "...",
    "test_type": "Functional",
    "precondition": "...",
    "steps": ["...", "..."],
    "expected": "...",
    "test_data": {...},
    "automation_type": "auto",
    "priority": "P0",
    "code_reference": "file.js:42"
  }
]
\`\`\`

---

## Quality Rules (MUST FOLLOW)

1. **Test Steps**: Must be atomic and actionable
   - ✅ "Call calculateTotal([1, 2, 3]) with array input"
   - ❌ "Test the calculateTotal function"

2. **Expected Results**: Must be specific and measurable
   - ✅ "Returns 6 (Number) and logs 'Calculation complete'"
   - ❌ "Returns correct result"

3. **Test Data**: Must contain concrete values, never placeholders
   - ✅ \`{"price": 99.99, "quantity": 3, "discount": 0.1}\`
   - ❌ \`{"price": "valid price", "quantity": "any number"}\`

4. **Code References**: Must cite specific lines from the diff
   - ✅ "Validates at src/cart.js:45-52"
   - ❌ "Validates in cart module"

5. **Boundary Analysis**: Every numeric input must have min, max, min-1, max+1 tests
6. **Error Cases**: Every validation must have null, empty, malformed tests
7. **Coverage**: Every function in the diff must have ≥1 test case`;

    if (this._verbose) {
      console.log(`[TestCaseGenerator] 🧪 Generating advanced test cases from code diff...`);
    }

    let response;
    try {
      response = await this._llmCall(prompt);
    } catch (err) {
      console.warn(`[TestCaseGenerator] ⚠️  LLM call failed (non-fatal): ${err.message}`);
      return { path: null, caseCount: 0, skipped: true, features: [] };
    }

    if (!response || !response.trim()) {
      console.warn(`[TestCaseGenerator] ⚠️  LLM returned empty response. Skipping.`);
      return { path: null, caseCount: 0, skipped: true, features: [] };
    }

    // Extract case count and features
    let caseCount = 0;
    const features = [];
    
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1].trim());
        caseCount = Array.isArray(parsed) ? parsed.length : 0;
        
        // Extract feature IDs
        parsed.forEach(tc => {
          if (tc.feature_id && !features.includes(tc.feature_id)) {
            features.push(tc.feature_id);
          }
        });
      }
    } catch {
      caseCount = (response.match(/"case_id"\s*:/g) || []).length;
    }

    // Wrap output
    const finalContent = `# Detailed Test Case Document

> Auto-generated by TestCaseGenerator (Advanced Mode)
> Generated from: Code Diff Analysis
> Date: ${new Date().toISOString()}

## Document Structure
1. **Feature Scope Analysis** - What functionality changed
2. **Detailed Test Cases** - Step-by-step test instructions
3. **Boundary & Edge Cases** - Critical boundary conditions
4. **Test Data Sets** - Concrete test data
5. **Coverage Matrix** - Coverage tracking
6. **Execution Instructions** - How to run tests
7. **Machine-Readable JSON** - For automation

---

${response}`;

    // Backup existing file
    if (fs.existsSync(outputPath)) {
      try {
        let version = 1;
        let backupPath;
        do {
          backupPath = outputPath.replace(/\.md$/, `.v${version}.md`);
          version++;
        } while (fs.existsSync(backupPath));
        fs.renameSync(outputPath, backupPath);
        if (this._verbose) {
          console.log(`[TestCaseGenerator] 📦 Backed up → ${path.basename(backupPath)}`);
        }
      } catch (backupErr) {
        console.warn(`[TestCaseGenerator] ⚠️  Backup failed (non-fatal): ${backupErr.message}`);
      }
    }

    fs.writeFileSync(outputPath, finalContent, 'utf-8');

    if (this._verbose) {
      console.log(`[TestCaseGenerator] ✅ Generated ${caseCount} detailed test case(s) for ${features.length} feature(s) → ${outputPath}`);
    }

    // Async translation
    translateMdFile(outputPath, this._llmCall).catch((err) => {
      console.warn(`[TestCaseGenerator] ⚠️  Translation failed (non-fatal): ${err.message}`);
    });

    return { path: outputPath, caseCount, skipped: false, features };
  }

  /**
   * Parse generated detailed test document and extract test cases for execution.
   * 
   * @param {string} detailedDocPath - Path to test-cases-detailed.md
   * @returns {Array} Array of structured test case objects
   */
  parseDetailedTestCases(detailedDocPath = null) {
    const docPath = detailedDocPath || path.join(this._outputDir, 'test-cases-detailed.md');
    
    if (!fs.existsSync(docPath)) {
      return [];
    }

    const content = fs.readFileSync(docPath, 'utf-8');
    
    // Extract JSON section (machine-readable test cases)
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch (err) {
        console.warn(`[TestCaseGenerator] ⚠️  Failed to parse JSON test cases: ${err.message}`);
      }
    }
    
    return [];
  }
}

module.exports = { TestCaseGenerator };
