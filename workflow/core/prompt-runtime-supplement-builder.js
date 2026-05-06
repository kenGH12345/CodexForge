'use strict';

const { generateIDEToolGuidance, getIDEDetectionResult } = require('./ide-detection');
const { SELF_REPORT_INSTRUCTION } = require('./agent-self-report');

const IDE_QUERY_SYMBOL_NOTE = `
> 💡 **Implementation Note**: \`CodeGraph.querySymbol()\` automatically uses IDE's \`view_code_item\` 
> when available (ADR-37), falling back to regex parsing only on failure. This provides 
> compiler-accurate symbol resolution (~100% accuracy) instead of regex-based approximation (~80%).`;

function buildRuntimeEnvironmentSection() {
  const osType = process.platform;
  const shellHint = osType === 'win32' ? 'PowerShell' : (process.env.SHELL || '/bin/bash');
  const envLines = [
    '### Runtime Environment',
    `- **OS**: ${osType === 'win32' ? 'Windows' : osType === 'darwin' ? 'macOS' : 'Linux'}`,
    `- **Shell**: ${shellHint}`,
  ];
  if (osType === 'win32') {
    envLines.push(
      '- **CRITICAL Shell Rules**:',
      '  - Do NOT use `&&` to chain commands (PowerShell does not support it). Use `;` or separate commands.',
      '  - Use `Get-ChildItem` instead of `ls`, `Select-String` instead of `grep`.',
      '  - Use backslash `\\` for path separators, or forward slash `/` (both work in PowerShell).',
      '  - Use `$env:VAR` instead of `$VAR` for environment variables.',
    );
  }
  return envLines.join('\n');
}

function buildIDEToolGuidanceSections() {
  try {
    const guidance = generateIDEToolGuidance();
    return guidance ? [guidance, IDE_QUERY_SYMBOL_NOTE] : [];
  } catch (_) {
    return [];
  }
}

function buildSelfReportInstructionSections() {
  try {
    const ideResult = getIDEDetectionResult();
    return ideResult.isInsideIDE && SELF_REPORT_INSTRUCTION ? [SELF_REPORT_INSTRUCTION] : [];
  } catch (_) {
    return [];
  }
}

function buildRuntimeSupplementSections() {
  return [
    buildRuntimeEnvironmentSection(),
    ...buildIDEToolGuidanceSections(),
    ...buildSelfReportInstructionSections(),
  ].filter(Boolean);
}

function appendRuntimeEnvironmentSection(sections) {
  try {
    sections.push(buildRuntimeEnvironmentSection());
  } catch (_) { /* Non-fatal */ }
}

function appendIDEToolGuidanceSections(sections) {
  sections.push(...buildIDEToolGuidanceSections());
}

function appendSelfReportInstructionSections(sections) {
  sections.push(...buildSelfReportInstructionSections());
}

module.exports = {
  IDE_QUERY_SYMBOL_NOTE,
  buildRuntimeEnvironmentSection,
  buildIDEToolGuidanceSections,
  buildSelfReportInstructionSections,
  buildRuntimeSupplementSections,
  appendRuntimeEnvironmentSection,
  appendIDEToolGuidanceSections,
  appendSelfReportInstructionSections,
};
