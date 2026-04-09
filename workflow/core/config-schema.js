/**
 * Config Schema — WorkFlowAgent 配置schema定义
 * 
 * 定义所有支持的配置项及其默认值
 */

'use strict';

const CONFIG_SCHEMA = {
  // 系统模式：open | closed
  // - open: AGENTS.md 软约束，用户可自由交互（默认）
  // - closed: 强制门禁模式，Git hooks 强制执行
  systemMode: {
    type: 'string',
    enum: ['open', 'closed'],
    default: 'closed',  // 默认封闭模式
    description: 'System enforcement mode'
  },

  // Git 门禁配置
  gitEnforcement: {
    type: 'object',
    default: {
      enabled: true,
      preCommitHook: true,
      commitMsgHook: false,
      autoInstall: true  // init-project 时自动安装
    },
    properties: {
      enabled: { type: 'boolean', default: true },
      preCommitHook: { type: 'boolean', default: true },
      commitMsgHook: { type: 'boolean', default: false },
      autoInstall: { type: 'boolean', default: true }
    }
  },

  // 工作流阶段配置
  workflowStages: {
    type: 'object',
    default: {
      required: ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'],
      allowSkip: [],  // 不允许跳过任何阶段（封闭模式）
      lightweightThreshold: 0  // 关闭轻量模式（封闭模式全部完整执行）
    }
  },

  // 门禁检查配置
  gateChecks: {
    type: 'object',
    default: {
      sessionValidityHours: 24,
      requireCompleteArtifact: true,
      evidenceCheck: true,  // ADR-37：必须提供 IDE 工具使用证据
      socraticChallenge: true  // 每个 stage 后自动触发苏格拉底挑战
    }
  }
};

/**
 * 验证配置对象
 * @param {Object} config - 待验证的配置
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateConfig(config) {
  const errors = [];
  
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    const value = config[key];
    
    // 检查必填
    if (value === undefined && schema.default === undefined) {
      errors.push(`Missing required config: ${key}`);
      continue;
    }
    
    // 类型检查
    if (value !== undefined && schema.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== schema.type && !(schema.type === 'array' && Array.isArray(value))) {
        errors.push(`Config ${key} should be ${schema.type}, got ${actualType}`);
      }
    }
    
    // 枚举检查
    if (value !== undefined && schema.enum && !schema.enum.includes(value)) {
      errors.push(`Config ${key} must be one of: ${schema.enum.join(', ')}`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 合并默认值
 * @param {Object} config - 用户提供的配置
 * @returns {Object} 合并后的配置
 */
function mergeDefaults(config = {}) {
  const merged = {};
  
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    if (config[key] !== undefined) {
      // 对象类型递归合并
      if (schema.type === 'object' && typeof config[key] === 'object') {
        merged[key] = { ...schema.default, ...config[key] };
      } else {
        merged[key] = config[key];
      }
    } else {
      merged[key] = schema.default;
    }
  }
  
  return merged;
}

module.exports = {
  CONFIG_SCHEMA,
  validateConfig,
  mergeDefaults
};
