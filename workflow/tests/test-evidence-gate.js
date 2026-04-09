'use strict';

/**
 * ADR-37 Evidence Gate Test
 * Validates that _validateArtifact correctly rejects artifacts written from LLM memory
 * and accepts artifacts with real IDE tool evidence.
 */

const fs = require('fs');
const path = require('path');

// ── Inline the ARTIFACT_SCHEMA and _validateArtifact for isolated testing ──
const ARTIFACT_SCHEMA = {
  ANALYSE: {
    file: 'analysis.md',
    requiredSections: ['## 根因', '## 受影响位置', '## 修改范围', '## 风险评估'],
    minLines: 10,
    evidencePatterns: [
      /\b\w[\w/-]*\.(js|ts|jsx|tsx|py|go|java|cs|cpp|c|rb|rs|md|json|yaml|yml)\b/,
      /(?:line|L|第)\s*\d+/i,
      /(?:function|class|const|let|var|def|func|interface|type)\s+\w+/,
      /(?:workflow|src|core|lib|test|spec|output)\/[\w.-]+/,
    ],
    evidenceMinMatches: 2,
    evidenceError: '[EVIDENCE_MISSING] analysis.md contains no evidence of IDE tool usage',
    evidenceFixInstruction: 'Use codebase_search/grep_search/view_code_item before writing analysis.md',
  },
};

function _validateArtifact(stage, content) {
  const schema = ARTIFACT_SCHEMA[stage];
  if (!schema) return { valid: true, skipped: true };

  const lineCount = content.split('\n').filter(l => l.trim()).length;
  if (lineCount < schema.minLines) {
    return { valid: false, error: `[ARTIFACT_TOO_SHORT] only ${lineCount} lines` };
  }

  const missingSections = schema.requiredSections.filter(s => !content.includes(s));
  if (missingSections.length > 0) {
    return { valid: false, error: `[ARTIFACT_SCHEMA_FAILED] missing: ${missingSections.join(', ')}` };
  }

  if (schema.evidencePatterns && schema.evidenceMinMatches > 0) {
    const matchedPatterns = schema.evidencePatterns.filter(p => p.test(content));
    if (matchedPatterns.length < schema.evidenceMinMatches) {
      return {
        valid: false,
        error: schema.evidenceError,
        fixInstruction: schema.evidenceFixInstruction,
        evidenceViolation: true,
        adr37Violation: true,
        matchedPatternCount: matchedPatterns.length,
        requiredPatternCount: schema.evidenceMinMatches,
      };
    }
  }

  return { valid: true, lineCount };
}

// ── Test Cases ──────────────────────────────────────────────────────────────

const C = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', reset: '\x1b[0m', bold: '\x1b[1m' };
let passed = 0, failed = 0;

function test(label, content, expectedValid, expectedError) {
  const result = _validateArtifact('ANALYSE', content);
  const ok = result.valid === expectedValid && (!expectedError || (result.error || '').includes(expectedError));
  if (ok) {
    console.log(`${C.green}✅ PASS${C.reset} ${label}`);
    passed++;
  } else {
    console.log(`${C.red}❌ FAIL${C.reset} ${label}`);
    console.log(`   expected valid=${expectedValid} error~="${expectedError}"`);
    console.log(`   got     valid=${result.valid} error="${result.error}"`);
    failed++;
  }
}

const BASE_SECTIONS = `## 根因\n## 受影响位置\n## 修改范围\n## 风险评估\n`;
const PADDING = 'x\n'.repeat(10);

// Case 1: Pure LLM memory — no file paths, no line numbers, no code references
test(
  'LLM memory only (no evidence) → EVIDENCE_MISSING',
  BASE_SECTIONS + PADDING + 'The problem is that the workflow does not enforce IDE tool usage properly.\nThe workflow stages are affected by this issue.\nWe need to modify the workflow to enforce IDE tool usage.\nLLM may bypass IDE tools and analysis quality may be low.\n',
  false,
  'EVIDENCE_MISSING'
);

// Case 2: Has file path → should pass (matches pattern 1 + pattern 4)
test(
  'Has file path (workflow/core/foo.js) → PASS',
  BASE_SECTIONS + PADDING + 'The problem is in workflow/core/ide-detection.js where the function detectIDEEnvironment() does not check for evidence.\nThe workflow/tools/ide-workflow-bridge.js file is affected.\nModify workflow/tools/ide-workflow-bridge.js to add evidence patterns.\nRisk: P1 LLM may bypass IDE tools.\n',
  true,
  null
);

// Case 3: Has line number reference → should pass (matches pattern 2 + pattern 1 via .js)
test(
  'Has line number + file extension → PASS',
  BASE_SECTIONS + PADDING + 'The problem is at line 47 in ide-detection.js where the function is missing.\nThe analysis.md file is affected at line 23.\nModify the function at line 47.\nRisk: P1 LLM may bypass IDE tools.\n',
  true,
  null
);

// Case 4: Has function/class reference only (1 pattern) → FAIL (needs 2)
test(
  'Only function reference (1 pattern) → EVIDENCE_MISSING',
  BASE_SECTIONS + PADDING + 'The problem is that function detectIDEEnvironment does not check for evidence.\nThe workflow stages are affected by this issue.\nWe need to modify the function to enforce IDE tool usage.\nLLM may bypass IDE tools and analysis quality may be low.\n',
  false,
  'EVIDENCE_MISSING'
);

// Case 5: Missing required sections → ARTIFACT_SCHEMA_FAILED (before evidence check)
test(
  'Missing required sections → ARTIFACT_SCHEMA_FAILED',
  '## 根因\nsome content\n## 受影响位置\nsome content\n' + PADDING,
  false,
  'ARTIFACT_SCHEMA_FAILED'
);

// Case 6: Real-world analysis.md content (from actual IDE tool usage)
const realWorldContent = `## 根因
The problem is in workflow/tools/ide-workflow-bridge.js at the _validateArtifact function (around line 5170).
The ARTIFACT_SCHEMA only checks for section headers and line count, but does not verify that the content
was generated from actual IDE tool calls (codebase_search, grep_search, view_code_item).

## 受影响位置
| File | Location | Issue |
|------|----------|-------|
| workflow/tools/ide-workflow-bridge.js | _validateArtifact() line 5170 | No evidence check |
| workflow/core/prompt-builder.js | buildPrompt() | No ADR-37 enforcement |
| AGENTS.md | ANALYSE stage schema | Missing evidence gate documentation |

## 修改范围
| File | Location | Change |
|------|----------|--------|
| workflow/tools/ide-workflow-bridge.js | ARTIFACT_SCHEMA.ANALYSE | Add evidencePatterns field |
| workflow/tools/ide-workflow-bridge.js | _validateArtifact() | Add evidence detection logic |
| AGENTS.md | ANALYSE stage section | Add Evidence Gate documentation |

## 风险评估
- P1: False positives — legitimate analysis without explicit file paths may be rejected
- P2: Pattern matching may miss some valid evidence formats
- P3: Existing analysis.md files may fail the new gate on first run
`;

test(
  'Real-world analysis.md with file paths + line numbers → PASS',
  realWorldContent,
  true,
  null
);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${C.bold}Evidence Gate Tests: ${passed} passed, ${failed} failed${C.reset}`);
if (failed === 0) {
  console.log(`${C.green}${C.bold}✅ All tests passed — ADR-37 Evidence Gate is working correctly${C.reset}`);
} else {
  console.log(`${C.red}${C.bold}❌ Some tests failed — check Evidence Gate implementation${C.reset}`);
  process.exit(1);
}
