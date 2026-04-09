#!/usr/bin/env node
/**
 * IDE Test Runner — Lightweight test/lint/syntax runner for IDE Agent mode
 *
 * In IDE Agent mode, the Node.js orchestrator (with its TestRunner, CodeReviewAgent,
 * QualityGate, etc.) does NOT run. This script provides a single-command entry point
 * that the IDE Agent can invoke via `terminal` to get structured test results.
 *
 * Usage:
 *   node workflow/tools/ide-test-runner.js --project-root .
 *   node workflow/tools/ide-test-runner.js --project-root . --lint-only
 *   node workflow/tools/ide-test-runner.js --project-root . --test-only
 *   node workflow/tools/ide-test-runner.js --project-root . --files "src/a.js,src/b.js"
 *
 * Output: Structured JSON report to stdout (parseable by the IDE Agent).
 *
 * Design principles (ADR-37 IDE-First):
 *   - Zero LLM calls — pure local execution
 *   - Zero external dependencies — uses only Node.js built-ins + project's own tooling
 *   - Non-blocking — all commands have timeouts
 *   - Structured output — JSON report for easy parsing by AI Agent
 *
 * @module workflow/tools/ide-test-runner
 */

'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes per command
const MAX_OUTPUT_CHARS = 8000;      // Truncate long outputs for LLM context

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    projectRoot: '.',
    lintOnly: false,
    testOnly: false,
    syntaxOnly: false,
    entropyOnly: false,
    files: [],        // Specific files to check (comma-separated)
    blockingSeverity: 'high',
    failOnSecrets: true,
    cveTop: 30,
    verbose: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--project-root':
        args.projectRoot = argv[++i] || '.';
        break;
      case '--lint-only':
        args.lintOnly = true;
        break;
      case '--test-only':
        args.testOnly = true;
        break;
      case '--syntax-only':
        args.syntaxOnly = true;
        break;
      case '--entropy-only':
        args.entropyOnly = true;
        break;
      case '--files':
        args.files = (argv[++i] || '').split(',').map(f => f.trim()).filter(Boolean);
        break;
      case '--blocking-severity':
        args.blockingSeverity = String(argv[++i] || 'high').toLowerCase();
        break;
      case '--fail-on-secrets':
        args.failOnSecrets = String(argv[++i] || 'true').toLowerCase() !== 'false';
        break;
      case '--cve-top':
        args.cveTop = parseInt(argv[++i], 10) || 30;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--help':
        console.log(`
IDE Test Runner — Lightweight test/lint/syntax runner for IDE Agent mode

Usage:
  node workflow/tools/ide-test-runner.js [options]

Options:
  --project-root <path>   Project root directory (default: .)
  --lint-only             Run only lint checks
  --test-only             Run only test suite
  --syntax-only           Run only syntax validation
  --entropy-only          Run only entropy checks (file size + dead code density)
  --files <f1,f2,...>     Check specific files only (comma-separated)
  --blocking-severity <critical|high>  Security gate threshold (default: high)
  --fail-on-secrets <true|false>       Fail if secret findings exist (default: true)
  --cve-top <N>                         Dependency packages to scan for CVEs (default: 30)
  --verbose               Show detailed output
  --help                  Show this help message

Output:
  JSON report to stdout with structure:
  {
    "timestamp": "ISO date",
    "projectRoot": "path",
    "lint": { "status": "pass|fail|skip", "errors": N, "output": "..." },
    "tests": { "status": "pass|fail|skip", "passed": N, "failed": N, "output": "..." },
    "syntax": { "status": "pass|fail|skip", "errors": [...] },
    "entropy": { "status": "pass|fail|skip", "violations": [...] },
    "summary": { "overallStatus": "pass|fail", "issues": N }
  }
`);
        process.exit(0);
        break;
    }
  }

  return args;
}

// ─── Command Execution Helper ────────────────────────────────────────────────

function runCommand(cmd, cwd, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const output = execSync(cmd, {
      cwd,
      timeout: timeoutMs,
      stdio: 'pipe',
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return { success: true, exitCode: 0, output: truncate(output) };
  } catch (err) {
    const stdout = err.stdout?.toString() || '';
    const stderr = err.stderr?.toString() || '';
    const combined = (stdout + '\n' + stderr).trim();
    return {
      success: false,
      exitCode: err.status ?? 1,
      output: truncate(combined),
    };
  }
}

function truncate(text, maxLen = MAX_OUTPUT_CHARS) {
  if (!text || text.length <= maxLen) return text || '';
  const half = Math.floor(maxLen / 2);
  return text.slice(0, half) + `\n\n... [${text.length - maxLen} chars truncated] ...\n\n` + text.slice(-half);
}

// ─── Detect Project Tooling ──────────────────────────────────────────────────

function detectTooling(projectRoot) {
  const result = {
    hasPackageJson: false,
    lintCommand: null,
    testCommand: null,
    hasTypeScript: false,
    hasEslint: false,
  };

  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    result.hasPackageJson = true;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg.scripts || {};

      // Detect lint command
      if (scripts.lint) {
        result.lintCommand = 'npm run lint';
      } else if (fs.existsSync(path.join(projectRoot, '.eslintrc.js')) ||
                 fs.existsSync(path.join(projectRoot, '.eslintrc.json')) ||
                 fs.existsSync(path.join(projectRoot, '.eslintrc.yml')) ||
                 fs.existsSync(path.join(projectRoot, 'eslint.config.js')) ||
                 fs.existsSync(path.join(projectRoot, 'eslint.config.mjs'))) {
        result.hasEslint = true;
        result.lintCommand = 'npx eslint . --ext .js,.ts --max-warnings=0';
      }

      // Detect test command
      if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
        result.testCommand = 'npm test';
      }

      // Detect TypeScript
      if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript ||
          fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) {
        result.hasTypeScript = true;
      }
    } catch { /* ignore parse errors */ }
  }

  return result;
}

// ─── Syntax Validation ───────────────────────────────────────────────────────

function validateSyntax(projectRoot, files) {
  const errors = [];

  // If specific files provided, check those; otherwise find recently modified .js files
  let filesToCheck = files;
  if (filesToCheck.length === 0) {
    // Find .js files modified in the last hour (or all .js in src/)
    try {
      const srcDir = path.join(projectRoot, 'src');
      const workflowDir = path.join(projectRoot, 'workflow');
      const dirs = [srcDir, workflowDir].filter(d => fs.existsSync(d));

      for (const dir of dirs) {
        const result = runCommand(
          `node -e "const fg=require('fs');const p=require('path');function walk(d,r){try{fg.readdirSync(d).forEach(f=>{const fp=p.join(d,f);const s=fg.statSync(fp);if(s.isDirectory()&&!f.startsWith('.')&&f!=='node_modules'&&f!=='dist'&&f!=='build')walk(fp,r);else if(f.endsWith('.js')&&Date.now()-s.mtimeMs<3600000)r.push(fp)})}catch{}return r}console.log(JSON.stringify(walk('${dir.replace(/\\/g, '\\\\\\\\')}',[])));"`,
          projectRoot,
          10_000
        );
        if (result.success && result.output) {
          try {
            const found = JSON.parse(result.output.trim());
            filesToCheck.push(...found);
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // Limit to 20 files max
  filesToCheck = filesToCheck.slice(0, 20);

  for (const file of filesToCheck) {
    const absPath = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    if (!fs.existsSync(absPath)) continue;
    if (!absPath.endsWith('.js') && !absPath.endsWith('.mjs') && !absPath.endsWith('.cjs')) continue;

    const result = runCommand(`node -c "${absPath}"`, projectRoot, 10_000);
    if (!result.success) {
      errors.push({
        file: path.relative(projectRoot, absPath),
        error: result.output.slice(0, 500),
      });
    }
  }

  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    filesChecked: filesToCheck.length,
    errors,
  };
}

// ─── Main Runner ─────────────────────────────────────────────────────────────

function run(args) {
  const projectRoot = path.resolve(args.projectRoot);
  const report = {
    timestamp: new Date().toISOString(),
    projectRoot,
    tooling: null,
    lint: { status: 'skip', errors: 0, warnings: 0, output: '' },
    tests: { status: 'skip', passed: 0, failed: 0, skipped: 0, output: '' },
    syntax: { status: 'skip', filesChecked: 0, errors: [] },
    security: {
      status: 'skip',
      blockingSeverity: String(args.blockingSeverity || 'high').toLowerCase(),
      failOnSecrets: args.failOnSecrets !== false,
      cve: null,
      secrets: null,
      blockingReasons: [],
    },
    summary: { overallStatus: 'pass', issues: 0, details: [] },
  };

  // Detect tooling
  const tooling = detectTooling(projectRoot);
  report.tooling = tooling;

  // ── Lint ────────────────────────────────────────────────────────────────
  if (!args.testOnly && !args.syntaxOnly && !args.entropyOnly) {
    if (tooling.lintCommand) {
      console.error(`[ide-test-runner] Running lint: ${tooling.lintCommand}`);
      const lintResult = runCommand(tooling.lintCommand, projectRoot);
      report.lint = {
        status: lintResult.success ? 'pass' : 'fail',
        command: tooling.lintCommand,
        exitCode: lintResult.exitCode,
        output: lintResult.output,
        errors: lintResult.success ? 0 : countPatterns(lintResult.output, /error/gi),
        warnings: countPatterns(lintResult.output, /warning/gi),
      };
      if (!lintResult.success) {
        report.summary.issues += report.lint.errors || 1;
        report.summary.details.push(`Lint: ${report.lint.errors} error(s)`);
      }
    } else {
      report.lint.status = 'no-config';
      report.lint.output = 'No lint configuration detected (no eslint config, no "lint" script in package.json)';
    }
  }

  // ── Tests ──────────────────────────────────────────────────────────────
  if (!args.lintOnly && !args.syntaxOnly && !args.entropyOnly) {
    if (tooling.testCommand) {
      console.error(`[ide-test-runner] Running tests: ${tooling.testCommand}`);
      const testResult = runCommand(tooling.testCommand, projectRoot);
      const passCount = countPatterns(testResult.output, /\bpass(ed|ing)?\b/gi);
      const failCount = countPatterns(testResult.output, /\bfail(ed|ing|ure)?\b/gi);
      report.tests = {
        status: testResult.success ? 'pass' : 'fail',
        command: tooling.testCommand,
        exitCode: testResult.exitCode,
        output: testResult.output,
        passed: passCount,
        failed: failCount,
        skipped: 0,
      };
      if (!testResult.success) {
        report.summary.issues += failCount || 1;
        report.summary.details.push(`Tests: ${failCount} failure(s)`);
      }
    } else {
      report.tests.status = 'no-config';
      report.tests.output = 'No test command detected (no "test" script in package.json, or default "echo Error" script)';
    }
  }

  // ── Syntax Validation ──────────────────────────────────────────────────
  if (!args.lintOnly && !args.testOnly && !args.entropyOnly) {
    console.error(`[ide-test-runner] Running syntax validation...`);
    report.syntax = validateSyntax(projectRoot, args.files);
    if (report.syntax.errors.length > 0) {
      report.summary.issues += report.syntax.errors.length;
      report.summary.details.push(`Syntax: ${report.syntax.errors.length} file(s) with errors`);
    }
  }

  // ── TypeScript Check ───────────────────────────────────────────────────
  if (tooling.hasTypeScript && !args.lintOnly && !args.testOnly && !args.syntaxOnly && !args.entropyOnly) {
    console.error(`[ide-test-runner] Running TypeScript check: npx tsc --noEmit`);
    const tsResult = runCommand('npx tsc --noEmit', projectRoot);
    report.typescript = {
      status: tsResult.success ? 'pass' : 'fail',
      exitCode: tsResult.exitCode,
      output: tsResult.output,
      errors: tsResult.success ? 0 : countPatterns(tsResult.output, /error TS\d+/g),
    };
    if (!tsResult.success) {
      report.summary.issues += report.typescript.errors || 1;
      report.summary.details.push(`TypeScript: ${report.typescript.errors} error(s)`);
    }
  }

  // ── Entropy Check (file size + dead code density) ─────────────────────
  if (args.entropyOnly || (!args.lintOnly && !args.testOnly && !args.syntaxOnly)) {
    console.error(`[ide-test-runner] Running entropy checks...`);
    report.entropy = runEntropyChecks(projectRoot);
    if (report.entropy.violations.length > 0) {
      const highCount = report.entropy.violations.filter(v => v.severity === 'high').length;
      report.summary.issues += highCount; // Only count high-severity as blocking
      if (highCount > 0) {
        report.summary.details.push(`Entropy: ${highCount} high-severity violation(s)`);
      }
    }
  }

  // ── Security Audit (dependency CVE + secret scanning) ──────────────────
  if (!args.syntaxOnly && !args.entropyOnly) {
    console.error(`[ide-test-runner] Running security audit...`);
    report.security = runSecurityAudit(projectRoot, {
      blockingSeverity: String(args.blockingSeverity || 'high').toLowerCase(),
      failOnSecrets: args.failOnSecrets !== false,
      cveTop: args.cveTop || 30,
    });

    if (report.security.status === 'fail') {
      report.summary.issues += Math.max(report.security.blockingReasons.length, 1);
      report.summary.details.push(`Security: ${report.security.blockingReasons.join(' | ')}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  report.summary.overallStatus = report.summary.issues === 0 ? 'PASS' : 'FAIL';

  return report;
}

function countPatterns(text, pattern) {
  if (!text) return 0;
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function severityRank(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical') return 4;
  if (s === 'high') return 3;
  if (s === 'medium') return 2;
  if (s === 'low') return 1;
  return 0;
}

function runSecretScan(projectRoot, maxFiles = 200) {
  const findings = [];
  const sourceExts = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.java', '.cs', '.rb', '.php', '.env', '.yaml', '.yml', '.json']);
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', 'output', '.idea', '.vscode', 'coverage']);

  const patterns = [
    { name: 'aws-access-key-id', severity: 'critical', regex: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: 'aws-secret-access-key', severity: 'critical', regex: /(?:AWS|aws)?[_-]?SECRET[_-]?ACCESS[_-]?KEY\s*[:=]\s*['"][A-Za-z0-9\/+=]{30,}['"]/g },
    { name: 'github-token', severity: 'critical', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
    { name: 'private-key-block', severity: 'critical', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
    { name: 'hardcoded-password', severity: 'high', regex: /\b(password|passwd|pwd)\b\s*[:=]\s*['"][^'"\n]{6,}['"]/gi },
    { name: 'hardcoded-api-key', severity: 'high', regex: /\b(api[_-]?key|access[_-]?token|secret[_-]?key)\b\s*[:=]\s*['"][A-Za-z0-9_\-\/.+=]{12,}['"]/gi },
    { name: 'slack-token', severity: 'high', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  ];

  function walk(dir, acc) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
    for (const e of entries) {
      if (acc.length >= maxFiles) break;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!ignoreDirs.has(e.name)) walk(full, acc);
      } else if (sourceExts.has(path.extname(e.name).toLowerCase())) {
        acc.push(full);
      }
    }
    return acc;
  }

  const files = walk(projectRoot, []);
  for (const absPath of files) {
    let content = '';
    try { content = fs.readFileSync(absPath, 'utf-8'); } catch { continue; }

    for (const p of patterns) {
      p.regex.lastIndex = 0;
      let m;
      while ((m = p.regex.exec(content)) !== null) {
        findings.push({
          type: p.name,
          severity: p.severity,
          file: path.relative(projectRoot, absPath).replace(/\\/g, '/'),
          snippet: String(m[0] || '').slice(0, 120),
        });
        if (findings.length >= 100) break;
      }
      if (findings.length >= 100) break;
    }
    if (findings.length >= 100) break;
  }

  return { filesScanned: files.length, findings };
}

function runSecurityAudit(projectRoot, policy = {}) {
  const blockingSeverity = ['critical', 'high'].includes(String(policy.blockingSeverity || 'high').toLowerCase())
    ? String(policy.blockingSeverity || 'high').toLowerCase()
    : 'high';
  const failOnSecrets = policy.failOnSecrets !== false;
  const cveTop = Number.isFinite(policy.cveTop) ? policy.cveTop : 30;
  const blockingRank = severityRank(blockingSeverity);

  const result = {
    status: 'pass',
    blockingSeverity,
    failOnSecrets,
    cve: null,
    secrets: null,
    blockingReasons: [],
  };

  try {
    const scannerPath = path.join(projectRoot, 'workflow', 'tools', 'ide-cve-scanner.js');
    if (fs.existsSync(scannerPath)) {
      const raw = execFileSync('node', [scannerPath, '--project-root', projectRoot, '--top', String(cveTop)], {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(raw || '{}');
      result.cve = parsed;
      const vulns = Array.isArray(parsed.vulnerabilities) ? parsed.vulnerabilities : [];
      const blockingCve = vulns.filter(v => severityRank(v.severity) >= blockingRank);
      if (blockingCve.length > 0) {
        result.status = 'fail';
        result.blockingReasons.push(`CVE findings >= ${blockingSeverity}: ${blockingCve.length}`);
      }
    } else {
      result.status = 'fail';
      result.blockingReasons.push('CVE scanner missing');
    }
  } catch (err) {
    result.status = 'fail';
    result.blockingReasons.push(`CVE scan failed: ${err.message}`);
  }

  try {
    result.secrets = runSecretScan(projectRoot, 200);
    if (failOnSecrets && result.secrets.findings.length > 0) {
      const blockingSecrets = result.secrets.findings.filter(f => severityRank(f.severity) >= blockingRank).length;
      result.status = 'fail';
      if (blockingSecrets > 0) {
        result.blockingReasons.push(`Secret findings >= ${blockingSeverity}: ${blockingSecrets}`);
      } else {
        result.blockingReasons.push(`Secret findings detected: ${result.secrets.findings.length}`);
      }
    }
  } catch (err) {
    result.status = 'fail';
    result.blockingReasons.push(`Secret scan failed: ${err.message}`);
  }

  return result;
}

// ─── Entropy Checks (file size + dead code density) ─────────────────────────

const ENTROPY_MAX_LINES = 600;
const ENTROPY_DEAD_CODE_RATIO = 0.05; // >5% TODO/FIXME/HACK lines → flag
const ENTROPY_EXTENSIONS = new Set(['.js', '.ts', '.dart', '.go', '.py', '.cs', '.lua']);
const ENTROPY_IGNORE_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'output', '.dart_tool', 'Library', 'Temp']);

/**
 * Run lightweight entropy checks: file size violations + dead code density.
 * Extracted from core/entropy-gc.js for IDE Agent mode (zero dependencies).
 */
function runEntropyChecks(projectRoot) {
  const violations = [];
  const sourceFiles = collectSourceFiles(projectRoot, projectRoot);

  // Check 1: File size violations
  for (const filePath of sourceFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').length;
      if (lines > ENTROPY_MAX_LINES) {
        violations.push({
          type: 'FILE_TOO_LARGE',
          severity: lines > ENTROPY_MAX_LINES * 1.5 ? 'high' : 'medium',
          file: path.relative(projectRoot, filePath),
          detail: `${lines} lines (limit: ${ENTROPY_MAX_LINES})`,
          suggestion: 'Split into smaller modules. Consider extracting helpers or sub-components.',
        });
      }
    } catch { /* ignore */ }
  }

  // Check 2: Dead code density (TODO/FIXME/HACK)
  for (const filePath of sourceFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const deadLines = lines.filter(l => /\b(TODO|FIXME|HACK|XXX)\b/i.test(l)).length;
      const ratio = lines.length > 0 ? deadLines / lines.length : 0;

      if (ratio > ENTROPY_DEAD_CODE_RATIO && deadLines >= 3) {
        violations.push({
          type: 'DEAD_CODE_DENSITY',
          severity: 'low',
          file: path.relative(projectRoot, filePath),
          detail: `${deadLines} TODO/FIXME/HACK comments (${(ratio * 100).toFixed(1)}% of file)`,
          suggestion: 'Schedule a cleanup pass to resolve or remove stale comments.',
        });
      }
    } catch { /* ignore */ }
  }

  return {
    status: violations.filter(v => v.severity === 'high').length > 0 ? 'fail' : 'pass',
    filesScanned: sourceFiles.length,
    violations,
  };
}

/**
 * Recursively collect source files for entropy scanning.
 */
function collectSourceFiles(dir, rootDir) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!ENTROPY_IGNORE_DIRS.has(e.name)) results.push(...collectSourceFiles(fullPath, rootDir));
    } else if (ENTROPY_EXTENSIONS.has(path.extname(e.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = parseArgs(process.argv);
  const report = run(args);

  // Output JSON report to stdout
  console.log(JSON.stringify(report, null, 2));

  // Exit with appropriate code
  process.exit(report.summary.overallStatus === 'PASS' ? 0 : 1);
}

module.exports = { run, parseArgs, detectTooling, validateSyntax, runEntropyChecks };
