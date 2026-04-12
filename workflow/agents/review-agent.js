/**
 * ReviewAgent – Peer Code Review Agent
 *
 * Domain Expert: Douglas Crockford (creator of JSLint/JSON, advocate for code quality)
 * Philosophy: "Good code is its own best documentation. But code review is the process by which
 * we transform bad code into good code, teaching while we examine."
 *
 * Role: Peer reviewer focused on code quality, patterns, and standards compliance.
 * Input:  output/code.diff
 * Output: output/review-report.md
 *
 * Constraints:
 *  - Operates as a peer reviewer (not black-box like tester)
 *  - Evaluates code against project standards, patterns, and best practices
 *  - Works in tandem with TesterAgent (Tester focuses on behavior, Reviewer focuses on code quality)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');
const { buildJsonBlockInstruction, extractJsonBlock, validateJsonBlock } = require('../core/agent-output-schema');

class ReviewAgent extends BaseAgent {
  constructor(llmCall, hookEmitter, opts = {}) {
    super(AgentRole.REVIEWER, llmCall, hookEmitter, opts);
    this._reviewDepth = opts.reviewDepth || 'standard';
    this._maxFindingCount = opts.maxFindingCount || 20;
  }

  buildPrompt(inputContent, expContext = null) {
    const expSection = expContext
      ? `\n## Accumulated Experience\n${expContext}\n`
      : '';

    const depthInstruction = this._buildDepthInstruction();
    const jsonInstruction = buildJsonBlockInstruction('reviewer');

    return `You are **Douglas Crockford** — creator of JSLint, author of *JavaScript: The Good Parts*
Review the code diff from an IMPLEMENTATION QUALITY perspective (white-box).
Focus on code patterns, style, architecture alignment, and standards.
${depthInstruction}

## Two-Stage Review Process (BitsAI-CR Pattern)
You MUST follow a two-stage review process to minimise false positives:

### Stage 1: RuleChecker — Systematic Checklist Review
1. Read the ENTIRE diff before making any judgments
2. For each changed function/method, expand context: understand callers, callees, and type definitions
3. Evaluate each dimension in order: SEC → ERR → PERF → STYLE → REQ → SYNTAX → EDGE → INTF → EXPORT → CONST
4. For each item: PASS (with evidence), FAIL (with evidence + fix), or N/A (with brief reason)

### Stage 2: ReviewFilter — Self-Verification
For EVERY finding from Stage 1, ask yourself:
- "Is this finding actually correct, or did I misread the code?"
- "Is this finding actionable, or is it noise?"
- "Would a senior developer accept this feedback, or dismiss it?"
If ANY answer is negative → DISCARD the finding. Do NOT include it in the report.

### Review Comment Quality Standard
Every finding MUST have 4 components:
1. **What**: The specific issue (with exact file:line reference)
2. **Why**: Why this is a problem (impact on correctness/security/performance)
3. **How**: Concrete fix suggestion (not vague "improve this")
4. **Severity**: Accurate severity level (CRITICAL/HIGH/MEDIUM/LOW)

## Output Format
1. **Review Summary** – Verdict with confidence (0-100%), findings count (Stage 1 → Stage 2 filter rate)
2. **Code Quality Findings** – Severity | Category | Location | Issue | Suggestion | Filter Decision (KEEP/DISCARD)
3. **Standards Compliance** – Checklist with PASS/FAIL/N/A per dimension
4. **Pattern Analysis** – Code pattern evaluation, defect chain analysis
5. **Coverage Matrix** – Which review dimensions were exercised vs blind spots
6. **Recommendations** – Actionable fixes, prioritised by severity
${jsonInstruction}

## Code Diff
\`\`\`diff
${inputContent}
\`\`\`
${expSection}`;
  }

  _buildDepthInstruction() {
    switch (this._reviewDepth) {
      case 'quick':
        return `Focus ONLY on: critical issues, major standards violations`;
      case 'thorough':
        return `Comprehensive review: examine every line, deep patterns analysis`;
      default:
        return `Focus on: standards compliance, maintainability, clear violations`;
    }
  }

  parseResponse(llmResponse) {
    const jsonBlock = extractJsonBlock(llmResponse);
    if (!jsonBlock) {
      console.warn(`[ReviewAgent] ⚠️ No structured JSON block found`);
    }
    return llmResponse;
  }
}

module.exports = { ReviewAgent };
