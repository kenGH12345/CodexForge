#!/usr/bin/env node
/**
 * Test: StageSmartSkip Two-Layer Task Intent Detection
 *
 * Validates:
 *   Layer 1: Regex pre-detection from raw user input
 *   Layer 2: Semantic confirmation from ANALYSE enriched output
 *   Priority resolution: Layer 2 > Layer 1
 *   Safety: Layer 2 FULL overrides Layer 1 non-code
 */

'use strict';

const {
  StageSmartSkip,
  detectTaskIntent,
  estimateTaskIntent,
  TaskIntent,
  INTENT_SKIP_MAP,
  SEMANTIC_INTENT_INDICATORS,
} = require('../core/stage-smart-skip');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

// ─── Test 1: Layer 1 — Regex Intent Detection ───────────────────────────────
console.log('\n=== Test 1: Layer 1 — Regex Intent Detection ===');

const layer1Tests = [
  // Design tasks
  { input: '方案设计 实现一个新的缓存模块', expected: 'design_only' },
  { input: '技术设计 微服务拆分', expected: 'design_only' },
  { input: '出个方案 重构数据库层', expected: 'design_only' },
  { input: '实施方案 同时考虑分析审查对比搜索', expected: 'design_only' },
  { input: 'design plan for new auth module', expected: 'design_only' },

  // Analysis tasks
  { input: '深度分析 工作流的能力输出质量', expected: 'analysis_only' },
  { input: '对比分析 React vs Vue', expected: 'analysis_only' },
  { input: '帮我分析一下这个模块的性能瓶颈', expected: 'analysis_only' },
  { input: '深度评估工作流的能力输出质量跟其他主流的agent进行比较', expected: 'analysis_only' },
  { input: 'compare React and Vue frameworks', expected: 'analysis_only' },

  // Review tasks
  { input: '代码审查 检查安全漏洞', expected: 'review_only' },
  { input: 'code review the auth module', expected: 'review_only' },

  // Research tasks
  { input: '调研一下业界最佳实践', expected: 'research_only' },
  { input: 'research best practices for caching', expected: 'research_only' },

  // Full pipeline (code tasks)
  { input: '实现一个REST API', expected: 'full' },
  { input: '修复登录页面的bug', expected: 'full' },
  { input: 'Build a new payment module', expected: 'full' },
];

layer1Tests.forEach(({ input, expected }) => {
  const result = detectTaskIntent(input);
  assert(
    result.intent === expected,
    `L1: "${input.slice(0, 35)}..." => ${result.intent} (expected: ${expected})`
  );
  assert(result.source === 'regex', `L1: source is "regex"`);
});

// ─── Test 2: Layer 2 — Semantic Intent Estimation ───────────────────────────
console.log('\n=== Test 2: Layer 2 — Semantic Intent Estimation ===');

// Design-only: strong signal in enriched requirement
const designEnriched = `
# Requirement Analysis

## Overview
The user requests a design plan for a new caching module.

## Deliverables: design document and architecture specification
No code implementation is needed at this stage.

## Scope
This is a design-only task. 不需要编写代码，只需要输出方案文档。
`;
const designResult = estimateTaskIntent(designEnriched);
assert(designResult.intent === 'design_only', `L2: Design enriched => ${designResult.intent}`);
assert(designResult.source === 'semantic', `L2: source is "semantic"`);
assert(designResult.confidence === 'high' || designResult.confidence === 'medium', `L2: confidence is high/medium`);

// Analysis-only: strong signal
const analysisEnriched = `
# Requirement Analysis

## Overview
Deep analysis of the workflow's capability output quality compared to other mainstream agents.

## Deliverables: analysis report and comparison matrix
目标：评估和对比分析

## Scope
Read-only analysis, no code changes needed.
`;
const analysisResult = estimateTaskIntent(analysisEnriched);
assert(analysisResult.intent === 'analysis_only', `L2: Analysis enriched => ${analysisResult.intent}`);

// Full pipeline: code signals
const codeEnriched = `
# Requirement Analysis

## Overview
Implement a new REST API endpoint for user authentication.

## Deliverables
- New auth module with JWT support
- Unit tests for all endpoints
- Integration tests

## Scope
需要编写代码实现新的认证模块，包括 JWT token 生成和验证。
Code changes required in the auth service.
`;
const codeResult = estimateTaskIntent(codeEnriched);
assert(codeResult.intent === 'full', `L2: Code enriched => ${codeResult.intent}`);

// Ambiguous: no strong signals either way
const ambiguousEnriched = `
# Requirement Analysis

## Overview
The user wants to improve the system performance.

## Scope
General improvement task.
`;
const ambiguousResult = estimateTaskIntent(ambiguousEnriched);
assert(ambiguousResult.intent === 'full', `L2: Ambiguous enriched => ${ambiguousResult.intent} (defaults to full)`);

// Review-only: strong signal
const reviewEnriched = `
# Requirement Analysis

## Overview
Code review of the authentication module for security vulnerabilities.

## Deliverables: review report with findings and recommendations
目标：审查现有代码的安全性

## Scope
Review existing code, no modifications needed.
`;
const reviewResult = estimateTaskIntent(reviewEnriched);
assert(reviewResult.intent === 'review_only', `L2: Review enriched => ${reviewResult.intent}`);

// Research-only: strong signal
const researchEnriched = `
# Requirement Analysis

## Overview
Research best practices for distributed caching in microservices.

## Deliverables: research report with recommendations
目标：调研分布式缓存方案

## Scope
Investigation only, no implementation.
`;
const researchResult = estimateTaskIntent(researchEnriched);
assert(researchResult.intent === 'research_only', `L2: Research enriched => ${researchResult.intent}`);

// ─── Test 3: Two-Layer Resolution — Agreement ──────────────────────────────
console.log('\n=== Test 3: Two-Layer Resolution — Agreement ===');

const skipAgree = new StageSmartSkip({ enabled: true });
skipAgree.setTaskIntent('方案设计 实现一个新的缓存模块');

// Simulate ANALYSE completion with matching intent
const mockStageCtxAgree = {
  get: (stage) => {
    if (stage === 'ANALYSE') {
      return {
        meta: {
          taskIntent: {
            intent: 'design_only',
            description: 'Design task',
            confidence: 'high',
            signals: ['design document'],
            source: 'semantic',
          },
        },
        artifacts: [],
      };
    }
    return null;
  },
};

const agreeResult = skipAgree.confirmTaskIntent({ stageCtx: mockStageCtxAgree });
assert(agreeResult.intent === 'design_only', `Agreement: intent stays design_only`);
assert(agreeResult.source === 'confirmed', `Agreement: source is "confirmed"`);
assert(!agreeResult.overridden, `Agreement: not overridden`);

// ─── Test 4: Two-Layer Resolution — Layer 2 Override (safety) ───────────────
console.log('\n=== Test 4: Two-Layer Resolution — Safety Override ===');

const skipSafety = new StageSmartSkip({ enabled: true });
skipSafety.setTaskIntent('分析一下为什么登录失败然后修复它');
// Layer 1 detects "分析一下" → analysis_only (FALSE POSITIVE!)

// Layer 2 detects code is needed
const mockStageCtxSafety = {
  get: (stage) => {
    if (stage === 'ANALYSE') {
      return {
        meta: {
          taskIntent: {
            intent: 'full',
            description: 'Code implementation required',
            confidence: 'high',
            signals: ['修复', 'bug fix'],
            source: 'semantic',
          },
        },
        artifacts: [],
      };
    }
    return null;
  },
};

const safetyResult = skipSafety.confirmTaskIntent({ stageCtx: mockStageCtxSafety });
assert(safetyResult.intent === 'full', `Safety: reverted to full (was analysis_only)`);
assert(safetyResult.overridden, `Safety: was overridden`);

// Verify CODE and TEST are NOT skipped after safety override
assert(!skipSafety.shouldSkip('CODE', {}).skip, `Safety: CODE not skipped after override`);
assert(!skipSafety.shouldSkip('TEST', {}).skip, `Safety: TEST not skipped after override`);

// ─── Test 5: Two-Layer Resolution — Layer 2 Detects Non-Code Missed by L1 ──
console.log('\n=== Test 5: Layer 2 Detects Non-Code Missed by Layer 1 ===');

const skipMissed = new StageSmartSkip({ enabled: true });
skipMissed.setTaskIntent('帮我看看这个系统的安全性怎么样');
// Layer 1: no match → full

const mockStageCtxMissed = {
  get: (stage) => {
    if (stage === 'ANALYSE') {
      return {
        meta: {
          taskIntent: {
            intent: 'review_only',
            description: 'Security review task',
            confidence: 'high',
            signals: ['review report', '审查现有'],
            source: 'semantic',
          },
        },
        artifacts: [],
      };
    }
    return null;
  },
};

const missedResult = skipMissed.confirmTaskIntent({ stageCtx: mockStageCtxMissed });
assert(missedResult.intent === 'review_only', `Missed: Layer 2 detected review_only`);
assert(missedResult.overridden, `Missed: was overridden (L1 was full)`);

// Verify PLAN, CODE, TEST are skipped
assert(skipMissed.shouldSkip('PLAN', {}).skip, `Missed: PLAN skipped after L2 override`);
assert(skipMissed.shouldSkip('CODE', {}).skip, `Missed: CODE skipped after L2 override`);
assert(skipMissed.shouldSkip('TEST', {}).skip, `Missed: TEST skipped after L2 override`);

// ─── Test 6: Two-Layer Resolution — Low Confidence Layer 2 ─────────────────
console.log('\n=== Test 6: Low Confidence Layer 2 — Keep Layer 1 ===');

const skipLowConf = new StageSmartSkip({ enabled: true });
skipLowConf.setTaskIntent('方案设计 新的缓存模块');
// Layer 1: design_only

const mockStageCtxLowConf = {
  get: (stage) => {
    if (stage === 'ANALYSE') {
      return {
        meta: {
          taskIntent: {
            intent: 'full',
            description: 'Default: full pipeline',
            confidence: 'low',
            signals: [],
            source: 'semantic',
          },
        },
        artifacts: [],
      };
    }
    return null;
  },
};

const lowConfResult = skipLowConf.confirmTaskIntent({ stageCtx: mockStageCtxLowConf });
assert(lowConfResult.intent === 'design_only', `LowConf: kept Layer 1 design_only (L2 was low confidence)`);
assert(!lowConfResult.overridden, `LowConf: not overridden`);

// ─── Test 7: Two-Layer Resolution — Medium Confidence Safety Revert ─────────
console.log('\n=== Test 7: Medium Confidence Safety Revert ===');

const skipMedSafety = new StageSmartSkip({ enabled: true });
skipMedSafety.setTaskIntent('分析一下这个bug的原因');
// Layer 1: analysis_only

const mockStageCtxMedSafety = {
  get: (stage) => {
    if (stage === 'ANALYSE') {
      return {
        meta: {
          taskIntent: {
            intent: 'full',
            description: 'Code implementation likely required',
            confidence: 'medium',
            signals: ['修复bug'],
            source: 'semantic',
          },
        },
        artifacts: [],
      };
    }
    return null;
  },
};

const medSafetyResult = skipMedSafety.confirmTaskIntent({ stageCtx: mockStageCtxMedSafety });
assert(medSafetyResult.intent === 'full', `MedSafety: reverted to full (medium confidence safety)`);
assert(medSafetyResult.overridden, `MedSafety: was overridden`);

// ─── Test 8: Disabled Smart-Skip ────────────────────────────────────────────
console.log('\n=== Test 8: Disabled Smart-Skip ===');

const skipDisabled = new StageSmartSkip({ enabled: false });
skipDisabled.setTaskIntent('深度分析 工作流的能力输出质量');
assert(!skipDisabled.shouldSkip('CODE', {}).skip, 'Disabled: CODE not skipped');
assert(!skipDisabled.shouldSkip('TEST', {}).skip, 'Disabled: TEST not skipped');

// ─── Test 9: No ANALYSE Data Available ──────────────────────────────────────
console.log('\n=== Test 9: No ANALYSE Data — Keep Layer 1 ===');

const skipNoData = new StageSmartSkip({ enabled: true });
skipNoData.setTaskIntent('方案设计 新的缓存模块');

const noDataResult = skipNoData.confirmTaskIntent({ stageCtx: { get: () => null } });
assert(noDataResult.intent === 'design_only', `NoData: kept Layer 1 design_only`);
assert(!noDataResult.overridden, `NoData: not overridden`);

// ─── Test 10: Intent Skip Map Correctness ───────────────────────────────────
console.log('\n=== Test 10: Intent Skip Map ===');

assert(INTENT_SKIP_MAP[TaskIntent.FULL].size === 0, 'FULL: no stages skipped');
assert(INTENT_SKIP_MAP[TaskIntent.DESIGN_ONLY].has('CODE'), 'DESIGN_ONLY: skips CODE');
assert(INTENT_SKIP_MAP[TaskIntent.DESIGN_ONLY].has('TEST'), 'DESIGN_ONLY: skips TEST');
assert(!INTENT_SKIP_MAP[TaskIntent.DESIGN_ONLY].has('ANALYSE'), 'DESIGN_ONLY: keeps ANALYSE');
assert(INTENT_SKIP_MAP[TaskIntent.ANALYSIS_ONLY].has('ARCHITECT'), 'ANALYSIS_ONLY: skips ARCHITECT');
assert(INTENT_SKIP_MAP[TaskIntent.ANALYSIS_ONLY].has('CODE'), 'ANALYSIS_ONLY: skips CODE');
assert(INTENT_SKIP_MAP[TaskIntent.REVIEW_ONLY].has('PLAN'), 'REVIEW_ONLY: skips PLAN');
assert(INTENT_SKIP_MAP[TaskIntent.RESEARCH_ONLY].has('ARCHITECT'), 'RESEARCH_ONLY: skips ARCHITECT');

// ─── Test 11: SEMANTIC_INTENT_INDICATORS exported ───────────────────────────
console.log('\n=== Test 11: Exports ===');

assert(typeof SEMANTIC_INTENT_INDICATORS === 'object', 'SEMANTIC_INTENT_INDICATORS exported');
assert(typeof estimateTaskIntent === 'function', 'estimateTaskIntent exported');
assert(typeof detectTaskIntent === 'function', 'detectTaskIntent exported');

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
