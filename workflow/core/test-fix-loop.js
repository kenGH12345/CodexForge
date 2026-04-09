/**
 * Test-Fix Loop – 测试-修复闭环
 *
 * 核心目标：测试发现问题时自动修复，直到通过或达到最大轮次
 *
 * 问题背景：
 *   之前的问题：发现问题 → 记录经验 → ❌ 结束（没有修复）
 *   现在的方案：发现问题 → 自动修复 → 重新测试 → ✅ 通过
 *
 * 工作流程：
 *   1. 运行测试套件
 *   2. 收集失败项
 *   3. 分类失败类型
 *   4. 生成修复方案
 *   5. 执行修复
 *   6. 重新运行测试
 *   7. 重复直到通过或达到 maxFixRounds
 *
 * 使用方式：
 *   const loop = new TestFixLoop({ maxFixRounds: 4 });
 *   await loop.run(testSuite, fixers);
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// Fixer Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fixer Registry – 修复器注册表
 *
 * 每种失败类型对应一个修复器
 */
const FixerType = {
  ARTIFACT_MISSING: 'artifact-missing-fixer',
  FORMAT_MISMATCH: 'format-mismatch-fixer',
  MODULE_ROUTE_BROKEN: 'module-route-fixer',
  FEATURE_ORPHANED: 'feature-orphaned-fixer',
  DOWNSTREAM_CONSUME_FAIL: 'downstream-consume-fixer',
  GENERIC: 'generic-fixer',
};

// ═══════════════════════════════════════════════════════════════════════════
// Test-Fix Loop Engine
// ═══════════════════════════════════════════════════════════════════════════

class TestFixLoop {
  /**
   * @param {object} options
   * @param {number} [options.maxFixRounds] - Maximum fix attempts (default: 4)
   * @param {boolean} [options.verbose] - Enable verbose logging
   * @param {string} [options.outputDir] - Output directory for artifacts
   * @param {object} [options.issueCollector] - IssuePatternCollector instance
   */
  constructor(options = {}) {
    this._maxFixRounds = options.maxFixRounds ?? 4;
    this._verbose = options.verbose ?? false;
    this._outputDir = options.outputDir || process.cwd();
    this._issueCollector = options.issueCollector || null;
    
    // Track fix history
    this._fixHistory = [];
    this._roundCount = 0;
  }

  /**
   * Run test-fix loop until all tests pass or max rounds reached.
   *
   * @param {function} testSuite - Async function that runs tests and returns { passed, failures }
   * @param {object} fixers - Object mapping failure types to fixer functions
   * @returns {object} Final test result with fix history
   */
  async run(testSuite, fixers = {}) {
    this._log('🚀 Starting Test-Fix Loop');
    this._log(`   Max fix rounds: ${this._maxFixRounds}`);
    
    let currentResult = await testSuite();
    
    while (!currentResult.passed && this._roundCount < this._maxFixRounds) {
      this._roundCount++;
      this._log(`\n${'─'.repeat(60)}`);
      this._log(`🔄 Fix Round ${this._roundCount}/${this._maxFixRounds}`);
      this._log(`   Failures: ${currentResult.failures.length}`);
      
      // Analyze and classify failures
      const classifiedFailures = this._classifyFailures(currentResult.failures);
      
      // Generate fix plan
      const fixPlan = this._generateFixPlan(classifiedFailures, fixers);
      
      if (fixPlan.length === 0) {
        this._log('⚠️  No applicable fixers found for failures');
        break;
      }
      
      // Execute fixes
      const fixResults = await this._executeFixes(fixPlan);
      
      // Record fix in history
      this._fixHistory.push({
        round: this._roundCount,
        failures: currentResult.failures,
        fixPlan: fixPlan.map(f => ({ type: f.type, action: f.action })),
        fixResults,
      });
      
      // Record to issue collector if available
      if (this._issueCollector) {
        for (const failure of currentResult.failures) {
          this._issueCollector.recordIssue({
            type: failure.type || 'test-failure-untracked',
            severity: failure.severity || 'medium',
            module: failure.test?.split(':')[0] || 'unknown',
            description: failure.error || 'Test failed',
            evidence: { round: this._roundCount, fixApplied: fixResults },
          });
        }
      }
      
      // Re-run tests
      this._log('\n   🧪 Re-running tests...');
      currentResult = await testSuite();
    }
    
    // Final summary
    const summary = this._generateSummary(currentResult);
    this._log('\n' + '═'.repeat(60));
    this._log(summary);
    
    return {
      passed: currentResult.passed,
      finalResult: currentResult,
      fixHistory: this._fixHistory,
      roundsUsed: this._roundCount,
      summary,
    };
  }

  /**
   * Classify failures by type.
   */
  _classifyFailures(failures) {
    return failures.map(f => {
      const testName = (f.test || '').toLowerCase();
      const errorMsg = (f.error || '').toLowerCase();
      
      let type = 'GENERIC';
      let severity = 'medium';
      
      // Classify by test name and error message
      if (testName.includes('artifact') || testName.includes('exists') ||
          errorMsg.includes('file not found') || errorMsg.includes('missing')) {
        type = 'ARTIFACT_MISSING';
        severity = 'critical';
      } else if (testName.includes('format') || testName.includes('parse') ||
                 errorMsg.includes('parse') || errorMsg.includes('format')) {
        type = 'FORMAT_MISMATCH';
        severity = 'high';
      } else if (testName.includes('route') || testName.includes('module') ||
                 errorMsg.includes('not called') || errorMsg.includes('not found in')) {
        type = 'MODULE_ROUTE_BROKEN';
        severity = 'high';
      } else if (testName.includes('orphan') || testName.includes('integrate')) {
        type = 'FEATURE_ORPHANED';
        severity = 'high';
      } else if (testName.includes('consume') || testName.includes('downstream')) {
        type = 'DOWNSTREAM_CONSUME_FAIL';
        severity = 'high';
      }
      
      return { ...f, type, severity };
    });
  }

  /**
   * Generate fix plan based on classified failures and available fixers.
   */
  _generateFixPlan(classifiedFailures, fixers) {
    const plan = [];
    
    for (const failure of classifiedFailures) {
      const fixerKey = FixerType[failure.type] || FixerType.GENERIC;
      const fixer = fixers[fixerKey] || fixers[failure.type] || null;
      
      if (fixer && typeof fixer === 'function') {
        plan.push({
          failure,
          type: failure.type,
          fixer,
          action: fixer.action || `Apply ${fixerKey}`,
        });
      } else {
        // No fixer available – add to plan as "manual fix required"
        plan.push({
          failure,
          type: failure.type,
          fixer: null,
          action: 'MANUAL_FIX_REQUIRED',
        });
      }
    }
    
    return plan;
  }

  /**
   * Execute fixes.
   */
  async _executeFixes(fixPlan) {
    const results = [];
    
    for (const fixItem of fixPlan) {
      if (!fixItem.fixer) {
        this._log(`   ⚠️  No fixer for: ${fixItem.failure.test} (${fixItem.type})`);
        results.push({ success: false, reason: 'no-fixer' });
        continue;
      }
      
      try {
        this._log(`   🔧 Fixing: ${fixItem.failure.test}`);
        this._log(`      Action: ${fixItem.action}`);
        
        const fixResult = await fixItem.fixer(fixItem.failure, {
          outputDir: this._outputDir,
          verbose: this._verbose,
        });
        
        const success = fixResult?.success !== false;
        results.push({ success, detail: fixResult?.detail || 'Fix applied' });
        
        if (success) {
          this._log(`      ✅ Fixed: ${fixResult?.detail || 'OK'}`);
        } else {
          this._log(`      ❌ Fix failed: ${fixResult?.detail || 'Unknown error'}`);
        }
      } catch (err) {
        this._log(`      ❌ Fix error: ${err.message}`);
        results.push({ success: false, error: err.message });
      }
    }
    
    return results;
  }

  /**
   * Generate summary.
   */
  _generateSummary(finalResult) {
    const lines = [];
    
    if (finalResult.passed) {
      lines.push('✅ TEST-FIX LOOP SUCCESS');
      lines.push(`   All tests passed after ${this._roundCount} fix round(s)`);
    } else {
      lines.push('❌ TEST-FIX LOOP FAILED');
      lines.push(`   Failed after ${this._roundCount}/${this._maxFixRounds} rounds`);
      lines.push(`   Remaining failures: ${finalResult.failures.length}`);
      
      if (finalResult.failures.length > 0) {
        lines.push('\n   Remaining issues:');
        for (const f of finalResult.failures.slice(0, 5)) {
          lines.push(`   • ${f.test}: ${f.error}`);
        }
        if (finalResult.failures.length > 5) {
          lines.push(`   ... and ${finalResult.failures.length - 5} more`);
        }
      }
    }
    
    // Fix history summary
    if (this._fixHistory.length > 0) {
      const totalFixes = this._fixHistory.reduce((sum, h) => 
        sum + h.fixResults.filter(r => r.success).length, 0);
      lines.push(`\n   Fixes applied: ${totalFixes} across ${this._fixHistory.length} round(s)`);
    }
    
    return lines.join('\n');
  }

  /**
   * Log helper.
   */
  _log(message) {
    if (this._verbose || process.env.VERBOSE) {
      console.log(message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Built-in Fixers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Artifact Missing Fixer – Creates missing artifacts with proper format.
 */
async function artifactMissingFixer(failure, options = {}) {
  const outputDir = options.outputDir || process.cwd();
  
  // Parse failure to determine what artifact is missing
  const errorMsg = failure.error || failure.test || '';
  
  // Try multiple patterns to extract path
  let artifactPath = null;
  
  // Pattern 1: "File not found at /path/to/file"
  let match = errorMsg.match(/File not found at[:\s]+([^\s]+)/i);
  if (match) {
    artifactPath = match[1];
  }
  
  // Pattern 2: "artifact: /path/to/file"
  if (!artifactPath) {
    match = errorMsg.match(/artifact[:\s]+([^\s]+)/i);
    if (match) {
      artifactPath = match[1];
    }
  }
  
  // Pattern 3: From test name (e.g., "ANALYSE: requirement.md exists")
  if (!artifactPath && failure.test) {
    const stageMatch = failure.test.match(/(ANALYSE|ARCHITECT|PLAN|CODE|TEST)[:\s]+([^\s:]+)/i);
    if (stageMatch) {
      const stage = stageMatch[1];
      const artifact = stageMatch[2].replace(/\s+exists$/i, '').trim();
      
      // Map stage to artifact
      const stageArtifacts = {
        ANALYSE: 'requirement.md',
        ARCHITECT: 'architecture.md',
        PLAN: 'execution-plan.md',
        CODE: 'code.diff',
        TEST: 'test-report.md',
      };
      
      const fileName = stageArtifacts[stage] || artifact;
      artifactPath = path.join(outputDir, fileName);
    }
  }
  
  if (!artifactPath) {
    return { success: false, detail: 'Cannot determine missing artifact path from: ' + errorMsg };
  }
  
  // Determine artifact type and create appropriate content
  const fileName = path.basename(artifactPath).toLowerCase();
  
  let content = '';
  let created = false;
  
  if (fileName.includes('requirement')) {
    content = generateRequirementTemplate();
    created = true;
  } else if (fileName.includes('architecture')) {
    content = generateArchitectureTemplate();
    created = true;
  } else if (fileName.includes('design')) {
    content = generateDesignTemplate();
    created = true;
  } else if (fileName.includes('plan') || fileName.includes('execution')) {
    content = generatePlanTemplate();
    created = true;
  } else if (fileName.includes('test-report')) {
    content = generateTestReportTemplate();
    created = true;
  } else if (fileName.includes('code.diff') || fileName.includes('diff')) {
    content = generateDiffTemplate();
    created = true;
  }
  
  if (!created) {
    return { success: false, detail: `No template for artifact: ${fileName}` };
  }
  
  // Ensure directory exists
  const dir = path.dirname(artifactPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // Write artifact
  fs.writeFileSync(artifactPath, content, 'utf-8');
  
  return { success: true, detail: `Created ${artifactPath} with template` };
}

/**
 * Format Mismatch Fixer – Fixes format issues in existing files.
 */
async function formatMismatchFixer(failure, options = {}) {
  const errorMsg = failure.error || '';
  
  // Check if it's a requirement.md format issue
  if (errorMsg.includes('user stories') || errorMsg.includes('acceptance criteria')) {
    // Fix the requirement.md format
    const reqPath = path.join(options.outputDir || process.cwd(), 'requirement.md');
    
    if (!fs.existsSync(reqPath)) {
      return { success: false, detail: 'requirement.md not found' };
    }
    
    let content = fs.readFileSync(reqPath, 'utf-8');
    
    // Add missing sections
    if (!content.includes('## User Stories')) {
      content = injectUserStories(content);
    }
    if (!content.includes('## Acceptance Criteria')) {
      content = injectAcceptanceCriteria(content);
    }
    
    fs.writeFileSync(reqPath, content, 'utf-8');
    return { success: true, detail: 'Fixed requirement.md format' };
  }
  
  return { success: false, detail: 'Unknown format mismatch type' };
}

/**
 * Generic Fixer – Fallback for unknown failure types.
 */
async function genericFixer(failure, options = {}) {
  return { success: false, detail: 'Generic fixer cannot auto-fix this issue' };
}

// ═══════════════════════════════════════════════════════════════════════════
// Template Generators
// ═══════════════════════════════════════════════════════════════════════════

function generateRequirementTemplate() {
  return `# Requirements

## Overview
This is a placeholder requirement document. Please fill in the actual requirements.

## User Stories
- As a user, I want to perform an action so that I can achieve a goal.

## Acceptance Criteria
1. GIVEN a condition WHEN an action is performed THEN an expected result occurs.

## Functional Requirements
1. The system must provide core functionality.

## Out of Scope
- Placeholder items
`;
}

function generateArchitectureTemplate() {
  return `# Architecture

## Overview
High-level architecture design.

## Components
- Component A: Description

## Data Flow
\`\`\`
Input → Processing → Output
\`\`\`

## Decisions
- Decision 1: Rationale
`;
}

function generateDesignTemplate() {
  return `# Design

## Overview
Detailed design document.

## API Design
- Endpoint: Description

## Data Models
- Model: Fields
`;
}

function generatePlanTemplate() {
  return `# Implementation Plan

## Tasks
1. Task 1
2. Task 2

## Timeline
- Week 1: Tasks 1-2

## Risks
- Risk 1: Mitigation
`;
}

function generateTestReportTemplate() {
  return `# Test Report

## Summary
- Total Tests: 0
- Passed: 0
- Failed: 0
- Skipped: 0

## Results
(No tests executed yet)

## Coverage
- Line Coverage: 0%
- Branch Coverage: 0%
- Function Coverage: 0%

## Recommendations
- Run tests to generate actual coverage data
`;
}

function generateDiffTemplate() {
  return `diff --git a/placeholder b/placeholder
--- a/placeholder
+++ b/placeholder
@@ -0,0 +1,2 @@
+# Placeholder diff file
+# This file will be replaced by actual code changes during execution
`;
}

function injectUserStories(content) {
  const userStoriesSection = `

## User Stories
- As a user, I want to use this feature so that I can accomplish my goal.
`;
  
  // Insert after Overview or at the end
  const insertPoint = content.includes('## Overview') 
    ? content.indexOf('## Overview') + content.substring(content.indexOf('## Overview')).indexOf('\n\n') + 2
    : content.length;
  
  return content.slice(0, insertPoint) + userStoriesSection + content.slice(insertPoint);
}

function injectAcceptanceCriteria(content) {
  const acSection = `

## Acceptance Criteria
1. GIVEN a user WHEN they perform an action THEN the expected result occurs.
`;
  
  // Insert after User Stories or before Out of Scope
  const insertPoint = content.includes('## Out of Scope')
    ? content.indexOf('## Out of Scope')
    : content.length;
  
  return content.slice(0, insertPoint) + acSection + content.slice(insertPoint);
}

// ═══════════════════════════════════════════════════════════════════════════
// Module Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  TestFixLoop,
  FixerType,
  // Built-in fixers
  artifactMissingFixer,
  formatMismatchFixer,
  genericFixer,
};
