'use strict';

/**
 * Socratic Exploration Question Generator — Generates discovery-oriented questions.
 *
 * Uses 4 heuristic strategies to challenge unstated assumptions and unexplored areas:
 *   1. inverse-assumption: "What if X is wrong?"
 *   2. boundary-push: "What happens beyond the stated limits?"
 *   3. implicit-need: "What common concern is missing?"
 *   4. cross-dimension: "From a different angle, what risks exist?"
 *
 * These questions are marked isExploratory: true and are selected by DiversityMixer
 * to fill the 10-15% exploration quota.
 *
 * @module workflow/core/socratic-exploration-generator
 */

const { extractEntities } = require('./socratic-entity-extractor');

const IMPLICIT_NEEDS_BY_STAGE = {
  ANALYSE: ['安全性', '性能', '可维护性', '可测试性', '向后兼容'],
  ARCHITECT: ['监控告警', '灰度发布', '数据迁移', '降级策略', '容量规划'],
  PLAN: ['回滚计划', '并行风险', '人员依赖', '外部依赖', '验收标准'],
  DEVELOP: ['错误处理', '日志记录', '并发安全', '内存泄漏', '超时处理'],
  CODE: ['错误处理', '日志记录', '并发安全', '内存泄漏', '超时处理'],
  TEST: ['边界值', '并发测试', '性能基准', '安全测试', '数据清理'],
};

const CROSS_DIMENSIONS = [
  { name: '安全性', riskType: '安全漏洞或权限绕过' },
  { name: '可观测性', riskType: '故障难以定位或监控盲区' },
  { name: '可维护性', riskType: '技术债务或未来扩展困难' },
  { name: '性能', riskType: '延迟或吞吐量瓶颈' },
  { name: '一致性', riskType: '数据不一致或竞态条件' },
];

class ExplorationQuestionGenerator {
  /**
   * Generate exploratory questions using up to 5 strategies.
   * When blindSpots are provided, _blindSpotPeriphery runs first with elevated scores.
   * @param {string} artifact
   * @param {string} stageName
   * @param {string} [requirement]
   * @param {string[]} [blindSpots]
   * @returns {Array<{question: string, strategy: string, isExploratory: boolean, score: number}>}
   */
  generate(artifact, stageName, requirement, blindSpots = []) {
    const content = String(artifact || '');
    const stage = String(stageName || 'DEVELOP').toUpperCase();
    const questions = [];

    const entities = extractEntities(content, stage);

    if (Array.isArray(blindSpots) && blindSpots.length > 0) {
      questions.push(...this._blindSpotPeriphery(blindSpots, content, stage));
    }

    questions.push(...this._inverseAssumption(content, entities, stage));
    questions.push(...this._boundaryPush(content, entities, stage));
    questions.push(...this._implicitNeed(content, stage, requirement));
    questions.push(...this._crossDimension(content, stage, entities));

    return questions.slice(0, 8);
  }

  /**
   * Strategy 0: Blind Spot Periphery — explore the surrounding dimensions of each detected blind spot.
   * Generates questions about boundary conditions, underlying assumptions, impact scope, and alternative paths.
   * Score is elevated (0.88-0.94) so these questions can break out of the 10-15% exploratory quota.
   */
  _blindSpotPeriphery(blindSpots, content, stage) {
    const questions = [];
    const peripheryTemplates = [
      (bs) => ({
        question: `盲点"${bs}"在极端输入或高负载下是否仍然成立？边界条件有没有被验证过？`,
        score: 0.92,
      }),
      (bs) => ({
        question: `"${bs}"背后依赖哪些前提假设？这些假设在当前 artifact 中是否有明确依据？`,
        score: 0.90,
      }),
      (bs) => ({
        question: `如果"${bs}"这个盲点成真，会影响哪些模块、用户或数据？影响传播链是否被评估过？`,
        score: 0.88,
      }),
      (bs) => ({
        question: `针对"${bs}"，是否存在可以规避这个盲点的替代方案或降级路径？`,
        score: 0.88,
      }),
    ];

    const contentLower = content.toLowerCase();
    for (const rawBs of (blindSpots || []).slice(0, 3)) {
      const bs = String(rawBs || '')
        .replace(/^⚠️\s*\[BLIND SPOT\][^\]]*\]\s*/i, '')
        .replace(/^⚠️\s*\[BLIND SPOT\]\s*/i, '')
        .trim()
        .slice(0, 60);
      if (!bs) continue;

      let added = 0;
      for (const tpl of peripheryTemplates) {
        if (added >= 2) break;
        const { question, score } = tpl(bs);
        const qLower = question.toLowerCase();
        const alreadyCovered = contentLower.includes(bs.toLowerCase().slice(0, 20));
        if (!alreadyCovered || score >= 0.90) {
          questions.push({
            question,
            strategy: 'blindspot-periphery',
            isExploratory: true,
            score,
          });
          added++;
        }
      }
    }

    return questions;
  }

  /**
   * Strategy 1: Inverse Assumption — challenge stated assumptions.
   * "If X is not true, what happens?"
   */
  _inverseAssumption(content, entities, stage) {
    const questions = [];
    const lines = content.split('\n');

    const assumptionPatterns = [
      /(?:假设|前提|假定|预计|认为|默认|assume|premise|expect|given that)(.{5,60})/i,
      /(?:如果|若|when|if)\s+(.{5,60})(?:，|,|则|then)/i,
    ];

    const found = new Set();
    for (const line of lines) {
      for (const pattern of assumptionPatterns) {
        const m = line.match(pattern);
        if (m && m[1] && !found.has(m[1].trim())) {
          const assumption = m[1].trim().slice(0, 60);
          found.add(assumption);
          questions.push({
            question: `如果"${assumption}"这一假设不成立，当前方案会面临什么风险？有备选路径吗？`,
            strategy: 'inverse-assumption',
            isExploratory: true,
            score: 0.75,
          });
          if (questions.length >= 2) break;
        }
      }
      if (questions.length >= 2) break;
    }

    if (questions.length === 0 && entities.decisions.length > 0) {
      const decision = entities.decisions[0].slice(0, 60);
      questions.push({
        question: `决策"${decision}"背后的核心假设是什么？如果该假设在生产环境中被证伪，影响有多大？`,
        strategy: 'inverse-assumption',
        isExploratory: true,
        score: 0.70,
      });
    }

    return questions;
  }

  /**
   * Strategy 2: Boundary Push — challenge stated limits and thresholds.
   * "What happens when X exceeds the stated boundary?"
   */
  _boundaryPush(content, entities, stage) {
    const questions = [];

    for (const num of entities.numbers.slice(0, 3)) {
      const numIdx = content.indexOf(num);
      if (numIdx < 0) continue;
      const surrounding = content.slice(Math.max(0, numIdx - 80), numIdx + num.length + 80);

      const isLimit = /(?:最大|最小|上限|下限|阈值|threshold|max|min|limit|不超过|至少)/i.test(surrounding);
      if (isLimit) {
        questions.push({
          question: `当前设定 ${num} 作为边界值，如果实际场景超出这个范围 10 倍，系统行为是什么？是否有熔断或降级机制？`,
          strategy: 'boundary-push',
          isExploratory: true,
          score: 0.72,
        });
        if (questions.length >= 1) break;
      }
    }

    if (questions.length === 0 && entities.numbers.length > 0) {
      questions.push({
          question: `方案中提到 ${entities.numbers[0]}，这是在什么负载条件下测量的？极端情况下（如流量突增 10x）的行为是否经过验证？`,
        strategy: 'boundary-push',
        isExploratory: true,
        score: 0.68,
      });
    }

    return questions.slice(0, 1);
  }

  /**
   * Strategy 3: Implicit Need — surface common concerns not mentioned.
   * "This common concern is missing — was it intentionally omitted?"
   */
  _implicitNeed(content, stage, requirement) {
    const questions = [];
    const contentLower = content.toLowerCase();
    const stageNeeds = IMPLICIT_NEEDS_BY_STAGE[stage] || IMPLICIT_NEEDS_BY_STAGE['DEVELOP'];

    for (const need of stageNeeds) {
      const needLower = need.toLowerCase();
      if (!contentLower.includes(needLower)) {
        const reqContext = requirement ? `（针对需求"${String(requirement).slice(0, 40)}"）` : '';
        questions.push({
          question: `方案${reqContext}未提及"${need}"。这是有意省略还是遗漏？如果不处理，会有什么后果？`,
          strategy: 'implicit-need',
          isExploratory: true,
          score: 0.65,
        });
        if (questions.length >= 2) break;
      }
    }

    return questions.slice(0, 1);
  }

  /**
   * Strategy 4: Cross-Dimension — examine from an orthogonal perspective.
   * "From dimension X angle, what risks exist?"
   */
  _crossDimension(content, stage, entities) {
    const questions = [];
    const contentLower = content.toLowerCase();

    for (const dim of CROSS_DIMENSIONS) {
      if (!contentLower.includes(dim.name.toLowerCase())) {
        const entityRef = entities.filePaths.length > 0
          ? `（涉及 ${entities.filePaths[0]}）`
          : '';
        questions.push({
          question: `从"${dim.name}"角度审视当前方案${entityRef}，是否存在${dim.riskType}的风险？这个维度在方案中未被显式讨论。`,
          strategy: 'cross-dimension',
          isExploratory: true,
          score: 0.62,
        });
        if (questions.length >= 1) break;
      }
    }

    return questions;
  }
}

module.exports = { ExplorationQuestionGenerator };
