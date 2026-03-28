/**
 * Execution Log Templates – Standard execution flow definitions and stage sequence
 *
 * Extracted from execution-log-validator.js (ADR-33 Phase 4) to isolate the
 * large template data structures from the validation logic.
 *
 * @module execution-log-templates
 */

'use strict';

const { WorkflowState } = require('./types');

// ─── Standard Execution Flow Templates ──────────────────────────────────────

/**
 * Standard execution flow definition.
 * Defines what artifacts and outputs are expected from each stage.
 */
const STANDARD_EXECUTION_FLOW = {
  [WorkflowState.ANALYSE]: {
    requiredArtifacts: ['requirement.md'],
    optionalArtifacts: ['requirement.zh.md'],
    minContentSections: 3,
    requiredSections: [
      { pattern: /(?:需求|Requirement|功能需求|Functional)/i, name: 'requirements' },
      { pattern: /(?:范围|Scope|项目范围|Project Scope)/i, name: 'scope' },
    ],
    expectedMetrics: {
      minLines: 20,
      maxLines: 500,
      hasJsonMetadata: true,
    },
  },

  [WorkflowState.ARCHITECT]: {
    requiredArtifacts: ['architecture.md'],
    optionalArtifacts: ['architecture.zh.md'],
    minContentSections: 4,
    requiredSections: [
      { pattern: /(?:架构|Architecture|系统架构|System Architecture)/i, name: 'architecture' },
      { pattern: /(?:组件|Component|模块|Module)/i, name: 'components' },
      { pattern: /(?:技术栈|Tech Stack|技术选型|Technology)/i, name: 'tech-stack' },
      { pattern: /(?:数据流|Data Flow|交互|Interaction)/i, name: 'data-flow' },
    ],
    expectedMetrics: {
      minLines: 30,
      maxLines: 800,
      hasJsonMetadata: true,
    },
  },

  [WorkflowState.PLAN]: {
    requiredArtifacts: ['execution-plan.md'],
    optionalArtifacts: ['execution-plan.zh.md'],
    minContentSections: 3,
    requiredSections: [
      { pattern: /(?:任务|Task|执行计划|Execution Plan)/i, name: 'tasks' },
      { pattern: /(?:阶段|Phase|里程碑|Milestone)/i, name: 'phases' },
      { pattern: /(?:依赖|Dependency|风险|Risk)/i, name: 'dependencies' },
    ],
    expectedMetrics: {
      minLines: 25,
      maxLines: 600,
      hasJsonMetadata: true,
    },
  },

  [WorkflowState.CODE]: {
    requiredArtifacts: ['code.diff'],
    optionalArtifacts: [],
    minContentSections: 1,
    requiredSections: [],
    expectedMetrics: {
      minLines: 10,
      maxLines: 5000,
      hasJsonMetadata: false,
      diffFormat: true,
    },
  },

  [WorkflowState.TEST]: {
    requiredArtifacts: ['test-report.md'],
    optionalArtifacts: ['test-report.zh.md'],
    minContentSections: 2,
    requiredSections: [
      { pattern: /(?:测试结果|Test Result|总结|Summary)/i, name: 'summary' },
      { pattern: /(?:通过|Pass|失败|Fail|覆盖率|Coverage)/i, name: 'metrics' },
    ],
    expectedMetrics: {
      minLines: 15,
      maxLines: 400,
      hasJsonMetadata: true,
    },
  },
};

/**
 * Stage sequence definition for flow validation.
 */
const STAGE_SEQUENCE = [
  WorkflowState.ANALYSE,
  WorkflowState.ARCHITECT,
  WorkflowState.PLAN,
  WorkflowState.CODE,
  WorkflowState.TEST,
];

module.exports = {
  STANDARD_EXECUTION_FLOW,
  STAGE_SEQUENCE,
};
