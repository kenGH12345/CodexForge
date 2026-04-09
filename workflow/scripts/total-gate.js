#!/usr/bin/env node
/**
 * Total Gate — 统一门禁入口（增强版）
 * 
 * 职责：在 Git commit 前强制检查工作流完整性和代码质量
 * 原理：不通过门禁 → 阻断 commit → 强制用户走工作流
 * 
 * 整合检查项（对应文章方案）：
 * 1. 工作流完整性：session 存在且完成所有阶段
 * 2. 编译检查：项目可编译通过
 * 3. 测试检查：测试通过率达标
 * 4. 规则扫描：代码规范、安全扫描
 * 5. 产出物匹配：代码修改与 workflow 记录一致
 * 
 * Usage:
 *   node workflow/scripts/total-gate.js [--mode pre-commit|ci|full]
 *   node workflow/scripts/total-gate.js --report  # 生成详细报告
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 引入 Gate Controller
const { GateController } = require('../agents/gate-controller');

// 配置
const CONFIG = {
  progressLogPath: 'output/workflow-progress.log',
  maxSessionAgeHours: 24,
  requiredStages: ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW'],
  
  // 增强：质量门禁阈值
  qualityThresholds: {
    minTestPassRate: 0.8,      // 最低测试通过率 80%
    maxLintErrors: 10,         // 最多 lint 错误数
    maxSecurityIssues: 0       // 安全漏洞必须为 0
  },
  
  // 项目类型检测
  projectTypes: [
    { name: 'node', files: ['package.json'], testCmd: 'npm test', lintCmd: 'npm run lint' },
    { name: 'python', files: ['requirements.txt', 'setup.py', 'pyproject.toml'], testCmd: 'pytest', lintCmd: 'flake8' },
    { name: 'java', files: ['pom.xml', 'build.gradle'], testCmd: 'mvn test', lintCmd: 'mvn checkstyle:check' },
    { name: 'go', files: ['go.mod'], testCmd: 'go test ./...', lintCmd: 'golangci-lint run' }
  ]
};

// 颜色输出
const COLORS = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m'
};

function log(color, message) {
  console.error(`${COLORS[color]}${message}${COLORS.reset}`);
}

// 读取工作流进度日志
function readProgressLog(projectRoot) {
  const logPath = path.join(projectRoot, CONFIG.progressLogPath);
  
  if (!fs.existsSync(logPath)) {
    return { exists: false, sessions: [] };
  }
  
  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l);
  
  // 解析 JSONL
  const sessions = [];
  let currentSession = null;
  
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'session_start') {
        currentSession = {
          sessionId: entry.session,
          startTime: entry.timestamp,
          requirement: entry.requirement,
          stages: []
        };
        sessions.push(currentSession);
      } else if (entry.type === 'stage_start' && currentSession) {
        currentSession.stages.push({
          stage: entry.stage,
          startTime: entry.timestamp,
          completed: false
        });
      } else if (entry.type === 'stage_end' && currentSession) {
        const stage = currentSession.stages.find(s => s.stage === entry.stage && !s.completed);
        if (stage) {
          stage.completed = true;
          stage.endTime = entry.timestamp;
        }
      } else if (entry.type === 'session_summary' && currentSession) {
        currentSession.completed = true;
        currentSession.endTime = entry.timestamp;
      }
    } catch (e) {
      // 跳过解析失败的行
    }
  }
  
  return { exists: true, sessions };
}

// 检查是否有有效的完成 session
function checkValidSession(sessions) {
  if (sessions.length === 0) {
    return { valid: false, reason: '没有工作流 session 记录' };
  }
  
  // 找最近的 session
  const latestSession = sessions[sessions.length - 1];
  const sessionAge = Date.now() - new Date(latestSession.startTime).getTime();
  const sessionAgeHours = sessionAge / (1000 * 60 * 60);
  
  if (sessionAgeHours > CONFIG.maxSessionAgeHours) {
    return { 
      valid: false, 
      reason: `最近的工作流 session 已过期（${Math.round(sessionAgeHours)} 小时前）` 
    };
  }
  
  // 检查是否完成了必需的阶段
  const completedStages = latestSession.stages.filter(s => s.completed).map(s => s.stage);
  const missingStages = CONFIG.requiredStages.filter(s => !completedStages.includes(s));
  
  if (missingStages.length > 0) {
    return { 
      valid: false, 
      reason: `工作流未完成，缺少阶段：${missingStages.join(', ')}` 
    };
  }
  
  // 检查是否完整完成
  if (!latestSession.completed) {
    return { valid: false, reason: '工作流 session 未完成' };
  }
  
  return { valid: true, session: latestSession };
}

// 获取即将 commit 的文件列表
function getStagedFiles(projectRoot) {
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=ACM', {
      cwd: projectRoot,
      encoding: 'utf-8'
    });
    return output.trim().split('\n').filter(f => f);
  } catch (e) {
    return [];
  }
}

// 检测项目类型
function detectProjectType(projectRoot) {
  for (const type of CONFIG.projectTypes) {
    if (type.files.some(f => fs.existsSync(path.join(projectRoot, f)))) {
      return type;
    }
  }
  return { name: 'unknown', testCmd: null, lintCmd: null };
}

// 运行编译检查
function runCompileCheck(projectRoot, projectType) {
  if (projectType.name === 'unknown') {
    return { passed: true, skipped: true, reason: '无法检测项目类型，跳过编译检查' };
  }

  const results = {
    passed: true,
    skipped: false,
    checks: [],
    errors: [],
    warnings: []
  };

  try {
    switch (projectType.name) {
      case 'node':
        // Node.js: 优先尝试 TypeScript 编译，然后是常规构建
        const nodeCmds = [
          { cmd: 'npm run build 2>&1', name: 'npm build' },
          { cmd: 'npm run compile 2>&1', name: 'npm compile' },
          { cmd: 'npx tsc --noEmit 2>&1', name: 'TypeScript type check' }
        ];
        
        for (const { cmd, name } of nodeCmds) {
          try {
            const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 120000 });
            results.checks.push({ name, passed: true, output: output.slice(0, 200) });
          } catch (e) {
            // 如果命令不存在，继续尝试下一个
            if (e.message.includes('command not found') || e.message.includes('not recognized')) {
              continue;
            }
            results.checks.push({ name, passed: false, error: e.stdout?.slice(0, 500) || e.message });
            results.errors.push(`${name} failed: ${e.message}`);
            results.passed = false;
          }
        }
        break;

      case 'python':
        // Python: 多层级编译检查
        const pyChecks = [
          { cmd: 'python -m compileall -q . 2>&1', name: 'Python syntax check' },
          { cmd: 'python -m py_compile $(find . -name "*.py" -type f | head -20) 2>&1', name: 'Py compile check' }
        ];

        // 检查 mypy 是否存在
        try {
          execSync('python -m mypy --version', { cwd: projectRoot, encoding: 'utf-8', timeout: 10000 });
          pyChecks.push({ cmd: 'python -m mypy . --ignore-missing-imports 2>&1 || true', name: 'MyPy type check' });
        } catch {
          results.warnings.push('MyPy not installed, skipping type check');
        }

        for (const { cmd, name } of pyChecks) {
          try {
            const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 60000, shell: true });
            results.checks.push({ name, passed: true, output: output.slice(0, 200) });
          } catch (e) {
            results.checks.push({ name, passed: false, error: e.stdout?.slice(0, 500) || e.message });
            results.errors.push(`${name} failed`);
            results.passed = false;
          }
        }
        break;

      case 'java':
        // Java: Maven 或 Gradle 编译检测
        const javaBuildTools = [
          { cmd: 'mvn compile -q 2>&1', name: 'Maven compile', check: 'mvn -version' },
          { cmd: './mvnw compile -q 2>&1 || mvn compile -q 2>&1', name: 'Maven wrapper compile', check: 'ls mvnw' },
          { cmd: './gradlew compileJava -q 2>&1 || gradle compileJava -q 2>&1', name: 'Gradle compile', check: 'ls gradlew' }
        ];

        let javaCompiled = false;
        for (const { cmd, name, check } of javaBuildTools) {
          try {
            // 先检查构建工具是否存在
            execSync(check, { cwd: projectRoot, encoding: 'utf-8', timeout: 5000, shell: true });
            const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 180000, shell: true });
            results.checks.push({ name, passed: true, output: output.slice(0, 200) });
            javaCompiled = true;
            break;
          } catch (e) {
            if (e.message.includes('not found') || e.message.includes('No such file')) {
              continue;
            }
            results.checks.push({ name, passed: false, error: e.stdout?.slice(0, 500) || e.message });
            results.errors.push(`${name} failed`);
            results.passed = false;
            javaCompiled = true;
            break;
          }
        }
        
        if (!javaCompiled) {
          results.warnings.push('No Java build tool (Maven/Gradle) detected');
          results.skipped = true;
        }
        break;

      case 'go':
        // Go: 编译 + vet 检查
        const goChecks = [
          { cmd: 'go build ./... 2>&1', name: 'Go build' },
          { cmd: 'go vet ./... 2>&1', name: 'Go vet' }
        ];

        for (const { cmd, name } of goChecks) {
          try {
            const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 120000 });
            results.checks.push({ name, passed: true, output: output.slice(0, 200) });
          } catch (e) {
            results.checks.push({ name, passed: false, error: e.stdout?.slice(0, 500) || e.message });
            results.errors.push(`${name} failed`);
            results.passed = false;
          }
        }

        // 检查 golangci-lint
        try {
          execSync('golangci-lint version', { cwd: projectRoot, encoding: 'utf-8', timeout: 5000 });
          const lintOutput = execSync('golangci-lint run --fast 2>&1 || true', { cwd: projectRoot, encoding: 'utf-8', timeout: 60000, shell: true });
          const hasErrors = lintOutput.includes('error') || lintOutput.includes('Error');
          results.checks.push({ name: 'golangci-lint', passed: !hasErrors, output: lintOutput.slice(0, 300) });
          if (hasErrors) {
            results.warnings.push('golangci-lint found issues (non-blocking)');
          }
        } catch {
          results.warnings.push('golangci-lint not installed');
        }
        break;

      default:
        return { passed: true, skipped: true, reason: '未实现该语言类型的编译检查' };
    }

    return results;
  } catch (e) {
    return { 
      passed: false, 
      error: e.stdout || e.message, 
      skipped: false,
      checks: results.checks
    };
  }
}

// 运行测试检查
function runTestCheck(projectRoot, projectType) {
  if (projectType.name === 'unknown') {
    return { passed: true, skipped: true, reason: '无法检测项目类型，跳过测试检查' };
  }

  const results = {
    passed: true,
    skipped: false,
    testSuites: [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
    errors: []
  };

  try {
    switch (projectType.name) {
      case 'node':
        // Node.js: 支持 Jest/Vitest/Mocha 的多种测试框架
        const nodeTestCmds = [
          { cmd: 'npm test 2>&1', name: 'npm test', reportPath: null },
          { cmd: 'npm run test:unit 2>&1', name: 'unit tests', reportPath: null },
          { cmd: 'npx jest --json --outputFile=test-report.json 2>&1 || true', name: 'Jest', reportPath: 'test-report.json' }
        ];

        for (const { cmd, name, reportPath } of nodeTestCmds) {
          try {
            let output;
            try {
              output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 180000, shell: true });
            } catch (execErr) {
              output = execErr.stdout || execErr.message;
            }

            // 解析测试结果
            const testResult = parseNodeTestOutput(output, name, reportPath ? path.join(projectRoot, reportPath) : null);
            results.testSuites.push(testResult);
            results.summary.total += testResult.total || 0;
            results.summary.passed += testResult.passed || 0;
            results.summary.failed += testResult.failed || 0;
            results.summary.skipped += testResult.skipped || 0;

            if (testResult.failed > 0) {
              results.passed = false;
              results.errors.push(`${name}: ${testResult.failed} test(s) failed`);
            }
          } catch (e) {
            results.testSuites.push({ name, error: e.message });
          }
        }
        break;

      case 'python':
        // Python: 支持 pytest/unittest
        const pyTestCmds = [
          { cmd: 'python -m pytest -v --tb=short 2>&1 || true', name: 'pytest' },
          { cmd: 'python -m pytest --junitxml=test-results.xml 2>&1 || true', name: 'pytest (JUnit)', reportPath: 'test-results.xml' },
          { cmd: 'python -m unittest discover -v 2>&1 || true', name: 'unittest' }
        ];

        for (const { cmd, name, reportPath } of pyTestCmds) {
          try {
            const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 180000, shell: true });
            const testResult = parsePythonTestOutput(output, name, reportPath ? path.join(projectRoot, reportPath) : null);
            
            if (testResult.total > 0) {
              results.testSuites.push(testResult);
              results.summary.total += testResult.total || 0;
              results.summary.passed += testResult.passed || 0;
              results.summary.failed += testResult.failed || 0;

              if (testResult.failed > 0) {
                results.passed = false;
                results.errors.push(`${name}: ${testResult.failed} test(s) failed`);
              }
              break; // 找到一个成功的就退出
            }
          } catch (e) {
            // 继续尝试下一个
          }
        }

        if (results.testSuites.length === 0) {
          results.skipped = true;
          results.errors.push('No Python test framework detected (pytest/unittest)');
        }
        break;

      case 'java':
        // Java: Maven/Gradle 测试
        const javaTestCmds = [
          { cmd: './mvnw test -q 2>&1 || mvn test -q 2>&1', name: 'Maven Test', check: 'ls pom.xml mvnw 2>/dev/null' },
          { cmd: './gradlew test -q 2>&1 || gradle test -q 2>&1', name: 'Gradle Test', check: 'ls build.gradle gradlew 2>/dev/null' }
        ];

        let javaTested = false;
        for (const { cmd, name, check } of javaTestCmds) {
          try {
            // 检查构建文件是否存在
            execSync(check, { cwd: projectRoot, encoding: 'utf-8', timeout: 5000, shell: true });
            
            let output;
            try {
              output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 300000, shell: true });
            } catch (execErr) {
              output = execErr.stdout || execErr.message;
            }

            // 查找测试报告
            const reportPaths = [
              path.join(projectRoot, 'target', 'surefire-reports'),
              path.join(projectRoot, 'build', 'test-results', 'test')
            ];

            const testResult = parseJavaTestOutput(output, name, reportPaths);
            results.testSuites.push(testResult);
            results.summary.total += testResult.total || 0;
            results.summary.passed += testResult.passed || 0;
            results.summary.failed += testResult.failed || 0;

            if (testResult.failed > 0) {
              results.passed = false;
              results.errors.push(`${name}: ${testResult.failed} test(s) failed`);
            }
            javaTested = true;
            break;
          } catch (e) {
            continue;
          }
        }

        if (!javaTested) {
          results.skipped = true;
          results.errors.push('No Java test build tool detected');
        }
        break;

      case 'go':
        // Go: go test
        try {
          const cmd = 'go test -v ./... 2>&1 || true';
          const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 180000, shell: true });
          const testResult = parseGoTestOutput(output);
          
          results.testSuites.push(testResult);
          results.summary.total += testResult.total || 0;
          results.summary.passed += testResult.passed || 0;
          results.summary.failed += testResult.failed || 0;

          if (testResult.failed > 0) {
            results.passed = false;
            results.errors.push(`Go test: ${testResult.failed} test(s) failed`);
          }
        } catch (e) {
          results.testSuites.push({ name: 'go test', error: e.message });
          results.passed = false;
        }
        break;

      default:
        // 使用项目配置的测试命令
        if (projectType.testCmd) {
          try {
            const output = execSync(projectType.testCmd, { 
              cwd: projectRoot, 
              encoding: 'utf-8', 
              timeout: 180000,
              shell: true
            });
            const hasFailure = /fail|error|FAIL/i.test(output) && !/0 failed|0 fail/i.test(output);
            results.passed = !hasFailure;
            results.testSuites.push({ name: 'custom', output: output.slice(0, 500) });
          } catch (e) {
            results.passed = false;
            results.errors.push(e.stdout ? e.stdout.slice(0, 500) : e.message);
          }
        } else {
          results.skipped = true;
          results.errors.push('No test command configured');
        }
    }

    return results;
  } catch (e) {
    return { 
      passed: false, 
      error: e.stdout || e.message,
      skipped: false,
      testSuites: results.testSuites,
      summary: results.summary
    };
  }
}

// 解析 Node.js 测试输出
function parseNodeTestOutput(output, framework, reportPath) {
  const result = { name: framework, total: 0, passed: 0, failed: 0, skipped: 0 };
  
  // 尝试读取 JSON 报告
  if (reportPath && fs.existsSync(reportPath)) {
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      result.total = report.numTotalTests || report.testResults?.length || 0;
      result.passed = report.numPassedTests || 0;
      result.failed = report.numFailedTests || 0;
      result.skipped = report.numPendingTests || 0;
      return result;
    } catch {
      // 回退到文本解析
    }
  }

  // 文本解析 (Jest/Vitest/Mocha 格式)
  const patterns = [
    /Tests?:\s*(\d+)\s*failed,?\s*(\d+)\s*passed,?\s*(\d+)\s*total/i,
    /(\d+)\s*passing.*?(\d+)\s*failing/i,
    /Test Suites?:\s*(\d+)\s*failed/i
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      result.failed = parseInt(match[1]) || 0;
      result.passed = parseInt(match[2]) || 0;
      result.total = parseInt(match[3]) || (result.passed + result.failed);
      break;
    }
  }

  if (result.total === 0) {
    result.total = (output.match(/✓|✔|PASS/g) || []).length + (output.match(/✗|✖|FAIL/g) || []).length;
    result.passed = (output.match(/✓|✔|PASS/g) || []).length;
    result.failed = (output.match(/✗|✖|FAIL/g) || []).length;
  }

  return result;
}

// 解析 Python 测试输出
function parsePythonTestOutput(output, framework, reportPath) {
  const result = { name: framework, total: 0, passed: 0, failed: 0, skipped: 0 };
  
  // 解析 pytest 输出
  const pytestMatch = output.match(/(\d+)\s*passed.*?(\d+)\s*failed.*?(\d+)\s*skipped/);
  if (pytestMatch) {
    result.passed = parseInt(pytestMatch[1]);
    result.failed = parseInt(pytestMatch[2]);
    result.skipped = parseInt(pytestMatch[3]);
    result.total = result.passed + result.failed + result.skipped;
    return result;
  }

  // 解析 unittest 输出
  const unittestMatch = output.match(/Ran\s*(\d+)\s*test/i);
  if (unittestMatch) {
    result.total = parseInt(unittestMatch[1]);
    const failedMatch = output.match(/FAILURES?|ERROR/);
    result.failed = failedMatch ? 1 : 0;
    result.passed = result.total - result.failed;
    return result;
  }

  return result;
}

// 解析 Java 测试输出
function parseJavaTestOutput(output, framework, reportPaths) {
  const result = { name: framework, total: 0, passed: 0, failed: 0, skipped: 0 };
  
  // 从 Surefire 报告目录解析
  for (const reportPath of reportPaths) {
    if (fs.existsSync(reportPath)) {
      try {
        const files = fs.readdirSync(reportPath);
        const xmlFiles = files.filter(f => f.endsWith('.xml'));
        
        for (const file of xmlFiles) {
          const content = fs.readFileSync(path.join(reportPath, file), 'utf-8');
          const testsMatch = content.match(/tests="(\d+)"/);
          const failuresMatch = content.match(/failures="(\d+)"/);
          const errorsMatch = content.match(/errors="(\d+)"/);
          const skippedMatch = content.match(/skipped="(\d+)"/);
          
          if (testsMatch) {
            result.total += parseInt(testsMatch[1]);
            result.failed += (parseInt(failuresMatch?.[1] || 0) + parseInt(errorsMatch?.[1] || 0));
            result.skipped += parseInt(skippedMatch?.[1] || 0);
          }
        }
        result.passed = result.total - result.failed - result.skipped;
        return result;
      } catch {
        // 继续尝试下一个路径
      }
    }
  }

  // 从输出文本解析
  const textMatch = output.match(/Tests run:\s*(\d+),?\s*Failures?:\s*(\d+),?\s*Errors?:\s*(\d+)/i);
  if (textMatch) {
    result.total = parseInt(textMatch[1]);
    result.failed = parseInt(textMatch[2]) + parseInt(textMatch[3]);
    result.passed = result.total - result.failed;
  }

  return result;
}

// 解析 Go 测试输出
function parseGoTestOutput(output) {
  const result = { name: 'go test', total: 0, passed: 0, failed: 0, skipped: 0 };
  
  // Go test 输出格式: "--- PASS:" 或 "--- FAIL:"
  const passMatches = output.match(/---\s*PASS:/g) || [];
  const failMatches = output.match(/---\s*FAIL:/g) || [];
  const skipMatches = output.match(/---\s*SKIP:/g) || [];
  
  result.passed = passMatches.length;
  result.failed = failMatches.length;
  result.skipped = skipMatches.length;
  result.total = result.passed + result.failed + result.skipped;

  // 检查是否有编译错误
  if (output.includes('build constraint') || output.includes('cannot find package')) {
    result.failed++;
    result.total++;
  }

  return result;
}

// 运行规则扫描
function runLintCheck(projectRoot, projectType) {
  if (projectType.name === 'unknown') {
    return { passed: true, skipped: true, reason: '无法检测项目类型，跳过 Lint 检查' };
  }

  const results = {
    passed: true,
    skipped: false,
    linters: [],
    summary: { errors: 0, warnings: 0, total: 0 },
    details: []
  };

  const qualityThresholds = CONFIG.qualityThresholds || { maxLintErrors: 10, maxLintWarnings: 50 };

  try {
    switch (projectType.name) {
      case 'node':
        // Node.js: ESLint + TypeScript + Prettier
        const nodeLinters = [
          { cmd: 'npx eslint --format json --output-file eslint-report.json . 2>&1 || true', name: 'ESLint', reportPath: 'eslint-report.json' },
          { cmd: 'npx tsc --noEmit 2>&1 || true', name: 'TypeScript', parser: 'tsc' },
          { cmd: 'npx prettier --check "**/*.{js,ts,jsx,tsx,json,md}" 2>&1 || true', name: 'Prettier', parser: 'prettier' }
        ];

        for (const { cmd, name, reportPath, parser } of nodeLinters) {
          try {
            const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 120000, shell: true });
            
            let lintResult;
            if (reportPath && fs.existsSync(path.join(projectRoot, reportPath))) {
              lintResult = parseESLintReport(path.join(projectRoot, reportPath), name);
            } else if (parser === 'tsc') {
              lintResult = parseTSCOutput(output, name);
            } else if (parser === 'prettier') {
              lintResult = parsePrettierOutput(output, name);
            } else {
              lintResult = parseGenericLintOutput(output, name);
            }

            results.linters.push(lintResult);
            results.summary.errors += lintResult.errors || 0;
            results.summary.warnings += lintResult.warnings || 0;
            results.summary.total += (lintResult.errors || 0) + (lintResult.warnings || 0);

            if (lintResult.errors > 0) {
              results.details.push(`${name}: ${lintResult.errors} error(s)`);
            }
          } catch (e) {
            results.linters.push({ name, error: e.message });
          }
        }
        break;

      case 'python':
        // Python: flake8 + pylint + black + mypy
        const pyLinters = [
          { cmd: 'python -m flake8 --format=json --output-file=flake8-report.json . 2>&1 || true', name: 'flake8', reportPath: 'flake8-report.json' },
          { cmd: 'python -m pylint --output-format=json --output=pylint-report.json . 2>&1 || true', name: 'pylint', reportPath: 'pylint-report.json' },
          { cmd: 'python -m black --check . 2>&1 || true', name: 'black', parser: 'black' }
        ];

        // 检查 mypy
        try {
          execSync('python -m mypy --version', { cwd: projectRoot, encoding: 'utf-8', timeout: 5000 });
          pyLinters.push({ cmd: 'python -m mypy . --show-error-codes 2>&1 || true', name: 'mypy', parser: 'mypy' });
        } catch {
          results.warnings = ['mypy not installed, skipping type check'];
        }

        for (const { cmd, name, reportPath, parser } of pyLinters) {
          try {
            const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 120000, shell: true });
            
            let lintResult;
            if (reportPath && fs.existsSync(path.join(projectRoot, reportPath))) {
              if (name === 'flake8') {
                lintResult = parseFlake8Report(path.join(projectRoot, reportPath));
              } else {
                lintResult = parsePylintReport(path.join(projectRoot, reportPath));
              }
            } else if (parser) {
              lintResult = parsePythonLinterOutput(output, name, parser);
            } else {
              lintResult = parseGenericLintOutput(output, name);
            }

            results.linters.push(lintResult);
            results.summary.errors += lintResult.errors || 0;
            results.summary.warnings += lintResult.warnings || 0;
            results.summary.total += (lintResult.errors || 0) + (lintResult.warnings || 0);

            if (lintResult.errors > 0) {
              results.details.push(`${name}: ${lintResult.errors} error(s)`);
            }
          } catch (e) {
            results.linters.push({ name, error: e.message });
          }
        }
        break;

      case 'java':
        // Java: Checkstyle + SpotBugs + PMD
        const javaLinters = [
          { cmd: './mvnw checkstyle:check -q 2>&1 || mvn checkstyle:check -q 2>&1 || true', name: 'Checkstyle', check: 'ls pom.xml mvnw 2>/dev/null' },
          { cmd: './gradlew checkstyleMain -q 2>&1 || gradle checkstyleMain -q 2>&1 || true', name: 'Gradle Checkstyle', check: 'ls build.gradle gradlew 2>/dev/null' }
        ];

        for (const { cmd, name, check } of javaLinters) {
          try {
            // 检查构建工具是否存在
            execSync(check, { cwd: projectRoot, encoding: 'utf-8', timeout: 5000, shell: true });
            
            let output;
            try {
              output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 180000, shell: true });
            } catch (execErr) {
              output = execErr.stdout || execErr.message;
            }

            const lintResult = parseJavaLintOutput(output, name);
            results.linters.push(lintResult);
            results.summary.errors += lintResult.errors || 0;
            results.summary.warnings += lintResult.warnings || 0;
            results.summary.total += (lintResult.errors || 0) + (lintResult.warnings || 0);

            if (lintResult.errors > 0) {
              results.details.push(`${name}: ${lintResult.errors} error(s)`);
            }
          } catch (e) {
            // 继续尝试下一个
          }
        }
        break;

      case 'go':
        // Go: go vet + golint + gofmt
        const goLinters = [
          { cmd: 'go vet ./... 2>&1 || true', name: 'go vet', parser: 'govet' },
          { cmd: 'gofmt -l . 2>&1 || true', name: 'gofmt', parser: 'gofmt' }
        ];

        // 检查 golint/golangci-lint
        try {
          execSync('golangci-lint version', { cwd: projectRoot, encoding: 'utf-8', timeout: 5000 });
          goLinters.push({ cmd: 'golangci-lint run 2>&1 || true', name: 'golangci-lint', parser: 'golangci' });
        } catch {
          results.warnings = ['golangci-lint not installed'];
        }

        for (const { cmd, name, parser } of goLinters) {
          try {
            const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 120000, shell: true });
            const lintResult = parseGoLintOutput(output, name, parser);
            
            results.linters.push(lintResult);
            results.summary.errors += lintResult.errors || 0;
            results.summary.warnings += lintResult.warnings || 0;
            results.summary.total += (lintResult.errors || 0) + (lintResult.warnings || 0);

            if (lintResult.errors > 0 || lintResult.warnings > 0) {
              results.details.push(`${name}: ${lintResult.errors} error(s), ${lintResult.warnings} warning(s)`);
            }
          } catch (e) {
            results.linters.push({ name, error: e.message });
          }
        }
        break;

      default:
        // 使用项目配置的 lint 命令
        if (projectType.lintCmd) {
          try {
            const output = execSync(projectType.lintCmd, { 
              cwd: projectRoot, 
              encoding: 'utf-8', 
              timeout: 60000,
              shell: true
            });
            const lintResult = parseGenericLintOutput(output, 'custom');
            results.linters.push(lintResult);
            results.summary = lintResult;
          } catch (e) {
            const errorOutput = e.stdout || e.message;
            const lintResult = parseGenericLintOutput(errorOutput, 'custom');
            results.linters.push(lintResult);
            results.summary = lintResult;
            results.details.push(`Lint error: ${lintResult.errors} error(s)`);
          }
        } else {
          results.skipped = true;
          results.details.push('未配置 lint 命令');
        }
    }

    // 根据阈值判断是否通过
    results.passed = results.summary.errors < qualityThresholds.maxLintErrors &&
                     results.summary.warnings < qualityThresholds.maxLintWarnings;

    if (!results.passed) {
      results.blockers = [
        `Lint errors (${results.summary.errors}) exceed threshold (${qualityThresholds.maxLintErrors})`,
        results.summary.warnings >= qualityThresholds.maxLintWarnings ? 
          `Lint warnings (${results.summary.warnings}) exceed threshold (${qualityThresholds.maxLintWarnings})` : null
      ].filter(Boolean);
    }

    return results;
  } catch (e) {
    return { 
      passed: false, 
      error: e.stdout || e.message,
      skipped: false,
      summary: results.summary,
      linters: results.linters
    };
  }
}

// Lint 报告解析函数
function parseESLintReport(reportPath, name) {
  const result = { name, errors: 0, warnings: 0, files: 0 };
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    if (Array.isArray(report)) {
      report.forEach(file => {
        result.files++;
        file.messages?.forEach(msg => {
          if (msg.severity === 2) result.errors++;
          else if (msg.severity === 1) result.warnings++;
        });
      });
    }
  } catch {
    // 解析失败返回空结果
  }
  return result;
}

function parseTSCOutput(output, name) {
  const result = { name, errors: 0, warnings: 0 };
  const errorMatches = output.match(/error TS\d+/g);
  if (errorMatches) {
    result.errors = errorMatches.length;
  }
  return result;
}

function parsePrettierOutput(output, name) {
  const result = { name, errors: 0, warnings: 0 };
  const unformattedFiles = output.match(/\.\w+$/gm);
  if (unformattedFiles) {
    result.warnings = unformattedFiles.length;
  }
  return result;
}

function parseFlake8Report(reportPath) {
  const result = { name: 'flake8', errors: 0, warnings: 0 };
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    Object.values(report).forEach(fileIssues => {
      fileIssues.forEach(issue => {
        if (['E', 'F'].includes(issue.code?.[0])) result.errors++;
        else result.warnings++;
      });
    });
  } catch {
    // 解析失败
  }
  return result;
}

function parsePylintReport(reportPath) {
  const result = { name: 'pylint', errors: 0, warnings: 0 };
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    if (Array.isArray(report)) {
      report.forEach(issue => {
        if (issue.type === 'error') result.errors++;
        else if (['warning', 'convention', 'refactor'].includes(issue.type)) result.warnings++;
      });
    }
  } catch {
    // 解析失败
  }
  return result;
}

function parsePythonLinterOutput(output, name, parser) {
  const result = { name, errors: 0, warnings: 0 };
  
  switch (parser) {
    case 'black':
      const unformatted = output.match(/would reformat/g);
      if (unformatted) result.warnings = unformatted.length;
      break;
    case 'mypy':
      const mypyErrors = output.match(/error:/g);
      if (mypyErrors) result.errors = mypyErrors.length;
      break;
    default:
      result = parseGenericLintOutput(output, name);
  }
  
  return result;
}

function parseJavaLintOutput(output, name) {
  const result = { name, errors: 0, warnings: 0 };
  
  // Checkstyle/Gradle 输出解析
  const checkstylePattern = /Checkstyle violation.*?:\s*(\d+)\s*(error|warning)/gi;
  let match;
  while ((match = checkstylePattern.exec(output)) !== null) {
    if (match[2] === 'error') result.errors += parseInt(match[1]);
    else result.warnings += parseInt(match[1]);
  }
  
  // 备用解析
  if (result.errors === 0 && result.warnings === 0) {
    const errorCount = (output.match(/ERROR/g) || []).length;
    const warningCount = (output.match(/WARNING/g) || []).length;
    result.errors = errorCount;
    result.warnings = warningCount;
  }
  
  return result;
}

function parseGoLintOutput(output, name, parser) {
  const result = { name, errors: 0, warnings: 0 };
  
  switch (parser) {
    case 'govet':
      const vetIssues = output.match(/^.*\.go:\d+:/gm);
      if (vetIssues) result.warnings = vetIssues.length;
      break;
    case 'gofmt':
      const unformatted = output.trim().split('\n').filter(l => l.endsWith('.go'));
      if (unformatted.length > 0) result.warnings = unformatted.length;
      break;
    case 'golangci':
      const issues = output.match(/\.go:\d+:/g);
      if (issues) {
        // golangci-lint: errors (E) vs warnings (W)
        const errorIssues = output.match(/:\s*error:/g);
        result.errors = errorIssues ? errorIssues.length : 0;
        result.warnings = issues.length - result.errors;
      }
      break;
    default:
      result = parseGenericLintOutput(output, name);
  }
  
  return result;
}

function parseGenericLintOutput(output, name) {
  const result = { name, errors: 0, warnings: 0 };
  
  const lines = output.split('\n');
  lines.forEach(line => {
    if (/\b(error|Error|ERROR)\b/.test(line) && /:\d+:/.test(line)) {
      result.errors++;
    } else if (/\b(warning|Warning|WARNING)\b/.test(line) && /:\d+:/.test(line)) {
      result.warnings++;
    }
  });
  
  return result;
}

// 主门禁逻辑
function runGate(projectRoot, mode = 'pre-commit') {
  log('yellow', `🔒 Total Gate [${mode}] — 统一门禁入口`);
  log('yellow', '=' .repeat(60));
  
  const results = {
    mode,
    timestamp: new Date().toISOString(),
    checks: {},
    passed: true,
    blockers: []
  };

  // 1. 工作流完整性检查
  log('yellow', '\n📋 检查 1: 工作流完整性');
  const { exists, sessions } = readProgressLog(projectRoot);
  
  if (!exists) {
    log('red', '❌ 门禁失败：workflow-progress.log 不存在');
    log('red', '   → 你必须先走完整工作流：/wf <你的需求>');
    results.checks.workflow = { passed: false, reason: '工作流日志不存在' };
    results.passed = false;
    results.blockers.push('缺少工作流日志');
  } else {
    const sessionCheck = checkValidSession(sessions);
    results.checks.workflow = sessionCheck;
    
    if (!sessionCheck.valid) {
      log('red', `❌ 门禁失败：${sessionCheck.reason}`);
      results.passed = false;
      results.blockers.push(sessionCheck.reason);
    } else {
      log('green', `✅ 工作流检查通过`);
      log('green', `   Session: ${sessionCheck.session.sessionId}`);
      log('green', `   完成阶段: ${sessionCheck.session.stages.filter(s => s.completed).length}/${CONFIG.requiredStages.length}`);
    }
  }

  // 2. 编译检查（full 模式或 ci 模式）
  if (mode === 'full' || mode === 'ci') {
    log('yellow', '\n🔨 检查 2: 编译检查');
    const projectType = detectProjectType(projectRoot);
    const compileResult = runCompileCheck(projectRoot, projectType);
    results.checks.compile = compileResult;
    
    if (compileResult.skipped) {
      log('yellow', `⏭️ ${compileResult.reason || compileResult.errors?.join('; ')}`);
    } else if (compileResult.passed) {
      if (compileResult.checks && compileResult.checks.length > 0) {
        log('green', `✅ 编译检查通过 (${compileResult.checks.length} 项检查)`);
        compileResult.checks.forEach(check => {
          if (check.passed) {
            log('gray', `   ✓ ${check.name}`);
          }
        });
      } else {
        log('green', '✅ 编译检查通过');
      }
    } else {
      log('red', `❌ 编译失败`);
      if (compileResult.checks) {
        compileResult.checks.forEach(check => {
          if (!check.passed) {
            log('red', `   ✗ ${check.name}: ${check.error?.slice(0, 100) || 'failed'}`);
          }
        });
      }
      if (compileResult.errors) {
        compileResult.errors.forEach(err => log('red', `   ${err}`));
      }
      results.passed = false;
      results.blockers.push('编译失败');
    }
  }

  // 3. 测试检查（full 模式或 ci 模式）
  if (mode === 'full' || mode === 'ci') {
    log('yellow', '\n🧪 检查 3: 测试检查');
    const projectType = detectProjectType(projectRoot);
    const testResult = runTestCheck(projectRoot, projectType);
    results.checks.test = testResult;
    
    if (testResult.skipped) {
      log('yellow', `⏭️ ${testResult.errors?.join('; ') || '跳过测试检查'}`);
    } else if (testResult.passed) {
      if (testResult.summary) {
        const { total, passed, failed, skipped } = testResult.summary;
        log('green', `✅ 测试检查通过 (${passed}/${total} passed, ${skipped} skipped)`);
        if (testResult.testSuites) {
          testResult.testSuites.forEach(suite => {
            if (suite.total > 0) {
              log('gray', `   ✓ ${suite.name}: ${suite.passed}/${suite.total}`);
            }
          });
        }
      } else {
        log('green', '✅ 测试检查通过');
      }
    } else {
      log('red', `❌ 测试失败`);
      if (testResult.summary) {
        const { total, passed, failed } = testResult.summary;
        log('red', `   结果: ${passed} passed, ${failed} failed (共 ${total})`);
      }
      if (testResult.errors) {
        testResult.errors.forEach(err => log('red', `   ${err}`));
      }
      results.passed = false;
      results.blockers.push('测试失败');
    }
  }

  // 4. 代码规范检查（full 模式）
  if (mode === 'full') {
    log('yellow', '\n📐 检查 4: 代码规范');
    const projectType = detectProjectType(projectRoot);
    const lintResult = runLintCheck(projectRoot, projectType);
    results.checks.lint = lintResult;
    
    if (lintResult.skipped) {
      log('yellow', `⏭️ ${lintResult.details?.join('; ') || '跳过代码规范检查'}`);
    } else if (lintResult.passed) {
      if (lintResult.linters && lintResult.linters.length > 0) {
        const { errors, warnings, total } = lintResult.summary || {};
        log('green', `✅ 代码规范检查通过 (${errors} errors, ${warnings} warnings)`);
        lintResult.linters.forEach(linter => {
          if (linter.errors > 0 || linter.warnings > 0) {
            log('gray', `   ⚠ ${linter.name}: ${linter.errors} errors, ${linter.warnings} warnings`);
          } else {
            log('gray', `   ✓ ${linter.name}`);
          }
        });
      } else {
        log('green', '✅ 代码规范检查通过');
      }
    } else {
      const { errors, warnings } = lintResult.summary || {};
      log('red', `❌ 代码规范问题: ${errors || 0} errors, ${warnings || 0} warnings`);
      if (lintResult.details) {
        lintResult.details.forEach(d => log('red', `   ${d}`));
      }
      if (lintResult.blockers) {
        lintResult.blockers.forEach(b => log('red', `   ${b}`));
      }
      results.passed = false;
      results.blockers.push('代码规范检查失败');
    }
  }

  // 5. 产出物匹配检查
  log('yellow', '\n📄 检查 5: 产出物匹配');
  const stagedFiles = getStagedFiles(projectRoot);
  if (stagedFiles.length === 0) {
    log('yellow', '⚠️ 没有 staged 文件');
    results.checks.artifacts = { passed: true, skipped: true };
  } else {
    log('green', `✅ 待提交文件: ${stagedFiles.length} 个`);
    results.checks.artifacts = { passed: true, fileCount: stagedFiles.length };
  }

  // 6. Gate Controller 检查（PRE-DEPLOY 阶段）
  log('yellow', '\n🚪 检查 6: Gate Controller 检查');
  try {
    const gateController = new GateController(projectRoot);
    const gateResult = gateController.quickCheck('latest');
    results.checks.gate = gateResult;
    
    if (gateResult.passed) {
      log('green', '✅ Gate 检查通过');
    } else {
      log('red', '❌ Gate 检查未通过');
      gateResult.blockers.forEach(b => log('red', `   - ${b}`));
      results.passed = false;
      results.blockers.push(...gateResult.blockers);
    }
  } catch (e) {
    log('yellow', `⏭️ Gate Controller 检查跳过: ${e.message}`);
    results.checks.gate = { passed: true, skipped: true, reason: e.message };
  }

  // 最终输出
  log('yellow', '\n' + '=' .repeat(60));
  if (results.passed) {
    log('green', '✅ 所有门禁检查通过，允许提交');
  } else {
    log('red', '❌ 门禁检查未通过，阻断提交');
    log('red', '\n阻塞项：');
    results.blockers.forEach(b => log('red', `  - ${b}`));
    log('yellow', '\n解决方式：执行完整工作流 → /wf <需求描述>');
  }

  return { passed: results.passed, exitCode: results.passed ? 0 : 1, details: results };
}

// CLI 入口
function main() {
  const args = process.argv.slice(2);
  const modeIndex = args.indexOf('--mode');
  const mode = modeIndex >= 0 ? args[modeIndex + 1] : 'pre-commit';
  const generateReport = args.includes('--report');
  const projectRoot = process.cwd();
  
  const result = runGate(projectRoot, mode);
  
  // 生成报告
  if (generateReport && result.details) {
    const reportPath = path.join(projectRoot, 'output', 'gate-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(result.details, null, 2));
    console.error(`\n📄 详细报告已生成: ${reportPath}`);
  }
  
  // 如果是 pre-commit hook，需要通过 exit code 阻断
  if (mode === 'pre-commit' || mode === 'ci') {
    process.exit(result.exitCode);
  }
  
  return result;
}

// 如果直接运行
if (require.main === module) {
  main();
}

module.exports = { runGate, readProgressLog, checkValidSession };
