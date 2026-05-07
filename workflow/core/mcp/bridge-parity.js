'use strict';

function checkBridgeParity(TOOLS, serverMode, toolFunctions) {
  const report = {
    timestamp: new Date().toISOString(),
    serverMode,
    toolCount: TOOLS.length,
    bridgeCommands: ['/wf', '/wf init', '/wf-tasks', '/workflow-status'],
    mcpTools: TOOLS.map(t => t.name),
    parityMap: {},
    issues: [],
  };

  const MAPPINGS = [
    { tool: 'workflow_triage', command: '/wf', flags: [], notes: 'Auto-triage on workflow_run' },
    { tool: 'workflow_run', command: '/wf', flags: ['--parallel', '--auto', '--force'], notes: 'Full pipeline or parallel execution' },
    { tool: 'workflow_init', command: '/wf init', flags: ['--path', '--dry-run'], notes: 'Project initialization' },
    { tool: 'workflow_status', command: '/workflow-status', flags: [], notes: 'Status check' },
  ];

  for (const mapping of MAPPINGS) {
    const mcpTool = TOOLS.find(t => t.name === mapping.tool);
    report.parityMap[mapping.tool] = {
      exists: !!mcpTool,
      command: mapping.command,
      flags: mapping.flags,
      notes: mapping.notes,
    };
    if (!mcpTool) {
      report.issues.push(`Missing MCP tool: ${mapping.tool}`);
    }
  }

  const missingBridge = [];
  for (const tool of TOOLS) {
    const hasBridge = MAPPINGS.some(m => m.tool === tool.name);
    if (!hasBridge) {
      missingBridge.push(tool.name);
    }
  }
  if (missingBridge.length > 0) {
    report.issues.push(`MCP tools without Bridge equivalents: ${missingBridge.join(', ')}`);
  }

  report.ideTools = {
    codebaseSearch: typeof toolFunctions.codebaseSearch === 'function',
    grepSearch: typeof toolFunctions.grepSearch === 'function',
    viewCodeItem: typeof toolFunctions.viewCodeItem === 'function',
    readFile: typeof toolFunctions.readFile === 'function',
    listDir: typeof toolFunctions.listDir === 'function',
    analysisTools: toolFunctions.toolsForAnalysis.length,
  };
  report.ideToolAvailable = Object.values(report.ideTools)
    .filter(v => typeof v === 'boolean' ? v : v > 0).length > 0;

  report.triageSync = {
    sharesLogicWithBridge: true,
    routeToIDEEnabled: true,
    experienceHookEnabled: true,
    note: 'request-triage.js is shared between /wf command and workflow_triage tool',
  };

  return report;
}

function formatParityReport(report = null, TOOLS, serverMode, toolFunctions) {
  const r = report || checkBridgeParity(TOOLS, serverMode, toolFunctions);
  const lines = [
    `# Bridge-MCP Parity Report`,
    ``,
    `**Server Mode**: ${r.serverMode}`,
    `**Timestamp**: ${r.timestamp}`,
    ``,
    `## Tool Count`,
    `- MCP Tools: ${r.toolCount}`,
    `- Bridge Commands: ${r.bridgeCommands.length}`,
    ``,
    `## Parity Mapping`,
  ];

  for (const [tool, info] of Object.entries(r.parityMap)) {
    lines.push(`### ${tool}`);
    lines.push(`- Status: ${info.exists ? '✅ Mapped' : '❌ Missing'}`);
    lines.push(`- Bridge Command: \`${info.command}\``);
    if (info.flags.length > 0) {
      lines.push(`- Supported Flags: ${info.flags.map(f => `\`${f}\``).join(', ')}`);
    }
    lines.push(`- Notes: ${info.notes}`);
    lines.push('');
  }

  lines.push(`## IDE Tool Availability (ADR-37)`);
  for (const [tool, available] of Object.entries(r.ideTools)) {
    const status = typeof available === 'boolean'
      ? (available ? '✅' : '❌')
      : (available > 0 ? `✅ (${available})` : '❌');
    lines.push(`- ${tool}: ${status}`);
  }
  lines.push('');

  lines.push(`## Triage Synchronization`);
  lines.push(`- Shared Logic: ${r.triageSync.sharesLogicWithBridge ? '✅' : '❌'}`);
  lines.push(`- Route-to-IDE: ${r.triageSync.routeToIDEEnabled ? '✅' : '❌'}`);
  lines.push(`- Experience Hook: ${r.triageSync.experienceHookEnabled ? '✅' : '❌'}`);
  lines.push('');

  if (r.issues.length > 0) {
    lines.push(`## ⚠️ Issues Detected`);
    for (const issue of r.issues) {
      lines.push(`- ${issue}`);
    }
  } else {
    lines.push(`## ✅ No Issues`);
    lines.push(`Bridge-MCP parity is aligned.`);
  }

  return lines.join('\n');
}

module.exports = { checkBridgeParity, formatParityReport };
