'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
// Extended scan: cover all code entry points that historically hard-coded
// output/code-graph.json. The migration collapsed these to resolveCodeGraphPath().
const scanRoots = [
  path.join(projectRoot, 'workflow', 'core'),
  path.join(projectRoot, 'workflow', 'commands'),
  path.join(projectRoot, 'workflow', 'tools'),
];
const allowlist = new Set([
  // CodeGraph internals — they own the legacy path read/write logic
  'workflow/core/agent-prompt-template.js',
  'workflow/core/arch-knowledge-cache.js',
  'workflow/core/code-graph.js',
  'workflow/core/code-graph-analysis.js',
  'workflow/core/code-graph-builder.js',
  'workflow/core/code-graph-cache.js',
  'workflow/core/code-graph-layered-reader.js',
  'workflow/core/code-graph-layered-reader.test.js',
  'workflow/core/code-graph-layered-index.test.js',
  'workflow/core/context-loader.js',
  // request-triage.js now fully migrated to resolveCodeGraphPath — removed from allowlist
  // Tooling that only references the name in user-facing prompts / docs, never reads it:
  'workflow/commands/commands-devtools-analysis.js',  // prints L3 path only when WF_CODE_GRAPH_LEGACY enabled
  'workflow/tools/ide-workflow-bridge.js',            // references in READ_META_SKILL_FIRST guidance text
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(projectRoot, file).replace(/\\/g, '/');
}

const offenders = [];
// Match any occurrence of the string 'code-graph.json' outside allowlisted files.
// Matches: readFileSync('...code-graph.json'), existsSync(...code-graph.json...), JSON.parse(...code-graph.json...),
// path.join(..., 'code-graph.json'), and any stray 'code-graph.json' literal.
const directReadPattern = /code-graph\.json/;

for (const root of scanRoots) {
  for (const file of walk(root)) {
    const r = rel(file);
    if (allowlist.has(r)) continue;
    const content = fs.readFileSync(file, 'utf-8');
    if (directReadPattern.test(content)) offenders.push(r);
  }
}

assert.deepStrictEqual(offenders, [], `Direct legacy code-graph.json references found (must go through resolveCodeGraphPath):\n${offenders.join('\n')}`);
console.log(`PASS no legacy code-graph.json direct references outside allowlist (scanned ${scanRoots.length} roots)`);
