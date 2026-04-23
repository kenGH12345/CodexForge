/**
 * Socratic Challenger – Constants & Configuration (ADR-56 Decomposition)
 *
 * Extracted from socratic-challenger.js to reduce the god file.
 * Contains all dimension definitions, stage challenges, artifact schemas,
 * quality check patterns, and answer quality evaluation logic.
 *
 * Original size: part of 157 KB monolith
 * Refactored size: ~18 KB
 *
 * @module workflow/core/socratic-constants
 */

'use strict';

// ─── Twelve Dimensions of Socratic Questioning (ADR-55 Rev.3) ────────────────
// 基于 Paul-Elder 批判性思维框架 + AI Agent 工程实践 + 决策价值评估
//
// Paul-Elder 标准维度 (6个):
//   RELEVANCE, BREADTH, DEPTH, LOGIC, CLARITY, PRECISION
//
// AI Agent 工程特有维度 (4个):
//   BOUNDARY, EVIDENCE, DATA, INDUSTRY_COMPARISON
//
// 决策价值维度 (1个, 与认知质量轴正交):
//   ROI_ASSESSMENT — 评估方案的收益是否覆盖风险和成本（"值不值得做"）
//
// 第一性原则维度 (1个, 元层次):
//   FIRST_PRINCIPLES — 检测结论是从基本事实推导的，还是从类比/惯例/经验借来的

const TEN_DIMENSIONS = {
  // ═══════════════════════════════════════════════════════════════════════════
  // Paul-Elder 批判性思维框架标准维度
  // ═══════════════════════════════════════════════════════════════════════════

  RELEVANCE: {
    name: '相关性',
    description: '相关发散：这个问题与哪些其他问题相关联？',
    paulElder: true,
    checks: [
      'related problems identified',
      'cross-domain connections',
      'upstream dependencies',
      'downstream impacts',
      'similar patterns elsewhere',
    ],
    questionTemplates: [
      '这个问题与哪些其他问题有关联？',
      '在其他模块或系统中是否有类似的问题？',
      '解决这个问题是否会引发其他问题？',
      '有没有上游依赖问题需要先解决？',
      '这个问题的解决模式能否复用到其他场景？',
    ],
  },
  BREADTH: {
    name: '广度',
    description: '横向扫描：是否覆盖了所有相关方面？',
    paulElder: true,
    checks: [
      'stakeholders identified',
      'use cases covered',
      'alternatives considered',
      'dependencies mapped',
      'impacts analyzed',
    ],
    questionTemplates: [
      '还有哪些相关方没有考虑到？',
      '有没有遗漏的使用场景？',
      '是否有其他方案可以达成同样目标？',
      '这个方案会影响哪些其他模块或系统？',
      '有没有考虑非功能性需求（性能、安全、可维护性）？',
    ],
  },
  DEPTH: {
    name: '深度',
    description: '纵向钻探：是否深入到根本原因？',
    paulElder: true,
    checks: [
      'root cause identified',
      'assumptions challenged',
      'trade-offs analyzed',
      'technical depth',
      'rationale provided',
    ],
    questionTemplates: [
      '这个问题的根本原因是什么？你如何确定的？',
      '你做的最关键假设是什么？如果假设错误会怎样？',
      '为什么选择这个方案而不是其他方案？权衡点在哪？',
      '有没有更深层次的技术挑战需要解决？',
      '你如何确保这个方案能解决根本问题而非表面症状？',
    ],
  },
  LOGIC: {
    name: '逻辑性',
    description: '逻辑验证：推理链是否正确、前提与结论是否一致？',
    paulElder: true,
    checks: [
      'reasoning chain valid',
      'premises consistent with conclusion',
      'no logical fallacies',
      'causality established',
      'counter-arguments addressed',
    ],
    questionTemplates: [
      '你的推理过程是什么？每一步都站得住脚吗？',
      '前提和结论之间是否有必然的因果关系？',
      '是否存在逻辑谬误（如滑坡谬误、循环论证、稻草人）？',
      '有没有反例可以推翻这个结论？',
      '如果接受这个结论，会导致什么矛盾？',
    ],
  },
  CLARITY: {
    name: '清晰度',
    description: '表达清晰：是否存在歧义术语或模糊表达？',
    paulElder: true,
    checks: [
      'terms clearly defined',
      'no ambiguous language',
      'concepts explained',
      'examples provided',
      'scope unambiguous',
    ],
    questionTemplates: [
      '你说的"{term}"具体指什么？能给出明确定义吗？',
      '这句话是否有歧义？能否换一种更清晰的表达？',
      '你能用更简单的语言解释这个概念吗？',
      '这个术语对所有人都有相同的理解吗？',
      '有没有可能被误解的地方？如何避免？',
    ],
  },
  PRECISION: {
    name: '精确性',
    description: '精确量化：是否有具体的数值、时间线和范围？',
    paulElder: true,
    checks: [
      'specific numbers provided',
      'timeline defined',
      'ranges specified',
      'constraints explicit',
      'tolerances documented',
    ],
    questionTemplates: [
      '你能给出具体的数值吗？而不是"很多"、"大约"？',
      '时间线是什么？每个阶段的截止日期？',
      '这个范围的上限和下限是多少？',
      '如果超出这个范围，会发生什么？',
      '有没有精确的验收标准？',
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // AI Agent 工程特有维度
  // ═══════════════════════════════════════════════════════════════════════════

  BOUNDARY: {
    name: '边界条件',
    description: '边界探测：极限情况下会发生什么？',
    paulElder: false,
    checks: [
      'edge cases handled',
      'failure modes identified',
      'limits defined',
      'graceful degradation',
      'recovery strategy',
    ],
    questionTemplates: [
      '当输入超出预期范围时会发生什么？',
      '最大负载/并发下系统会如何？',
      '如果某个依赖失败，系统会怎样？',
      '有没有定义失败边界和回退策略？',
      '极端情况下（数据量10x、用户100x）还能工作吗？',
    ],
  },
  EVIDENCE: {
    name: '结论依据',
    description: '依据验证：结论是否有充分证据支撑？',
    paulElder: false,
    checks: [
      'data provided',
      'tests referenced',
      'benchmarks cited',
      'examples given',
      'proof demonstrated',
    ],
    questionTemplates: [
      '你得出这个结论的依据是什么？',
      '有没有数据或测试结果支撑这个说法？',
      '能否提供具体的例子或场景说明？',
      '这个结论是验证过的还是推测的？',
      '有没有可能结论是错误的？如何证伪？',
    ],
  },
  DATA: {
    name: '数据支撑',
    description: '数据验证：是否有量化数据支持决策？',
    paulElder: false,
    checks: [
      'metrics defined',
      'quantified goals',
      'measurement strategy',
      'baseline established',
      'success criteria',
    ],
    questionTemplates: [
      '有没有量化指标来衡量成功？',
      '预期的性能指标是多少？如何测量？',
      '有没有对比基准（baseline）？',
      '数据从哪里来？可靠吗？',
      '如何验证数据驱动了正确的决策？',
    ],
  },
  INDUSTRY_COMPARISON: {
    name: '业界对比',
    description: '业界对标：与成熟方案相比优势在哪里？',
    paulElder: false,
    checks: [
      'industry best practices referenced',
      'competitor analysis',
      'standards compliance',
      'proven patterns used',
      'advantages demonstrated',
    ],
    questionTemplates: [
      '业界成熟的方案是如何解决这个问题的？',
      '与竞品/开源方案相比，你的方案优势在哪里？',
      '有没有参考行业标准或最佳实践？',
      '这个方案是否有先例？为什么你认为能做得更好？',
      '有没有可能业界方案已经是最优解？你的创新点是什么？',
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 决策价值维度（与认知质量轴正交 — 评估"值不值得做"）
  // ═══════════════════════════════════════════════════════════════════════════

  ROI_ASSESSMENT: {
    name: '收益风险评估',
    description: '决策价值：方案的收益是否覆盖风险和成本？是否值得做？',
    paulElder: false,
    decisionValue: true,  // 决策价值维度标记（与认知质量维度正交）
    checks: [
      'benefits quantified',
      'risks assessed with probability',
      'cost estimated',
      'roi calculated or argued',
      'worst case acceptable',
    ],
    questionTemplates: [
      '这个方案的预期收益是什么？能否量化？',
      '方案的主要风险有哪些？发生概率和代价多高？',
      '投入（时间/复杂度/维护成本）与预期收益是否匹配？',
      '如果不做这个方案，最坏后果是什么？发生概率多高？',
      '有没有更轻量的替代路径能达到 80% 的收益？',
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 第一性原则维度（元层次 — 检测思维起点）
  // ═══════════════════════════════════════════════════════════════════════════

  FIRST_PRINCIPLES: {
    name: '第一性原则',
    description: '起点验证：结论是从基本事实推导的，还是从类比/惯例/经验借来的？',
    paulElder: false,
    firstPrinciples: true,  // 元层次标记
    checks: [
      'fundamental facts identified',
      'analogies challenged',
      'assumptions decomposed',
      'derived from basics',
      'convention questioned',
    ],
    questionTemplates: [
      '你的结论是从哪些基本事实推导出来的？还是从类比/惯例借来的？',
      '如果抛开所有行业惯例和经验，从零推导，你会得出同样的结论吗？',
      '你做的哪些假设是"历史上一直这样做"而非"物理/逻辑上必须这样做"？',
      '这个问题的本质约束是什么？哪些是真正的限制，哪些只是惯例？',
      '如果你是第一个解决这个问题的人，没有任何参考，你会怎么做？',
    ],
  },
};

// Twelve dimensions (ADR-55 Rev.3 — added ROI_ASSESSMENT)
const TWELVE_DIMENSIONS = TEN_DIMENSIONS;

// Backward compatibility aliases
const ELEVEN_DIMENSIONS = TEN_DIMENSIONS;
const SEVEN_DIMENSIONS = TEN_DIMENSIONS;
const SIX_DIMENSIONS = TEN_DIMENSIONS;
const FIVE_DIMENSIONS = TEN_DIMENSIONS;

// Socratic questioning layers (What → Why → How → What-if)
const SOCRATIC_LAYERS = {
  What: {
    description: 'Clarify claims and definitions',
    templates: [
      'What exactly do you mean by "{claim}"?',
      'What are the specific deliverables you produced?',
      'What criteria did you use to determine success?',
      'What assumptions did you make?',
    ],
  },
  Why: {
    description: 'Probe reasoning and justification',
    templates: [
      'Why did you choose this approach over alternatives?',
      'Why should we trust this conclusion without evidence?',
      'Why did you not consider {alternative}?',
      'Why is this the optimal solution?',
    ],
  },
  How: {
    description: 'Examine implementation and process',
    templates: [
      'How did you verify that this works correctly?',
      'How would this perform under {stress_condition}?',
      'How did you handle edge cases like {edge_case}?',
      'How confident are you? What would change your mind?',
    ],
  },
  'What-if': {
    description: 'Challenge with scenarios and risks',
    templates: [
      'What if {assumption} turned out to be false?',
      'What if the user {unexpected_behavior}?',
      'What would happen in production at scale?',
      'What could go wrong that you haven\'t considered?',
    ],
  },
};

// Stage-specific challenge patterns
const STAGE_CHALLENGES = {
  ANALYSE: {
    claims: ['requirement understood', 'scope defined', 'stakeholders identified'],
    probes: [
      'What is the core value proposition for the user?',
      'If this feature didn\'t exist, what would the user lose?',
      'What edge cases in the requirement have you not addressed?',
      'Who are the stakeholders and have you validated their needs?',
      'What constraints are you assuming that might not be true?',
    ],
  },
  ARCHITECT: {
    claims: ['architecture designed', 'components defined', 'interfaces specified'],
    probes: [
      'What happens to this architecture under high concurrency?',
      'What are the single points of failure?',
      'How does this design handle network partitions?',
      'What trade-offs did you make and why?',
      'What would need to change if requirements doubled in complexity?',
    ],
  },
  PLAN: {
    claims: ['tasks identified', 'dependencies mapped', 'timeline estimated'],
    probes: [
      'What tasks might take longer than expected and why?',
      'What dependencies could block progress?',
      'What risks have you not accounted for?',
      'What would you do if a critical dependency failed?',
      'How confident is your timeline estimate?',
    ],
  },
  CODE: {
    claims: ['code written', 'tests passing', 'implementation complete'],
    probes: [
      'What edge cases does your code NOT handle?',
      'What would happen with invalid/malicious input?',
      'Where might performance bottlenecks occur?',
      'What technical debt are you introducing?',
      'What would a code reviewer criticize?',
    ],
  },
  TEST: {
    claims: ['tests passing', 'coverage achieved', 'quality verified'],
    probes: [
      'What scenarios did you NOT test?',
      'How would this behave with corrupted data?',
      'What happens under load/stress conditions?',
      'What assumptions are your tests making?',
      'What would cause these tests to fail in production?',
    ],
  },
};

// ─── Stage Artifact Schema (for targeted Socratic questioning) ───────────────
const STAGE_ARTIFACT_SCHEMA = {
  ANALYSE: {
    expectedSections: [
      { heading: /根因|root\s*cause/i, required: true, minWords: 30, contentType: 'conclusion',
        qualityChecks: ['file_paths', 'why_not_what'], label: '根因分析' },
      { heading: /受影响位置|affected/i, required: true, minWords: 10, contentType: 'evidence',
        qualityChecks: ['table_or_list', 'file_paths'], label: '受影响位置' },
      { heading: /修改范围|change\s*scope/i, required: true, minWords: 20, contentType: 'decision',
        qualityChecks: ['table_format', 'actionable'], label: '修改范围' },
      { heading: /风险评估|risk/i, required: true, minWords: 15, contentType: 'risk',
        qualityChecks: ['severity_levels', 'mitigation'], label: '风险评估' },
    ],
  },
  ARCHITECT: {
    expectedSections: [
      { heading: /设计|design|组件|component/i, required: true, minWords: 30, contentType: 'decision',
        qualityChecks: ['module_refs', 'trade_offs'], label: '架构设计' },
      { heading: /接口|interface|contract/i, required: false, minWords: 15, contentType: 'decision',
        qualityChecks: ['input_output'], label: '接口定义' },
      { heading: /数据流|data\s*flow|流程/i, required: false, minWords: 10, contentType: 'evidence',
        qualityChecks: ['diagram_or_steps'], label: '数据流' },
    ],
  },
  PLAN: {
    expectedSections: [
      { heading: /T-\d+|任务|task/i, required: true, minWords: 10, contentType: 'decision',
        qualityChecks: ['file_paths', 'impl_steps'], label: '任务定义' },
    ],
  },
  CODE: {
    expectedSections: [],
  },
  DEVELOP: {
    expectedSections: [],
  },
  TEST: {
    expectedSections: [
      { heading: /测试|test|结果|result/i, required: true, minWords: 10, contentType: 'evidence',
        qualityChecks: ['test_commands', 'pass_fail'], label: '测试结果' },
    ],
  },
  REVIEW: {
    expectedSections: [
      { heading: /审查|review|风险|risk/i, required: false, minWords: 10, contentType: 'conclusion',
        qualityChecks: ['severity_levels'], label: '审查结论' },
    ],
  },
  DEPLOY: {
    expectedSections: [
      { heading: /部署|deploy|激活|activation/i, required: false, minWords: 5, contentType: 'decision',
        qualityChecks: [], label: '部署说明' },
    ],
  },
};

// Stage position weights for dynamic scoring (earlier stages have higher cascade risk)
const STAGE_POSITION_WEIGHTS = {
  ANALYSE: 0.10, ARCHITECT: 0.08, PLAN: 0.06,
  CODE: 0.04, DEVELOP: 0.04, TEST: 0.02,
  REVIEW: 0, DEPLOY: 0,
};

// Quality check patterns for schema gap detection
const QUALITY_CHECK_PATTERNS = {
  file_paths: /\b\w[\w/-]*\.(js|ts|py|go|java|md|json)\b/,
  why_not_what: /因为|由于|because|therefore|根因|root\s*cause/i,
  table_or_list: /\|.*\||\n[-*]\s/,
  table_format: /\|.*\|.*\|/,
  actionable: /修改|新增|删除|替换|modify|add|delete|replace/i,
  severity_levels: /P[012]|严重|高|中|低|critical|high|medium|low/i,
  mitigation: /缓解|规避|mitigation|workaround|fallback/i,
  module_refs: /(?:workflow|src|core|lib)\/[\w.-]+/,
  trade_offs: /权衡|trade.?off|取舍|优缺点|pros.*cons/i,
  input_output: /输入|输出|input|output|参数|param|return/i,
  diagram_or_steps: /```|flowchart|sequenceDiagram|步骤|step\s*\d/i,
  impl_steps: /实现|implement|步骤|step/i,
  test_commands: /node|npm|pytest|jest|test|assert/i,
  pass_fail: /pass|fail|通过|失败|✅|❌|\d+\/\d+/i,
};

// ─── E4: Answer Quality Gate (borrowed from EGPAgent) ─────────────────────────

const ANSWER_QUALITY_CONFIG = {
  minAnswerLength: 30,
  minSpecificitySignals: 1,
  qualityThreshold: 0.5,
};

const SPECIFICITY_PATTERNS = [
  /\d+/,                                    // Contains numbers
  /[「」『』""]/,                            // Contains quotation marks
  /(?:因为|由于|原因是|根据|because|since)/,  // Causal explanation
  /(?:具体来说|例如|比如|如|e\.g\.|for example)/, // Concrete examples
  /(?:第一|第二|首先|其次|最后|1\.|2\.)/,     // Structured answer
  /(?:方案|策略|机制|流程|步骤|approach|strategy)/, // Action plan
  /(?:workflow|src|core|lib|test)\/[\w.-]+/,  // File path references
];

const EVASION_PATTERNS = [
  /(?:这个问题很好|好问题|值得思考|good question)/i,
  /(?:以后再|后续|待定|暂时不|TBD|TODO)/i,
  /(?:已经考虑|已经处理|已经解决)(?:了|过)?$/,
  /回答解析失败/,
];

/**
 * E4: Evaluate the quality of a self-answer to a Socratic question.
 * Borrowed from EGPAgent's evaluate_answer_quality (4-dimension evaluation).
 *
 * @param {string} questionText - The Socratic question that was asked
 * @param {string} answerText - The self-answer provided by the IDE Agent
 * @param {object} [options] - Optional configuration overrides
 * @returns {{
 *   acceptable: boolean,
 *   qualityScore: number,
 *   dimensions: {length: number, specificity: number, relevance: number, nonEvasion: number},
 *   issues: string[],
 *   suggestion: string
 * }}
 */
function evaluateAnswerQuality(questionText, answerText, options = {}) {
  const config = { ...ANSWER_QUALITY_CONFIG, ...options };
  const answer = String(answerText || '').trim();
  const question = String(questionText || '');
  const issues = [];

  // Dimension 1: Length adequacy (0.0-1.0)
  let lengthScore;
  if (answer.length < config.minAnswerLength) {
    lengthScore = answer.length / Math.max(config.minAnswerLength, 1);
    issues.push(`回答过短（${answer.length}字 < ${config.minAnswerLength}字要求）`);
  } else {
    lengthScore = Math.min(1.0, answer.length / 200);
  }

  // Dimension 2: Specificity (0.0-1.0)
  let specificityHits = 0;
  for (const pattern of SPECIFICITY_PATTERNS) {
    if (pattern.test(answer)) specificityHits++;
  }
  const specificityScore = Math.min(1.0, specificityHits / (config.minSpecificitySignals * 2 || 1));
  if (specificityHits < config.minSpecificitySignals) {
    issues.push(`回答缺乏具体性（仅命中 ${specificityHits} 个具体性信号）`);
  }

  // Dimension 3: Relevance (0.0-1.0)
  const relevanceKeywords = [];
  const TYPE_LABELS = new Set([
    'Schema缺口', '内容锚定', '假设验证', '量化缺失', '逻辑性', '精确性',
    '清晰度', '广度', '深度', '边界', '证据', '数据', '行业对比', '相关性',
    '第一性原理', 'ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST',
  ]);

  const sectionMatch = question.match(/[""\u201c\u201d]([^""\u201c\u201d]+)[""\u201c\u201d]/);
  if (sectionMatch) relevanceKeywords.push(sectionMatch[1]);

  const bracketMatch = question.match(/\[([^\]]+)\]/g);
  if (bracketMatch) {
    for (const m of bracketMatch) {
      const inner = m.slice(1, -1);
      if (inner.length > 1 && inner.length < 30 && !TYPE_LABELS.has(inner)) {
        relevanceKeywords.push(inner);
      }
    }
  }

  const cornerMatch = question.match(/[「『]([^」』]+)[」』]/g);
  if (cornerMatch) {
    for (const m of cornerMatch) {
      const inner = m.slice(1, -1).trim();
      if (inner.length > 3 && inner.length < 80) {
        const phrases = inner.split(/[，。；、,;.\s]+/).filter(p => p.length > 2);
        relevanceKeywords.push(...phrases.slice(0, 3));
      }
    }
  }

  const questionBody = question
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[「『][^」』]+[」』]/g, '')
    .trim();
  const nounPhrasePatterns = [
    /[""\u201c\u201d]([^""\u201c\u201d]{2,20})[""\u201c\u201d]/g,
    /(?:缺少|缺失|缺乏|补充|验证|提供)\s*([^\s，。？]{2,15})/g,
  ];
  for (const pattern of nounPhrasePatterns) {
    let match;
    while ((match = pattern.exec(questionBody)) !== null) {
      const phrase = match[1].trim().replace(/[""\u201c\u201d「」『』]/g, '').trim();
      if (phrase.length > 1 && !relevanceKeywords.includes(phrase)) {
        relevanceKeywords.push(phrase);
      }
    }
  }

  const uniqueKeywords = [...new Set(relevanceKeywords)];
  const relevanceHits = uniqueKeywords.filter(kw => {
    if (answer.includes(kw)) return true;
    if (kw.length > 3) {
      const minLen = Math.ceil(kw.length * 0.6);
      for (let len = kw.length - 1; len >= minLen; len--) {
        if (answer.includes(kw.slice(0, len))) return true;
      }
    }
    return false;
  }).length;
  const relevanceScore = uniqueKeywords.length > 0
    ? Math.min(1.0, relevanceHits / Math.max(1, Math.ceil(uniqueKeywords.length * 0.4)))
    : 0.5;
  if (uniqueKeywords.length > 0 && relevanceHits === 0) {
    issues.push(`回答未提及追问关注的概念（${uniqueKeywords.slice(0, 3).join('、')}）`);
  }

  // Dimension 4: Non-evasion (0.0-1.0)
  let evasionCount = 0;
  for (const pattern of EVASION_PATTERNS) {
    if (pattern.test(answer)) evasionCount++;
  }
  const nonEvasionScore = Math.max(0.0, 1.0 - evasionCount * 0.3);
  if (evasionCount > 0) {
    issues.push(`回答可能在回避问题（检测到 ${evasionCount} 个回避信号）`);
  }

  // Weighted average
  const weights = { length: 0.25, specificity: 0.30, relevance: 0.20, nonEvasion: 0.25 };
  const qualityScore = (
    lengthScore * weights.length +
    specificityScore * weights.specificity +
    relevanceScore * weights.relevance +
    nonEvasionScore * weights.nonEvasion
  );

  const acceptable = qualityScore >= config.qualityThreshold;
  const suggestion = acceptable
    ? ''
    : '请提供更具体的回答：包含具体数值/方案/依据，直接针对追问的设计缺口进行补充。';

  return {
    acceptable,
    qualityScore: Math.round(qualityScore * 100) / 100,
    dimensions: {
      length: Math.round(lengthScore * 100) / 100,
      specificity: Math.round(specificityScore * 100) / 100,
      relevance: Math.round(relevanceScore * 100) / 100,
      nonEvasion: Math.round(nonEvasionScore * 100) / 100,
    },
    issues,
    suggestion,
  };
}

/**
 * 获取指定阶段和任务类型的维度权重配置
 * @param {string} stageName - 当前阶段名称 (如 'ANALYSE')
 * @param {string} [taskFingerprint='general'] - 任务类型指纹 (如 'bugfix', 'performance')
 * @returns {Object} 维度权重映射表
 */
function getStageDimensionChecks(stageName, taskFingerprint = 'general') {
  const baseChecks = {
    ANALYSE: { RELEVANCE: 2, DEPTH: 2, FIRST_PRINCIPLES: 2, EVIDENCE: 2, ROI_ASSESSMENT: 2 },
    ARCHITECT: { BREADTH: 2, LOGIC: 2, BOUNDARY: 2, INDUSTRY_COMPARISON: 1, ROI_ASSESSMENT: 2 },
    PLAN: { PRECISION: 2, LOGIC: 1, DATA: 1, ROI_ASSESSMENT: 1 },
    CODE: { BOUNDARY: 2, EVIDENCE: 2, CLARITY: 1 },
    DEVELOP: { BOUNDARY: 2, EVIDENCE: 2, CLARITY: 1 },
    TEST: { EVIDENCE: 2, BOUNDARY: 2, DATA: 1 },
  };

  const checks = { ...(baseChecks[stageName] || {}) };

  // 动态叠加基于任务类型的权重
  if (taskFingerprint === 'performance') {
    checks.DATA = (checks.DATA || 0) + 1;
    checks.PRECISION = (checks.PRECISION || 0) + 1;
  } else if (taskFingerprint === 'security') {
    checks.BOUNDARY = (checks.BOUNDARY || 0) + 1;
    checks.LOGIC = (checks.LOGIC || 0) + 1;
  } else if (taskFingerprint === 'bugfix') {
    checks.DEPTH = (checks.DEPTH || 0) + 1;
    checks.EVIDENCE = (checks.EVIDENCE || 0) + 1;
  } else if (taskFingerprint === 'test') {
    checks.BOUNDARY = (checks.BOUNDARY || 0) + 1;
    checks.DATA = (checks.DATA || 0) + 1;
  } else if (taskFingerprint === 'feature') {
    checks.BREADTH = (checks.BREADTH || 0) + 1;
    checks.BOUNDARY = (checks.BOUNDARY || 0) + 1;
  } else if (taskFingerprint === 'refactor') {
    checks.LOGIC = (checks.LOGIC || 0) + 1;
    checks.EVIDENCE = (checks.EVIDENCE || 0) + 1;
  }

  return checks;
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  TEN_DIMENSIONS,
  ELEVEN_DIMENSIONS,
  TWELVE_DIMENSIONS,
  SEVEN_DIMENSIONS,
  SIX_DIMENSIONS,
  FIVE_DIMENSIONS,
  SOCRATIC_LAYERS,
  STAGE_CHALLENGES,
  STAGE_ARTIFACT_SCHEMA,
  STAGE_POSITION_WEIGHTS,
  QUALITY_CHECK_PATTERNS,
  ANSWER_QUALITY_CONFIG,
  evaluateAnswerQuality,
  getStageDimensionChecks,
};
