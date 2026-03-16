/**
 * DeveloperAgent – Code Development Agent
 *
 * Role: Executor.
 * Input:  output/architecture.md  (file path passed by orchestrator)
 * Output: output/code.diff        (unified diff format)
 *
 * Constraints:
 *  - MUST NOT modify requirement.md or architecture.md
 *  - MUST NOT write test reports
 *  - MUST produce output as a unified diff (git diff format)
 *  - MUST strictly follow the architecture document
 */

'use strict';

const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');

class DeveloperAgent extends BaseAgent {
  constructor(llmCall, hookEmitter) {
    super(AgentRole.DEVELOPER, llmCall, hookEmitter);
  }

  /**
   * Builds the developer prompt.
   * Input content is the full text of architecture.md.
   *
   * @param {string} inputContent - Content of architecture.md
   * @param {string|null} expContext - Experience context block from ExperienceStore (optional)
   * @returns {string}
   */
  buildPrompt(inputContent, expContext = null) {
    const expSection = expContext
      ? `\n## Accumulated Experience (Reference Before Coding)\n${expContext}\n`
      : '';

    return `You are a **Code Development Agent** – a disciplined executor.

## Your Role
- Read the architecture document and implement it faithfully as code.
- Output ONLY a unified diff (git diff format) representing the changes to be applied.
- Do NOT modify requirement.md or architecture.md.
- Do NOT write test cases or test reports.
- Strictly follow the architecture: do not introduce components or patterns not described.
- If accumulated experience is provided below, apply proven patterns and avoid known pitfalls.

## Output Format
Produce a unified diff in standard git diff format:
\`\`\`diff
--- a/path/to/file.js
+++ b/path/to/file.js
@@ -line,count +line,count @@
 context line
+added line
-removed line
 context line
\`\`\`

Rules:
- Each file change must have a proper diff header
- Include sufficient context lines (3 lines before/after each change)
- Group related changes in the same file together
- Add new files with \`--- /dev/null\` and \`+++ b/new-file.js\`

## Mandatory Preamble Sections
Before the diff output, you MUST include the following two sections:

### Architecture Design *(mandatory)*
A concise record of the implementation design decisions made for this coding task:
- Which modules/files were created or modified and why
- Which design patterns were applied (e.g. factory, singleton, middleware chain)
- How the implementation maps to the architecture document's component breakdown
- Any deviations from the architecture and the justification for each deviation
- ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.

### Execution Plan *(mandatory)*
An ordered list of the implementation steps taken:
- Step 1: [what was done first and why]
- Step 2: [what was done next]
- ... (continue for all significant steps)
- What was intentionally deferred or left as TODO and why
- ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.

## Architecture Document
${inputContent}
${expSection}
## Instructions
First write the "Architecture Design" and "Execution Plan" sections.
Then generate the code.diff. Output the diff content inside a \`\`\`diff block.
**CRITICAL**: Both preamble sections are MANDATORY. Do not omit them.`;
  }

  /**
   * Parses the LLM response.
   * Extracts the diff content from code blocks if wrapped.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // ── Mandatory section compliance check ────────────────────────────────────
    const mandatorySections = ['Architecture Design', 'Execution Plan'];
    const missingSections = mandatorySections.filter(s => !llmResponse.includes(s));
    if (missingSections.length > 0) {
      console.warn(`[DeveloperAgent] ⚠️  COMPLIANCE: Missing mandatory section(s): ${missingSections.join(', ')}. The agent output specification requires these sections.`);
    } else {
      console.log(`[DeveloperAgent] ✅ Mandatory sections present: Architecture Design, Execution Plan.`);
    }

    // Extract content from ```diff ... ``` block if present (handle optional diff and \r\n)
    const diffBlockMatch = llmResponse.match(/```(?:diff)?\r?\n([\s\S]*?)```/);
    if (diffBlockMatch) {
      return diffBlockMatch[1].trim();
    }
    // Fallback: strip any remaining markdown backticks just in case
    return llmResponse.replace(/^```(?:diff)?\r?\n/m, '').replace(/```$/m, '').trim();
  }
}

module.exports = { DeveloperAgent };
