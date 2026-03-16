#!/usr/bin/env node

/**
 * Syntax Check Script – Pre-test validation gate
 *
 * Runs `node --check` on all .js source files to catch SyntaxErrors
 * (broken comments, unclosed brackets, etc.) BEFORE running actual tests.
 *
 * `node --check` only parses the file; it does not execute it.
 * Cost: ~5ms per file. Total: < 500ms for the entire project.
 *
 * Exit codes:
 *   0 – All files parsed successfully
 *   1 – One or more files have syntax errors
 */

'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIRS  = ['core', 'agents', 'commands', 'tools'];

function main() {
  console.log('\n  🔍 Syntax Check: Running node --check on all source files...\n');

  let checked = 0;
  let errors  = 0;

  for (const dir of SOURCE_DIRS) {
    const dirPath = path.join(PROJECT_ROOT, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const result = spawnSync('node', ['--check', filePath], {
        encoding: 'utf-8',
        timeout: 10_000,
      });

      checked++;

      if (result.status !== 0) {
        errors++;
        const errOutput = (result.stderr || result.stdout || 'Unknown error').trim();
        console.error(`  ❌ ${dir}/${file}`);
        // Extract the most relevant error line
        const lines = errOutput.split('\n');
        for (const line of lines.slice(0, 4)) {
          console.error(`     ${line}`);
        }
        console.error('');
      }
    }
  }

  console.log(`  📦 Checked ${checked} file(s), ${errors} error(s)\n`);

  if (errors > 0) {
    console.error(`  ❌ SYNTAX CHECK FAILED: ${errors} file(s) have syntax errors.`);
    console.error(`     Fix these before running tests.\n`);
    process.exit(1);
  }

  console.log('  ✅ All source files are syntactically valid.\n');
}

main();
