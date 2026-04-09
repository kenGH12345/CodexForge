#!/usr/bin/env node
/**
 * Verify Dual-Mode Alignment Script
 *
 * Manually verifies_bridge command and MCP tool parity.
 * Run this script to validate ADR-XX "Dual Mode Synchronization".
 *
 * Usage:
 *   node workflow/scripts/verify-dual-mode.js [--project-root <path>]
 *
 * Exit Codes:
 *   0 - All checks passed
 *   1 - Parity issues detected
 *   2 - Internal error
 */

'use strict';

const path = require('path');
const fs = require('fs');

// ─── Configuration ──────────────────────────────────────────────────────────

const TEST_CASES = [
  { name: 'Simple typo fix', requirement: 'Fix typo in README', expected: 'ide_direct' },
  { name: 'Add comment', requirement: 'Add comment explaining the logic', expected: 'ide_direct' },
  { name: 'Minor update', requirement: 'Update error message wording', expected: 'ide_direct' },
  { name: 'Refactor module', requirement: 'Refactor the auth module to use async/await', expected: 'full_pipeline' },
  { name: 'New feature', requirement: 'Implement a new payment gateway integration', expected: 'full_pipeline' },
  { name: 'API work', requirement: 'Add new REST endpoint for user search', expected: 'full_pipeline' },
  { name: 'Database migration', requirement: 'Add database migration for new user fields', expected: 'full_pipeline' },
  { name: 'Performance optimization', requirement: 'Optimize the search query performance', expected: 'full_pipeline' },
];

// ─── Imports ────────────────────────────────────────────────────────────────

const { MCPServer } = require('../core/mcp-server');
const { RequestTriage } = require('../core/request-triage');

// ─── Color Output Helpers ───────────────────────────────────────────────────

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';

function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}✗${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}⚠${RESET} ${msg}`); }
function info(msg) { console.log(`${BLUE}ℹ${RESET} ${msg}`); }

// ─── Verification Functions ─────────────────────────────────────────────────

async function verifyTriageParity(projectRoot) {
  console.log('\n📋 Test Suite: Triage Decision Parity\n');

  const server = new MCPServer({ projectRoot });
  const triage = new RequestTriage();
  let passed = 0;
  let failed = 0;

  for (const testCase of TEST_CASES) {
    // Bridge mode (RequestTriage directly)
    const bridgeResult = triage.triage(testCase.requirement, { projectRoot });

    // MCP mode (via server)
    const toolResult = await runMCPTool(server, 'workflow_triage', {
      requirement: testCase.requirement,
    });

    // Parse MCP result
    const mcpJson = parseMCPResponse(toolResult);

    // Compare
    const scoreMatch = bridgeResult.score === mcpJson.complexity.score;
    const suggestionMatch = bridgeResult.suggestion === mcpJson.routing.suggestion;

    if (scoreMatch && suggestionMatch) {
      ok(`${testCase.name}: score=${bridgeResult.score}, suggestion=${bridgeResult.suggestion}`);
      passed++;
    } else {
      fail(`${testCase.name}:`);
      console.log(`  Bridge: score=${bridgeResult.score}, suggestion=${bridgeResult.suggestion}`);
      console.log(`  MCP:    score=${mcpJson.complexity.score}, suggestion=${mcpJson.routing.suggestion}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

async function verifyIDEToolInjection() {
  console.log('\n🔧 Test Suite: IDE Tool Injection\n');

  let passed = true;

  // Test 1: Server without IDE tools
  const serverNoTools = new MCPServer({ projectRoot: process.cwd() });
  if (serverNoTools._ideToolCount === 0 && !serverNoTools.checkBridgeParity().ideToolAvailable) {
    ok('Server starts without IDE tools (fallback mode)');
  } else {
    fail('Server should have 0 IDE tools when none injected');
    passed = false;
  }

  // Test 2: Server with IDE tools
  const mockTools = {
    codebaseSearch: async () => [],
    grepSearch: async () => [],
    viewCodeItem: async () => {},
    readFile: async () => {},
    listDir: async () => [],
  };

  const serverWithTools = new MCPServer({
    projectRoot: process.cwd(),
    IDE_TOOLS: mockTools,
  });

  const parity = serverWithTools.checkBridgeParity();
  if (parity.ideTools.codebaseSearch && parity.ideTools.grepSearch && parity.ideTools.viewCodeItem) {
    ok('IDE tools properly injected and detected');
  } else {
    fail('IDE tool injection not working');
    passed = false;
  }

  // Test 3: Analysis tools injection
  const serverWithAnalysisTools = new MCPServer({
    projectRoot: process.cwd(),
    toolsForAnalysis: [{ name: 'testTool', call: () => {} }],
  });

  const parityWithAnalysis = serverWithAnalysisTools.checkBridgeParity();
  if (parityWithAnalysis.ideTools.analysisTools === 1) {
    ok('Analysis tools properly injected');
  } else {
    fail('Analysis tool injection not working');
    passed = false;
  }

  return passed;
}

async function verifyBridgeParityReport(projectRoot) {
  console.log('\n📊 Test Suite: Bridge Command Parity Report\n');

  const server = new MCPServer({ projectRoot });
  const report = server.checkBridgeParity();

  // Check structure
  const requiredFields = ['timestamp', 'serverMode', 'toolCount', 'bridgeCommands', 'mcpTools', 'parityMap', 'issues', 'ideTools', 'triageSync'];
  const allFieldsPresent = requiredFields.every(f => f in report);

  if (allFieldsPresent) {
    ok('Parity report has all required fields');
  } else {
    fail('Parity report missing fields');
    return false;
  }

  // Check tool mappings
  const mappedTools = Object.keys(report.parityMap);
  const expectedTools = ['workflow_triage', 'workflow_run', 'workflow_init', 'workflow_status'];
  const allToolsMapped = expectedTools.every(t => mappedTools.includes(t));

  if (allToolsMapped) {
    ok('All MCP tools mapped to Bridge commands');
  } else {
    fail('Some MCP tools not mapped');
    return false;
  }

  // Check no issues
  if (report.issues.length === 0) {
    ok('No parity issues detected');
  } else {
    for (const issue of report.issues) {
      warn(`Parity issue: ${issue}`);
    }
  }

  // Check triage sync
  if (report.triageSync.sharesLogicWithBridge && report.triageSync.routeToIDEEnabled) {
    ok('Triage logic synchronized between modes');
  } else {
    fail('Triage logic not synchronized');
    return false;
  }

  return true;
}

async function generateParityReport(projectRoot) {
  console.log('\n📝 Generating Parity Report\n');

  const server = new MCPServer({ projectRoot });
  const report = server.formatParityReport();

  // Write to file
  const reportPath = path.join(projectRoot, '.workflow', 'dual-mode-parity-report.md');
  const reportDir = path.dirname(reportPath);

  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  fs.writeFileSync(reportPath, report, 'utf8');

  info(`Parity report written to: ${reportPath}`);
  console.log('\n--- Report Preview ---\n');
  console.log(report.slice(0, 800) + '...\n');
}

// ─── Helper Functions ───────────────────────────────────────────────────────

async function runMCPTool(server, toolName, args) {
  const handler = server._requestHandlers.get('tools/call');
  if (!handler) {
    throw new Error('tools/call handler not found');
  }
  return handler({ name: toolName, arguments: args });
}

function parseMCPResponse(result) {
  const text = result.content[0].text;
  const match = text.match(/```json\n([\s\S]+?)\n```/);
  if (match) {
    return JSON.parse(match[1]);
  }
  // Fallback for error responses
  return { complexity: { score: 0 }, routing: { suggestion: 'unknown' } };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Dual-Mode Alignment Verification');
  console.log('  ADR-XX: Bridge Command ↔ MCP Tool Parity Check');
  console.log('═══════════════════════════════════════════════════════════════');

  // Parse args
  const args = process.argv.slice(2);
  let projectRoot = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root' && args[i + 1]) {
      projectRoot = path.resolve(args[i + 1]);
      i++;
    }
  }

  info(`Project root: ${projectRoot}`);

  let allPassed = true;

  try {
    // Run all verification suites
    allPassed = await verifyTriageParity(projectRoot) && allPassed;
    allPassed = await verifyIDEToolInjection() && allPassed;
    allPassed = await verifyBridgeParityReport(projectRoot) && allPassed;

    // Generate report
    await generateParityReport(projectRoot);

    // Final summary
    console.log('\n═══════════════════════════════════════════════════════════════');
    if (allPassed) {
      console.log(`${GREEN}✅ All verification checks passed!${RESET}`);
      console.log('Dual-mode alignment is confirmed.');
      process.exit(0);
    } else {
      console.log(`${RED}❌ Some verification checks failed.${RESET}`);
      console.log('Please review the output above for details.');
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n${RED}❌ Internal error:${RESET}`, err.message);
    console.error(err.stack);
    process.exit(2);
  }
}

// Run if directly executed
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(2);
  });
}

module.exports = {
  verifyTriageParity,
  verifyIDEToolInjection,
  verifyBridgeParityReport,
};
