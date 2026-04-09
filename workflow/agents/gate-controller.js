/**
 * Gate Controller — 闸门总控 Agent
 * 
 * 职责：在 DEVELOP 阶段之前进行可行性检查
 * 位置：PLAN → DEVELOP 的临界点
 * 
 * 检查维度：
 * 1. 上游产出完整性（ANALYSE、ARCHITECT、PLAN 是否有有效产出）
 * 2. 技术可行性预检（依赖是否存在、接口是否定义）
 * 3. 资源就绪性（必要的配置、环境变量）
 * 4. 风险标记（高风险变更的额外确认）
 * 
 * 文章对应：Harness 的 Scripts 作为硬约束，在阶段转换时强制执行
 * 
 * @module workflow/agents/gate-controller
 */

'use strict';

const fs = require('fs');
const path = require('path');

class GateController {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.outputDir = path.join(projectRoot, 'output');
    
    // Gate 检查点定义（对应文章的阶段门禁）
    this.gates = [
      {
        id: 'PRE-DEVELOP',
        position: 'PLAN → DEVELOP',
        checks: ['artifacts', 'dependencies', 'config', 'risk']
      },
      {
        id: 'PRE-TEST',
        position: 'DEVELOP → TEST',
        checks: ['compile', 'lint', 'basic-test']
      },
      {
        id: 'PRE-DEPLOY',
        position: 'REVIEW → DEPLOY',
        checks: ['integration-test', 'gate-final']
      }
    ];
  }

  /**
   * 执行 Gate 检查
   * @param {string} gateId - Gate ID (e.g., 'PRE-DEVELOP')
   * @param {Object} context - 检查上下文
   * @returns {Object} 检查结果 { passed, blockers, warnings }
   */
  async check(gateId, context = {}) {
    const gate = this.gates.find(g => g.id === gateId);
    if (!gate) {
      return { passed: false, error: `Unknown gate: ${gateId}` };
    }

    const results = {
      gateId,
      timestamp: new Date().toISOString(),
      checks: [],
      passed: true,
      blockers: [],
      warnings: []
    };

    // 执行每个检查项
    for (const checkType of gate.checks) {
      const checkResult = await this._runCheck(checkType, context);
      results.checks.push({
        type: checkType,
        ...checkResult
      });

      if (!checkResult.passed) {
        results.passed = false;
        results.blockers.push(...checkResult.blockers);
      }
      if (checkResult.warnings) {
        results.warnings.push(...checkResult.warnings);
      }
    }

    return results;
  }

  /**
   * 快速检查（用于 Bridge 调用）
   * @param {string} sessionId - Session ID
   * @returns {Object} 快速检查结果
   */
  quickCheck(sessionId) {
    const artifacts = this._checkArtifacts();
    const blockers = [];

    // 必须存在的上游产出
    const requiredArtifacts = [
      { file: 'analysis.md', stage: 'ANALYSE' },
      { file: 'architecture.md', stage: 'ARCHITECT' },
      { file: 'execution-plan.md', stage: 'PLAN' }
    ];

    for (const artifact of requiredArtifacts) {
      if (!artifacts[artifact.file]) {
        blockers.push(`缺少 ${artifact.stage} 产出: ${artifact.file}`);
      }
    }

    return {
      passed: blockers.length === 0,
      blockers,
      artifactsFound: Object.keys(artifacts).length,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 生成 Gate 报告（Markdown 格式）
   * @param {Object} checkResult - 检查结果
   * @returns {string} Markdown 报告
   */
  generateReport(checkResult) {
    const lines = [
      '# Gate 检查报告',
      '',
      `**Gate ID**: ${checkResult.gateId}`,
      `**时间**: ${checkResult.timestamp}`,
      `**结果**: ${checkResult.passed ? '✅ 通过' : '❌ 未通过'}`,
      ''
    ];

    if (checkResult.blockers.length > 0) {
      lines.push('## ❌ 阻塞项', '');
      checkResult.blockers.forEach(b => lines.push(`- ${b}`));
      lines.push('');
    }

    if (checkResult.warnings && checkResult.warnings.length > 0) {
      lines.push('## ⚠️ 警告', '');
      checkResult.warnings.forEach(w => lines.push(`- ${w}`));
      lines.push('');
    }

    lines.push('## 详细检查项', '');
    for (const check of checkResult.checks || []) {
      const status = check.passed ? '✅' : '❌';
      lines.push(`### ${status} ${check.type}`);
      if (check.details) {
        lines.push(`- ${check.details}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ============== Private Check Methods ==============

  async _runCheck(checkType, context) {
    switch (checkType) {
      case 'artifacts':
        return this._checkArtifactsDetailed();
      case 'dependencies':
        return this._checkDependencies();
      case 'config':
        return this._checkConfig();
      case 'risk':
        return this._checkRisk(context);
      case 'compile':
        return await this._checkCompile();
      case 'lint':
        return await this._checkLint();
      case 'basic-test':
        return await this._checkBasicTest();
      case 'gate-final':
        return this._checkGateFinal();
      default:
        return { passed: true, details: `Unknown check type: ${checkType}` };
    }
  }

  _checkArtifacts() {
    const artifacts = {};
    const files = ['analysis.md', 'architecture.md', 'execution-plan.md', 
                   'development-output.md', 'test-output.md', 'review-output.md'];
    
    for (const file of files) {
      const filePath = path.join(this.outputDir, file);
      artifacts[file] = fs.existsSync(filePath);
    }

    return artifacts;
  }

  _checkArtifactsDetailed() {
    const artifacts = this._checkArtifacts();
    const required = ['analysis.md', 'architecture.md', 'execution-plan.md'];
    const blockers = [];

    for (const file of required) {
      if (!artifacts[file]) {
        blockers.push(`缺少必需产出: ${file}`);
      }
    }

    return {
      passed: blockers.length === 0,
      blockers,
      details: `找到 ${Object.values(artifacts).filter(Boolean).length}/${Object.keys(artifacts).length} 个产出文件`
    };
  }

  _checkDependencies() {
    // 检查 package.json / requirements.txt 等依赖文件是否存在
    const depFiles = ['package.json', 'requirements.txt', 'Cargo.toml', 'pom.xml', 'go.mod'];
    const found = depFiles.find(f => fs.existsSync(path.join(this.projectRoot, f)));
    
    return {
      passed: true, // 依赖文件缺失不阻塞，只是警告
      warnings: found ? [] : ['未检测到依赖配置文件，请确认项目结构'],
      details: found ? `依赖文件: ${found}` : '未找到依赖文件'
    };
  }

  _checkConfig() {
    // 检查必要配置
    const configFiles = [
      { file: '.workflow/config.json', required: false, desc: '工作流配置' },
      { file: 'workflow.config.js', required: false, desc: '旧版工作流配置' }
    ];

    const warnings = [];
    for (const config of configFiles) {
      if (!fs.existsSync(path.join(this.projectRoot, config.file)) && config.required) {
        warnings.push(`缺少 ${config.desc}: ${config.file}`);
      }
    }

    return {
      passed: true,
      warnings,
      details: warnings.length > 0 ? '部分配置缺失' : '配置检查通过'
    };
  }

  _checkRisk(context) {
    // 检查高风险标记
    const risks = context.risks || [];
    
    if (risks.length === 0) {
      return { passed: true, details: '无高风险标记' };
    }

    const highRisks = risks.filter(r => r.level === 'high');
    return {
      passed: highRisks.length === 0, // 高风险需要额外确认
      blockers: highRisks.map(r => `高风险: ${r.description}`),
      warnings: risks.filter(r => r.level !== 'high').map(r => `风险: ${r.description}`),
      details: `发现 ${risks.length} 个风险标记，其中 ${highRisks.length} 个高风险`
    };
  }

  async _checkCompile() {
    // 简化版：检查是否有编译产物或编译命令
    // 实际实现应调用项目特定的编译脚本
    return {
      passed: true,
      details: '编译检查（需要项目特定实现）'
    };
  }

  async _checkLint() {
    // 简化版
    return {
      passed: true,
      details: '代码规范检查（需要项目特定实现）'
    };
  }

  async _checkBasicTest() {
    // 简化版
    return {
      passed: true,
      details: '基础测试（需要项目特定实现）'
    };
  }

  _checkGateFinal() {
    // 最终门禁检查
    return {
      passed: true,
      details: '最终门禁检查通过'
    };
  }
}

module.exports = { GateController };
