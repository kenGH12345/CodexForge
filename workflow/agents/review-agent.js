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

## Output Format
1. **Review Summary** – Verdict with confidence (0-100%)
2. **Code Quality Findings** – Severity | Category | Location | Issue | Suggestion
3. **Standards Compliance** – Checklist
4. **Pattern Analysis** – Code pattern evaluation
5. **Recommendations** – Actionable fixes
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
