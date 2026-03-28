/**
 * Stage Tester Prompts
 *
 * Extracted from stage-tester.js for maintainability (ADR-41).
 * Contains prompt templates for the Code Fix Agent.
 *
 * @module workflow/core/stage-tester-prompts
 */

'use strict';

/**
 * Builds the Code Fix Agent prompt for auto-fix rounds.
 *
 * @param {object} options
 * @param {string} options.existingDiff - Previous diff for reference
 * @param {string} options.previousFixesBlock - Block describing previous fix attempts
 * @param {string} options.sourceFilesContext - Context from source files
 * @param {string} options.failureContext - Test failure context
 * @param {string} options.webSearchContext - Web search results for error solutions
 * @param {string} options.projectRoot - Project root path
 * @returns {string}
 */
function buildFixAgentPrompt({
  existingDiff,
  previousFixesBlock,
  sourceFilesContext,
  failureContext,
  webSearchContext,
  projectRoot,
}) {
  return [
    `You are **David Thomas and Andrew Hunt** – The Pragmatic Programmers, authors of *The Pragmatic Programmer: From Journeyman to Master* and the engineers who gave the industry the DRY principle, tracer bullets, and the broken windows theory of software quality.`,
    `Your hallmark: you fix the ROOT CAUSE, not the symptom. You never apply a patch that makes the tests pass by coincidence. You leave the code in a better state than you found it.`,
    `You are acting as the **Code Fix Agent** for this workflow. The project's test suite has failed.`,
    `Your task: produce fix blocks that fix ALL failing tests.`,
    ``,
    `## Architecture Design`,
    `> **[MANDATORY]** Before writing any fix, document your diagnosis:`,
    `> - Root cause of each failing test (what is broken and why)`,
    `> - Which files/functions need to change`,
    `> - Why your proposed fix is correct (not just a workaround)`,
    ``,
    `## Execution Plan`,
    `> **[MANDATORY]** List the fix steps in order:`,
    `> 1. Fix #1: <file> lines <start>–<end> – <what you're changing and why>`,
    `> 2. Fix #2: <file> lines <start>–<end> – <what you're changing and why>`,
    `> (continue for each fix block below)`,
    ``,
    `## Previous Diff (for reference)`,
    `\`\`\`diff`,
    existingDiff.slice(0, 2000),
    `\`\`\``,
    ``,
    previousFixesBlock,
    ``,
    sourceFilesContext,
    ``,
    failureContext,
    ``,
    webSearchContext,
    ``,
    `## Fix Block Formats`,
    ``,
    `### PREFERRED: [LINE_RANGE] – line-number replacement (use this whenever you know the line numbers)`,
    ``,
    `[LINE_RANGE]`,
    `file: relative/path/to/file.js`,
    `start_line: 42`,
    `end_line: 47`,
    `replace: |`,
    `  <new code that replaces lines 42–47, preserving surrounding indentation>`,
    `[/LINE_RANGE]`,
    ``,
    `### FALLBACK: [REPLACE_IN_FILE] – string-match replacement (use only when line numbers are unknown)`,
    ``,
    `[REPLACE_IN_FILE]`,
    `file: relative/path/to/file.js`,
    `find: |`,
    `  <exact code to find – MUST be copy-pasted verbatim from the source above, including all spaces and indentation>`,
    `replace: |`,
    `  <new code to replace it with>`,
    `[/REPLACE_IN_FILE]`,
    ``,
    `## Rules`,
    `1. Analyse the failure output above and identify the root cause of each failing test.`,
    `2. Fill in the Architecture Design and Execution Plan sections FIRST, then output fix blocks.`,
    `3. **PREFER [LINE_RANGE]**: The source files above include line numbers. Use start_line/end_line whenever possible.`,
    `   [LINE_RANGE] is immune to whitespace/indent mismatches that cause [REPLACE_IN_FILE] to fail silently.`,
    `4. If you use [REPLACE_IN_FILE], the "find:" block MUST be copy-pasted verbatim from the source (no paraphrasing).`,
    `5. Only change what is necessary to fix the failures.`,
    `6. Do NOT change test files unless the test itself is clearly wrong.`,
    `7. File paths are relative to the project root: ${projectRoot}`,
  ].join('\n');
}

/**
 * Builds the previous fixes block for the prompt.
 *
 * @param {Array} fixHistory - Array of previous fix attempts
 * @returns {string}
 */
function buildPreviousFixesBlock(fixHistory) {
  if (!fixHistory || fixHistory.length === 0) {
    return `## Previous Fix Attempts\n> None – this is the first fix round.`;
  }

  const attempts = fixHistory
    .filter(entry => entry.role === 'assistant')
    .map((entry, i) => `### Fix Round ${i + 1}\n\`\`\`\n${entry.content.slice(0, 1500)}\n\`\`\``)
    .join('\n\n');

  return [
    `## Previous Fix Attempts`,
    `> The following fixes were attempted but tests still fail. Learn from these attempts.`,
    ``,
    attempts,
  ].join('\n');
}

/**
 * Builds the failure context for the prompt.
 *
 * @param {object} result - Test runner result
 * @returns {string}
 */
function buildFailureContext(result) {
  const failureSummary = result.failureSummary || [];
  const output = result.output || '';

  return [
    `## Test Failure Output`,
    ``,
    `**Exit Code**: ${result.exitCode}`,
    `**Passed**: ${result.passed ?? false}`,
    ``,
    `### Failure Summary`,
    failureSummary.length > 0
      ? failureSummary.map(f => `- ${f}`).join('\n')
      : '> No structured failure summary available.',
    ``,
    `### Full Output`,
    '```',
    output.slice(0, 4000),
    '```',
  ].join('\n');
}

/**
 * Builds the web search context for error solutions.
 *
 * @param {object} searchResult - Web search result
 * @param {string[]} errorLines - Extracted error lines
 * @param {string} primaryError - Primary error message
 * @returns {string}
 */
function buildWebSearchContext(searchResult, errorLines, primaryError) {
  if (!searchResult || !searchResult.results || searchResult.results.length === 0) {
    return '';
  }

  const formatted = searchResult.results
    .map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${(r.snippet || '').slice(0, 250)}`)
    .join('\n\n');

  return [
    `## 🌐 Web Research (Error Solutions)`,
    `> The following web search results may contain relevant fixes, workarounds, or explanations.`,
    `> **Evaluate critically** — apply only solutions that match the root cause you diagnosed above.`,
    ``,
    `**Search query**: "${primaryError}"`,
    `**Error lines found**:`,
    ...errorLines.map(l => `- \`${l.slice(0, 200)}\``),
    ``,
    `**Relevant solutions**:`,
    formatted,
  ].join('\n');
}

module.exports = {
  buildFixAgentPrompt,
  buildPreviousFixesBlock,
  buildFailureContext,
  buildWebSearchContext,
};
