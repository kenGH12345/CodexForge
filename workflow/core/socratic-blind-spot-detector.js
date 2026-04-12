/**
 * Socratic Challenger – Blind Spot Detector (ADR-56 Decomposition)
 *
 * Extracted from socratic-challenger.js.
 * Handles D4 blind spot aggregation, dimension-level blind spot detection,
 * and rule-driven question collection.
 *
 * @module workflow/core/socratic-blind-spot-detector
 */

'use strict';

const {
  ELEVEN_DIMENSIONS,
  STAGE_CHALLENGES,
} = require('./socratic-constants');

/**
 * D4: Aggregate blind spot detection — top-5 across all dimensions.
 * @param {string} stageName - Current stage
 * @param {string} content - Artifact content
 * @param {string[]} claims - Extracted claims
 * @param {object} context - Additional context
 * @param {object} artifactStructure - Parsed artifact structure
 * @param {object} instance - SocraticChallenger instance (for utility methods)
 * @returns {string[]} Detected blind spots (max 5)
 */
function detectBlindSpots(stageName, content, claims, context, artifactStructure, instance) {
  const blindSpots = [];
  const contentLower = String(content || '').toLowerCase();

  // 1. Dimension-level blind spots
  const dimensionBlindSpots = detectDimensionBlindSpots(stageName, contentLower);
  blindSpots.push(...dimensionBlindSpots);

  // 2. Schema-gap blind spots (from artifact structure analysis)
  if (artifactStructure && artifactStructure.schemaGaps) {
    for (const gap of artifactStructure.schemaGaps) {
      if (gap.severity === 'missing_required') {
        blindSpots.push(`⚠️ [BLIND SPOT] 缺少必需 section "${gap.section}" — 后续阶段将缺乏关键输入`);
      }
    }
  }

  // 3. Claim-without-evidence blind spots
  for (const claim of (claims || []).slice(0, 4)) {
    if (!_hasEvidenceNearClaim(String(claim), contentLower)) {
      blindSpots.push(`⚠️ [BLIND SPOT] 声明"${_truncate(claim, 50)}"缺乏支撑证据`);
    }
  }

  // 4. Stage-specific blind spots
  const stageBS = _detectStageSpecificBlindSpots(stageName, contentLower);
  blindSpots.push(...stageBS);

  // Deduplicate and cap at 5
  const unique = [...new Set(blindSpots)];
  return unique.slice(0, 5);
}

/**
 * Detect blind spots for each of the 11 dimensions.
 */
function detectDimensionBlindSpots(stageName, contentLower) {
  const blindSpots = [];
  const stageDimChecks = _getStageDimensionChecks(stageName);

  for (const [dimKey, dim] of Object.entries(ELEVEN_DIMENSIONS)) {
    const checks = dim.checks || [];
    let hitCount = 0;
    for (const check of checks) {
      const signals = _expandCheckSignals(check);
      const hit = signals.some(s => contentLower.includes(String(s).toLowerCase()));
      if (hit) hitCount++;
    }
    const ratio = checks.length > 0 ? hitCount / checks.length : 0.5;

    // Stage-specific dimension priority
    const stageWeight = stageDimChecks[dimKey] || 1;

    if (ratio < 0.2 && stageWeight >= 1) {
      blindSpots.push(`⚠️ [BLIND SPOT][${dimKey}] "${dim.name}"维度严重缺失 — ${dim.description}`);
    } else if (ratio < 0.4 && stageWeight >= 2) {
      blindSpots.push(`⚠️ [BLIND SPOT][${dimKey}] "${dim.name}"维度薄弱 — 需要补充`);
    }
  }

  return blindSpots;
}

function _hasEvidenceNearClaim(claim, contentLower) {
  const claimLower = claim.toLowerCase();
  const idx = contentLower.indexOf(claimLower);
  if (idx < 0) return true;  // Claim not found in content, skip

  const surrounding = contentLower.slice(Math.max(0, idx - 300), idx + claim.length + 300);
  const evidenceSignals = /test|验证|evidence|proof|data|benchmark|metric|coverage|因为|由于|测试|依据|证据|实测/i;
  return evidenceSignals.test(surrounding);
}

function _detectStageSpecificBlindSpots(stageName, contentLower) {
  const spots = [];

  if (stageName === 'ANALYSE') {
    if (!/根因|root\s*cause/i.test(contentLower)) {
      spots.push('⚠️ [BLIND SPOT] ANALYSE 阶段未识别根因，可能只处理了表面症状');
    }
    if (!/影响范围|impact|受影响/i.test(contentLower)) {
      spots.push('⚠️ [BLIND SPOT] ANALYSE 阶段未分析影响范围');
    }
  }

  if (stageName === 'ARCHITECT') {
    if (!/trade.?off|权衡|备选|alternative/i.test(contentLower)) {
      spots.push('⚠️ [BLIND SPOT] ARCHITECT 阶段未进行方案权衡分析');
    }
    if (!/接口|interface|contract/i.test(contentLower)) {
      spots.push('⚠️ [BLIND SPOT] ARCHITECT 阶段未定义模块间接口');
    }
  }

  if (stageName === 'PLAN') {
    if (!/依赖|depend/i.test(contentLower)) {
      spots.push('⚠️ [BLIND SPOT] PLAN 阶段未分析任务依赖关系');
    }
    if (!/收益|成本|投入|roi|cost.?benefit/i.test(contentLower)) {
      spots.push('⚠️ [BLIND SPOT] PLAN 阶段未评估投入产出比，可能执行了低价值任务');
    }
  }

  // ROI_ASSESSMENT: Decision-making stages should evaluate benefit/cost
  if (stageName === 'ANALYSE') {
    if (!/收益|价值|benefit|value|改善|improvement/i.test(contentLower)) {
      spots.push('⚠️ [BLIND SPOT] ANALYSE 阶段未量化修复收益，可能在不值得修复的问题上投入');
    }
  }

  if (stageName === 'ARCHITECT') {
    if (!/风险|代价|risk|cost|退化|regression/i.test(contentLower)) {
      spots.push('⚠️ [BLIND SPOT] ARCHITECT 阶段未评估架构升级的风险代价，可能引入过度工程');
    }
  }

  if (stageName === 'TEST' || stageName === 'DEVELOP') {
    if (!/edge\s*case|边界|异常/i.test(contentLower)) {
      spots.push('⚠️ [BLIND SPOT] 实现阶段未考虑边界/异常场景');
    }
    if (!/error|exception|异常处理|try.*catch/i.test(contentLower)) {
      spots.push('⚠️ [BLIND SPOT] 实现阶段未考虑错误处理');
    }
  }

  return spots;
}

function _getStageDimensionChecks(stageName) {
  const checks = {
    ANALYSE: { RELEVANCE: 2, DEPTH: 2, FIRST_PRINCIPLES: 2, EVIDENCE: 2, ROI_ASSESSMENT: 2 },
    ARCHITECT: { BREADTH: 2, LOGIC: 2, BOUNDARY: 2, INDUSTRY_COMPARISON: 1, ROI_ASSESSMENT: 2 },
    PLAN: { PRECISION: 2, LOGIC: 1, DATA: 1, ROI_ASSESSMENT: 1 },
    CODE: { BOUNDARY: 2, EVIDENCE: 2, CLARITY: 1 },
    DEVELOP: { BOUNDARY: 2, EVIDENCE: 2, CLARITY: 1 },
    TEST: { EVIDENCE: 2, BOUNDARY: 2, DATA: 1 },
  };
  return checks[stageName] || {};
}

function _expandCheckSignals(check) {
  const key = String(check || '').toLowerCase();
  const dict = {
    'stakeholders identified': ['stakeholder', 'stakeholders', '利益相关方', '相关方'],
    'use cases covered': ['use case', '场景', '用例', '覆盖'],
    'alternatives considered': ['alternative', 'trade-off', '备选方案', '替代方案'],
    'dependencies mapped': ['dependency', 'dependencies', '依赖'],
    'impacts analyzed': ['impact', '影响'],
    'root cause identified': ['root cause', '根因', '本质原因'],
    'assumptions challenged': ['assumption', '假设'],
    'trade-offs analyzed': ['trade-off', '权衡'],
    'technical depth': ['algorithm', '复杂度', '技术细节', '实现细节'],
    'rationale provided': ['because', 'therefore', 'reason', '依据', '原因'],
    'reasoning chain valid': ['推理', 'reasoning', '因果链', '逻辑链'],
    'premises consistent with conclusion': ['前提', '结论', 'premise', 'conclusion'],
    'terms clearly defined': ['定义', 'definition', '术语'],
    'no ambiguous language': ['歧义', 'ambiguous', '清晰'],
    'specific numbers provided': ['%', 'ms', 'qps', '数字', '数值'],
    'timeline defined': ['timeline', '截止', '日期', '里程碑'],
    'constraints explicit': ['constraint', '约束'],
    'edge cases handled': ['edge case', '边界', '异常场景'],
    'failure modes identified': ['failure', '故障', '失败模式'],
    'recovery strategy': ['rollback', '回滚', '降级', '恢复'],
    'tests referenced': ['test', '测试', '断言'],
    'benchmarks cited': ['benchmark', '基准', '压测'],
    'metrics defined': ['metric', '指标'],
    'quantified goals': ['目标', '量化'],
    'baseline established': ['baseline', '基线'],
    'industry best practices referenced': ['best practice', '最佳实践', '行业标准'],
    'competitor analysis': ['竞品', 'competitor', '对比'],
    'standards compliance': ['standard', 'compliance', '规范'],
    'proven patterns used': ['pattern', '模式', '成熟方案'],
    'fundamental facts identified': ['fundamental', '基本事实', '本质约束'],
    'analogies challenged': ['类比', '惯例', 'analog'],
    'assumptions decomposed': ['假设拆解', 'assumption'],
    'derived from basics': ['推导', 'derived', '从零'],
    'convention questioned': ['惯例', 'convention'],
    'benefits quantified': ['benefit', '收益', '收益量化', '价值', 'value', '提升', 'improvement'],
    'risks assessed with probability': ['risk', '风险', '概率', 'probability', '发生概率', 'likelihood'],
    'cost estimated': ['cost', '成本', '代价', '投入', 'effort', '工时', '复杂度'],
    'roi calculated or argued': ['roi', '投入产出', '性价比', 'cost-benefit', 'worth', '值得'],
    'worst case acceptable': ['worst', '最坏', '最差', 'worst.case', '底线', '可接受'],
  };
  return dict[key] || [check];
}

function _truncate(s, n) {
  return String(s || '').slice(0, n);
}

// ─── Rule-Driven Question Collection (F6) ────────────────────────────────────

/**
 * Collect questions driven by rule/pattern matching.
 * F6: Priority demoted to P3 (backfill only).
 * @param {string} stageName - Current stage
 * @param {string} content - Artifact content
 * @param {object} context - Additional context
 * @param {object} artifactStructure - Parsed artifact structure
 * @returns {{ questions: string[], diagnostics: object }}
 */
function collectRuleDrivenQuestions(stageName, content, context, artifactStructure) {
  const contentLower = String(content || '').toLowerCase();
  const questions = [];
  const diagnostics = { rulesChecked: 0, rulesTriggered: 0 };

  // Rule: Quantitative claim without numbers
  if (/(?:预计|大约|约|估计|approximately|roughly|expected)/i.test(content)) {
    if (!/\d+(\.\d+)?/.test(content)) {
      questions.push('[missing_evidence] artifact 中有量化声明但无具体数值，请提供数据支撑');
      diagnostics.rulesTriggered++;
    }
    diagnostics.rulesChecked++;
  }

  // Rule: Risk mention without mitigation
  if (/(?:风险|risk|问题|缺陷|vulnerability)/i.test(content)) {
    if (!/(?:缓解|规避|mitigation|workaround|fallback|回滚|降级|解决方案)/i.test(content)) {
      questions.push('[missing_evidence] 识别了风险但未提供缓解措施，请说明回退策略');
      diagnostics.rulesTriggered++;
    }
    diagnostics.rulesChecked++;
  }

  // Rule: Design decision without alternatives
  if (/(?:选择|决定|采用|选型|decide|choose|select|approach)/i.test(content)) {
    if (!/(?:替代|备选|alternative|other option|也可以|权衡|trade.?off)/i.test(content)) {
      questions.push('[missing_evidence] 做出了设计决策但未说明替代方案，请补充权衡分析');
      diagnostics.rulesTriggered++;
    }
    diagnostics.rulesChecked++;
  }

  // Rule: Assumption without validation plan
  if (/(?:假设|前提|假定|assume|premise)/i.test(content)) {
    if (!/(?:验证|确认|核实|validate|verify|test|测试)/i.test(content)) {
      questions.push('[missing_evidence] 存在关键假设但无验证计划，请说明如何确认假设成立');
      diagnostics.rulesTriggered++;
    }
    diagnostics.rulesChecked++;
  }

  // Rule: Decision/change without benefit quantification (ROI_ASSESSMENT)
  if (/(?:修改|变更|优化|新增|重构|升级|迁移|implement|refactor|upgrade|migrate|modify|change)/i.test(content)) {
    if (!/(?:收益|价值|benefit|value|提升|改善|improvement|roi|投入产出)/i.test(content)) {
      questions.push('[missing_evidence] 方案/变更缺少收益量化，请说明预期收益和价值');
      diagnostics.rulesTriggered++;
    }
    diagnostics.rulesChecked++;
  }

  // Rule: Risk mention without cost/probability assessment (ROI_ASSESSMENT)
  if (/(?:风险|risk|副作用|side.?effect|退化|regression)/i.test(content)) {
    if (!/(?:概率|代价|成本|影响程度|probability|cost|severity|likelihood|发生概率)/i.test(content)) {
      questions.push('[missing_evidence] 识别了风险但未评估发生概率和代价，请量化风险影响');
      diagnostics.rulesTriggered++;
    }
    diagnostics.rulesChecked++;
  }

  // Rule: Large scope change without ROI justification (ROI_ASSESSMENT)
  if (/(?:架构|整体|全面|complete|full|architecture|major)/i.test(content)) {
    if (!/(?:轻量|最小|渐进|incremental|minimal|替代路径|更小范围)/i.test(content)) {
      questions.push('[missing_evidence] 大范围变更未考虑更轻量的替代路径，请说明为何不能分步或缩小范围');
      diagnostics.rulesTriggered++;
    }
    diagnostics.rulesChecked++;
  }

  // Rule: Schema gaps (from artifact structure)
  if (artifactStructure && artifactStructure.schemaGaps) {
    for (const gap of artifactStructure.schemaGaps) {
      if (gap.severity === 'missing_required') {
        questions.push(`[missing_evidence] 必需 section "${gap.section}" 缺失 — 请补充`);
        diagnostics.rulesTriggered++;
      }
    }
    diagnostics.rulesChecked++;
  }

  return { questions, diagnostics };
}

/**
 * Build rule config for general and stage-specific rules.
 * @param {string} stageName
 * @param {string} content
 * @param {object} context
 * @returns {{ general: object[], stage: object[] }}
 */
function buildRuleConfig(stageName, content, context) {
  const general = [
    { name: 'quantitative_claim', check: /预计|大约|约|估计|approximately/i.test(content), message: '量化声明需数值' },
    { name: 'risk_without_mitigation', check: /风险|risk/i.test(content) && !/缓解|mitigation|回滚/i.test(content), message: '风险缺缓解' },
    { name: 'decision_without_alternatives', check: /选择|决定|采用/i.test(content) && !/替代|备选|alternative/i.test(content), message: '决策缺备选' },
    { name: 'assumption_without_validation', check: /假设|前提|assume/i.test(content) && !/验证|validate|test/i.test(content), message: '假设缺验证' },
    { name: 'change_without_benefit', check: /修改|变更|优化|新增|重构|升级/i.test(content) && !/收益|价值|benefit|roi|投入产出/i.test(content), message: '变更缺收益量化' },
    { name: 'risk_without_cost', check: /风险|risk/i.test(content) && !/概率|代价|成本|发生概率|probability|cost/i.test(content), message: '风险缺代价评估' },
  ];

  const stageRules = {
    ANALYSE: [
      { name: 'no_root_cause', check: !/根因|root\s*cause/i.test(content), message: '缺根因分析' },
      { name: 'no_impact_scope', check: !/影响范围|impact/i.test(content), message: '缺影响范围' },
      { name: 'no_benefit_quantification', check: !/收益|价值|benefit|improvement/i.test(content), message: '缺收益量化' },
    ],
    ARCHITECT: [
      { name: 'no_tradeoffs', check: !/权衡|trade.?off|备选/i.test(content), message: '缺方案权衡' },
      { name: 'no_interface', check: !/接口|interface|contract/i.test(content), message: '缺接口定义' },
      { name: 'no_risk_cost', check: !/风险.*代价|risk.*cost|退化|regression|副作用/i.test(content), message: '缺风险代价评估' },
    ],
    PLAN: [
      { name: 'no_dependency', check: !/依赖|depend/i.test(content), message: '缺依赖分析' },
      { name: 'no_roi', check: !/收益|投入|roi|cost.?benefit/i.test(content), message: '缺投入产出评估' },
    ],
    TEST: [
      { name: 'no_coverage', check: !/覆盖|coverage/i.test(content), message: '缺覆盖率' },
      { name: 'no_edge_case', check: !/边界|edge/i.test(content), message: '缺边界测试' },
    ],
    DEVELOP: [
      { name: 'no_error_handling', check: !/错误处理|error.*handle|try.*catch/i.test(content), message: '缺错误处理' },
    ],
  };

  const stage = stageRules[stageName] || [];

  return { general, stage };
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  detectBlindSpots,
  detectDimensionBlindSpots,
  collectRuleDrivenQuestions,
  buildRuleConfig,
};
