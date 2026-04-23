'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SCAN_ROOTS = ['workflow/core', 'workflow/tools'];
const TEST_ROOTS = [
  'tests', 'test',
  'workflow/tests', 'workflow/test',
  'workflow/core/__tests__', 'workflow/core/runtime/__tests__',
];
const REQUIRE_SCAN_ROOTS = ['workflow'];
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'output', '.workflow', '__tests__']);
const GRACE_PERIOD_DAYS = 7;

const EXEMPT_TAG_RE = /@production-exempt\s+(experimental|reserved|test-helper)(?:[^\r\n]*?)?\r?\n/i;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// D4: Capture dynamic script loads (Worker Threads, child_process.fork/spawn).
// Matches literal paths inside new Worker('...'), fork('...'), spawn('node', ['...']).
// Also picks up identifiers like WORKER_SCRIPT whose value contains the target file name
// via a secondary pass that scans for `path.join(__dirname, '<name>.js')` patterns.
const DYNAMIC_LOAD_RE = /(?:new\s+Worker|(?:child_process\.)?(?:fork|spawn))\s*\(\s*(?:[^)]*?['"]([^'"]+\.js)['"]|([A-Z_][A-Z0-9_]*))/g;
const PATH_JOIN_SCRIPT_RE = /path\.join\s*\(\s*__dirname\s*,\s*['"]([^'"]+\.js)['"]\s*\)/g;
const OBSERVABILITY_RE = /(\bobservability\b|\brecordResult\b|\brecord[A-Z]\w+\b|\bconsole\.(error|warn|info|log)\b|\blogger\.(info|warn|error|debug|trace)\b|\bwriteFile\b|\bfs\.append\w*\b|\bjournal\b|\bemit\s*\()/;
const TYPE_ONLY_RE = /^\s*module\.exports\s*=\s*\{[\s\S]*?\}\s*;?\s*$/;
const PURE_TYPE_HINT_RE = /(-types|-constants|-templates|-schema|-prompts)\.js$/;
const CLI_MAIN_RE = /require\.main\s*===\s*module|^#!\s*\/usr\/bin\/env\s+node/m;
const PLUGIN_PATH_RE = /\/plugins\//;
const PLUGIN_EXPORT_RE = /module\.exports\s*=\s*new\s+\w*Plugin\s*\(/;
const THIN_DELEGATOR_EXTENDS_RE = /class\s+\w+\s+extends\s+\w+/;
const THIN_DELEGATOR_METHOD_RE = /async?\s*(execute|run|handle)\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/;
// D9: ADR-33 P0 decomposition produced re-export facades that aggregate child
// modules via pure require + module.exports. These facades have no runtime
// logic (cannot carry observability) and may be consumed through mixin-injection
// patterns that elude require-index scans (see workflow/index.js:1334-1339).
// We detect them structurally: header mentions Facade/re-export/ADR-33, body is
// only require() + module.exports with zero function/class declarations.
const FACADE_HEADER_RE = /Re-?export\s+Facade|ADR-33|mixin|aggregat\w+\s+export/i;

// D10: ADR-33 sub-components (pure-function helpers, entity extractors, calculators
// split from hub modules) cannot carry R2 observability themselves — the host is
// the proper logging site. Detect modules that are only consumed by "trusted
// hosts" (production-ready or weak-R3-only) as aggregation sub-components and
// treat them as exempt. Scope is strict: must have at least one trusted host
// caller; modules consumed only by other iso/failing modules stay in isolation.

function scan(projectRoot, opts = {}) {
  const roots = opts.scanRoots || DEFAULT_SCAN_ROOTS;
  const now = Date.now();
  const graceMs = GRACE_PERIOD_DAYS * 24 * 3600 * 1000;

  const modules = [];
  for (const root of roots) {
    const absRoot = path.join(projectRoot, root);
    if (!fs.existsSync(absRoot)) continue;
    collectJsFiles(absRoot, modules, projectRoot);
  }

  const requireIndex = buildRequireIndex(projectRoot);
  const dynamicLoadIndex = buildDynamicLoadIndex(projectRoot);
  const testImportIndex = buildTestImportIndex(projectRoot);

  // D10: iterative two-pass scan. Pass 1 classifies every module without D10 so
  // we know which callers are "trusted hosts" (prod-ready or weak-R3-only).
  // Then we expand the trusted-host set iteratively: any module whose only
  // "dark" property is R2+R3 but that is exclusively consumed by trusted hosts
  // is promoted to exempt, and its existence extends the host set for its own
  // downstream sub-components (e.g., socratic-challenger -> socratic-question-
  // generator -> socratic-diversity-mixer). Iteration stops when no new module
  // is promoted (fixed point).
  const firstPassClassification = classifyFirstPass(modules, {
    now, graceMs, requireIndex, dynamicLoadIndex, testImportIndex,
  });
  const trustedHosts = buildTrustedHostSet(firstPassClassification);
  const aggregationIndex = new Map();
  let changed = true;
  let iter = 0;
  while (changed && iter < 8) {
    changed = false;
    iter++;
    const nextIndex = buildAggregationIndex(modules, trustedHosts);
    for (const [childRel, hosts] of nextIndex.entries()) {
      if (!aggregationIndex.has(childRel)) {
        aggregationIndex.set(childRel, hosts);
        // Promote the newly-exempt child to trusted host so its own sub-
        // components can be reached in the next iteration.
        if (!trustedHosts.has(childRel)) {
          trustedHosts.add(childRel);
          changed = true;
        }
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    projectRoot,
    scanRoots: roots,
    totals: { scanned: 0, productionReady: 0, weak: 0, isolation: 0, exempt: 0, pending: 0 },
    isolationModules: [],
    weakModules: [],
    exemptModules: [],
    pendingModules: [],
  };

  for (const mod of modules) {
    report.totals.scanned++;
    const content = safeRead(mod.absPath);
    const exemption = parseExemption(content);
    if (exemption) {
      report.totals.exempt++;
      report.exemptModules.push({ module: mod.relPath, exemption });
      continue;
    }

    // D9: re-export facades are structurally incapable of satisfying R2 (no logic
    // to log) and often appear R1-failed due to mixin-injection patterns the
    // require-index cannot trace. Treat as auto-exempt (reserved).
    if (isReExportFacade(content)) {
      report.totals.exempt++;
      report.exemptModules.push({
        module: mod.relPath,
        exemption: { tag: 'reserved', reason: 're-export facade (ADR-33 P0 decomposition, auto-detected)' },
      });
      continue;
    }

    // D10: aggregation sub-component — consumed only by trusted hosts that
    // themselves satisfy R1+R2. Host observability covers the sub-component.
    const aggregationHosts = aggregationIndex.get(mod.relPath);
    if (aggregationHosts && aggregationHosts.length > 0) {
      report.totals.exempt++;
      report.exemptModules.push({
        module: mod.relPath,
        exemption: {
          tag: 'reserved',
          reason: `aggregation sub-component (hosts: ${aggregationHosts.slice(0, 3).join(', ')}${aggregationHosts.length > 3 ? '…' : ''})`,
        },
      });
      continue;
    }

    const ageMs = now - fileAge(mod.absPath);
    const isNew = ageMs < graceMs;
    const isPureType = isPureTypeModule(mod, content);
    const isCliEntry = isCliEntryModule(content);
    const isDynamicPlugin = isDynamicPluginModule(mod, content);
    const isThinDelegator = isThinDelegatorModule(content);

    const failedSignals = [];
    const hasTestConsumer = hasIntegrationTest(mod, testImportIndex);
    if (!isCliEntry && !isDynamicPlugin && !isRequireReachable(mod, requireIndex) && !isDynamicallyLoaded(mod, dynamicLoadIndex)) {
      failedSignals.push('R1-require-orphan');
    }
    if (!isPureType && !isThinDelegator && !hasObservability(content)) {
      failedSignals.push('R2-no-observability');
    }
    if (!hasTestConsumer) failedSignals.push('R3-no-integration-test');

    // D6: a module that has ONLY a test-file consumer is no longer a pure orphan —
    // it is a "test-only" reachable module. We tag it so we can treat it as weak
    // rather than isolation, preserving the traceability the simple boolean lost.
    const tags = [];
    if (hasTestConsumer && failedSignals.includes('R1-require-orphan')) {
      tags.push('test-only-consumer');
    }

    const record = {
      module: mod.relPath,
      failedSignals,
      signalCount: failedSignals.length,
      ageDays: Math.floor(ageMs / (24 * 3600 * 1000)),
      tags,
    };

    if (failedSignals.length === 0) {
      report.totals.productionReady++;
    } else if (isNew) {
      report.totals.pending++;
      report.pendingModules.push(record);
    } else if (failedSignals.length === 1) {
      report.totals.weak++;
      report.weakModules.push(record);
    } else if (tags.includes('test-only-consumer') && failedSignals.length === 2) {
      // D6: R1 + R3 already eliminated by test consumer promotion — only R2 remaining
      // belongs in weak bucket (still worth fixing but not isolation).
      report.totals.weak++;
      report.weakModules.push(record);
    } else {
      report.totals.isolation++;
      report.isolationModules.push(record);
    }
  }

  return report;
}

function collectJsFiles(dir, bucket, projectRoot) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(abs, bucket, projectRoot);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') && !entry.name.endsWith('.smoke.js')) {
      const relPath = path.relative(projectRoot, abs).replace(/\\/g, '/');
      const moduleName = path.basename(entry.name, '.js');
      bucket.push({ absPath: abs, relPath, moduleName, dir: path.dirname(abs) });
    }
  }
}

function buildRequireIndex(projectRoot) {
  const index = new Map();
  for (const root of REQUIRE_SCAN_ROOTS) {
    const absRoot = path.join(projectRoot, root);
    if (!fs.existsSync(absRoot)) continue;
    walkJs(absRoot, projectRoot, (absPath) => {
      const rel = path.relative(projectRoot, absPath).replace(/\\/g, '/');
      if (isTestPath(rel)) return;
      const content = safeRead(absPath);
      let m;
      REQUIRE_RE.lastIndex = 0;
      while ((m = REQUIRE_RE.exec(content)) !== null) {
        const target = m[1];
        if (!target.startsWith('.')) continue;
        const resolvedName = path.basename(target, '.js');
        if (!index.has(resolvedName)) index.set(resolvedName, []);
        index.get(resolvedName).push(rel);
      }
    });
  }
  return index;
}

function isTestPath(relPath) {
  return (
    relPath.startsWith('tests/') ||
    relPath.startsWith('test/') ||
    relPath.includes('/__tests__/') ||
    relPath.includes('/tests/') ||
    relPath.includes('/test/') ||
    relPath.endsWith('.test.js') ||
    relPath.endsWith('.spec.js')
  );
}

// D4: Build an index of modules loaded dynamically via new Worker / fork / spawn.
// Scans non-test JS files for DYNAMIC_LOAD_RE + PATH_JOIN_SCRIPT_RE and maps
// basename(target, '.js') -> list of callers. Catches the pattern in
// code-graph-builder.js:38 (const WORKER_SCRIPT = path.join(__dirname, 'code-graph-worker.js'))
// plus direct literal forms.
function buildDynamicLoadIndex(projectRoot) {
  const index = new Map();
  for (const root of REQUIRE_SCAN_ROOTS) {
    const absRoot = path.join(projectRoot, root);
    if (!fs.existsSync(absRoot)) continue;
    walkJs(absRoot, projectRoot, (absPath) => {
      const rel = path.relative(projectRoot, absPath).replace(/\\/g, '/');
      if (isTestPath(rel)) return;
      const content = safeRead(absPath);
      // Direct literal form: new Worker('./foo.js'), fork('./foo.js')
      let m;
      DYNAMIC_LOAD_RE.lastIndex = 0;
      while ((m = DYNAMIC_LOAD_RE.exec(content)) !== null) {
        const literalPath = m[1];
        if (literalPath) {
          const name = path.basename(literalPath, '.js');
          if (!index.has(name)) index.set(name, []);
          index.get(name).push(rel);
        }
      }
      // Indirect form: path.join(__dirname, 'foo.js') assigned to a const
      // later passed to new Worker(...). We conservatively treat every such
      // script reference in the file as dynamically loaded from this caller.
      PATH_JOIN_SCRIPT_RE.lastIndex = 0;
      while ((m = PATH_JOIN_SCRIPT_RE.exec(content)) !== null) {
        const scriptName = path.basename(m[1], '.js');
        if (!index.has(scriptName)) index.set(scriptName, []);
        index.get(scriptName).push(rel);
      }
    });
  }
  return index;
}

function isDynamicallyLoaded(mod, dynamicLoadIndex) {
  const callers = dynamicLoadIndex.get(mod.moduleName) || [];
  const modNormalized = mod.relPath.replace(/\\/g, '/');
  return callers.some((c) => c.replace(/\\/g, '/') !== modNormalized);
}

function buildTestImportIndex(projectRoot) {
  const index = new Map();
  for (const testRoot of TEST_ROOTS) {
    const absRoot = path.join(projectRoot, testRoot);
    if (!fs.existsSync(absRoot)) continue;
    walkJs(absRoot, projectRoot, (absPath) => {
      const content = safeRead(absPath);
      let m;
      REQUIRE_RE.lastIndex = 0;
      while ((m = REQUIRE_RE.exec(content)) !== null) {
        const resolvedName = path.basename(m[1], '.js');
        if (!index.has(resolvedName)) index.set(resolvedName, true);
      }
    });
  }
  return index;
}

function walkJs(dir, projectRoot, cb) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(abs, projectRoot, cb);
    else if (entry.isFile() && entry.name.endsWith('.js')) cb(abs);
  }
}

function isRequireReachable(mod, requireIndex) {
  const callers = requireIndex.get(mod.moduleName) || [];
  const modNormalized = mod.relPath.replace(/\\/g, '/');
  const externalCallers = callers.filter((c) => {
    const callerNormalized = c.replace(/\\/g, '/');
    if (callerNormalized === modNormalized) return false;
    if (isTestPath(callerNormalized)) return false;
    return true;
  });
  return externalCallers.length > 0;
}

function hasObservability(content) {
  return OBSERVABILITY_RE.test(content);
}

function isPureTypeModule(mod, content) {
  if (PURE_TYPE_HINT_RE.test(mod.relPath)) return true;
  const body = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
  if (body.length < 300 && !/function\s|class\s|=>\s*\{/.test(body)) return true;
  return false;
}

function hasIntegrationTest(mod, testImportIndex) {
  return testImportIndex.has(mod.moduleName);
}

function isCliEntryModule(content) {
  return CLI_MAIN_RE.test(content);
}

function isDynamicPluginModule(mod, content) {
  if (!PLUGIN_PATH_RE.test(mod.relPath)) return false;
  return PLUGIN_EXPORT_RE.test(content);
}

function isThinDelegatorModule(content) {
  const codeBody = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const nonEmptyLines = codeBody.split('\n').filter((l) => l.trim().length > 0).length;
  if (nonEmptyLines > 80) return false;
  if (!THIN_DELEGATOR_EXTENDS_RE.test(codeBody)) return false;
  const m = codeBody.match(THIN_DELEGATOR_METHOD_RE);
  if (!m) return false;
  const body = m[2] || '';
  const bodyLines = body.split('\n').filter((l) => l.trim().length > 0).length;
  return bodyLines <= 12;
}

// D9: detect re-export facade via three structural signals AND-combined.
function isReExportFacade(content) {
  const head = content.slice(0, 800);
  if (!FACADE_HEADER_RE.test(head)) return false;
  const codeBody = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (/\bfunction\s+\w+\s*\(/.test(codeBody)) return false;
  if (/\bclass\s+\w+/.test(codeBody)) return false;
  if (/=>\s*\{[\s\S]{20,}/.test(codeBody)) return false;
  if (!/module\.exports\s*=/.test(codeBody)) return false;
  const requireCount = (codeBody.match(/require\s*\(/g) || []).length;
  return requireCount >= 1;
}

// D10: first-pass classifier \u2014 same signals/rules as scan(), minus D10 itself.
// Output: Map<relPath, { signals, isNew, isPureType, isFacade, isCliEntry,
// isDynamicPlugin, isThinDelegator, hasTestConsumer }>. Used to identify which
// modules are trusted hosts for the aggregation-subcomponent promotion.
function classifyFirstPass(modules, ctx) {
  const { now, graceMs, requireIndex, dynamicLoadIndex, testImportIndex } = ctx;
  const result = new Map();
  for (const mod of modules) {
    const content = safeRead(mod.absPath);
    const exemption = parseExemption(content);
    if (exemption) { result.set(mod.relPath, { status: 'exempt' }); continue; }
    if (isReExportFacade(content)) { result.set(mod.relPath, { status: 'exempt' }); continue; }
    const ageMs = now - fileAge(mod.absPath);
    const isNew = ageMs < graceMs;
    const isPureType = isPureTypeModule(mod, content);
    const isCliEntry = isCliEntryModule(content);
    const isDynamicPlugin = isDynamicPluginModule(mod, content);
    const isThinDelegator = isThinDelegatorModule(content);
    const hasTestConsumer = hasIntegrationTest(mod, testImportIndex);
    const failed = [];
    if (!isCliEntry && !isDynamicPlugin && !isRequireReachable(mod, requireIndex) && !isDynamicallyLoaded(mod, dynamicLoadIndex)) failed.push('R1');
    if (!isPureType && !isThinDelegator && !hasObservability(content)) failed.push('R2');
    if (!hasTestConsumer) failed.push('R3');
    let status;
    if (failed.length === 0) status = 'prod-ready';
    else if (isNew) status = 'pending';
    else if (failed.length === 1) status = 'weak';
    else if (hasTestConsumer && failed.includes('R1') && failed.length === 2) status = 'weak';
    else status = 'isolation';
    result.set(mod.relPath, { status, failed, hasTestConsumer });
  }
  return result;
}

// D10: a trusted host must pass R1+R2 (i.e., has reachability AND observability).
// That means: production-ready, OR (weak|pending) with only R3 missing. pending
// modules are included when their only failing signal is R3, because R1+R2 are
// already satisfied and the R3 gap alone does not invalidate host status.
// Exempt modules ARE included because their host responsibility is already
// covered (facade modules or sub-components of a healthy aggregation chain).
function buildTrustedHostSet(firstPassClassification) {
  const trusted = new Set();
  for (const [relPath, info] of firstPassClassification.entries()) {
    if (info.status === 'prod-ready' || info.status === 'exempt') { trusted.add(relPath); continue; }
    if ((info.status === 'weak' || info.status === 'pending') &&
        Array.isArray(info.failed) && info.failed.length === 1 && info.failed[0] === 'R3') {
      trusted.add(relPath);
    }
  }
  return trusted;
}

// D10: build reverse index of aggregation-subcomponent => list of trusted hosts.
// A module qualifies as aggregation sub-component if: (a) it has at least one
// trusted host caller, AND (b) the module itself is NOT already prod-ready or
// trusted (we only promote failing modules, never re-classify healthy ones).
// The require-based resolution walks basename matches similar to
// isRequireReachable(), but specifically targets non-test external callers.
function buildAggregationIndex(modules, trustedHosts) {
  const index = new Map();
  if (trustedHosts.size === 0) return index;
  const byBasename = new Map();
  for (const mod of modules) byBasename.set(mod.moduleName, mod.relPath);
  for (const hostRel of trustedHosts) {
    const absHost = modules.find((m) => m.relPath === hostRel);
    if (!absHost) continue;
    const content = safeRead(absHost.absPath);
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(content)) !== null) {
      const target = m[1];
      if (!target.startsWith('.')) continue;
      const resolvedName = path.basename(target, '.js');
      const childRel = byBasename.get(resolvedName);
      if (!childRel || childRel === hostRel) continue;
      if (trustedHosts.has(childRel)) continue;
      if (!index.has(childRel)) index.set(childRel, []);
      if (!index.get(childRel).includes(hostRel)) index.get(childRel).push(hostRel);
    }
  }
  return index;
}

function parseExemption(content) {
  const head = content.slice(0, 1500);
  const m = head.match(EXEMPT_TAG_RE);
  if (!m) return null;
  const tag = m[1];
  // Extract optional reason text on same line after tag, trimmed of
  // leading separator chars (dash variants, colon, space) and trailing space.
  const line = m[0];
  const afterTag = line.slice(line.toLowerCase().indexOf(tag) + tag.length);
  const reason = afterTag.replace(/^[\s\-–—:]+/, '').replace(/\r?\n$/, '').trim();
  return { tag, reason };
}

function safeRead(abs) {
  try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; }
}

function fileAge(abs) {
  try { return fs.statSync(abs).mtimeMs; } catch { return Date.now(); }
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Isolation Modules Inventory');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Scan roots: ${report.scanRoots.join(', ')}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('|----------|------:|');
  lines.push(`| Total scanned | ${report.totals.scanned} |`);
  lines.push(`| ✅ Production-ready | ${report.totals.productionReady} |`);
  lines.push(`| ⚠️ Weak integration (1 signal failed) | ${report.totals.weak} |`);
  lines.push(`| ❌ Isolation (2-3 signals failed) | ${report.totals.isolation} |`);
  lines.push(`| 🕒 Pending (within grace period) | ${report.totals.pending} |`);
  lines.push(`| 📌 Exempt (@production-exempt) | ${report.totals.exempt} |`);
  lines.push('');

  if (report.isolationModules.length > 0) {
    lines.push('## ❌ Isolation Modules (MUST fix)');
    lines.push('');
    lines.push('| Module | Age | Failed Signals | Tags |');
    lines.push('|--------|-----|----------------|------|');
    for (const r of report.isolationModules) {
      const tags = (r.tags && r.tags.length) ? r.tags.join(', ') : '-';
      lines.push(`| \`${r.module}\` | ${r.ageDays}d | ${r.failedSignals.join(', ')} | ${tags} |`);
    }
    lines.push('');
  }

  if (report.weakModules.length > 0) {
    lines.push('## ⚠️ Weak Integration Modules');
    lines.push('');
    lines.push('| Module | Age | Failed Signals | Tags |');
    lines.push('|--------|-----|----------------|------|');
    for (const r of report.weakModules) {
      const tags = (r.tags && r.tags.length) ? r.tags.join(', ') : '-';
      lines.push(`| \`${r.module}\` | ${r.ageDays}d | ${r.failedSignals.join(', ')} | ${tags} |`);
    }
    lines.push('');
  }

  if (report.pendingModules.length > 0) {
    lines.push('## 🕒 Pending Modules (Grace Period)');
    lines.push('');
    for (const r of report.pendingModules) {
      lines.push(`- \`${r.module}\` (age ${r.ageDays}d; will be enforced after ${GRACE_PERIOD_DAYS - r.ageDays}d)`);
    }
    lines.push('');
  }

  if (report.exemptModules.length > 0) {
    lines.push('## 📌 Exempt Modules');
    lines.push('');
    lines.push('| Module | Tag | Reason |');
    lines.push('|--------|-----|--------|');
    for (const r of report.exemptModules) {
      lines.push(`| \`${r.module}\` | ${r.exemption.tag} | ${r.exemption.reason || '-'} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('See [ADR-56 Production-First Principle](../workflow/docs/adr-56-production-first-principle.md) for rules.');
  return lines.join('\n');
}

module.exports = { scan, renderMarkdown };

if (require.main === module) {
  const args = process.argv.slice(2);
  let projectRoot = process.cwd();
  let writeReport = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root' && args[i + 1]) { projectRoot = path.resolve(args[++i]); }
    else if (args[i] === '--no-write') { writeReport = false; }
  }
  const report = scan(projectRoot);
  const md = renderMarkdown(report);
  if (writeReport) {
    const outDir = path.join(projectRoot, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'isolation-modules-inventory.md');
    fs.writeFileSync(outPath, md, 'utf8');
    console.error(`[production-readiness-scanner] Report written: ${outPath}`);
  }
  console.log(JSON.stringify(report, null, 2));
}
