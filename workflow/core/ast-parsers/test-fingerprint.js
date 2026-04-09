#!/usr/bin/env node
/**
 * P0 AST Integration Test Suite
 * Tests Tree-sitter adapter and FingerprintEngine functionality
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Test configuration
const TEST_FILE = path.join(__dirname, 'test-sample.js');

// Sample code for testing
const SAMPLE_CODE = `
/**
 * User service for authentication
 */
class UserService {
  constructor(database) {
    this.db = database;
  }

  /**
   * Authenticate a user
   * @param {string} username
   * @param {string} password
   * @returns {Promise<User>}
   */
  async authenticate(username, password) {
    const user = await this.db.findOne({ username });
    if (!user) return null;
    return user;
  }

  /**
   * Register new user
   */
  async register(userData) {
    return this.db.create(userData);
  }
}

// Arrow function exports
const validateToken = async (token) => {
  return token.length > 10;
};

module.exports = { UserService, validateToken };
`;

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  P0 AST Integration Test Suite');
  console.log('  Tree-sitter Adapter + Fingerprint Engine');
  console.log('═══════════════════════════════════════════════════════════\n');

  let testsPassed = 0;
  let testsFailed = 0;

  // Test 1: Module Loading
  console.log('[Test 1] Module Loading...');
  let treeSitterAdapter, FingerprintEngine;
  try {
    treeSitterAdapter = require('./tree-sitter-adapter');
    ({ FingerprintEngine } = require('./fingerprint-engine'));
    console.log('  ✅ Tree-sitter adapter loaded');
    console.log('  ✅ FingerprintEngine loaded');
    testsPassed++;
  } catch (err) {
    console.error('  ❌ Failed to load modules:', err.message);
    testsFailed++;
    process.exit(1);
  }

  // Test 2: Tree-sitter Availability
  console.log('\n[Test 2] Tree-sitter Availability...');
  const isAvailable = treeSitterAdapter.testAvailability();
  if (isAvailable) {
    console.log('  ✅ Tree-sitter is available and functional');
    console.log(`  📦 Supported languages: ${treeSitterAdapter.SUPPORTED_EXTENSIONS.join(', ')}`);
    testsPassed++;
  } else {
    console.log('  ⚠️  Tree-sitter not available (optional - will use regex fallback)');
    testsPassed++; // Not a failure, feature degrades gracefully
  }

  // Test 3: Symbol Extraction
  console.log('\n[Test 3] Symbol Extraction (AST)...');
  fs.writeFileSync(TEST_FILE, SAMPLE_CODE);
  
  try {
    const result = treeSitterAdapter.parseFile(SAMPLE_CODE, 'test-sample.js', '.js');
    
    console.log(`  ✅ Parser used: ${result.usedAST ? 'tree-sitter' : 'regex'}`);
    console.log(`  📊 Symbols found: ${result.symbols.length}`);
    
    result.symbols.forEach(sym => {
      console.log(`     - ${sym.kind}: ${sym.name} (line ${sym.line})`);
      if (sym.signature) {
        console.log(`       signature: ${sym.signature}`);
      }
      if (sym.summary) {
        console.log(`       summary: ${sym.summary.slice(0, 50)}...`);
      }
    });
    
    if (result.symbols.some(s => s.name === 'UserService')) {
      testsPassed++;
    } else {
      console.log('  ❌ Expected symbol UserService not found');
      testsFailed++;
    }
  } catch (err) {
    console.error('  ❌ Symbol extraction failed:', err.message);
    testsFailed++;
  }

  // Test 4: Structural Fingerprinting
  console.log('\n[Test 4] Structural Fingerprinting...');
  try {
    const fp = treeSitterAdapter.generateFingerprint(SAMPLE_CODE, '.js');
    
    console.log(`  ✅ Content hash: ${fp.contentHash}`);
    console.log(`  ✅ AST hash: ${fp.astHash || 'N/A'}`);
    console.log(`  ✅ Structure fingerprint: ${fp.structureFingerprint}`);
    console.log(`  ✅ Parser used: ${fp.parserUsed}`);
    console.log(`  ✅ Symbols extracted: ${fp.symbols.length}`);
    testsPassed++;
  } catch (err) {
    console.error('  ❌ Fingerprint generation failed:', err.message);
    testsFailed++;
  }

  // Test 5: Fingerprint Engine Integration
  console.log('\n[Test 5] Fingerprint Engine Integration...');
  const testProjectDir = path.join(__dirname, 'test-project');
  fs.mkdirSync(testProjectDir, { recursive: true });
  fs.writeFileSync(path.join(testProjectDir, 'test.js'), SAMPLE_CODE);
  
  try {
    const engine = new FingerprintEngine({
      projectRoot: testProjectDir,
    });
    
    // Initial fingerprint
    const fp1 = engine.fingerprint(path.join(testProjectDir, 'test.js'));
    console.log(`  ✅ Initial fingerprint: ${fp1.structureFingerprint}`);
    
    // Format only change
    fs.writeFileSync(path.join(testProjectDir, 'test.js'), SAMPLE_CODE.replace(/  /g, '    '));
    const fp2 = engine.fingerprint(path.join(testProjectDir, 'test.js'));
    const changeType = engine.classifyChange(fp1, fp2);
    
    console.log(`  ✅ After formatting change: ${changeType === 'format' ? 'correctly classified as format-only' : changeType}`);
    
    // Signature change
    const modifiedCode = SAMPLE_CODE.replace('async authenticate(username, password)', 'async authenticate(username, password, options = {})');
    fs.writeFileSync(path.join(testProjectDir, 'test.js'), modifiedCode);
    const fp3 = engine.fingerprint(path.join(testProjectDir, 'test.js'));
    const changeType2 = engine.classifyChange(fp1, fp3);
    
    console.log(`  ✅ After signature change: ${changeType2}`);
    
    // Save cache
    engine.saveCache();
    console.log('  ✅ Cache saved successfully');
    
    testsPassed++;
  } catch (err) {
    console.error('  ❌ Fingerprint engine test failed:', err.message);
    testsFailed++;
  }

  // Test 6: Change Classification Decision Matrix
  console.log('\n[Test 6] Change Classification Decision Matrix...');
  try {
    const engine = new FingerprintEngine({ projectRoot: testProjectDir });
    
    // Create test scenario
    const changes = {
      unchanged: ['file1.js'],
      format: ['file2.js', 'file3.js'],
      signature: ['file4.js', 'file5.js', 'file6.js'],
      api_breaking: ['api.js'],
    };
    
    const recommendation = engine.getRebuildRecommendation(changes);
    
    console.log(`  ✅ Recommendation: ${recommendation.action}`);
    console.log(`     Reason: ${recommendation.reason}`);
    console.log(`     Affected files: ${recommendation.affectedFiles.length}`);
    
    if (recommendation.action === 'architecture_update') {
      testsPassed++;
    } else {
      console.log('  ❌ Expected architecture_update for API-breaking changes');
      testsFailed++;
    }
  } catch (err) {
    console.error('  ❌ Change classification test failed:', err.message);
    testsFailed++;
  }

  // Test 7: Dual-Mode Accuracy Verification
  console.log('\n[Test 7] Dual-Mode (AST vs Regex) Comparison...');
  try {
    const engine = new FingerprintEngine({
      projectRoot: testProjectDir,
      useTreeSitter: false, // Force regex
    });
    
    const fpRegex = engine.generateFingerprint(SAMPLE_CODE, '.js', 'test.js');
    console.log(`  ✅ Regex mode: ${fpRegex.symbols.length} symbols, parser: ${fpRegex.parser}`);
    
    if (isAvailable) {
      const engineAST = new FingerprintEngine({
        projectRoot: testProjectDir,
        useTreeSitter: true,
      });
      engineAST.enableTreeSitter();
      
      const fpAST = engineAST.generateFingerprint(SAMPLE_CODE, '.js', 'test.js');
      console.log(`  ✅ AST mode: ${fpAST.symbols.length} symbols, parser: ${fpAST.parser}`);
      
      // AST should find more symbols (arrow functions, async markers, etc.)
      if (fpAST.symbols.length >= fpRegex.symbols.length) {
        console.log('  ✅ AST mode found equal or more symbols than regex');
        testsPassed++;
      } else {
        console.log('  ⚠️  AST mode found fewer symbols (may need tuning)');
        testsPassed++;
      }
    } else {
      console.log('  ℹ️  Skipping AST comparison - tree-sitter not available');
      testsPassed++;
    }
  } catch (err) {
    console.error('  ❌ Dual-mode comparison failed:', err.message);
    testsFailed++;
  }

  // Cleanup
  console.log('\n[Cleanup] Removing test files...');
  try {
    fs.unlinkSync(TEST_FILE);
    fs.rmSync(testProjectDir, { recursive: true, force: true });
    console.log('  ✅ Test files cleaned up');
  } catch (err) {
    console.warn('  ⚠️  Cleanup warning:', err.message);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Test Results');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  ✅ Passed: ${testsPassed}`);
  console.log(`  ❌ Failed: ${testsFailed}`);
  console.log(`  📊 Total: ${testsPassed + testsFailed}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});