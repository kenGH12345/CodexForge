/**
 * IDE LLM Adapter — Bridges Orchestrator's llmCall to IDE Agent's reasoning capability.
 *
 * Problem: Orchestrator requires a `llmCall` function, but in IDE Agent mode,
 * the LLM IS the IDE Agent itself (not an external API). This adapter enables
 * the Orchestrator to delegate LLM calls to the IDE Agent via file-based IPC.
 *
 * Protocol (File IPC):
 *   1. Orchestrator calls llmCall(prompt)
 *   2. Adapter writes prompt to: <outputDir>/.llm-request-<id>.json
 *   3. Adapter prints: [IDE_LLM_REQUEST:<id>] to stderr
 *   4. IDE Agent reads the request file, generates response, writes to:
 *      <outputDir>/.llm-response-<id>.json
 *   5. Adapter polls for response file (max 300s), reads and returns content
 *
 * Usage (as --llm-module argument to ide-workflow-bridge.js run):
 *   node workflow/tools/ide-workflow-bridge.js run \
 *     --requirement "Build a REST API" \
 *     --llm-module workflow/tools/ide-llm-adapter.js \
 *     --project-root .
 *
 * IDE Agent workflow:
 *   1. Start the run command (it will pause at each LLM request)
 *   2. Watch for [IDE_LLM_REQUEST:<id>] in stderr
 *   3. Read output/.llm-request-<id>.json
 *   4. Generate response using your reasoning
 *   5. Write response to output/.llm-response-<id>.json
 *   6. The run command will continue automatically
 *
 * Design principles (ADR-37 IDE-First):
 *   - Zero external dependencies
 *   - File-based IPC (works with any terminal tool)
 *   - Structured JSON protocol
 *   - Configurable timeout and output directory
 *
 * @module workflow/tools/ide-llm-adapter
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_OUTPUT_DIR = process.env.WORKFLOW_OUTPUT_DIR || 'output';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.WORKFLOW_LLM_TIMEOUT_MS || '300000', 10); // 5 minutes
const DEFAULT_POLL_INTERVAL_MS = 500;

// ─── File IPC LLM Adapter ─────────────────────────────────────────────────────

/**
 * Creates a llmCall function that delegates to IDE Agent via file IPC.
 *
 * @param {object} [options]
 * @param {string} [options.outputDir] - Directory for IPC files (default: 'output')
 * @param {number} [options.timeoutMs] - Max wait time in ms (default: 300000)
 * @param {number} [options.pollIntervalMs] - Polling interval in ms (default: 500)
 * @returns {Function} async (prompt: string) => string
 */
function createIdeLlmCall(options = {}) {
  const outputDir = path.resolve(options.outputDir || DEFAULT_OUTPUT_DIR);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let requestCounter = 0;

  return async function ideLlmCall(prompt) {
    const requestId = `${Date.now()}-${++requestCounter}`;
    const requestFile = path.join(outputDir, `.llm-request-${requestId}.json`);
    const responseFile = path.join(outputDir, `.llm-response-${requestId}.json`);

    // Analyze prompt to determine stage context
    const promptLower = (prompt || '').toLowerCase();
    let stageHint = 'UNKNOWN';
    if (promptLower.includes('requirement') || promptLower.includes('analyse') || promptLower.includes('analyst')) {
      stageHint = 'ANALYSE';
    } else if (promptLower.includes('architect') || promptLower.includes('architecture') || promptLower.includes('design')) {
      stageHint = 'ARCHITECT';
    } else if (promptLower.includes('plan') || promptLower.includes('task') || promptLower.includes('implementation plan')) {
      stageHint = 'PLAN';
    } else if (promptLower.includes('code') || promptLower.includes('implement') || promptLower.includes('developer')) {
      stageHint = 'CODE';
    } else if (promptLower.includes('test') || promptLower.includes('spec') || promptLower.includes('tester')) {
      stageHint = 'TEST';
    }

    // Write request file
    const requestData = {
      id: requestId,
      stage: stageHint,
      timestamp: new Date().toISOString(),
      promptLength: (prompt || '').length,
      promptPreview: (prompt || '').slice(0, 500),
      prompt: prompt || '',
      instructions: [
        `Read this file to understand what the Orchestrator needs.`,
        `Generate a response using your IDE Agent reasoning capability.`,
        `Write your response to: ${responseFile}`,
        `Response format: JSON with { "content": "<your response text>" }`,
        `Or plain text file with just the response content.`,
      ],
      responseFile,
    };

    fs.writeFileSync(requestFile, JSON.stringify(requestData, null, 2), 'utf-8');

    // Signal to IDE Agent
    process.stderr.write(`\n[IDE_LLM_REQUEST:${requestId}]\n`);
    process.stderr.write(`Stage: ${stageHint}\n`);
    process.stderr.write(`Request file: ${requestFile}\n`);
    process.stderr.write(`Response file: ${responseFile}\n`);
    process.stderr.write(`Waiting for IDE Agent response (timeout: ${timeoutMs / 1000}s)...\n\n`);

    // Poll for response file
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (fs.existsSync(responseFile)) {
        try {
          const responseContent = fs.readFileSync(responseFile, 'utf-8').trim();

          // Try to parse as JSON first
          let responseText = responseContent;
          try {
            const parsed = JSON.parse(responseContent);
            if (parsed.content) {
              responseText = parsed.content;
            } else if (typeof parsed === 'string') {
              responseText = parsed;
            }
          } catch (_) {
            // Not JSON, use as plain text
            responseText = responseContent;
          }

          // Cleanup IPC files
          try {
            fs.unlinkSync(requestFile);
            fs.unlinkSync(responseFile);
          } catch (_) { /* non-fatal */ }

          process.stderr.write(`[IDE_LLM_RESPONSE:${requestId}] Received (${responseText.length} chars)\n\n`);
          return responseText;
        } catch (readErr) {
          // File might still be writing, wait a bit
          await sleep(pollIntervalMs);
          continue;
        }
      }

      await sleep(pollIntervalMs);
    }

    // Timeout: cleanup and throw
    try { fs.unlinkSync(requestFile); } catch (_) { /* non-fatal */ }

    throw new Error(
      `[IdeLlmAdapter] Timeout waiting for IDE Agent response (${timeoutMs / 1000}s). ` +
      `Request ID: ${requestId}. Stage: ${stageHint}. ` +
      `Expected response at: ${responseFile}`
    );
  };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Module Export ────────────────────────────────────────────────────────────

// When used as --llm-module, export the llmCall function directly
// The run command will call: require(llmModule).createIdeLlmCall(options)
module.exports = {
  createIdeLlmCall,
  // Convenience: default instance for direct require
  llmCall: createIdeLlmCall(),
};

// ─── CLI Mode ─────────────────────────────────────────────────────────────────

// When run directly, show usage info
if (require.main === module) {
  console.log(JSON.stringify({
    module: 'ide-llm-adapter',
    description: 'IDE LLM Adapter — bridges Orchestrator llmCall to IDE Agent via file IPC',
    usage: 'node workflow/tools/ide-workflow-bridge.js run --requirement "..." --llm-module workflow/tools/ide-llm-adapter.js',
    protocol: {
      step1: 'Orchestrator calls llmCall(prompt)',
      step2: 'Adapter writes prompt to output/.llm-request-<id>.json',
      step3: 'Adapter prints [IDE_LLM_REQUEST:<id>] to stderr',
      step4: 'IDE Agent reads request file, generates response, writes to output/.llm-response-<id>.json',
      step5: 'Adapter reads response and returns to Orchestrator',
    },
    envVars: {
      WORKFLOW_OUTPUT_DIR: 'Output directory for IPC files (default: output)',
      WORKFLOW_LLM_TIMEOUT_MS: 'Max wait time in ms (default: 300000 = 5 minutes)',
    },
  }, null, 2));
}
