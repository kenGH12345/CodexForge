/**
 * Demo: Functionality Evaluation with 6-Dimension Framework
 *
 * 演示如何使用新的功能正确性/完整性评估器
 */

'use strict';

const { BenchmarkTask, ExecutionResult, EvaluationDimension } = require('../workflow/core/benchmark-types');
const { FunctionalityEvaluator } = require('../workflow/core/functionality-evaluator');
const { QualityScorer } = require('../workflow/core/benchmark-runner');

// ═══════════════════════════════════════════════════════════════════════════
// 示例 1: 完整的功能评估演示
// ═══════════════════════════════════════════════════════════════════════════

async function demoFunctionalityEvaluation() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  6-维度评估框架演示');
  console.log('  6-Dimension Evaluation Framework Demo');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // 创建一个示例任务（模拟一个 API 开发任务）
  const task = new BenchmarkTask({
    id: 'demo-api-001',
    name: 'Build REST API with error handling',
    description: 'Create a REST API endpoint that handles CRUD operations with proper validation and error handling',
    category: 'development',
    level: 'medium',
    requirements: [
      'Create Express.js API with /users endpoint',
      'Implement GET, POST, PUT, DELETE methods',
      'Add input validation',
      'Implement error handling middleware',
      'Add JSDoc documentation',
    ],
    expectedArtifacts: ['api.js', 'validation.js', 'README.md', 'test.js'],
    evaluationCriteria: {
      'REST endpoints': 'Has proper REST API structure',
      'Input validation': 'Validates request body and params',
      'Error handling': 'Returns appropriate error responses',
      'Documentation': 'Has JSDoc comments',
      'Tests': 'Includes unit tests',
    },
    timeLimitMinutes: 30,
    tokenBudget: 50000,
  });

  // 创建模拟的执行结果（包含代码产出）
  const executionResult = new ExecutionResult({
    taskId: task.id,
    artifactCount: 4,
    artifacts: {
      'api.js': `
/**
 * User API Controller
 * @module api
 */

const express = require('express');
const router = express.Router();

// In-memory store (replace with DB in production)
const users = new Map();

/**
 * Get all users
 * @route GET /users
 * @returns {Array<User>} List of users
 */
router.get('/users', (req, res, next) => {
  try {
    const userList = Array.from(users.values());
    res.json({ success: true, data: userList });
  } catch (err) {
    next(err);
  }
});

/**
 * Get user by ID
 * @route GET /users/:id
 * @param {string} id - User ID
 * @returns {User} User object
 */
router.get('/users/:id', (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Validate input
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid user ID' 
      });
    }
    
    const user = users.get(id);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

/**
 * Create new user
 * @route POST /users
 * @param {Object} body - User data
 * @returns {User} Created user
 */
router.post('/users', (req, res, next) => {
  try {
    const { name, email } = req.body;
    
    // Input validation
    if (!name || typeof name !== 'string' || name.length < 2) {
      return res.status(400).json({ 
        success: false, 
        error: 'Name must be at least 2 characters' 
      });
    }
    
    if (!email || !email.includes('@')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Valid email required' 
      });
    }
    
    const id = Math.random().toString(36).substr(2, 9);
    const user = { id, name, email, createdAt: new Date().toISOString() };
    
    users.set(id, user);
    res.status(201).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

/**
 * Update user
 * @route PUT /users/:id
 * @param {string} id - User ID
 * @param {Object} body - Updated data
 * @returns {User} Updated user
 */
router.put('/users/:id', (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, email } = req.body;
    
    if (!users.has(id)) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const existing = users.get(id);
    const updated = { 
      ...existing, 
      ...(name && { name }),
      ...(email && { email }),
      updatedAt: new Date().toISOString()
    };
    
    users.set(id, updated);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * Delete user
 * @route DELETE /users/:id
 * @param {string} id - User ID
 */
router.delete('/users/:id', (req, res, next) => {
  try {
    const { id } = req.params;
    
    if (!users.has(id)) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    users.delete(id);
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    next(err);
  }
});

// Error handling middleware
router.use((err, req, res) => {
  console.error('API Error:', err);
  res.status(500).json({ 
    success: false, 
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message 
  });
});

module.exports = router;
`,
      'validation.js': `
/**
 * Input Validation Utilities
 */

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

function validateString(value, field, options = {}) {
  if (value === null || value === undefined) {
    throw new ValidationError(\`\${field} is required\`, field);
  }
  
  if (typeof value !== 'string') {
    throw new ValidationError(\`\${field} must be a string\`, field);
  }
  
  if (options.min && value.length < options.min) {
    throw new ValidationError(
      \`\${field} must be at least \${options.min} characters\`,
      field
    );
  }
  
  if (options.max && value.length > options.max) {
    throw new ValidationError(
      \`\${field} must not exceed \${options.max} characters\`,
      field
    );
  }
  
  if (options.pattern && !options.pattern.test(value)) {
    throw new ValidationError(\`\${field} format is invalid\`, field);
  }
  
  return true;
}

function validateEmail(email) {
  const emailPattern = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  return validateString(email, 'email', { pattern: emailPattern });
}

module.exports = {
  ValidationError,
  validateString,
  validateEmail,
};
`,
      'README.md': `
# User API

REST API for user management.

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /users | List all users |
| GET | /users/:id | Get user by ID |
| POST | /users | Create new user |
| PUT | /users/:id | Update user |
| DELETE | /users/:id | Delete user |

## Usage

\`\`\`javascript
const app = require('express')();
const userApi = require('./api');

app.use('/api', userApi);
app.listen(3000);
\`\`\`

## Error Handling

All errors return JSON with { success: false, error: string }
`,
      'test.js': `
const request = require('supertest');
const express = require('express');
const userApi = require('./api');

describe('User API', () => {
  let app;
  
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', userApi);
  });

  describe('GET /users', () => {
    it('should return empty array initially', async () => {
      const res = await request(app).get('/api/users');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('POST /users', () => {
    it('should create a new user', async () => {
      const res = await request(app)
        .post('/api/users')
        .send({ name: 'John', email: 'john@example.com' });
      
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('John');
    });

    it('should validate input', async () => {
      const res = await request(app)
        .post('/api/users')
        .send({ name: 'J', email: 'invalid' });
      
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
`,
    },
    iterationCount: 2,
    durationMs: 125000, // ~2 minutes
    tokensConsumed: 35000,
    userInterventionCount: 0,
    executionLog: `
[Planning] Creating REST API with Express.js
[Step 1] Setting up Express router and basic structure
[Step 2] Implementing GET /users endpoint
[Step 3] Implementing POST /users with validation
[Step 4] Implementing PUT and DELETE endpoints
[Step 5] Adding error handling middleware
[Step 6] Writing tests
[Complete] All features implemented
`,
    codeMetrics: {
      filesAdded: 4,
      testFilesAdded: 1,
      totalLines: 180,
      complexity: 'medium',
    },
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 步骤 1: 使用功能评估器评估功能正确性和完整性
  // ═════════════════════════════════════════════════════════════════════════
  
  console.log('📊 Step 1: Functionality Assessment (6-Dimension Framework)');
  console.log('───────────────────────────────────────────────────────────────────\n');

  const funcEvaluator = new FunctionalityEvaluator({ verbose: true });
  const funcAssessment = await funcEvaluator.evaluate(executionResult, task);

  console.log('\n✅ Functional Correctness Score:', funcAssessment.functionalCorrectness.score, '/ 100');
  console.log('   └── Includes: Core Logic | Edge Cases | Type Correctness | Output Validation');
  
  console.log('\n✅ Functional Completeness Score:', funcAssessment.functionalCompleteness.score, '/ 100');
  console.log('   └── Includes: Requirements | Features | API | Documentation');
  
  console.log('\n✅ Overall Functionality:', funcAssessment.overallScore, '/ 100');

  // ═════════════════════════════════════════════════════════════════════════
  // 步骤 2: 使用 QualityScorer 进行完整评分
  // ═════════════════════════════════════════════════════════════════════════
  
  console.log('\n\n📊 Step 2: Complete Quality Scoring');
  console.log('───────────────────────────────────────────────────────────────────\n');

  const scorer = new QualityScorer({ verbose: true });
  const scores = await scorer.scoreExecution(executionResult, task);

  // 打印所有维度得分
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║           6-DIMENSION EVALUATION RESULTS                         ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║  维度 (Dimension)                │ 得分 │ 权重 │ 加权贡献      ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  
  const dimensions = [
    { name: '功能性正确性 (Correctness)', score: scores.functionalCorrectness?.score || 0, weight: 0.25, critical: true },
    { name: '功能性完整性 (Completeness)', score: scores.functionalCompleteness?.score || 0, weight: 0.20, critical: false },
    { name: '代码质量 (Quality)', score: scores.codeQuality?.score || 0, weight: 0.20, critical: false },
    { name: '鲁棒性 (Robustness)', score: scores.robustness?.score || 0, weight: 0.15, critical: false },
    { name: '开发效率 (Efficiency)', score: scores.devEfficiency?.score || 0, weight: 0.15, critical: false },
    { name: '用户体验 (Experience)', score: scores.userExperience?.score || 0, weight: 0.05, critical: false },
  ];

  dimensions.forEach(dim => {
    const weighted = (dim.score * dim.weight).toFixed(1);
    const criticalMark = dim.critical ? ' ⭐' : '';
    console.log(`║  ${dim.name.padEnd(30)} │ ${String(dim.score).padStart(3)}  │ ${String(dim.weight * 100).padStart(3)}% │ ${weighted.padStart(5)}${criticalMark.padEnd(10)} ║`);
  });

  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  📊 总评 (Overall Score)                                ${String(scores.overallScore).padStart(3)} / 100    ║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  // ═════════════════════════════════════════════════════════════════════════
  // 步骤 3: 详细指标分析
  // ═════════════════════════════════════════════════════════════════════════
  
  console.log('\n\n📊 Step 3: Detailed Metrics Breakdown');
  console.log('───────────────────────────────────────────────────────────────────\n');

  // 功能正确性详情
  if (scores.functionalCorrectness?.details) {
    console.log('🎯 Functional Correctness Details:');
    scores.functionalCorrectness.details.forEach(d => {
      console.log(`   • ${d.metric}: ${d.score}/100`);
      if (d.evidence) {
        const evidence = typeof d.evidence === 'string' ? d.evidence : JSON.stringify(d.evidence).slice(0, 60);
        console.log(`     └─ Evidence: ${evidence}...`);
      }
    });
  }

  // 功能完整性详情
  if (scores.functionalCompleteness?.details) {
    console.log('\n📋 Functional Completeness Details:');
    scores.functionalCompleteness.details.forEach(d => {
      console.log(`   • ${d.metric}: ${d.score}/100`);
      if (d.covered !== undefined) {
        console.log(`     └─ Covered: ${d.covered}/${d.total}`);
      }
    });
  }

  // 鲁棒性详情
  if (scores.robustness) {
    console.log('\n🛡️ Robustness Details:');
    console.log(`   • Error Handling: ${scores.robustness.errorHandling}/100`);
    console.log(`   • Input Validation: ${scores.robustness.inputValidation}/100`);
    console.log(`   • Exception Safety: ${scores.robustness.exceptionSafety}/100`);
    console.log(`   • Resource Cleanup: ${scores.robustness.resourceCleanup}/100`);
    console.log(`   • Test Pass Rate: ${scores.robustness.testPassRate}/100`);
  }

  // 效率详情
  if (scores.devEfficiency) {
    console.log('\n⚡ Development Efficiency Details:');
    console.log(`   • Iteration Efficiency: ${scores.devEfficiency.iterationEfficiency}/100 (${executionResult.iterationCount} iterations)`);
    console.log(`   • Time Efficiency: ${scores.devEfficiency.timeEfficiency}/100 (${(executionResult.durationMs / 60000).toFixed(1)} min)`);
    console.log(`   • Token Efficiency: ${scores.devEfficiency.tokenEfficiency}/100 (${executionResult.tokensConsumed} tokens)`);
    console.log(`   • Automation Level: ${scores.devEfficiency.automationLevel}/100 (${executionResult.userInterventionCount} interventions)`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 步骤 4: 生成简单 Markdown 报告
  // ═════════════════════════════════════════════════════════════════════════
  
  console.log('\n\n📊 Step 4: Generate Report');
  console.log('───────────────────────────────────────────────────────────────────\n');

  // 生成简单的 Markdown 报告
  const report = generateSimpleReport(scores, funcAssessment, task);
  
  console.log('✅ Report generated successfully!');
  console.log('\n📄 Report preview (first 2000 chars):');
  console.log('─'.repeat(70));
  console.log(report.slice(0, 2000));
  console.log('\n... [truncated] ...');
  console.log('─'.repeat(70));

  // 保存报告到文件
  const fs = require('fs');
  const path = require('path');
  const reportPath = path.join(__dirname, '../output/demo-evaluation-report.md');
  
  // Ensure output directory exists
  const outputDir = path.dirname(reportPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  fs.writeFileSync(reportPath, report);
  console.log(`\n💾 Full report saved to: ${reportPath}`);

  return { scores, funcAssessment, report };
}

/**
 * 生成简单的 Markdown 报告
 */
function generateSimpleReport(scores, funcAssessment, task) {
  const now = new Date().toISOString().replace(/T/, ' ').slice(0, 19);
  
  return `# WorkflowAgent Evaluation Report

**Task:** ${task.name}  
**Generated:** ${now}

---

## 📊 6-Dimension Evaluation Results

| Dimension | Score | Weight | Weighted | |
|-----------|-------|--------|----------|---|
| ⭐ Functional Correctness | ${scores.functionalCorrectness?.score || 0}/100 | 25% | ${((scores.functionalCorrectness?.score || 0) * 0.25).toFixed(1)} | |
| 📋 Functional Completeness | ${scores.functionalCompleteness?.score || 0}/100 | 20% | ${((scores.functionalCompleteness?.score || 0) * 0.20).toFixed(1)} | |
| 💎 Code Quality | ${scores.codeQuality?.score || 0}/100 | 20% | ${((scores.codeQuality?.score || 0) * 0.20).toFixed(1)} | |
| 🛡️ Robustness | ${scores.robustness?.score || 0}/100 | 15% | ${((scores.robustness?.score || 0) * 0.15).toFixed(1)} | |
| ⚡ Dev Efficiency | ${scores.devEfficiency?.score || 0}/100 | 15% | ${((scores.devEfficiency?.score || 0) * 0.15).toFixed(1)} | |
| 😊 User Experience | ${scores.userExperience?.score || 0}/100 | 5% | ${((scores.userExperience?.score || 0) * 0.05).toFixed(1)} | |
| **TOTAL** | | | **${scores.overallScore}/100** | ${getGrade(scores.overallScore)} |

---

## 🎯 Functional Correctness Details

${formatCorrectnessDetails(scores.functionalCorrectness)}

---

## 📋 Functional Completeness Details

${formatCompletenessDetails(scores.functionalCompleteness)}

---

## 🛡️ Robustness Details

- **Error Handling:** ${scores.robustness?.errorHandling || 0}/100
- **Input Validation:** ${scores.robustness?.inputValidation || 0}/100
- **Exception Safety:** ${scores.robustness?.exceptionSafety || 0}/100
- **Resource Cleanup:** ${scores.robustness?.resourceCleanup || 0}/100
- **Test Pass Rate:** ${scores.robustness?.testPassRate || 0}/100

---

## Methodology

This evaluation uses the 6-Dimension Framework where:
1. **Functional Correctness (25%)** - MOST CRITICAL
2. **Functional Completeness (20%)**
3. **Code Quality (20%)**
4. **Robustness (15%)**
5. **Dev Efficiency (15%)**
6. **User Experience (5%)**

Reference: SWE-bench, HumanEval industry standards
`;
}

function getGrade(score) {
  if (score >= 90) return '🟢 Excellent';
  if (score >= 70) return '🟡 Good';
  if (score >= 50) return '🟠 Acceptable';
  return '🔴 Needs Improvement';
}

function formatCorrectnessDetails(details) {
  if (!details?.details || !Array.isArray(details.details)) return 'N/A';
  return details.details.map(d => {
    const score = typeof d.score === 'number' ? d.score : 0;
    return `- **${d.metric || 'Unknown'}:** ${score}/100`;
  }).join('\n');
}

function formatCompletenessDetails(details) {
  if (!details?.details || !Array.isArray(details.details)) return 'N/A';
  return details.details.map(d => {
    const score = typeof d.score === 'number' ? d.score : 0;
    return `- **${d.metric || 'Unknown'}:** ${score}/100`;
  }).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 示例 2: 对比评估演示 - 展示完整 6 维度差异
// ═══════════════════════════════════════════════════════════════════════════

async function demoComparison() {
  console.log('\n\n═══════════════════════════════════════════════════════════════════');
  console.log('  对比评估演示 (IDE vs WorkflowAgent) - 全维度对比');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const task = new BenchmarkTask({
    id: 'demo-compare-001',
    name: 'Build calculator module',
    description: 'Create a calculator module with basic operations, error handling, and tests',
    level: 'medium',
    requirements: [
      'Implement add, subtract, multiply, divide',
      'Handle division by zero',
      'Add input validation',
      'Include unit tests',
      'Add documentation',
    ],
    evaluationCriteria: {
      'basic operations': 'Has add, subtract, multiply, divide',
      'error handling': 'Handles edge cases and errors',
      'input validation': 'Validates inputs',
      'tests': 'Has unit tests',
      'documentation': 'Has README and JSDoc',
    },
  });

  // ═════════════════════════════════════════════════════════════════════════
  // IDE 产出：最小实现，仅满足基本要求
  // ═════════════════════════════════════════════════════════════════════════
  const ideResult = new ExecutionResult({
    taskId: task.id,
    artifacts: {
      'calculator.js': `
function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

function divide(a, b) {
  return a / b;
}

module.exports = { add, subtract, multiply, divide };
`,
      'README.md': `
# Calculator

Basic calculator module.
`,
    },
    iterationCount: 1,
    durationMs: 25000,
    tokensConsumed: 3000,
    userInterventionCount: 0,
    durationSeconds: 25,
  });

  // ═════════════════════════════════════════════════════════════════════════
  // WorkflowAgent 产出：完整工业级实现
  // ═════════════════════════════════════════════════════════════════════════
  const agentResult = new ExecutionResult({
    taskId: task.id,
    artifacts: {
      'calculator.js': `
/**
 * Calculator Module - Provides basic arithmetic operations
 * @module calculator
 */

'use strict';

/**
 * Calculator configuration
 * @constant {number}
 */
const MAX_SAFE_VALUE = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_VALUE = Number.MIN_SAFE_INTEGER;

/**
 * Validates numeric input
 * @param {*} value - Value to validate
 * @param {string} name - Parameter name for error messages
 * @throws {TypeError} If value is not a valid number
 */
function validateNumeric(value, name) {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new TypeError(\`\${name} must be a valid number\`);
  }
  if (!isFinite(value)) {
    throw new RangeError(\`\${name} must be finite\`);
  }
}

/**
 * Checks if result is within safe integer range
 * @param {number} result - Result to check
 * @returns {number} The result
 * @throws {RangeError} If result overflows
 */
function checkOverflow(result) {
  if (result > MAX_SAFE_VALUE || result < MIN_SAFE_VALUE) {
    throw new RangeError('Result exceeds safe integer range');
  }
  return result;
}

/**
 * Adds two numbers
 * @param {number} a - First operand
 * @param {number} b - Second operand
 * @returns {number} Sum of a and b
 * @throws {TypeError} If inputs are not numbers
 */
function add(a, b) {
  validateNumeric(a, 'First operand');
  validateNumeric(b, 'Second operand');
  return checkOverflow(a + b);
}

/**
 * Subtracts second number from first
 * @param {number} a - First operand
 * @param {number} b - Second operand
 * @returns {number} Difference (a - b)
 */
function subtract(a, b) {
  validateNumeric(a, 'First operand');
  validateNumeric(b, 'Second operand');
  return checkOverflow(a - b);
}

/**
 * Multiplies two numbers
 * @param {number} a - First operand
 * @param {number} b - Second operand
 * @returns {number} Product of a and b
 */
function multiply(a, b) {
  validateNumeric(a, 'First operand');
  validateNumeric(b, 'Second operand');
  return checkOverflow(a * b);
}

/**
 * Divides first number by second
 * @param {number} a - Dividend
 * @param {number} b - Divisor
 * @returns {number} Quotient (a / b)
 * @throws {RangeError} If divisor is zero
 */
function divide(a, b) {
  validateNumeric(a, 'Dividend');
  validateNumeric(b, 'Divisor');
  if (b === 0) {
    throw new RangeError('Division by zero is not allowed');
  }
  return a / b;
}

/**
 * Calculates power
 * @param {number} base - Base number
 * @param {number} exponent - Exponent
 * @returns {number} base raised to exponent
 */
function power(base, exponent) {
  validateNumeric(base, 'Base');
  validateNumeric(exponent, 'Exponent');
  return checkOverflow(Math.pow(base, exponent));
}

/**
 * Calculates square root
 * @param {number} value - Input value
 * @returns {number} Square root
 * @throws {RangeError} If value is negative
 */
function sqrt(value) {
  validateNumeric(value, 'Value');
  if (value < 0) {
    throw new RangeError('Cannot calculate square root of negative number');
  }
  return Math.sqrt(value);
}

module.exports = {
  add,
  subtract,
  multiply,
  divide,
  power,
  sqrt,
  // Constants
  MAX_SAFE_VALUE,
  MIN_SAFE_VALUE,
};
`,
      'calculator.test.js': `
const { add, subtract, multiply, divide, power, sqrt } = require('./calculator');

describe('Calculator', () => {
  describe('add', () => {
    it('should add two positive numbers', () => {
      expect(add(2, 3)).toBe(5);
    });

    it('should handle negative numbers', () => {
      expect(add(-2, -3)).toBe(-5);
    });

    it('should throw on non-numeric input', () => {
      expect(() => add('a', 2)).toThrow(TypeError);
      expect(() => add(null, 2)).toThrow(TypeError);
    });

    it('should throw on overflow', () => {
      expect(() => add(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
    });
  });

  describe('subtract', () => {
    it('should subtract correctly', () => {
      expect(subtract(5, 3)).toBe(2);
    });
  });

  describe('multiply', () => {
    it('should multiply correctly', () => {
      expect(multiply(4, 5)).toBe(20);
    });
  });

  describe('divide', () => {
    it('should divide correctly', () => {
      expect(divide(10, 2)).toBe(5);
    });

    it('should throw on division by zero', () => {
      expect(() => divide(10, 0)).toThrow('Division by zero');
    });
  });

  describe('power', () => {
    it('should calculate power correctly', () => {
      expect(power(2, 3)).toBe(8);
    });
  });

  describe('sqrt', () => {
    it('should calculate square root', () => {
      expect(sqrt(9)).toBe(3);
    });

    it('should throw on negative input', () => {
      expect(() => sqrt(-1)).toThrow('square root of negative');
    });
  });
});
`,
      'README.md': `
# Calculator Module

A robust calculator module with comprehensive error handling and validation.

## Installation

\`\`\`bash
npm install calculator
\`\`\`

## Usage

\`\`\`javascript
const { add, subtract, multiply, divide } = require('./calculator');

// Basic operations
console.log(add(2, 3));        // 5
console.log(divide(10, 2));    // 5
\`\`\`

## Error Handling

All functions validate inputs and throw appropriate errors:
- \`TypeError\` - Invalid input types
- \`RangeError\` - Division by zero, overflow, etc.

## API Reference

### add(a, b)
Adds two numbers with overflow checking.

### subtract(a, b)
Subtracts b from a.

### multiply(a, b)
Multiplies two numbers.

### divide(a, b)
Divides a by b. Throws on division by zero.

### power(base, exponent)
Calculates base^exponent.

### sqrt(value)
Calculates square root. Throws on negative input.

## Testing

\`\`\`bash
npm test
\`\`\`
`,
      'package.json': `
{
  "name": "calculator",
  "version": "1.0.0",
  "description": "Robust calculator module",
  "main": "calculator.js",
  "scripts": {
    "test": "jest"
  },
  "devDependencies": {
    "jest": "^29.0.0"
  }
}
`,
    },
    iterationCount: 2,
    durationMs: 90000,
    tokensConsumed: 12000,
    userInterventionCount: 0,
    durationSeconds: 90,
  });

  const scorer = new QualityScorer();

  console.log('🔍 Evaluating IDE result...');
  const ideScores = await scorer.scoreExecution(ideResult, task);

  console.log('\n🔍 Evaluating WorkflowAgent result...');
  const agentScores = await scorer.scoreExecution(agentResult, task);

  // ═════════════════════════════════════════════════════════════════════════
  // 展示完整的 6 维度对比结果
  // ═════════════════════════════════════════════════════════════════════════
  
  console.log('\n╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                     6-DIMENSION COMPARISON RESULTS                          ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  Dimension                        │  IDE    │  Agent   │   Δ    │ Status    ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════╣');

  const dimensions = [
    { key: 'functionalCorrectness', name: 'Functional Correctness', weight: 0.25, icon: '⭐' },
    { key: 'functionalCompleteness', name: 'Functional Completeness', weight: 0.20, icon: '📋' },
    { key: 'codeQuality', name: 'Code Quality', weight: 0.20, icon: '💎' },
    { key: 'robustness', name: 'Robustness', weight: 0.15, icon: '🛡️' },
    { key: 'devEfficiency', name: 'Dev Efficiency', weight: 0.15, icon: '⚡' },
    { key: 'userExperience', name: 'User Experience', weight: 0.05, icon: '😊' },
  ];

  dimensions.forEach(dim => {
    const ide = ideScores[dim.key]?.score || 0;
    const agent = agentScores[dim.key]?.score || 0;
    const delta = agent - ide;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    
    let status;
    if (delta > 20) status = '🔥 Major +';
    else if (delta > 10) status = '✅ Better';
    else if (delta > -10) status = '➖ Similar';
    else status = '❌ Worse';
    
    console.log(`║  ${dim.icon} ${dim.name.padEnd(28)} │ ${String(ide).padStart(3)}/100 │ ${String(agent).padStart(4)}/100 │ ${deltaStr.padStart(4)} │ ${status.padEnd(9)} ║`);
  });

  console.log('╠════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  📊 OVERALL                          │ ${String(ideScores.overallScore).padStart(3)}/100 │ ${String(agentScores.overallScore).padStart(4)}/100 │ +${String(agentScores.overallScore - ideScores.overallScore).padStart(2)} │           ║`);
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');

  // ═════════════════════════════════════════════════════════════════════════
  // 展示详细子指标对比
  // ═════════════════════════════════════════════════════════════════════════
  
  console.log('\n📊 Detailed Sub-metrics Comparison');
  console.log('═'.repeat(78));

  // Functional Correctness Details
  console.log('\n🎯 Functional Correctness Breakdown:');
  const ideCorrectness = ideScores.functionalCorrectness?.details || [];
  const agentCorrectness = agentScores.functionalCorrectness?.details || [];
  
  const correctnessMetrics = ['coreLogic', 'edgeCases', 'typeCorrectness', 'outputValidation'];
  correctnessMetrics.forEach(metric => {
    const ideScore = ideCorrectness.find(d => d.metric === metric)?.score || 0;
    const agentScore = agentCorrectness.find(d => d.metric === metric)?.score || 0;
    const delta = agentScore - ideScore;
    const icon = delta > 20 ? '🔥' : delta > 0 ? '↑' : delta < 0 ? '↓' : '=';
    console.log(`   ${metric.padEnd(18)} IDE: ${String(ideScore).padStart(3)}/100  Agent: ${String(agentScore).padStart(3)}/100  ${icon} ${delta > 0 ? '+' : ''}${delta}`);
  });

  // Robustness Details
  console.log('\n🛡️ Robustness Breakdown:');
  console.log(`   Error Handling      IDE: ${String(ideScores.robustness?.errorHandling || 0).padStart(3)}/100  Agent: ${String(agentScores.robustness?.errorHandling || 0).padStart(3)}/100`);
  console.log(`   Input Validation    IDE: ${String(ideScores.robustness?.inputValidation || 0).padStart(3)}/100  Agent: ${String(agentScores.robustness?.inputValidation || 0).padStart(3)}/100`);
  console.log(`   Exception Safety    IDE: ${String(ideScores.robustness?.exceptionSafety || 0).padStart(3)}/100  Agent: ${String(agentScores.robustness?.exceptionSafety || 0).padStart(3)}/100`);
  console.log(`   Resource Cleanup    IDE: ${String(ideScores.robustness?.resourceCleanup || 0).padStart(3)}/100  Agent: ${String(agentScores.robustness?.resourceCleanup || 0).padStart(3)}/100`);

  // Dev Efficiency Details
  console.log('\n⚡ Dev Efficiency Breakdown:');
  console.log(`   Iteration Count     IDE: ${ideResult.iterationCount}      Agent: ${agentResult.iterationCount}`);
  console.log(`   Time Efficiency     IDE: ${String(ideScores.devEfficiency?.timeEfficiency || 0).padStart(3)}/100  Agent: ${String(agentScores.devEfficiency?.timeEfficiency || 0).padStart(3)}/100`);
  console.log(`   Token Efficiency    IDE: ${String(ideScores.devEfficiency?.tokenEfficiency || 0).padStart(3)}/100  Agent: ${String(agentScores.devEfficiency?.tokenEfficiency || 0).padStart(3)}/100`);
  console.log(`   Tokens Consumed     IDE: ${ideResult.tokensConsumed.toLocaleString()}   Agent: ${agentResult.tokensConsumed.toLocaleString()}`);

  // ═════════════════════════════════════════════════════════════════════════
  // Key Insights
  // ═════════════════════════════════════════════════════════════════════════
  
  console.log('\n💡 Key Insights:');
  console.log('');
  
  // 计算各项指标差异
  const correctnessDelta = (agentScores.functionalCorrectness?.score || 0) - (ideScores.functionalCorrectness?.score || 0);
  const completenessDelta = (agentScores.functionalCompleteness?.score || 0) - (ideScores.functionalCompleteness?.score || 0);
  const qualityDelta = (agentScores.codeQuality?.score || 0) - (ideScores.codeQuality?.score || 0);
  const robustnessDelta = (agentScores.robustness?.score || 0) - (ideScores.robustness?.score || 0);
  
  console.log('   1. 🔥 Functional Correctness Major Improvement (+', correctnessDelta, '):');
  console.log('      - WorkflowAgent: extensive edge case handling (NaN, Infinity checks)');
  console.log('      - WorkflowAgent: comprehensive input validation with specific error types');
  console.log('      - IDE: basic implementation with no validation');
  console.log('      Result: Agent catches bugs IDE would miss at runtime!');
  console.log('');
  
  console.log('   2. 🔥 Functional Completeness Major Improvement (+', completenessDelta, '):');
  console.log('      - WorkflowAgent: 6 exported functions vs IDE\'s 4');
  console.log('      - WorkflowAgent: bonus features (power, sqrt)');
  console.log('      - WorkflowAgent: comprehensive documentation & tests');
  console.log('      - IDE: minimal implementation, no tests, brief README');
  console.log('');
  
  console.log('   3. ✅ Code Quality Significantly Better (+', qualityDelta, '):');
  console.log('      - WorkflowAgent: JSDoc for every function, consistent naming');
  console.log('      - WorkflowAgent: modular design with helper functions');
  console.log('      - IDE: no documentation, basic structure');
  console.log('');
  
  console.log('   4. 🔥 Robustness Dramatically Higher (+', robustnessDelta, '):');
  console.log('      - WorkflowAgent: 7 test cases covering edge cases');
  console.log('      - WorkflowAgent: TypeError, RangeError for different violations');
  console.log('      - IDE: no error handling, would crash on bad input');
  console.log('');
  
  // Token efficiency analysis
  const tokenDelta = agentResult.tokensConsumed - ideResult.tokensConsumed;
  const timeDeltaSeconds = Math.floor((agentResult.durationMs - ideResult.durationMs) / 1000);
  const timeDeltaFormatted = timeDeltaSeconds > 60 ? `${Math.floor(timeDeltaSeconds / 60)}m ${timeDeltaSeconds % 60}s` : `${timeDeltaSeconds}s`;
  console.log('   5. 📊 Token/Time Trade-off:');
  console.log(`      - WorkflowAgent used ${(tokenDelta / ideResult.tokensConsumed * 100).toFixed(0)}% more tokens (${tokenDelta.toLocaleString()})`);
  console.log(`      - WorkflowAgent took ${timeDeltaFormatted} longer`);
  console.log(`      - BUT: Agent prevents runtime bugs, which would cost MORE in debugging!`);
  console.log('');
  
  console.log('   6. 🎯 ROI Analysis:');
  const bugFixCost = 5000; // Estimated tokens to fix a runtime bug
  const potentialBugsPrevented = 5; // Estimated bugs caught
  const totalBugFixCost = bugFixCost * potentialBugsPrevented;
  const extraTokensInvested = tokenDelta;
  const netRoi = totalBugFixCost - extraTokensInvested;
  console.log(`      - Bugs prevented x fix cost: ${potentialBugsPrevented} x ${bugFixCost.toLocaleString()} = ${totalBugFixCost.toLocaleString()} tokens saved`);
  console.log(`      - Extra tokens invested: ${extraTokensInvested.toLocaleString()}`);
  console.log(`      - NET ROI: +${netRoi.toLocaleString()} tokens saved`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 主运行函数
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  try {
    // 运行完整评估演示
    await demoFunctionalityEvaluation();
    
    // 运行对比演示
    await demoComparison();
    
    console.log('\n\n═══════════════════════════════════════════════════════════════════');
    console.log('  ✅ Demo completed successfully!');
    console.log('═══════════════════════════════════════════════════════════════════\n');
    
    console.log('Key takeaways:');
    console.log('  1. Functional Correctness (25%) is the MOST CRITICAL dimension');
    console.log('  2. All dimensions are automatically evaluated from code artifacts');
    console.log('  3. Edge cases, type safety, and validation are measured');
    console.log('  4. Token efficiency is tracked alongside code quality');
    console.log('');
    
  } catch (err) {
    console.error('Demo failed:', err);
    process.exit(1);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  main();
}

module.exports = {
  demoFunctionalityEvaluation,
  demoComparison,
};
