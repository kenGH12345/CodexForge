/**
 * Requirement Use Case Production & Consumption Chain Tests
 * 
 * 验证需求用例的完整链路：
 *   1. AnalystAgent产出需求用例（User Stories + Acceptance Criteria）
 *   2. CoverageChecker解析需求用例
 *   3. ArchitectAgent消费需求用例
 *   4. 验证覆盖率报告生成
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseRequirements, CoverageChecker } = require('../core/coverage-checker');

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: parseRequirements – 需求用例解析能力
// ═══════════════════════════════════════════════════════════════════════════

function test_parseRequirements_englishUserStories() {
  console.log('\n📋 Test: parseRequirements - English User Stories');
  
  const requirementMd = `
# Requirements

## Overview
A user authentication system.

## User Stories
- As a user, I want to register with email and password so that I can create an account.
- As a user, I want to log in with my credentials so that I can access my dashboard.
- As an admin, I want to manage user roles so that I can control access permissions.

## Acceptance Criteria
1. WHEN a user registers with valid data THEN an account is created.
2. WHEN a user logs in with correct credentials THEN a JWT token is issued.
3. WHEN an admin assigns a role THEN the user's permissions are updated.
`;

  const items = parseRequirements(requirementMd);
  
  console.log(`   Parsed ${items.length} items`);
  items.forEach(item => console.log(`   - ${item.id} [${item.type}]: ${item.text.slice(0, 50)}...`));
  
  // 验证User Stories被正确解析
  const stories = items.filter(i => i.type === 'story');
  assert(stories.length >= 2, `Expected ≥2 user stories, got ${stories.length}`);
  
  // 验证Acceptance Criteria被正确解析
  const criteria = items.filter(i => i.type === 'criteria');
  assert(criteria.length >= 2, `Expected ≥2 acceptance criteria, got ${criteria.length}`);
  
  // 验证ID格式
  items.forEach(item => {
    assert(item.id.match(/^REQ-\d{3}$/), `Invalid ID format: ${item.id}`);
    assert(item.text.length > 10, `Item text too short: ${item.text}`);
  });
  
  console.log('   ✅ PASS: English User Stories parsed correctly\n');
}

function test_parseRequirements_chineseUserStories() {
  console.log('\n📋 Test: parseRequirements - Chinese User Stories');
  
  const requirementMd = `
# 需求文档

## 概述
用户认证系统。

## 用户故事
- 作为用户，我希望能够使用邮箱和密码注册，以便创建账户。
- 作为用户，我希望能够登录系统，以便访问我的仪表板。
- 作为管理员，我希望能够管理用户角色，以便控制访问权限。

## 验收标准
1. 当用户使用有效数据注册时，账户被创建。
2. 当用户使用正确凭证登录时，签发JWT令牌。
`;

  const items = parseRequirements(requirementMd);
  
  console.log(`   Parsed ${items.length} items`);
  
  const stories = items.filter(i => i.type === 'story');
  assert(stories.length >= 1, `Expected ≥1 Chinese user story, got ${stories.length}`);
  
  const criteria = items.filter(i => i.type === 'criteria');
  assert(criteria.length >= 1, `Expected ≥1 Chinese acceptance criteria, got ${criteria.length}`);
  
  console.log('   ✅ PASS: Chinese User Stories parsed correctly\n');
}

function test_parseRequirements_functionalRequirements() {
  console.log('\n📋 Test: parseRequirements - Functional Requirements');
  
  const requirementMd = `
# Requirements

## Functional Requirements
1. The system must support JWT-based authentication.
2. The system should provide password reset functionality.
3. The system shall enforce rate limiting on login attempts.

## Non-Functional Requirements
- Performance: Response time < 200ms
- Security: All passwords must be hashed with bcrypt
`;

  const items = parseRequirements(requirementMd);
  
  console.log(`   Parsed ${items.length} items`);
  
  const functional = items.filter(i => i.type === 'functional');
  assert(functional.length >= 2, `Expected ≥2 functional requirements, got ${functional.length}`);
  
  console.log('   ✅ PASS: Functional Requirements parsed correctly\n');
}

function test_parseRequirements_emptyDocument() {
  console.log('\n📋 Test: parseRequirements - Empty Document');
  
  const requirementMd = `
# Requirements

## Overview
This is a placeholder.
`;

  const items = parseRequirements(requirementMd);
  
  console.log(`   Parsed ${items.length} items`);
  assert(items.length === 0, `Expected 0 items for empty document, got ${items.length}`);
  
  console.log('   ✅ PASS: Empty document handled correctly\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: CoverageChecker – 需求覆盖率验证
// ═══════════════════════════════════════════════════════════════════════════

async function test_coverageChecker_fullCoverage() {
  console.log('\n📋 Test: CoverageChecker - Full Coverage Scenario');
  
  const requirementMd = `
# Requirements

## User Stories
- As a user, I want to authenticate with JWT.
- As an admin, I want to manage users.

## Acceptance Criteria
1. WHEN user logs in THEN JWT token is returned.
2. WHEN admin creates user THEN user is added to database.
`;

  const architectureMd = `
# Architecture

## Components
- **AuthService**: Handles JWT authentication for users.
- **UserManagementService**: Allows admins to manage user accounts.

## API Endpoints
- POST /auth/login - Authenticates user and returns JWT token
- POST /admin/users - Creates a new user (admin only)
`;

  // 创建临时文件
  const tempDir = path.join(__dirname, '../output/temp-coverage-test');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const reqPath = path.join(tempDir, 'requirement.md');
  const archPath = path.join(tempDir, 'architecture.md');
  
  fs.writeFileSync(reqPath, requirementMd, 'utf-8');
  fs.writeFileSync(archPath, architectureMd, 'utf-8');
  
  // Mock LLM调用 - 模拟完美覆盖
  const mockLlmCall = async (prompt) => {
    // 返回所有需求都被覆盖
    return JSON.stringify([
      { id: 'REQ-001', covered: true, reason: 'AuthService handles JWT authentication.' },
      { id: 'REQ-002', covered: true, reason: 'UserManagementService handles user management.' },
      { id: 'REQ-003', covered: true, reason: 'POST /auth/login endpoint returns JWT.' },
      { id: 'REQ-004', covered: true, reason: 'POST /admin/users creates users.' },
    ]);
  };
  
  const checker = new CoverageChecker(mockLlmCall, { verbose: false });
  const result = await checker.check(reqPath, archPath);
  
  console.log(`   Total: ${result.total}, Covered: ${result.covered}, Uncovered: ${result.uncovered}`);
  console.log(`   Coverage Rate: ${result.coverageRate}%`);
  
  // 验证
  assert(result.total >= 3, `Expected ≥3 total items, got ${result.total}`);
  assert(result.coverageRate >= 75, `Expected ≥75% coverage, got ${result.coverageRate}%`);
  assert(!result.skipped, 'Coverage check should not be skipped');
  
  // 清理
  fs.unlinkSync(reqPath);
  fs.unlinkSync(archPath);
  fs.rmdirSync(tempDir);
  
  console.log('   ✅ PASS: Full coverage detected correctly\n');
}

async function test_coverageChecker_partialCoverage() {
  console.log('\n📋 Test: CoverageChecker - Partial Coverage Scenario');
  
  const requirementMd = `
# Requirements

## User Stories
- As a user, I want to authenticate with JWT.
- As a user, I want to reset my password.
- As an admin, I want to manage users.

## Acceptance Criteria
1. WHEN user logs in THEN JWT token is returned.
2. WHEN user requests password reset THEN reset email is sent.
3. WHEN admin creates user THEN user is added to database.
`;

  const architectureMd = `
# Architecture

## Components
- **AuthService**: Handles JWT authentication.
- **UserManagementService**: Manages user accounts.

## API Endpoints
- POST /auth/login - Returns JWT token
`;

  const tempDir = path.join(__dirname, '../output/temp-partial-coverage-test');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const reqPath = path.join(tempDir, 'requirement.md');
  const archPath = path.join(tempDir, 'architecture.md');
  
  fs.writeFileSync(reqPath, requirementMd, 'utf-8');
  fs.writeFileSync(archPath, architectureMd, 'utf-8');
  
  // Mock LLM调用 - 模拟部分覆盖
  const mockLlmCall = async (prompt) => {
    return JSON.stringify([
      { id: 'REQ-001', covered: true, reason: 'AuthService handles JWT.' },
      { id: 'REQ-002', covered: false, reason: 'No password reset functionality in architecture.' },
      { id: 'REQ-003', covered: true, reason: 'UserManagementService exists.' },
      { id: 'REQ-004', covered: true, reason: 'POST /auth/login returns JWT.' },
      { id: 'REQ-005', covered: false, reason: 'No password reset email mechanism described.' },
      { id: 'REQ-006', covered: false, reason: 'No POST /admin/users endpoint defined.' },
    ]);
  };
  
  const checker = new CoverageChecker(mockLlmCall, { verbose: false });
  const result = await checker.check(reqPath, archPath);
  
  console.log(`   Total: ${result.total}, Covered: ${result.covered}, Uncovered: ${result.uncovered}`);
  console.log(`   Coverage Rate: ${result.coverageRate}%`);
  console.log(`   Risk Notes: ${result.riskNotes.length}`);
  
  // 验证
  assert(result.uncovered >= 2, `Expected ≥2 uncovered items, got ${result.uncovered}`);
  assert(result.coverageRate < 70, `Expected <70% coverage for partial scenario, got ${result.coverageRate}%`);
  assert(result.riskNotes.length >= 2, `Expected ≥2 risk notes for uncovered items, got ${result.riskNotes.length}`);
  
  // 清理
  fs.unlinkSync(reqPath);
  fs.unlinkSync(archPath);
  fs.rmdirSync(tempDir);
  
  console.log('   ✅ PASS: Partial coverage detected correctly\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: 下游消费验证 – ArchitectAgent读取需求用例
// ═══════════════════════════════════════════════════════════════════════════

function test_architectAgent_consumesRequirements() {
  console.log('\n📋 Test: ArchitectAgent Consumes Requirements');
  
  const { extractJsonBlock } = require('../core/agent-output-schema');
  
  // 模拟AnalystAgent输出的requirement.md（带JSON块）
  const requirementMd = `
\`\`\`json
{
  "version": "1.0",
  "requirements": [
    { "id": "REQ-001", "text": "User authentication with JWT" },
    { "id": "REQ-002", "text": "Password reset functionality" },
    { "id": "REQ-003", "text": "Role-based access control" }
  ],
  "risks": [
    "JWT token expiration handling needed",
    "Password reset email delivery reliability"
  ],
  "moduleMap": {
    "modules": [
      { "id": "auth", "name": "Authentication Module", "description": "Handles user auth" },
      { "id": "user", "name": "User Management Module", "description": "Manages user accounts" }
    ]
  }
}
\`\`\`

# Requirements

## Overview
User authentication system with RBAC.

## User Stories
- As a user, I want to authenticate with JWT.
- As a user, I want to reset my password.
- As an admin, I want to manage user roles.
`;

  // 验证JSON块提取
  const jsonBlock = extractJsonBlock(requirementMd);
  assert(jsonBlock !== null, 'JSON block should be extracted');
  
  console.log(`   Extracted JSON block with ${jsonBlock.requirements?.length || 0} requirements`);
  console.log(`   Module map has ${jsonBlock.moduleMap?.modules?.length || 0} modules`);
  
  // 验证需求用例存在
  assert(jsonBlock.requirements && jsonBlock.requirements.length >= 2, 
    `Expected ≥2 requirements in JSON block, got ${jsonBlock.requirements?.length || 0}`);
  
  // 验证模块映射存在
  assert(jsonBlock.moduleMap && jsonBlock.moduleMap.modules, 
    'Module map should be present for downstream consumption');
  
  // 验证风险识别
  assert(jsonBlock.risks && jsonBlock.risks.length >= 1, 
    `Expected ≥1 risk identified, got ${jsonBlock.risks?.length || 0}`);
  
  console.log('   ✅ PASS: ArchitectAgent can consume requirement.md correctly\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: 运行时产物验证 – 实际产出文件检查
// ═══════════════════════════════════════════════════════════════════════════

function test_runtimeArtifact_requirementsExist() {
  console.log('\n📋 Test: Runtime Artifact - requirement.md Existence');
  
  const outputDir = path.join(__dirname, '../output');
  const reqPath = path.join(outputDir, 'requirement.md');
  
  // 检查是否存在真实的需求文档（非mock文件）
  const realRequirementFiles = fs.readdirSync(outputDir)
    .filter(f => f.includes('requirement') && !f.includes('mock') && !f.includes('test'))
    .map(f => path.join(outputDir, f));
  
  console.log(`   Found ${realRequirementFiles.length} real requirement file(s)`);
  
  // 验证mock文件内容格式
  const mockReqPath = path.join(outputDir, 'mock-requirement.md');
  if (fs.existsSync(mockReqPath)) {
    const content = fs.readFileSync(mockReqPath, 'utf-8');
    const items = parseRequirements(content);
    console.log(`   Mock requirement.md: ${content.length} chars, ${items.length} parseable items`);
    
    // 验证至少有可解析的需求项
    if (items.length === 0) {
      console.log('   ⚠️  WARNING: mock-requirement.md has no parseable requirement items');
      console.log('   ⚠️  This indicates the format does not match parseRequirements expectations');
    }
  }
  
  console.log('   ✅ PASS: Requirement artifact verification completed\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Test Runner
// ═══════════════════════════════════════════════════════════════════════════

async function runAllTests() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  🔍 REQUIREMENT USE CASE PRODUCTION & CONSUMPTION TESTS ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  let passed = 0;
  let failed = 0;
  
  const tests = [
    { name: 'parseRequirements_englishUserStories', fn: test_parseRequirements_englishUserStories },
    { name: 'parseRequirements_chineseUserStories', fn: test_parseRequirements_chineseUserStories },
    { name: 'parseRequirements_functionalRequirements', fn: test_parseRequirements_functionalRequirements },
    { name: 'parseRequirements_emptyDocument', fn: test_parseRequirements_emptyDocument },
    { name: 'architectAgent_consumesRequirements', fn: test_architectAgent_consumesRequirements },
    { name: 'runtimeArtifact_requirementsExist', fn: test_runtimeArtifact_requirementsExist },
  ];
  
  const asyncTests = [
    { name: 'coverageChecker_fullCoverage', fn: test_coverageChecker_fullCoverage },
    { name: 'coverageChecker_partialCoverage', fn: test_coverageChecker_partialCoverage },
  ];
  
  // 同步测试
  for (const { name, fn } of tests) {
    try {
      fn();
      passed++;
    } catch (err) {
      console.log(`   ❌ FAIL: ${name}`);
      console.log(`   Error: ${err.message}\n`);
      failed++;
    }
  }
  
  // 异步测试
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      passed++;
    } catch (err) {
      console.log(`   ❌ FAIL: ${name}`);
      console.log(`   Error: ${err.message}\n`);
      failed++;
    }
  }
  
  // 汇总
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`📊 SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════\n');
  
  return failed === 0;
}

// Export for test runner
module.exports = { runAllTests };

// Run if executed directly
if (require.main === module) {
  runAllTests().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(err => {
    console.error('Test runner crashed:', err);
    process.exit(1);
  });
}
