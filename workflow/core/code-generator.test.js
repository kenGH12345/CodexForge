/**
 * Code Generator Tests – Phase 3
 *
 * Tests for AST-based code transformation, template generation,
 * and safe refactoring capabilities.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  CodeGenerator,
  RefactoringEngine,
  PROVIDER_PATTERN_TEMPLATES,
  TRANSFORMATION_SPECS,
} = require('./code-generator');

// ─── Test Utilities ─────────────────────────────────────────────────────────

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-gen-test-'));
}

function cleanupDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Template Tests ─────────────────────────────────────────────────────────

console.log('\n=== Template Tests ===\n');

// Test 1: Registry template generation
(function testRegistryTemplate() {
  const generator = new CodeGenerator({ dryRun: true });

  const result = generator.generateFromTemplate(
    'registry',
    { adrId: '001', domain: 'ide' },
    '/test/provider-registry.js'
  );

  assert.strictEqual(result.success, true);
  assert.ok(result.content, 'Should have generated content');
  assert.ok(result.content.includes('ProviderRegistry'), 'Should contain class name');
  assert.ok(result.content.includes('register'), 'Should have register method');
  assert.ok(result.content.includes('get'), 'Should have get method');
  assert.ok(result.content.includes('ADR-001'), 'Should reference ADR ID');

  console.log('✅ Test 1 passed: Registry template generation');
})();

// Test 2: IDE Provider template generation
(function testIDEProviderTemplate() {
  const generator = new CodeGenerator({ dryRun: true });

  const result = generator.generateFromTemplate(
    'ideProvider',
    { adrId: '002' },
    '/test/ide-provider.js'
  );

  assert.strictEqual(result.success, true);
  assert.ok(result.content.includes('ideProvider'), 'Should have ideProvider export');
  assert.ok(result.content.includes('detectCurrentIDE'), 'Should have detection function');
  assert.ok(result.content.includes('vscode'), 'Should include default IDEs');
  assert.ok(result.content.includes('cursor'), 'Should include Cursor IDE');

  console.log('✅ Test 2 passed: IDE Provider template generation');
})();

// Test 3: Config template generation
(function testConfigTemplate() {
  const generator = new CodeGenerator({ dryRun: true });

  const result = generator.generateFromTemplate(
    'config',
    {},
    '/test/config/ides.json'
  );

  assert.strictEqual(result.success, true);
  const config = JSON.parse(result.content);
  assert.ok(config.vscode, 'Should have vscode config');
  assert.ok(config.cursor, 'Should have cursor config');
  assert.ok(Array.isArray(config.vscode.envVars), 'envVars should be array');

  console.log('✅ Test 3 passed: Config template generation');
})();

// ─── Transformation Spec Tests ──────────────────────────────────────────────

console.log('\n=== Transformation Spec Tests ===\n');

// Test 4: Pattern detection
(function testPatternDetection() {
  const testCode = `
const IDE_SIGNATURES = {
  vscode: { name: 'VS Code', envVars: ['VSCODE'] },
  cursor: { name: 'Cursor', envVars: ['CURSOR'] },
};
`;

  const detected = TRANSFORMATION_SPECS.EXTRACT_IDE_SIGNATURES.detect(testCode);
  assert.strictEqual(detected, true, 'Should detect IDE_SIGNATURES pattern');

  const notDetected = TRANSFORMATION_SPECS.EXTRACT_IDE_SIGNATURES.detect('const x = 1;');
  assert.strictEqual(notDetected, false, 'Should not detect non-pattern code');

  console.log('✅ Test 4 passed: Pattern detection');
})();

// Test 5: Transformation preview
(function testTransformationPreview() {
  const testCode = `const IDE_SIGNATURES = {
  vscode: {
    name: 'VS Code',
    envVars: ['VSCODE']
  },
  cursor: {
    name: 'Cursor',
    envVars: ['CURSOR']
  },
};`;

  const preview = TRANSFORMATION_SPECS.EXTRACT_IDE_SIGNATURES.preview(testCode, {});

  assert.ok(preview, 'Should return preview');
  assert.ok(preview.changes.length > 0, 'Should list changes');
  assert.ok(preview.newFiles.length > 0, 'Should list new files');
  assert.ok(preview.changes[0].entriesFound >= 2, 'Should detect entries');

  console.log('✅ Test 5 passed: Transformation preview');
  console.log(`   Changes: ${preview.changes.length}, New files: ${preview.newFiles.length}`);
  console.log(`   Entries found: ${preview.changes[0].entriesFound}`);
})();

// Test 6: Code transformation
(function testCodeTransformation() {
  const testCode = `
const IDE_SIGNATURES = {
  vscode: { name: 'VS Code' },
  cursor: { name: 'Cursor' },
};

function getIDE(key) {
  return IDE_SIGNATURES[key];
}
`;

  const result = TRANSFORMATION_SPECS.EXTRACT_IDE_SIGNATURES.transform(testCode, {});

  assert.strictEqual(result.success, true, 'Transformation should succeed');
  assert.ok(result.transformed.includes('ideProvider'), 'Should use ideProvider');
  assert.ok(result.transformed.includes("require('./ide-provider')"), 'Should add import');
  assert.ok(!result.transformed.includes('IDE_SIGNATURES'), 'Should remove old object');

  console.log('✅ Test 6 passed: Code transformation');
})();

// ─── CodeGenerator Tests ────────────────────────────────────────────────────

console.log('\n=== CodeGenerator Tests ===\n');

// Test 7: Generate complete provider pattern
(function testGenerateProviderPattern() {
  const tempDir = createTempDir();
  const generator = new CodeGenerator({ outputDir: tempDir });

  const results = generator.generateProviderPattern({ adrId: '005' });

  assert.strictEqual(results.length, 3, 'Should generate 3 files');
  assert.ok(results.every(r => r.success), 'All generations should succeed');

  // Check files were created
  assert.ok(fs.existsSync(results[0].filePath), 'Registry file should exist');
  assert.ok(fs.existsSync(results[1].filePath), 'IDE Provider file should exist');

  console.log('✅ Test 7 passed: Generate complete provider pattern');
  results.forEach(r => console.log(`   ${path.basename(r.filePath)}`));

  cleanupDir(tempDir);
})();

// Test 8: Transform file with backup
(function testTransformWithBackup() {
  const tempDir = createTempDir();
  const testFile = path.join(tempDir, 'test.js');

  fs.writeFileSync(testFile, `
const IDE_SIGNATURES = {
  vscode: { name: 'VS Code' },
};

module.exports = { IDE_SIGNATURES };
`, 'utf-8');

  const generator = new CodeGenerator({
    outputDir: tempDir,
    backupDir: path.join(tempDir, '.backups'),
  });

  const result = generator.transform(testFile, 'EXTRACT_IDE_SIGNATURES');

  assert.strictEqual(result.success, true);
  assert.ok(result.backupPath, 'Should create backup');
  assert.ok(fs.existsSync(result.backupPath), 'Backup file should exist');
  assert.ok(result.transformed.includes('ideProvider'), 'Should be transformed');

  // Verify backup contains original
  const backupContent = fs.readFileSync(result.backupPath, 'utf-8');
  assert.ok(backupContent.includes('IDE_SIGNATURES'), 'Backup should have original');

  console.log('✅ Test 8 passed: Transform file with backup');
  console.log(`   Backup: ${result.backupPath}`);

  cleanupDir(tempDir);
})();

// Test 9: Rollback functionality
(function testRollback() {
  const tempDir = createTempDir();
  const testFile = path.join(tempDir, 'test.js');
  const originalContent = `const IDE_SIGNATURES = {
  vscode: { name: 'VS Code' },
  cursor: { name: 'Cursor' },
};

module.exports = { IDE_SIGNATURES };`;

  fs.writeFileSync(testFile, originalContent, 'utf-8');

  const generator = new CodeGenerator({
    backupDir: path.join(tempDir, '.backups'),
  });

  // Transform
  const transformResult = generator.transform(testFile, 'EXTRACT_IDE_SIGNATURES');
  assert.ok(transformResult.success, `Transform failed: ${transformResult.errors.join(', ')}`);

  // Verify transformed - check that const declaration was replaced
  const transformedContent = fs.readFileSync(testFile, 'utf-8');
  // The original "const IDE_SIGNATURES = {" should be replaced with import
  assert.ok(!transformedContent.includes('const IDE_SIGNATURES = {'), 'Should remove IDE_SIGNATURES object');
  assert.ok(transformedContent.includes('ideProvider'), 'Should add ideProvider usage');

  // Rollback
  const rollbackResult = generator.rollback(testFile);
  assert.strictEqual(rollbackResult.success, true);

  // Verify restored - check content matches original pattern
  const restoredContent = fs.readFileSync(testFile, 'utf-8');
  // Check key elements are restored
  assert.ok(restoredContent.includes('IDE_SIGNATURES'), 'Should restore IDE_SIGNATURES');
  assert.ok(restoredContent.includes("name: 'VS Code'"), 'Should restore VS Code entry');
  assert.ok(restoredContent.includes("name: 'Cursor'"), 'Should restore Cursor entry');

  console.log('✅ Test 9 passed: Rollback functionality');

  cleanupDir(tempDir);
})();

// Test 10: Dry run mode
(function testDryRunMode() {
  const tempDir = createTempDir();
  const testFile = path.join(tempDir, 'test.js');

  fs.writeFileSync(testFile, `const x = 1;`, 'utf-8');

  const generator = new CodeGenerator({ dryRun: true });

  const result = generator.transform(testFile, 'ADD_PROVIDER_IMPORT');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.dryRun, true);

  // File should NOT be modified
  const content = fs.readFileSync(testFile, 'utf-8');
  assert.strictEqual(content, 'const x = 1;');

  console.log('✅ Test 10 passed: Dry run mode preserves files');

  cleanupDir(tempDir);
})();

// ─── RefactoringEngine Tests ────────────────────────────────────────────────

console.log('\n=== RefactoringEngine Tests ===\n');

// Test 11: Preview from ADR
(function testPreviewFromADR() {
  const engine = new RefactoringEngine();

  const mockADR = {
    id: 'ADR-010',
    metadata: {
      patternId: 'HARDCODED_CONFIG_ENTRY',
      patternName: 'Hardcoded Configuration Entry',
    },
  };

  const preview = engine.preview(mockADR);

  assert.ok(preview, 'Should return preview');
  assert.strictEqual(preview.adrId, 'ADR-010');
  assert.ok(preview.files.length > 0, 'Should list files to be created');
  assert.ok(preview.files.every(f => f.content), 'Files should have content preview');

  console.log('✅ Test 11 passed: Preview from ADR');
  console.log(`   Files to create: ${preview.files.length}`);
})();

// Test 12: Execute refactoring from ADR
(function testExecuteFromADR() {
  const tempDir = createTempDir();
  const engine = new RefactoringEngine({
    generator: { outputDir: tempDir },
  });

  const mockADR = {
    id: 'ADR-011',
    metadata: {
      patternId: 'HARDCODED_CONFIG_ENTRY',
      patternName: 'Hardcoded Configuration Entry',
    },
  };

  const result = engine.executeFromADR(mockADR);

  assert.ok(result, 'Should return result');
  assert.ok(result.operations.length > 0, 'Should have operations');
  assert.ok(result.timestamp, 'Should have timestamp');
  assert.ok(result.success, `Should succeed (errors: ${result.errors.join(', ')})`);

  console.log('✅ Test 12 passed: Execute refactoring from ADR');

  cleanupDir(tempDir);
})();

// Test 13: Audit log
(function testAuditLog() {
  const engine = new RefactoringEngine();

  const initialLog = engine.getAuditLog();
  assert.strictEqual(initialLog.length, 0, 'Log should be empty initially');

  const mockADR = {
    id: 'ADR-012',
    metadata: { patternId: 'HARDCODED_CONFIG_ENTRY' },
  };

  engine.preview(mockADR);
  engine.executeFromADR(mockADR);

  const log = engine.getAuditLog();
  assert.ok(log.length >= 1, 'Log should have entries');
  assert.ok(log[0].timestamp, 'Entries should have timestamps');
  assert.ok(log[0].action, 'Entries should have actions');

  console.log('✅ Test 13 passed: Audit log functionality');
})();

// ─── Validation Tests ───────────────────────────────────────────────────────

console.log('\n=== Validation Tests ===\n');

// Test 14: Validate transformation
(function testValidateTransformation() {
  const generator = new CodeGenerator();

  const original = `
function add(a, b) {
  return a + b;
}
module.exports = { add };
`;

  const transformed = `
function add(a, b) {
  const result = a + b;
  return result;
}
module.exports = { add };
`;

  const result = generator.validateTransformation(original, transformed);

  assert.ok(result.checks.some(c => c.name === 'syntax' && c.passed), 'Syntax check should pass');
  assert.ok(result.checks.some(c => c.name === 'exports'), 'Export check should run');

  console.log('✅ Test 14 passed: Validate transformation');
})();

// ─── Constants Tests ────────────────────────────────────────────────────────

console.log('\n=== Constants Tests ===\n');

// Test 15: Template structure validation
(function testTemplateStructure() {
  assert.ok(PROVIDER_PATTERN_TEMPLATES.registry, 'Should have registry template');
  assert.ok(PROVIDER_PATTERN_TEMPLATES.ideProvider, 'Should have ideProvider template');
  assert.ok(PROVIDER_PATTERN_TEMPLATES.config, 'Should have config template');

  assert.strictEqual(typeof PROVIDER_PATTERN_TEMPLATES.registry, 'function');
  assert.strictEqual(typeof PROVIDER_PATTERN_TEMPLATES.ideProvider, 'function');
  assert.strictEqual(typeof PROVIDER_PATTERN_TEMPLATES.config, 'function');

  console.log('✅ Test 15 passed: Template structure validation');
})();

// Test 16: Transformation spec structure
(function testTransformationSpecStructure() {
  assert.ok(TRANSFORMATION_SPECS.EXTRACT_IDE_SIGNATURES, 'Should have IDE extraction spec');
  assert.ok(TRANSFORMATION_SPECS.ADD_PROVIDER_IMPORT, 'Should have import spec');

  const spec = TRANSFORMATION_SPECS.EXTRACT_IDE_SIGNATURES;
  assert.ok(spec.id, 'Spec should have ID');
  assert.ok(spec.name, 'Spec should have name');
  assert.ok(spec.description, 'Spec should have description');
  assert.strictEqual(typeof spec.detect, 'function', 'Should have detect function');
  assert.strictEqual(typeof spec.preview, 'function', 'Should have preview function');
  assert.strictEqual(typeof spec.transform, 'function', 'Should have transform function');

  console.log('✅ Test 16 passed: Transformation spec structure');
})();

// ─── Summary ────────────────────────────────────────────────────────────────

console.log('\n=== All Tests Passed ===\n');
console.log('✅ Template Tests: 3/3 passed');
console.log('✅ Transformation Spec Tests: 3/3 passed');
console.log('✅ CodeGenerator Tests: 4/4 passed');
console.log('✅ RefactoringEngine Tests: 3/3 passed');
console.log('✅ Validation Tests: 1/1 passed');
console.log('✅ Constants Tests: 2/2 passed');
console.log('✅ Total: 16/16 tests passed\n');
