/**
 * Socratic Challenger – Runtime Conclusion Questioning Mechanism
 *
 * ADR-54: Proactive Quality Assurance through Socratic Questioning
 *
 * Implements a "self-doubt" mechanism that CHALLENGES AGENT CONCLUSIONS:
 *  1. Conclusion Extraction – What did the agent claim to accomplish?
 *  2. Socratic Questioning – Use What/Why/How/What-if to probe
 *  3. Blind Spot Detection – Find assumptions, edge cases, risks
 *  4. Evidence Validation – Ask for proof, data, test coverage
 *
 * This is NOT a quality score checker. It's a devil's advocate that
 * questions the agent's conclusions to surface hidden problems.
 *
 * @module workflow/core/socratic-challenger
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config-loader');

// ─── Constants ───────────────────────────────────────────────────────────────

// ─── Eleven Dimensions of Socratic Questioning (ADR-55 Rev.2) ─────────────────
// 基于 Paul-Elder 批判性思维框架 + AI Agent 工程实践扩展
// 
// Paul-Elder 标准维度 (6个):
//   RELEVANCE, BREADTH, DEPTH, LOGIC, CLARITY, PRECISION
// 
// AI Agent 工程特有维度 (4个):
//   BOUNDARY, EVIDENCE, DATA, INDUSTRY_COMPARISON
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

// Eleven dimensions (ADR-55 Rev.2)
const ELEVEN_DIMENSIONS = TEN_DIMENSIONS;

// Backward compatibility aliases
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
// Defines expected structure and quality standards for each stage's artifact.
// Used by _extractArtifactStructure() to generate anchored, schema-gap questions.
// This is SEPARATE from ide-workflow-bridge.js ARTIFACT_SCHEMA (which does pass/fail validation).
// This schema focuses on QUESTIONING quality, not validation.
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
    expectedSections: [], // code.diff validated separately
  },
  DEVELOP: {
    expectedSections: [], // same as CODE
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

// ─── SocraticChallenger Class ────────────────────────────────────────────────

class SocraticChallenger {
  /**
   * @param {object} options
   * @param {number} [options.maxQuestions=3] - Max questions per challenge
   * @param {boolean} [options.verbose=true] - Enable detailed logging
   * @param {function} [options.llmCall] - LLM for semantic analysis (optional)
   */
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();

    let loadedConfig = {};
    try {
      loadedConfig = getConfig(this.projectRoot) || {};
    } catch {
      loadedConfig = {};
    }

    const socraticCfg = loadedConfig.socraticChallenge || {};

    this.maxQuestions = options.maxQuestions ?? socraticCfg.maxQuestions ?? 3;
    this.verbose = options.verbose !== false;
    this.llmCall = options.llmCall || null;
    this.ruleConfig = this._buildRuleConfig(socraticCfg);
    this._challengeHistory = new Map();  // Track challenges per stage
    this._questionHistory = [];
    this._lastRuleDiagnostics = null;
    this._lastHeadingClaims = [];  // D6: Cache heading-level claims for targeted challenge
    // D1: Session-level cross-stage question dedup — prevents the same core question
    // from appearing in multiple stages (e.g. "缺少推导依据" in ANALYSE, ARCHITECT, PLAN...)
    this._sessionQuestionCoreHashes = new Set();
  }

  // ─── Main Entry Point ──────────────────────────────────────────────────────

  /**
   * Challenge an agent's conclusion about a stage output.
   * This is NOT a quality score check - it's a devil's advocate interrogation.
   *
   * @param {string} stageName - e.g. 'ANALYSE', 'ARCHITECT'
   * @param {string|object} output - Stage output (path or content)
   * @param {object} context - Additional context (claims, metrics, etc.)
   * @returns {Promise<{challenged: boolean, questions: string[], blindSpots: string[], confidence: number}>}
   */
  async challenge(stageName, output, context = {}) {
    this._log(`\n${'═'.repeat(50)}`);
    this._log(`[SocraticChallenger] 🤔 DEVIL'S ADVOCATE for stage: ${stageName}`);
    this._log(`${'═'.repeat(50)}`);

    // 1. Extract content and claims
    const content = this._extractContent(output);

    // D5: LIGHTWEIGHT artifact full suppression — skip all challenge generation
    // for artifacts explicitly marked as having no substantive content.
    // Previously only schema-gap was skipped; now ALL sources are suppressed.
    if (String(content || '').includes('[LIGHTWEIGHT]')) {
      this._log(`[SocraticChallenger] 💤 LIGHTWEIGHT artifact detected — skipping all challenges`);
      return {
        challenged: false,
        triggerReasons: ['lightweight_artifact'],
        questions: [],
        blindSpots: [],
        confidence: 1.0,
        confidenceStatus: 'na',
        confidenceReason: 'LIGHTWEIGHT artifact — no substantive content to challenge',
        evidenceBreakdown: null,
        dimensionScores: null,
        shouldRetry: false,
        requiresRevision: false,
        p2Protocol: null,
        revisionSummary: {
          required: false,
          reason: 'lightweight_artifact',
          questionCount: 0,
          blindSpotCount: 0,
          verificationQuestionCount: 0,
          protocol: null,
        },
        ruleDiagnostics: null,
      };
    }

    const claims = this._extractClaims(stageName, content, context);
    this._log(`[SocraticChallenger] 📋 Agent claims: ${claims.join(', ') || '(none explicit)'}`);

    // 2. Generate Socratic questions to challenge claims
    let generatedQuestions = this._generateSocraticQuestions(stageName, claims, content, context);
    
    // 2.5 Rewrite questions dynamically using LLM if available
    if (this.llmCall && generatedQuestions.length > 0) {
      this._log(`[SocraticChallenger] 🧠 Rewriting questions dynamically using LLM...`);
      generatedQuestions = await this._rewriteQuestionsWithLLM(stageName, generatedQuestions, content, context);
    }

    this._log(`[SocraticChallenger] ❓ Generated ${generatedQuestions.length} challenge questions`);

    // 3. Detect blind spots (things agent might have missed)
    const detectedBlindSpots = this._detectBlindSpots(stageName, content, claims, context);
    this._log(`[SocraticChallenger] 🕳️  Detected ${detectedBlindSpots.length} potential blind spots`);

    // 4. Calculate confidence in agent's conclusions
    const taskFingerprint = this._inferTaskFingerprint(stageName, content, context);
    const confidenceResult = this._calculateConfidence(content, claims, detectedBlindSpots, {
      ...context,
      stageName,
      taskFingerprint,
    });
    const confidence = confidenceResult.confidence;
    const confidenceStatus = confidenceResult.confidenceStatus || 'ok';
    const confidenceReason = confidenceResult.confidenceReason || null;
    const evidenceBreakdown = confidenceResult.evidenceBreakdown || null;
    const dimensionScores = confidenceResult.dimensionScores || null;

    const confidenceLabel = confidenceStatus === 'na'
      ? `N/A (${confidenceReason || 'insufficient evidence'})`
      : `${(confidence * 100).toFixed(0)}%`;
    this._log(`[SocraticChallenger] 📊 Confidence in conclusions: ${confidenceLabel}`);

    // 5. P0 trigger gate: challenge only when evidence/risk/logic gap is detected
    const triggerDecision = this._decideChallengeTrigger({
      stageName,
      claims,
      blindSpots: detectedBlindSpots,
      confidence,
      confidenceStatus,
      confidenceReason,
      evidenceBreakdown,
      dimensionScores,
      taskFingerprint,
      context,
    });

    const challenged = triggerDecision.shouldChallenge;
    const questions = challenged ? generatedQuestions : [];
    const blindSpots = challenged ? detectedBlindSpots : [];

    if (challenged && questions.length > 0) {
      this._log(`[SocraticChallenger] ── CHALLENGE QUESTIONS ──`);
      questions.forEach((q, i) => this._log(`  ${i + 1}. ${q}`));
    }

    if (challenged && blindSpots.length > 0) {
      this._log(`[SocraticChallenger] ── BLIND SPOTS ──`);
      blindSpots.forEach((bs, i) => this._log(`  ${i + 1}. ${bs}`));
    }

    if (!challenged) {
      this._log(`[SocraticChallenger] 💤 Trigger gate skipped challenge: ${triggerDecision.reasons.join('; ') || 'no critical evidence gap'}`);
    }

    this._log(`${'═'.repeat(50)}\n`);

    // Record challenge history
    this._challengeHistory.set(stageName, {
      timestamp: new Date().toISOString(),
      claims,
      questions,
      blindSpots,
      confidence,
      confidenceStatus,
      confidenceReason,
      evidenceBreakdown,
      trigger: triggerDecision,
    });

    const shouldRetry = challenged && confidenceStatus === 'ok' && confidence < 0.50;
    const requiresRevision = challenged;
    const p2Protocol = challenged
      ? this._buildP2RevisionProtocol(stageName, {
        questions,
        blindSpots,
        triggerReasons: triggerDecision.reasons,
        context,
      })
      : null;

    return {
      challenged,
      triggerReasons: triggerDecision.reasons,
      questions,
      blindSpots,
      confidence,
      confidenceStatus,
      confidenceReason,
      evidenceBreakdown,
      dimensionScores,
      shouldRetry,
      requiresRevision,
      p2Protocol,
      revisionSummary: {
        required: requiresRevision,
        reason: triggerDecision.reasons[0] || null,
        questionCount: questions.length,
        blindSpotCount: blindSpots.length,
        verificationQuestionCount: p2Protocol?.verificationQuestions?.length || 0,
        protocol: p2Protocol?.name || null,
      },
      ruleDiagnostics: this._lastRuleDiagnostics || null,
    };
  }

  // ─── Content Extraction ────────────────────────────────────────────────────

  /**
   * Extract content from output (path or direct content).
   */
  _extractContent(output) {
    if (!output) return '';

    if (typeof output === 'string') {
      // Check if it looks like a file path
      if (output.includes(path.sep) || output.endsWith('.md') || output.endsWith('.txt')) {
        try {
          if (fs.existsSync(output)) {
            return fs.readFileSync(output, 'utf-8');
          }
        } catch (err) {
          this._log(`[SocraticChallenger] ⚠️  Could not read file: ${err.message}`);
        }
      }
      return output;
    }

    if (typeof output === 'object' && output.artifactPath) {
      try {
        if (fs.existsSync(output.artifactPath)) {
          return fs.readFileSync(output.artifactPath, 'utf-8');
        }
      } catch (err) {
        this._log(`[SocraticChallenger] ⚠️  Could not read artifact: ${err.message}`);
      }
    }

    if (typeof output === 'object' && output.content) {
      return output.content;
    }

    return String(output);
  }

  /**
   * Extract claims the agent is making about the output.
   */
  // D6: Enhanced claim extraction — extract concrete assertions from artifact content,
  // not just regex-matched English phrases. Parses heading-level claims, decision statements,
  // and quantitative assertions.
  _extractClaims(stageName, content, context) {
    const claims = [];
    const contentStr = String(content || '');

    // Get stage-specific default claims
    const stageConfig = STAGE_CHALLENGES[stageName];
    if (stageConfig && stageConfig.claims) {
      claims.push(...stageConfig.claims);
    }

    // D6: Extract heading-level claims (## headings are implicit claims about what was done)
    const headingClaims = [];
    const headingRe = /^#{1,3}\s+(.+)/gm;
    let hMatch;
    while ((hMatch = headingRe.exec(contentStr)) !== null) {
      const title = hMatch[1].trim();
      // Skip generic headings like "Overview", "Summary"
      if (title.length > 5 && !/^(overview|summary|\u6982\u8ff0|\u603b\u7ed3|table of contents|\u76ee\u5f55)$/i.test(title)) {
        headingClaims.push(title);
      }
    }

    // D6: Extract decision/conclusion statements
    const decisionPatterns = [
      /(?:\u51b3\u5b9a|\u9009\u62e9|\u91c7\u7528|\u786e\u5b9a|\u7ed3\u8bba\u662f|\u56e0\u6b64|\u6240\u4ee5|therefore|decided to|chose|concluded)\s*[\uff1a:]?\s*([^\n.\u3002]{10,80})/gi,
      /(?:The|This)\s+(?:architecture|design|implementation|solution)\s+(?:is|provides|supports)\s+([^.]{10,80})/gi,
    ];

    for (const pattern of decisionPatterns) {
      let match;
      while ((match = pattern.exec(contentStr)) !== null) {
        const claim = (match[1] || match[0]).trim();
        if (claim && claim.length > 10 && !claims.includes(claim)) {
          claims.push(claim);
        }
      }
    }

    // D6: Extract quantitative assertions (numbers that imply a claim)
    const quantPatterns = [
      /(?:coverage|\u8986\u76d6\u7387)\s*(?:is|at|\u4e3a|\u8fbe\u5230)?\s*(\d+%?)/gi,
      /(?:performance|\u6027\u80fd)\s+(?:improved?|\u63d0\u5347)\s+(?:by\s+)?(\d+%?)/gi,
      /(\d+)\s*(?:tests?|\u6d4b\u8bd5)\s+(?:passed?|\u901a\u8fc7)/gi,
    ];

    for (const pattern of quantPatterns) {
      let match;
      while ((match = pattern.exec(contentStr)) !== null) {
        const claim = match[0].trim();
        if (claim && !claims.includes(claim)) {
          claims.push(claim);
        }
      }
    }

    // Extract explicit claims from content (original patterns)
    const claimPatterns = [
      /(?:I have|I've|We have|completed|finished|implemented|created|designed|verified|tested)\s+([^.]+)/gi,
      /(?:All|The)\s+tests?\s+(?:passed?|passing)/gi,
    ];

    for (const pattern of claimPatterns) {
      let match;
      while ((match = pattern.exec(contentStr)) !== null) {
        const claim = match[1] || match[0];
        if (claim && !claims.includes(claim)) {
          claims.push(claim.trim());
        }
      }
    }

    // Add claims from context
    if (context.claims) {
      claims.push(...context.claims);
    }

    // D6: Store heading claims separately for targeted challenge
    this._lastHeadingClaims = headingClaims;

    // D6: Promote heading claims that contain decision/conclusion keywords to main claims
    const decisionKeywords = /决定|选择|采用|结论|方案|设计|implemented|decided|chose|selected|conclusion/i;
    for (const hc of headingClaims) {
      if (decisionKeywords.test(hc) && !claims.includes(hc)) {
        claims.push(hc);
      }
    }

    return claims;
  }
  // ─── Socratic Question Generation ───────────────────────────────────────────

  /**
   * Rewrite template-based questions dynamically using LLM to make them highly contextual.
   */
  async _rewriteQuestionsWithLLM(stageName, questions, content, context) {
    if (!this.llmCall || questions.length === 0) return questions;

    try {
      const requirement = this._extractRequirementText(context);
      const truncatedContent = String(content || '').slice(0, 3000);
      
      const prompt = `
You are a Socratic Challenger. Your task is to rewrite the following template-based questions to be highly specific to the current context.
Do NOT change the core intent of the questions, just make them sound natural and directly reference the specific details in the content.
Do NOT answer the questions. Just output the rewritten questions.
IMPORTANT: The rewritten questions MUST be in Chinese (中文).

Stage: ${stageName}
Requirement: ${requirement}

Content Snippet:
${truncatedContent}

Original Questions:
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Output ONLY the rewritten questions in Chinese, one per line, numbered (e.g., "1. ..."). Keep them concise and sharp.
`;

      const response = await this.llmCall(prompt, `socratic-rewrite-${stageName.toLowerCase()}`);
      if (!response) return questions;

      // Extract lines that look like numbered list items
      const rewritten = response.split('\n')
        .map(l => l.trim())
        .filter(l => /^\d+\.\s+/.test(l))
        .map(l => l.replace(/^\d+\.\s*/, '').trim())
        .filter(Boolean);

      if (rewritten.length > 0) {
        // If we got at least some valid rewritten questions, use them (up to the original count)
        return rewritten.slice(0, questions.length);
      }
      return questions;
    } catch (err) {
      this._log(`[SocraticChallenger] ⚠️ LLM rewrite failed: ${err.message}`);
      return questions;
    }
  }

  /**
   * Generate Socratic questions to challenge the agent's claims.
   * Now uses task fingerprint + evidence-gap reranking to reduce repetitive outputs.
   */
  _generateSocraticQuestions(stageName, claims, content, context = {}) {
    const stageConfig = STAGE_CHALLENGES[stageName];
    const requirement = this._extractRequirementText(context);
    const snippets = this._extractStageSnippets(content, stageName);
    const taskFingerprint = this._inferTaskFingerprint(stageName, content, context);

    const candidates = [];

    // P0: Schema-gap questions (highest priority — content anchoring + schema mapping)
    // Skip for LIGHTWEIGHT artifacts
    if (!String(content || '').includes('[LIGHTWEIGHT]')) {
      const artifactStructure = this._extractArtifactStructure(content, stageName);
      this._lastArtifactStructure = artifactStructure; // cache for scoring
      for (const q of (artifactStructure.anchoredQuestions || [])) {
        candidates.push({
          question: q.question,
          reasonTag: 'schema_gap',
          source: 'schema',
          priority: 0.98,
          severity: q.severity,
          anchorSection: q.anchorSection,
          anchorLine: q.anchorLine,
        });
      }
    }

    // F6: Rule-driven questions — PRIORITY DEMOTED to P3 (backfill only)
    // Industry reference: Claude Code's "model-centric" philosophy — rules are for
    // hard constraints (security), not soft quality (questioning). Rule-driven questions
    // only fill remaining slots when content-driven questions are insufficient.
    const ruleDriven = this._collectRuleDrivenQuestions(stageName, content, context);
    this._lastRuleDiagnostics = ruleDriven.diagnostics;
    for (const q of (ruleDriven.questions || [])) {
      candidates.push({
        question: q,
        reasonTag: 'missing_evidence',
        source: 'rule',
        priority: 0.65,  // F6: Demoted from 0.95 to 0.65 (below claim 0.96, task 0.88, dimension 0.8)
      });
    }

    // Eleven-dimension questions
    const dimensionQuestions = this._generateDimensionQuestions(stageName, content, context, snippets);
    for (const q of dimensionQuestions) {
      candidates.push({
        question: q,
        reasonTag: 'coverage_gap',
        source: 'dimension',
        priority: 0.8,
      });
    }

    // Task-type specific probes
    const taskProbes = this._generateTaskSpecificProbes(taskFingerprint, stageName, content, requirement);
    for (const q of taskProbes) {
      candidates.push({
        question: q,
        reasonTag: 'task_specific_gap',
        source: 'task',
        priority: 0.88,
      });
    }

    // Stage-specific probes (grounded by requirement)
    if (stageConfig && stageConfig.probes) {
      const contentLower = content.toLowerCase();
      const relevantProbes = stageConfig.probes.filter(probe => {
        const keyWords = this._extractKeyWords(probe);
        return !keyWords.some(kw => contentLower.includes(kw.toLowerCase()));
      });

      for (const probe of relevantProbes.slice(0, 2)) {
        const q = requirement
          ? `[${stageName}] 针对需求"${this._truncate(requirement, 50)}"，${probe}`
          : `[${stageName}] ${probe}`;
        candidates.push({
          question: q,
          reasonTag: 'stage_probe',
          source: 'stage',
          priority: 0.72,
        });
      }
    }

    // F6: Challenge specific claims using Socratic layers — PRIORITY ELEVATED
    // Industry reference: Claude Code's "model-centric" philosophy — content-driven
    // questions always rank above rule-driven templates. Claim-specific challenges
    // are anchored to actual artifact content, making them more actionable.
    for (const claim of claims.slice(0, 3)) {
      const layerQuestions = this._challengeClaimWithLayers(claim, content);
      for (const q of layerQuestions) {
        candidates.push({
          question: q,
          reasonTag: 'claim_verification',
          source: 'claim',
          priority: 0.96,  // F6: Elevated from 0.82 to 0.96 (above rule-driven 0.85)
        });
      }
    }
    // What-if scenario
    const whatIfQuestion = this._generateWhatIfQuestion(stageName, content);
    if (whatIfQuestion) {
      candidates.push({
        question: whatIfQuestion,
        reasonTag: 'boundary_risk',
        source: 'what_if',
        priority: 0.74,
      });
    }

    // D7: Cross-stage consistency questions — detect contradictions/gaps
    // between current artifact and previous stage artifacts
    const crossStageQuestions = this._generateCrossStageQuestions(stageName, content, context);
    for (const q of crossStageQuestions) {
      candidates.push({
        question: q,
        reasonTag: 'cross_stage_gap',
        source: 'cross_stage',
        priority: 0.92,  // High priority — cross-stage inconsistencies are critical
      });
    }

    const selected = this._selectAndRerankQuestions(candidates, taskFingerprint, content, context);
    this._rememberQuestions(selected);

    return selected;
  }

  /**
   * Generate questions for each of the eleven dimensions.
   */
  _generateDimensionQuestions(stageName, content, context = {}, snippets = []) {
    const questions = [];
    const contentLower = content.toLowerCase();
    const requirement = this._extractRequirementText(context);

    for (const [dimKey, dim] of Object.entries(ELEVEN_DIMENSIONS)) {
      const missingChecks = this._getMissingChecksForDimension(dimKey, dim, stageName, contentLower);
      if (missingChecks.length === 0) continue;

      const question = this._buildContextualDimensionQuestion({
        dim,
        stageName,
        requirement,
        snippets,
        missingChecks,
      });

      if (question) questions.push(question);
    }

    return questions;
  }

  _getMissingChecksForDimension(dimKey, dim, stageName, contentLower) {
    const allCheckKeys = [
      ...dim.checks,
      ...(this._getStageDimensionChecks(stageName, dimKey) || []),
    ];

    const missing = [];
    for (const check of allCheckKeys) {
      const signals = this._expandCheckSignals(check);
      const hit = signals.some(s => this._containsSignal(contentLower, s));
      if (!hit) {
        missing.push(check);
      }
    }

    return missing;
  }

  _buildContextualDimensionQuestion({ dim, stageName, requirement, snippets, missingChecks }) {
    const template = dim.questionTemplates[Math.min(missingChecks.length - 1, dim.questionTemplates.length - 1)];
    if (!template) return null;

    const missingFocus = missingChecks.slice(0, 2).join('、');
    const requirementPart = requirement
      ? `需求“${this._truncate(requirement, 50)}”`
      : '当前任务';

    const snippet = snippets && snippets.length > 0
      ? `当前输出中“${this._truncate(snippets[0], 40)}”`
      : `当前${stageName}阶段输出`;

    return `[${dim.name}][${stageName}] 对于${requirementPart}，${snippet}尚未体现“${missingFocus}”，${template}`;
  }

  // D3: Refined task fingerprint — 8 types with confidence scoring and content-based classification
  _inferTaskFingerprint(stageName, content, context = {}) {
    const requirement = this._extractRequirementText(context);
    const text = `${String(requirement || '')}\n${String(content || '')}`.toLowerCase();

    const hasAny = (patterns) => patterns.some(p => p.test(text));
    const countHits = (patterns) => patterns.filter(p => p.test(text)).length;

    // D3: Score each task type by signal density (not just first-match)
    const typeScores = {
      bugfix:       countHits([/bug/i, /fix/i, /regression/i, /故障/, /报错/, /修复/, /异常/, /失败/, /crash/, /error.*handling/i, /stack.*trace/i]),
      refactor:     countHits([/refactor/i, /重构/, /cleanup/, /重整/, /优化结构/, /tech.*debt/i, /技术债/, /code.*smell/i, /extract.*method/i]),
      ops:          countHits([/deploy/i, /release/i, /运维/, /ops/i, /告警/, /监控/, /incident/i, /sre/i, /infra/i, /ci.*cd/i, /pipeline/i]),
      research:     countHits([/research/i, /调研/, /方案对比/, /benchmark/i, /ab.*test/i, /实验/, /poc/i, /spike/i, /feasibility/i, /可行性/]),
      enhancement:  countHits([/enhance/i, /增强/, /improve/i, /优化/, /提升/, /升级/, /upgrade/i, /boost/i]),
      migration:    countHits([/migrat/i, /迁移/, /升级.*版本/, /version.*upgrade/i, /compat/i, /兼容/, /breaking.*change/i]),
      integration:  countHits([/integrat/i, /集成/, /对接/, /接入/, /third.*party/i, /第三方/, /api.*connect/i, /sdk/i]),
      feature:      countHits([/feature/i, /功能/, /需求/, /新增/, /implement/i, /实现/, /add.*support/i, /user.*story/i]),
    };

    // Pick highest-scoring type; default to 'feature' on tie
    let taskType = 'feature';
    let maxScore = 0;
    for (const [type, score] of Object.entries(typeScores)) {
      if (score > maxScore) {
        maxScore = score;
        taskType = type;
      }
    }

    // D3: Confidence = how clearly one type dominates
    const totalSignals = Object.values(typeScores).reduce((a, b) => a + b, 0);
    const typeConfidence = totalSignals > 0 ? maxScore / totalSignals : 0;

    const riskProfile = [];
    if (hasAny([/security|auth|权限|注入|xss|csrf|安全/])) riskProfile.push('security');
    if (hasAny([/latency|qps|性能|吞吐|并发|延迟/])) riskProfile.push('latency');
    if (hasAny([/rollback|回滚|降级|fallback|容灾/])) riskProfile.push('rollback');
    if (hasAny([/compat|兼容|breaking change|迁移/])) riskProfile.push('compatibility');
    if (hasAny([/data.*loss|数据.*丢失|corrupt|损坏/])) riskProfile.push('data_integrity');
    if (riskProfile.length === 0) riskProfile.push('correctness');

    const evidenceNeeds = this._buildEvidenceSlots({ taskType, riskProfile }, stageName);

    return {
      taskType,
      typeConfidence,
      typeScores,
      riskProfile,
      evidenceNeeds,
      stageName,
    };
  }

  _buildEvidenceSlots(taskFingerprint = {}, stageName = '') {
    const slots = new Set();
    slots.add('reasoning');
    slots.add('tests');

    const taskType = taskFingerprint.taskType || 'feature';
    if (taskType === 'bugfix') {
      slots.add('logs');
      slots.add('repro');
      slots.add('root_cause');
    }
    if (taskType === 'ops') {
      slots.add('metrics');
      slots.add('rollback_proof');
    }
    if (taskType === 'research') {
      slots.add('benchmark');
      slots.add('industry_comparison');
    }
    if (taskType === 'refactor') {
      slots.add('diff_scope');
      slots.add('compatibility');
    }
    // D3: New task type evidence slots
    if (taskType === 'enhancement') {
      slots.add('baseline_comparison');
      slots.add('metrics');
    }
    if (taskType === 'migration') {
      slots.add('compatibility');
      slots.add('rollback_proof');
      slots.add('data_integrity');
    }
    if (taskType === 'integration') {
      slots.add('interfaces');
      slots.add('error_handling');
      slots.add('timeout_strategy');
    }

    const risks = Array.isArray(taskFingerprint.riskProfile) ? taskFingerprint.riskProfile : [];
    if (risks.includes('latency')) slots.add('metrics');
    if (risks.includes('security')) slots.add('threat_model');
    if (risks.includes('rollback')) slots.add('rollback_proof');
    if (risks.includes('compatibility')) slots.add('compatibility');
    if (risks.includes('data_integrity')) slots.add('data_integrity');

    if (stageName === 'ARCHITECT') slots.add('interfaces');
    if (stageName === 'PLAN') slots.add('dependencies');
    if (stageName === 'TEST') slots.add('coverage');

    return [...slots];
  }

  // D3: Expanded task-specific probes for 8 task types
  _generateTaskSpecificProbes(taskFingerprint, stageName, content, requirement) {
    const probesByType = {
      bugfix: [
        '当前修复如何稳定复现并验证不再复发？',
        '根因证据是什么？如何证明不是伴随症状？',
        '是否提供了回归测试覆盖此次故障路径？',
      ],
      feature: [
        '这个需求的验收标准是否可量化且可重复验证？',
        '用户价值与实现复杂度之间的权衡是否明确？',
        '功能上线后如何观测是否达到预期目标？',
      ],
      refactor: [
        '重构前后行为一致性的证据是什么？',
        '本次重构边界在哪里，如何避免隐性范围蔓延？',
        '兼容性风险如何评估并验证？',
      ],
      ops: [
        '关键监控指标阈值和告警策略是否已定义？',
        '故障时的回滚与降级路径是否经过演练？',
        '运行手册中是否包含排障步骤和恢复SLO？',
      ],
      research: [
        '候选方案的对比维度和实验变量是否可复现？',
        '结论是否由数据驱动，而非主观偏好？',
        '是否标注了适用边界与失效条件？',
      ],
      // D3: New task types
      enhancement: [
        '增强前后的性能/质量基线对比数据是什么？',
        '本次增强的边界在哪里，如何避免过度工程？',
        '增强效果如何量化验证？',
      ],
      migration: [
        '迁移前后的数据一致性如何验证？',
        '回退方案是否经过测试？迁移失败时的恢复路径是什么？',
        '兼容性矩阵是否覆盖所有受影响的下游消费者？',
      ],
      integration: [
        '第三方接口的错误处理和超时策略是否已定义？',
        '集成测试是否覆盖了认证失败、限流、数据格式变更等边界场景？',
        '外部依赖不可用时的降级方案是什么？',
      ],
    };

    const taskType = taskFingerprint?.taskType || 'feature';
    const typeConfidence = taskFingerprint?.typeConfidence || 0;
    const probes = probesByType[taskType] || probesByType.feature;
    const requirementPrefix = requirement ? `针对需求"${this._truncate(requirement, 50)}"，` : '';

    // D3: If type confidence is low (<0.3), also include generic probes
    const contentLower = String(content || '').toLowerCase();
    let filtered = probes
      .filter(p => !this._extractKeyWords(p).some(kw => contentLower.includes(kw.toLowerCase())));

    if (typeConfidence < 0.3 && taskType !== 'feature') {
      // Low confidence — supplement with feature probes as fallback
      const featureFallback = (probesByType.feature || [])
        .filter(p => !this._extractKeyWords(p).some(kw => contentLower.includes(kw.toLowerCase())));
      filtered = [...filtered.slice(0, 1), ...featureFallback.slice(0, 1)];
    }

    return filtered
      .slice(0, 2)
      .map(p => `[${stageName}][${taskType}] ${requirementPrefix}${p}`);
  }
  _selectAndRerankQuestions(candidates, taskFingerprint, content, context = {}) {
    const maxQuestions = Math.max(1, this.maxQuestions);
    const dedup = [];
    const seen = new Set();

    for (const item of candidates || []) {
      const q = String(item?.question || '').trim();
      if (!q) continue;
      if (seen.has(q)) continue;
      seen.add(q);
      dedup.push({ ...item, question: q });
    }

    const scored = dedup.map(item => ({
      ...item,
      score: this._scoreQuestionCandidate(item, taskFingerprint, content, context),
    }));

    scored.sort((a, b) => b.score - a.score);

    // ── P0/P1/P2 layered selection (dynamic priority ranking) ──
    // P0: missing required sections (schema gaps) — always first
    // P1: weak content (schema quality issues) — second priority
    // P2: all other questions — fill remaining slots
    const MAX_PER_LAYER = 2;
    const selected = [];

    const isSimilar = (q) => {
      const tooSimilarToSelected = selected.some(s => this._semanticSimilarity(s, q) > 0.82);
      const tooSimilarToHistory = this._questionHistory.some(s => this._semanticSimilarity(s, q) > 0.82);
      // D1: Cross-stage session-level dedup — reject questions whose core text
      // (stripped of stage name, line numbers, section names) was already asked
      const coreHash = this._computeQuestionCoreHash(q);
      const alreadyAskedInSession = this._sessionQuestionCoreHashes.has(coreHash);
      return tooSimilarToSelected || tooSimilarToHistory || alreadyAskedInSession;
    };

    // Layer P0: missing_required
    const p0 = scored.filter(i => i.severity === 'missing_required');
    for (const item of p0) {
      if (selected.length >= maxQuestions) break;
      if (selected.length >= MAX_PER_LAYER && item.severity === 'missing_required') {
        // Allow max 2 P0 questions to avoid overwhelming
        const p0Count = selected.filter(s => scored.find(sc => sc.question === s)?.severity === 'missing_required').length;
        if (p0Count >= MAX_PER_LAYER) break;
      }
      if (!isSimilar(item.question)) selected.push(item.question);
    }

    // Layer P1: weak_content
    const p1 = scored.filter(i => i.severity === 'weak_content');
    for (const item of p1) {
      if (selected.length >= maxQuestions) break;
      if (!isSimilar(item.question)) selected.push(item.question);
    }

    // D2: In P2 layer, prioritize schema_gap source over generic questions
    // This ensures content-anchored questions always rank above template-based ones
    const p2SchemaGap = scored.filter(i =>
      i.severity !== 'missing_required' && i.severity !== 'weak_content' && i.source === 'schema'
    );
    for (const item of p2SchemaGap) {
      if (selected.length >= maxQuestions) break;
      if (selected.includes(item.question)) continue;
      if (!isSimilar(item.question)) selected.push(item.question);
    }

    // Layer P2: everything else (by score)
    for (const item of scored) {
      if (selected.length >= maxQuestions) break;
      if (selected.includes(item.question)) continue;
      if (!isSimilar(item.question)) selected.push(item.question);
    }

    // Fallback: fill remaining slots without similarity check
    if (selected.length < maxQuestions) {
      for (const item of scored) {
        if (selected.length >= maxQuestions) break;
        if (!selected.includes(item.question)) selected.push(item.question);
      }
    }

    return selected;
  }

  _scoreQuestionCandidate(item, taskFingerprint, content, context = {}) {
    const q = String(item?.question || '').toLowerCase();
    const base = Number(item?.priority || 0.5);

    const evidenceNeeds = Array.isArray(taskFingerprint?.evidenceNeeds) ? taskFingerprint.evidenceNeeds : [];
    const evidenceHits = evidenceNeeds.filter(slot => q.includes(slot.replace('_', '')) || q.includes(this._slotDisplayText(slot).toLowerCase()));
    const evidenceBoost = evidenceHits.length > 0 ? 0.15 : 0;

    const riskProfile = Array.isArray(taskFingerprint?.riskProfile) ? taskFingerprint.riskProfile : [];
    const riskBoost = riskProfile.some(r => q.includes(String(r).toLowerCase())) ? 0.08 : 0;

    const requirement = this._extractRequirementText(context).toLowerCase();
    const requirementBoost = requirement && this._extractKeyWords(requirement).some(k => q.includes(k.toLowerCase())) ? 0.06 : 0;

    const contentLower = String(content || '').toLowerCase();
    const noveltyBoost = this._extractKeyWords(q).some(k => !contentLower.includes(k.toLowerCase())) ? 0.04 : 0;

    // ── Dynamic factors (schema gap severity + stage position) ──
    // Schema gap boost: questions about missing/weak sections get priority
    const severity = item?.severity || '';
    const schemaGapBoost = severity === 'missing_required' ? 0.25
      : severity === 'weak_content' ? 0.15
      : severity === 'missing_optional' ? 0.05
      : severity === 'untested_assumption' ? 0.20
      : severity === 'weak_evidence' ? 0.18
      : 0;

    // Stage position boost: earlier stages have higher cascade risk
    const stageName = String(context?.stageName || context?.stage || '').toUpperCase();
    const stagePositionBoost = STAGE_POSITION_WEIGHTS[stageName] || 0;

    // E2: Confidence inversion boost — low-confidence content gets higher questioning priority
    // Borrowed from EGPAgent's (1 - avg_claim_confidence) × 0.20 factor
    const confidenceInversionBoost = this._detectLowConfidenceSignals(q, content) ? 0.12 : 0;

    return base + evidenceBoost + riskBoost + requirementBoost + noveltyBoost + schemaGapBoost + stagePositionBoost + confidenceInversionBoost;
  }

  /**
   * E2: Detect low-confidence signals in question text or artifact content.
   * Borrowed from EGPAgent's (1 - avg_claim_confidence) factor.
   * When content contains hedging/uncertainty language, questions about that
   * content should get higher priority (confidence inversion).
   * @param {string} questionText - Question text (lowercase)
   * @param {string} content - Artifact content
   * @returns {boolean} True if low-confidence signals detected
   */
  _detectLowConfidenceSignals(questionText, content) {
    // Individual low-confidence signal words (not grouped patterns)
    const lowConfidenceWords = [
      '可能', '大约', '大概', '也许', '或许', '估计', '似乎',
      '假设', '假定', '前提是', '待定', '暂时', 'TBD', 'TODO',
    ];
    const lowConfidencePatterns = [
      /maybe|perhaps|roughly|approximately|might|could be|unclear/i,
      /assume|premise|if\s+we\s+assume/i,
    ];
    const textToCheck = String(questionText || '') + ' ' + String(content || '').slice(0, 2000);
    let hits = 0;
    for (const word of lowConfidenceWords) {
      if (textToCheck.includes(word)) hits++;
    }
    for (const pattern of lowConfidencePatterns) {
      if (pattern.test(textToCheck)) hits++;
    }
    return hits >= 2; // Need at least 2 signals to trigger
  }

  _slotDisplayText(slot) {
    const map = {
      reasoning: '推导',
      tests: '测试',
      logs: '日志',
      repro: '复现',
      root_cause: '根因',
      metrics: '指标',
      rollback_proof: '回滚',
      benchmark: '基准',
      industry_comparison: '业界对比',
      diff_scope: '范围',
      compatibility: '兼容',
      threat_model: '安全模型',
      interfaces: '接口',
      dependencies: '依赖',
      coverage: '覆盖率',
    };
    return map[slot] || slot;
  }

  _buildP2RevisionProtocol(stageName, { questions = [], blindSpots = [], triggerReasons = [], context = {} } = {}) {
    const requirement = this._extractRequirementText(context);
    const selectedQuestions = (questions || []).slice(0, Math.max(2, this.maxQuestions));

    const verificationQuestions = selectedQuestions.map((q, idx) => {
      const normalized = String(q || '').trim();
      return `V${idx + 1}: ${normalized}`;
    });

    const evidenceChecks = (blindSpots || []).slice(0, 3).map((bs, idx) => `E${idx + 1}: 针对“${this._truncate(bs, 80)}”补充可验证证据`);

    const rewriteInstructions = [
      '仅修改被验证问题命中的段落，避免整篇重写。',
      '每个核心结论至少补充一条证据（测试、日志、指标或推导链）。',
      '若结论无法被证据支持，必须明确降级为假设并标注后续验证。',
      '输出末尾追加“Revision Notes”说明回答了哪些验证问题与具体改动。',
    ];

    const protocolName = 'cove-self-refine-lite';
    return {
      name: protocolName,
      requirement: requirement ? this._truncate(requirement, 120) : '',
      triggerReasons: triggerReasons || [],
      verificationQuestions,
      evidenceChecks,
      rewriteInstructions,
      promptHint: `使用 ${protocolName}: 先逐条回答 verificationQuestions，再按 rewriteInstructions 修订产物。`,
    };
  }

  _decideChallengeTrigger({
    stageName,
    claims,
    blindSpots,
    confidence,
    confidenceStatus,
    evidenceBreakdown,
    dimensionScores,
    taskFingerprint,
    context = {},
  }) {
    const reasons = [];

    const highRiskStages = new Set(['ARCHITECT', 'CODE', 'TEST']);
    const isHighRiskStage = highRiskStages.has(String(stageName || '').toUpperCase());

    const supportedClaims = Number(evidenceBreakdown?.coveredClaims || 0);
    const totalClaims = Number(evidenceBreakdown?.claimCount || 0);
    const hasClaimGap = totalClaims > 0 && supportedClaims < totalClaims;
    if (hasClaimGap) {
      reasons.push(`claim_gap:${supportedClaims}/${totalClaims}`);
    }

    const lowConfidence = confidenceStatus === 'ok' && Number.isFinite(confidence) && confidence < 0.62;
    if (lowConfidence) {
      reasons.push(`low_confidence:${(confidence * 100).toFixed(0)}%`);
    }

    const lowLogic = Number.isFinite(dimensionScores?.LOGIC) && dimensionScores.LOGIC < 0.60;
    const lowFirstPrinciples = Number.isFinite(dimensionScores?.FIRST_PRINCIPLES) && dimensionScores.FIRST_PRINCIPLES < 0.60;
    const lowEvidence = Number.isFinite(dimensionScores?.EVIDENCE) && dimensionScores.EVIDENCE < 0.60;
    if (lowLogic) reasons.push('low_logic');
    if (lowFirstPrinciples) reasons.push('low_first_principles');
    if (lowEvidence) reasons.push('low_evidence');

    // F3: Severity-Based Trigger (replaces static count >= 2 threshold)
    // After D4 aggregation, blind spots are max 5 and always >= 2 for non-trivial
    // artifacts, making the old threshold meaningless. Now only HIGH severity
    // blind spots (involving FIRST_PRINCIPLES or LOGIC dimensions) trigger challenge.
    // Industry reference: Claude Code has no blind_spots counter — model self-judges.
    const blindSpotCount = Array.isArray(blindSpots) ? blindSpots.length : 0;
    const hasHighSeverityBlindSpot = Array.isArray(blindSpots) && blindSpots.some(bs =>
      /严重度: high/i.test(bs) || /FIRST_PRINCIPLES|LOGIC|逻辑性|第一性/i.test(bs)
    );
    if (hasHighSeverityBlindSpot) {
      reasons.push(`blind_spots_high_severity:${blindSpotCount}`);
    }

    const taskRiskProfile = Array.isArray(taskFingerprint?.riskProfile) ? taskFingerprint.riskProfile : [];
    const hasHighRiskProfile = taskRiskProfile.some(r => ['security', 'latency', 'rollback', 'compatibility'].includes(r));
    if (isHighRiskStage && hasHighRiskProfile && lowConfidence) {
      reasons.push('high_risk_stage_low_confidence');
    }

    const explicitForce = context?.forceChallenge === true;
    const explicitSkip = context?.skipChallenge === true;

    if (explicitSkip) {
      return { shouldChallenge: false, reasons: ['explicit_skip'] };
    }

    if (explicitForce) {
      return { shouldChallenge: true, reasons: ['explicit_force', ...reasons] };
    }

    const shouldChallenge = reasons.length > 0;
    return {
      shouldChallenge,
      reasons: shouldChallenge ? reasons : ['no_critical_gap'],
    };
  }

  _semanticSimilarity(a, b) {
    const sa = new Set(this._normalizeForSimilarity(a));
    const sb = new Set(this._normalizeForSimilarity(b));
    if (sa.size === 0 || sb.size === 0) return 0;

    let inter = 0;
    for (const t of sa) {
      if (sb.has(t)) inter++;
    }

    const union = sa.size + sb.size - inter;
    return union > 0 ? inter / union : 0;
  }

  _normalizeForSimilarity(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map(s => s.trim())
      .filter(s => s.length >= 2)
      .slice(0, 24);
  }

  /**
   * D1: Compute a "core hash" of a question by stripping stage names, line numbers,
   * section names, and dimension tags. This allows cross-stage dedup: the same
   * underlying question asked in ANALYSE and ARCHITECT will produce the same hash.
   *
   * Example: "[结论依据][ANALYSE] 对于需求...尚未体现data provided" and
   *          "[结论依据][ARCHITECT] 对于需求...尚未体现data provided"
   *   → both normalize to the same core hash.
   */
  _computeQuestionCoreHash(question) {
    const q = String(question || '');
    const core = q
      // Strip dimension/stage tags like [结论依据][ANALYSE], [Schema缺口][PLAN]
      .replace(/\[[^\]]{1,20}\]/g, '')
      // Strip line number references like （第 42 行附近）
      .replace(/[（(]第\s*\d+\s*行[^)）]*[)）]/g, '')
      // Strip quoted section names like "根因", "修改范围"
      .replace(/["\u201c\u201d][^"\u201c\u201d]{1,20}["\u201c\u201d]/g, '')
      // Strip requirement quotes like 需求"xxx"
      .replace(/需求["\u201c][^"\u201d]*["\u201d]/g, '')
      // Strip snippet quotes like 当前输出中"xxx"
      .replace(/当前输出中["\u201c][^"\u201d]*["\u201d]/g, '')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // Simple string hash (djb2)
    let hash = 5381;
    for (let i = 0; i < core.length; i++) {
      hash = ((hash << 5) + hash + core.charCodeAt(i)) & 0x7fffffff;
    }
    return String(hash);
  }

  /**
   * D1: Remember questions and update session-level core hash set.
   * The session hash set persists across stages within the same SocraticChallenger instance,
   * enabling cross-stage dedup.
   */
  _rememberQuestions(questions = []) {
    const incoming = (questions || []).map(q => String(q || '').trim()).filter(Boolean);
    if (incoming.length === 0) return;

    this._questionHistory.push(...incoming);
    if (this._questionHistory.length > 30) {
      this._questionHistory = this._questionHistory.slice(-30);
    }

    // D1: Sync session-level core hashes for cross-stage dedup
    for (const q of incoming) {
      this._sessionQuestionCoreHashes.add(this._computeQuestionCoreHash(q));
    }
  }

  _buildRuleConfig(raw = {}) {
    const defaults = {
      enabled: true,
      maxQuestionsPerSignal: 2,
      universalRules: [
        {
          id: 'vague-language',
          whenAny: ['大约', '可能', '也许', 'roughly', 'approximately', 'maybe', 'probably'],
          question: '当前产物存在模糊表达（如“{signal}”），能否给出可验证的具体数值或边界？',
          blindSpot: '[清晰度] 产物中存在模糊措辞，影响可执行性',
        },
        {
          id: 'placeholder',
          whenAny: ['TODO', 'TBD', 'FIXME', '待定', '待补充', 'placeholder'],
          question: '当前产物仍有未完成占位（如“{signal}”），这会如何影响下游阶段与验收？',
          blindSpot: '[结论依据] 关键结论仍依赖未完成项',
        },
        {
          id: 'no-rationale',
          whenMissingAll: ['因为', '由于', '原因', 'because', 'therefore', 'rationale', 'reason'],
          question: '你给出了结论但缺少推导依据。核心决策是如何从事实推导出来的？',
          blindSpot: '[逻辑性] 结论缺少显式推理链',
        },
      ],
      stageRules: {
        ANALYSE: [
          {
            id: 'analyse-acceptance',
            whenMissingAll: ['验收', 'acceptance', 'success criteria', 'done when'],
            question: '分析产物缺少验收标准，如何判断需求被正确实现？',
            blindSpot: '[精确性][ANALYSE] 缺少验收标准',
          },
          {
            id: 'analyse-risk',
            whenMissingAll: ['风险', 'risk', 'constraint', '约束', '限制'],
            question: '分析产物未体现风险与约束，时间/依赖/技术债的主要风险是什么？',
            blindSpot: '[边界条件][ANALYSE] 缺少风险约束分析',
          },
        ],
        ARCHITECT: [
          {
            id: 'arch-interface',
            whenMissingAll: ['接口', 'interface', 'API', 'contract', '协议'],
            question: '架构产物缺少接口契约定义，模块间如何交互、输入输出格式是什么？',
            blindSpot: '[清晰度][ARCHITECT] 缺少接口契约',
          },
          {
            id: 'arch-fallback',
            whenMissingAll: ['回滚', 'rollback', '降级', 'fallback', '故障'],
            question: '架构产物未体现故障与回退策略，核心依赖失败时的降级路径是什么？',
            blindSpot: '[边界条件][ARCHITECT] 缺少故障回退设计',
          },
        ],
        PLAN: [
          {
            id: 'plan-priority',
            whenMissingAll: ['优先级', 'priority', 'P0', 'P1', 'P2', '顺序'],
            question: '计划产物未明确优先级。若资源不足，哪些任务必须先做、哪些可延后？',
            blindSpot: '[逻辑性][PLAN] 缺少优先级与顺序依据',
          },
          {
            id: 'plan-dependency',
            whenMissingAll: ['依赖', 'depend', 'before', 'after', '先', '后'],
            question: '计划产物未体现依赖关系。关键任务之间的前置约束是什么？',
            blindSpot: '[广度][PLAN] 缺少依赖映射',
          },
        ],
        CODE: [
          {
            id: 'code-test-evidence',
            whenMissingAll: ['test', '测试', 'spec', 'assert'],
            question: '代码产物未体现测试证据，这次改动如何被验证？',
            blindSpot: '[结论依据][CODE] 缺少测试证据',
          },
          {
            id: 'code-error-handling',
            whenMissingAll: ['error', 'exception', 'catch', 'try', '错误处理', '异常'],
            question: '代码产物缺少异常路径说明，空值/失败/并发冲突是如何处理的？',
            blindSpot: '[边界条件][CODE] 缺少异常与边界处理',
          },
        ],
        TEST: [
          {
            id: 'test-verdict',
            whenMissingAll: ['pass', 'fail', '✅', '❌', '通过', '失败', 'PASS', 'FAIL'],
            question: '测试产物没有明确通过/失败结论。实际执行结果和退出状态是什么？',
            blindSpot: '[精确性][TEST] 缺少明确测试结论',
          },
          {
            id: 'test-coverage',
            whenMissingAll: ['覆盖率', 'coverage', '%'],
            question: '测试产物未提供覆盖率或路径覆盖信息，当前验证覆盖范围有多大？',
            blindSpot: '[数据支撑][TEST] 缺少覆盖率数据',
          },
        ],
      },
      artifactRules: [
        {
          id: 'artifact-short-content',
          appliesToStages: ['ANALYSE', 'ARCHITECT', 'PLAN', 'TEST'],
          minLength: 180,
          question: '当前阶段产物内容偏短，是否足以支撑下游执行与验收决策？',
          blindSpot: '[深度] 产物信息密度不足',
        },
        {
          id: 'artifact-thin-heading-structure',
          appliesToStages: ['ANALYSE', 'ARCHITECT', 'PLAN'],
          minHeadingCount: 2,
          question: '当前阶段产物结构较薄（标题层级不足），是否遗漏关键决策章节？',
          blindSpot: '[清晰度] 产物结构化程度不足',
        },
      ],
    };

    const mergeObject = (base, extra) => {
      const out = { ...base };
      if (!extra || typeof extra !== 'object') return out;
      for (const k of Object.keys(extra)) {
        const bv = out[k];
        const ev = extra[k];
        if (Array.isArray(ev)) {
          out[k] = ev;
        } else if (ev && typeof ev === 'object' && !Array.isArray(ev) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
          out[k] = mergeObject(bv, ev);
        } else {
          out[k] = ev;
        }
      }
      return out;
    };

    return mergeObject(defaults, raw || {});
  }

  _collectRuleDrivenQuestions(stageName, content, context = {}) {
    const cfg = this.ruleConfig || {};
    if (!cfg.enabled) {
      return { questions: [], blindSpots: [], diagnostics: { enabled: false, matchedRules: [] } };
    }

    const text = String(content || '');
    const textLower = text.toLowerCase();
    const questions = [];
    const blindSpots = [];
    const matchedRules = [];

    const allStageRules = Array.isArray(cfg.stageRules?.[stageName]) ? cfg.stageRules[stageName] : [];
    const universalRules = Array.isArray(cfg.universalRules) ? cfg.universalRules : [];
    const artifactRules = Array.isArray(cfg.artifactRules) ? cfg.artifactRules : [];

    const applyRule = (rule, signal = '') => {
      if (!rule || typeof rule !== 'object') return;
      const q = this._renderRuleText(rule.question, { stageName, signal, context, content: text });
      if (q) questions.push(q);
      if (rule.blindSpot) blindSpots.push(rule.blindSpot);
      matchedRules.push(rule.id || 'unnamed-rule');
    };

    const hasAll = (terms) => Array.isArray(terms) && terms.length > 0 && terms.every(t => textLower.includes(String(t).toLowerCase()));
    const hitAny = (terms) => Array.isArray(terms) && terms.length > 0 && terms.find(t => textLower.includes(String(t).toLowerCase()));

    for (const rule of [...universalRules, ...allStageRules]) {
      const anySignal = hitAny(rule.whenAny);
      const missAll = Array.isArray(rule.whenMissingAll) && rule.whenMissingAll.length > 0 && !hitAny(rule.whenMissingAll);
      if (anySignal || missAll) {
        applyRule(rule, anySignal || 'missing-signal');
      }
    }

    for (const rule of artifactRules) {
      const stageAllowed = !Array.isArray(rule.appliesToStages) || rule.appliesToStages.includes(stageName);
      if (!stageAllowed) continue;

      if (typeof rule.minLength === 'number' && text.length < rule.minLength) {
        applyRule(rule, `length<${rule.minLength}`);
        continue;
      }

      if (typeof rule.minHeadingCount === 'number') {
        const headingCount = (text.match(/^#+\s+/gm) || []).length;
        if (headingCount < rule.minHeadingCount) {
          applyRule(rule, `headingCount<${rule.minHeadingCount}`);
        }
      }
    }

    const maxPerSignal = Number(cfg.maxQuestionsPerSignal || 2);
    const uniqueQuestions = [...new Set(questions)].slice(0, Math.max(3, this.maxQuestions + maxPerSignal));
    const uniqueBlindSpots = [...new Set(blindSpots)];

    const diagnostics = {
      enabled: true,
      matchedRules,
      stage: stageName,
      artifactLength: text.length,
      headingCount: (text.match(/^#+\s+/gm) || []).length,
    };

    return {
      questions: uniqueQuestions,
      blindSpots: uniqueBlindSpots,
      diagnostics,
    };
  }

  _renderRuleText(template, vars = {}) {
    if (!template || typeof template !== 'string') return '';
    return template
      .replace(/\{stage\}/g, vars.stageName || '')
      .replace(/\{signal\}/g, vars.signal || '')
      .replace(/\{requirement\}/g, this._truncate(vars.context?.rawRequirement || vars.context?.requirement || '', 60));
  }

  /**
   * Challenge a specific claim using all Socratic layers.
   */
  // D6: Enhanced claim challenge — generate targeted questions for specific claims
  // extracted from artifact content, not generic template questions.
  _challengeClaimWithLayers(claim, content) {
    const questions = [];
    const claimLower = String(claim || '').toLowerCase();
    const contentLower = String(content || '').toLowerCase();

    // D6: Detect claim type and generate targeted challenge
    const isQuantitative = /\d+%?|\u6570\u636e|\u6307\u6807|\u6027\u80fd|coverage|metric/i.test(claim);
    const isDecision = /\u51b3\u5b9a|\u9009\u62e9|\u91c7\u7528|chose|decided|selected/i.test(claim);
    const isCompletion = /completed|finished|\u5b8c\u6210|implemented|\u5b9e\u73b0/i.test(claim);

    if (isQuantitative) {
      // Challenge quantitative claims with evidence demand
      questions.push(`\u58f0\u660e"${this._truncate(claim, 60)}"\u7684\u6570\u636e\u6765\u6e90\u662f\u4ec0\u4e48\uff1f\u662f\u5b9e\u6d4b\u8fd8\u662f\u4f30\u7b97\uff1f`);
    } else if (isDecision) {
      // Challenge decisions with alternative exploration
      questions.push(`\u5173\u4e8e"${this._truncate(claim, 60)}"\uff0c\u8003\u8651\u8fc7\u54ea\u4e9b\u66ff\u4ee3\u65b9\u6848\uff1f\u4e3a\u4ec0\u4e48\u6392\u9664\u4e86\u5b83\u4eec\uff1f`);
    } else if (isCompletion) {
      // Challenge completion claims with verification demand
      questions.push(`"${this._truncate(claim, 60)}"\u7684\u9a8c\u8bc1\u8bc1\u636e\u662f\u4ec0\u4e48\uff1f\u5982\u4f55\u786e\u8ba4\u4e0d\u662f\u90e8\u5206\u5b8c\u6210\uff1f`);
    } else {
      // Generic but claim-specific challenge
      questions.push(`\u5173\u4e8e"${this._truncate(claim, 60)}"\uff0c\u5982\u679c\u8fd9\u4e2a\u5047\u8bbe\u662f\u9519\u7684\uff0c\u4f1a\u5bfc\u81f4\u4ec0\u4e48\u540e\u679c\uff1f`);
    }

    // D6: Check if the claim has supporting evidence in the content
    const claimKeywords = this._normalizeForSimilarity(claim);
    const evidenceSignals = ['\u56e0\u4e3a', '\u7531\u4e8e', '\u8bc1\u636e', 'because', 'evidence', 'data shows', '\u6d4b\u8bd5\u7ed3\u679c'];
    const hasEvidence = claimKeywords.some(kw => {
      // Check if there's evidence near the claim keyword in content
      const idx = contentLower.indexOf(kw);
      if (idx < 0) return false;
      const nearby = contentLower.substring(Math.max(0, idx - 200), Math.min(contentLower.length, idx + 200));
      return evidenceSignals.some(sig => nearby.includes(sig));
    });

    if (!hasEvidence && questions.length < 2) {
      questions.push(`"${this._truncate(claim, 40)}"\u7f3a\u5c11\u652f\u6491\u8bc1\u636e\u3002\u80fd\u5426\u63d0\u4f9b\u5177\u4f53\u7684\u6570\u636e\u6216\u6d4b\u8bd5\u7ed3\u679c\uff1f`);
    }

    return questions;
  }

  /**
   * Generate a What-if question specific to the stage.
   */
  _generateWhatIfQuestion(stageName, content) {
    const scenarios = {
      ANALYSE: 'the user\'s actual needs differ from what they stated',
      ARCHITECT: 'traffic increases 10x unexpectedly',
      PLAN: 'a critical dependency becomes unavailable',
      CODE: 'invalid input is provided by a malicious user',
      TEST: 'the system is deployed to a different environment',
    };

    const scenario = scenarios[stageName] || 'assumptions turn out to be wrong';
    return `What if ${scenario}? How would your solution handle that?`;
  }

  // ─── D7: Cross-Stage Consistency Questions ──────────────────────────────────
  // Reads previous stage artifacts (passed via context.previousArtifacts) and
  // generates questions about inconsistencies, dropped requirements, or
  // unaddressed decisions between stages.

  /**
   * D7: Generate cross-stage consistency questions.
   * Detects when the current artifact contradicts or ignores content from
   * previous stage artifacts.
   *
   * @param {string} stageName - Current stage
   * @param {string} content - Current artifact content
   * @param {object} context - Must include context.previousArtifacts: { ANALYSE: string, ARCHITECT: string, ... }
   * @returns {string[]} Cross-stage consistency questions
   */
  _generateCrossStageQuestions(stageName, content, context = {}) {
    const questions = [];
    const prevArtifacts = context.previousArtifacts || {};

    // Stage dependency chain — what previous stages should the current stage reference?
    const dependencies = {
      ARCHITECT: ['ANALYSE'],
      PLAN:      ['ANALYSE', 'ARCHITECT'],
      CODE:      ['PLAN', 'ARCHITECT'],
      DEVELOP:   ['PLAN', 'ARCHITECT'],
      TEST:      ['CODE', 'PLAN'],
    };

    const deps = dependencies[stageName];
    if (!deps || deps.length === 0) return questions;

    const contentLower = String(content || '').toLowerCase();

    for (const depStage of deps) {
      const prevContent = prevArtifacts[depStage];
      if (!prevContent || prevContent.length < 50) continue;

      // D7-a: Extract key decisions/headings from previous artifact
      const prevHeadings = [];
      const headingRe = /^#{1,3}\s+(.+)/gm;
      let m;
      while ((m = headingRe.exec(prevContent)) !== null) {
        const title = m[1].trim();
        if (title.length > 5) prevHeadings.push(title);
      }

      // D7-b: Check if current artifact references key concepts from previous stage
      const prevKeyTerms = this._extractCrossStageKeyTerms(prevContent);
      const unreferencedTerms = prevKeyTerms.filter(term =>
        !contentLower.includes(term.toLowerCase())
      );

      if (unreferencedTerms.length >= 3) {
        const termPreview = unreferencedTerms.slice(0, 3).join('、');
        questions.push(
          `[跨阶段一致性][${depStage}→${stageName}] ${depStage}阶段提到的关键概念（${termPreview}）在当前产物中未被引用。是否遗漏了重要决策？`
        );
      }

      // D7-c: Check for risk items mentioned in ANALYSE but not addressed later
      if (depStage === 'ANALYSE') {
        // Extract risk content lines (skip headings — they contain generic text like "Risk Assessment")
        const riskLines = prevContent.split('\n').filter(line => {
          const trimmed = line.trim();
          // Skip headings and empty lines
          if (!trimmed || trimmed.startsWith('#')) return false;
          return /(?:风险|risk|约束|constraint|限制|limitation)/i.test(trimmed);
        });

        const risks = riskLines.map(line => {
          // Extract the substantive part after the keyword
          const m = line.match(/(?:风险|risk|约束|constraint|限制|limitation)[：:：]?\s*(.{10,80})/i);
          return m ? m[1].trim() : line.trim();
        }).filter(r => r.length > 10);

        const unaddressedRisks = risks.filter(risk => {
          // Use meaningful words (>3 chars) to check if risk is addressed
          const riskWords = risk.toLowerCase().split(/[\s,，、]+/).filter(w => w.length > 3);
          return riskWords.length > 0 && !riskWords.some(w => contentLower.includes(w));
        });

        if (unaddressedRisks.length > 0) {
          questions.push(
            `[跨阶段一致性][ANALYSE→${stageName}] 分析阶段识别的风险"${this._truncate(unaddressedRisks[0], 50)}"在当前产物中未被提及。该风险是否已被解决或有意忽略？`
          );
        }
      }

      // D7-d: Check for decision items in ARCHITECT not reflected in PLAN/CODE
      if (depStage === 'ARCHITECT' && (stageName === 'PLAN' || stageName === 'CODE' || stageName === 'DEVELOP')) {
        const decisionPatterns = /(?:决定|选择|采用|decided|chose|selected)[：:]?\s*([^\n]{10,60})/gi;
        const decisions = [];
        let dMatch;
        while ((dMatch = decisionPatterns.exec(prevContent)) !== null) {
          decisions.push(dMatch[1].trim());
        }

        const unreflectedDecisions = decisions.filter(dec => {
          const decWords = dec.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          return !decWords.some(w => contentLower.includes(w));
        });

        if (unreflectedDecisions.length > 0) {
          questions.push(
            `[跨阶段一致性][ARCHITECT→${stageName}] 架构决策"${this._truncate(unreflectedDecisions[0], 50)}"在当前产物中未体现。实现是否偏离了架构设计？`
          );
        }
      }
    }

    return questions.slice(0, 2);  // Max 2 cross-stage questions
  }

  /**
   * D7: Extract key terms from a previous stage artifact for cross-reference checking.
   * Focuses on technical terms, proper nouns, and domain-specific vocabulary.
   */
  _extractCrossStageKeyTerms(content) {
    const terms = new Set();
    const contentStr = String(content || '');

    // Extract terms from headings — prefer multi-word phrases over single words
    const headingRe = /^#{1,3}\s+(.+)/gm;
    let m;
    while ((m = headingRe.exec(contentStr)) !== null) {
      const title = m[1].trim();
      // Add full heading as a phrase if it's specific enough
      if (title.length > 8 && !/^(overview|summary|概述|总结|introduction|背景|目录)/i.test(title)) {
        terms.add(title);
      }
    }

    // Extract terms from bold text (usually important concepts)
    const boldRe = /\*\*([^*]+)\*\*/g;
    while ((m = boldRe.exec(contentStr)) !== null) {
      const phrase = m[1].trim();
      if (phrase.length > 4 && phrase.length < 40) terms.add(phrase);
    }

    // Extract file paths (critical for code-related stages)
    const pathRe = /(?:[\w-]+\/)+[\w.-]+\.\w+/g;
    while ((m = pathRe.exec(contentStr)) !== null) {
      terms.add(m[0]);
    }

    // Extract technical terms (CamelCase, snake_case, or Chinese technical terms)
    const techTermRe = /(?:[A-Z][a-z]+){2,}|[a-z]+_[a-z]+(?:_[a-z]+)*|[\u4e00-\u9fff]{4,}/g;
    while ((m = techTermRe.exec(contentStr)) !== null) {
      const term = m[0];
      if (term.length > 4) terms.add(term);
    }

    // Filter out common stop words and generic section names
    const stopWords = new Set([
      'this', 'that', 'with', 'from', 'have', 'will', 'been', 'should', 'would',
      'could', 'about', 'which', 'their', 'there', 'these', 'those', 'other',
      'some', 'more', 'when', 'what', 'where', 'overview', 'summary', 'root',
      'cause', 'analysis', 'design', 'implementation', 'description', 'scope',
      'assessment', 'components', 'affected', 'modification', 'requirement',
      'risk', 'section', 'table', 'list', 'note', 'details', 'background',
      'introduction', 'conclusion', 'result', 'output', 'input', 'status',
    ]);
    return [...terms].filter(t => {
      const lower = t.toLowerCase();
      // Skip single generic words
      if (!t.includes(' ') && !t.includes('/') && !t.includes('_') && stopWords.has(lower)) return false;
      // Skip very short terms
      if (t.length <= 4 && !t.includes('/')) return false;
      return true;
    });
  }

  /**
   * Extract key words from a probe for relevance checking.
   */
  _extractKeyWords(probe) {
    // Simple extraction: words that indicate what the probe is about
    const keyWords = [];
    const patterns = [
      /edge cases?/i,
      /concurr/i,
      /scal/i,
      /fail/i,
      /error/i,
      /performance/i,
      /secur/i,
      /valid/i,
      /test/i,
      /assum/i,
    ];

    for (const pattern of patterns) {
      if (pattern.test(probe)) {
        keyWords.push(pattern.source.replace(/\\/g, '').replace(/\?/g, ''));
      }
    }

    return keyWords;
  }

  // ─── Blind Spot Detection ───────────────────────────────────────────────────

  /**
   * Detect potential blind spots - things the agent might have missed.
   * Now covers all ten dimensions (ADR-55):
   *   Paul-Elder: RELEVANCE, BREADTH, DEPTH, LOGIC, CLARITY, PRECISION
   *   AI Engineering: BOUNDARY, EVIDENCE, DATA, INDUSTRY_COMPARISON
   */
  // D4: Blind spot aggregation — compress raw blind spots into max 5 high-signal
  // grouped entries. Instead of listing every missing check, group by dimension
  // and report the most critical gap per dimension.
  _detectBlindSpots(stageName, content, claims, context = {}) {
    const rawBlindSpots = [];
    const contentLower = content.toLowerCase();

    const ruleDriven = this._collectRuleDrivenQuestions(stageName, content, context);
    rawBlindSpots.push(...(ruleDriven.blindSpots || []));

    // D4: Collect per-dimension miss counts for aggregation
    const dimensionMissCounts = {};
    for (const [dimKey, dim] of Object.entries(ELEVEN_DIMENSIONS)) {
      const dimBlindSpots = this._detectDimensionBlindSpots(dimKey, dim, contentLower, stageName);
      if (dimBlindSpots.length > 0) {
        dimensionMissCounts[dim.name] = {
          key: dimKey,
          total: dimBlindSpots.length,
          items: dimBlindSpots,
          // Severity: more misses = higher severity
          severity: dimBlindSpots.length >= 4 ? 'high' : dimBlindSpots.length >= 2 ? 'medium' : 'low',
        };
      }
    }

    const requirement = this._extractRequirementText(context);
    if (requirement && !/需求|目标|验收|success criteria|acceptance/i.test(content)) {
      rawBlindSpots.push(`[${stageName}] 当前输出未显式回链到需求与验收标准`);
    }

    // D4: Aggregate — instead of listing all 16+ raw blind spots,
    // produce max 5 high-signal grouped entries
    const aggregated = [];

    // 1. Rule-driven blind spots (already concise) — keep top 2
    const ruleBS = [...new Set(rawBlindSpots)];
    aggregated.push(...ruleBS.slice(0, 2));

    // 2. Dimension blind spots — group by dimension, pick top 3 dimensions by severity
    const sortedDims = Object.entries(dimensionMissCounts)
      .sort((a, b) => {
        // Sort by severity (high > medium > low), then by miss count
        const sevOrder = { high: 3, medium: 2, low: 1 };
        const sevDiff = (sevOrder[b[1].severity] || 0) - (sevOrder[a[1].severity] || 0);
        if (sevDiff !== 0) return sevDiff;
        return b[1].total - a[1].total;
      });

    const MAX_AGGREGATED = 5;
    for (const [dimName, info] of sortedDims) {
      if (aggregated.length >= MAX_AGGREGATED) break;

      // D4: Produce one aggregated blind spot per dimension
      // Instead of "[逻辑性] 未涉及: reasoning chain valid" × 5,
      // produce "[逻辑性] 5项检查未通过（reasoning chain, premises, causality...）"
      const checkNames = info.items
        .map(bs => {
          // Extract the check name from "[$dim] 未涉及: $check" or "[$dim][$stage] 缺少: $check"
          const m = bs.match(/(?:未涉及|缺少)[：:]\s*(.+)/);
          return m ? m[1].trim() : null;
        })
        .filter(Boolean);

      if (checkNames.length > 0) {
        const preview = checkNames.slice(0, 3).join('、');
        const suffix = checkNames.length > 3 ? `等${checkNames.length}项` : '';
        aggregated.push(`[${dimName}][${stageName}] ${info.total}项检查未通过（${preview}${suffix}）— 严重度: ${info.severity}`);
      } else {
        // Fallback: use first raw blind spot from this dimension
        aggregated.push(info.items[0]);
      }
    }

    return aggregated.slice(0, MAX_AGGREGATED);
  }

  /**
   * Detect blind spots for a specific dimension.
   */
  _detectDimensionBlindSpots(dimKey, dim, contentLower, stageName) {
    const blindSpots = [];

    for (const check of dim.checks) {
      const signals = this._expandCheckSignals(check);
      const hit = signals.some(s => this._containsSignal(contentLower, s));
      if (!hit) {
        blindSpots.push(`[${dim.name}] 未涉及: ${check}`);
      }
    }

    if (dimKey === 'FIRST_PRINCIPLES') {
      const analogyPatterns = [
        /参考.*方案|借鉴.*经验|类似.*项目|业界.*惯例|通常.*做法/,
        /一般来说|通常情况|按照惯例|行业标准做法/,
      ];
      const hasAnalogy = analogyPatterns.some(p => p.test(contentLower));
      const hasDerivation = /因为.*所以|由于.*导致|基于.*推导|从.*出发|therefore|because|derived from/i.test(contentLower);
      if (hasAnalogy && !hasDerivation) {
        blindSpots.push(`[第一性原则] 检测到类比/惯例思维，但缺少从基本事实的推导过程`);
      }
      if (!this._containsSignal(contentLower, 'fundamental') && !this._containsSignal(contentLower, '本质')) {
        blindSpots.push(`[第一性原则] 未识别问题的本质约束（物理/逻辑限制 vs 历史惯例）`);
      }
    }

    const stageChecks = this._getStageDimensionChecks(stageName, dimKey);
    for (const check of stageChecks) {
      const signals = this._expandCheckSignals(check);
      const hit = signals.some(s => this._containsSignal(contentLower, s));
      if (!hit) {
        blindSpots.push(`[${dim.name}][${stageName}] 缺少: ${check}`);
      }
    }

    return blindSpots;
  }

  // ─── Confidence Calculation ─────────────────────────────────────────────────

  /**
   * Calculate confidence in the agent's conclusions.
   * P0: abstain (N/A) under mock/evidence-insufficient conditions.
   * P1: cap penalties to avoid collapsing to 0 for noisy blind spots.
   * P2+: evidence-slot + claim-evidence chain hybrid scoring.
   */
  _calculateConfidence(content, claims, blindSpots, context = {}) {
    const contentLower = String(content || '').toLowerCase();
    const isMockLlm = context.isMockLlm === true || String(context.llmSource || '').toLowerCase() === 'mock';
    const stageName = context.stageName || context.stage || '';
    const taskFingerprint = context.taskFingerprint || this._inferTaskFingerprint(stageName, content, context);

    // ── F1: Stage-Specific Evaluator (Agentless/Claude Code pattern) ──────────
    // Instead of a universal keyword-matching confidence model, use stage-specific
    // completion detectors that understand each stage's output format.
    // TEST stage: parse pass/fail counts directly (test-based verification).
    // DEVELOP stage: check for code evidence (file paths, diffs).
    // This eliminates the "floor effect" where 9/9 passed gets 8.7% confidence.
    const stageSpecificResult = this._evaluateStageSpecificConfidence(stageName, content, contentLower, claims, blindSpots);
    if (stageSpecificResult) {
      return stageSpecificResult;
    }

    // ── Eleven Dimension Score (semantic signal matching) ───────────────────
    const dimensionScores = {};

    for (const [dimKey, dim] of Object.entries(ELEVEN_DIMENSIONS)) {
      const coveredChecks = dim.checks.filter(check => {
        const signals = this._expandCheckSignals(check);
        return signals.some(s => this._containsSignal(contentLower, s));
      });
      const score = coveredChecks.length / dim.checks.length;
      dimensionScores[dimKey] = score;
    }

    const weights = {
      RELEVANCE: 0.07,
      BREADTH: 0.07,
      DEPTH: 0.09,
      LOGIC: 0.13,
      CLARITY: 0.11,
      PRECISION: 0.11,
      BOUNDARY: 0.07,
      EVIDENCE: 0.08,
      DATA: 0.08,
      INDUSTRY_COMPARISON: 0.05,
      FIRST_PRINCIPLES: 0.14,
    };

    let dimensionScore = 0;
    for (const [dimKey, score] of Object.entries(dimensionScores)) {
      dimensionScore += score * (weights[dimKey] || 0.10);
    }

    // ── Content Quality Score ────────────────────────────────────────────────
    let contentScore = 0.5;
    if (content.length > 500) contentScore += 0.1;
    if (content.length > 1000) contentScore += 0.1;
    if (/because|since|therefore|due to|因为|由于/i.test(content)) contentScore += 0.15;
    if (/tested|verified|validated|confirmed|测试|验证/i.test(content)) contentScore += 0.15;
    contentScore = Math.min(1, contentScore);

    // ── Claim-level Evidence Chain Score ─────────────────────────────────────
    const evidence = this._scoreClaimEvidence(content, claims);
    const evidenceChainScore = evidence.score;

    // ── Evidence Slot Coverage (task-specific) ───────────────────────────────
    const slotCoverage = this._scoreEvidenceSlots(content, taskFingerprint, stageName);

    // ── Blind Spot Penalty with Cap ──────────────────────────────────────────
    const highPriorityBlindSpots = blindSpots.filter(bs => bs.includes('数据支撑') || bs.includes('结论依据'));
    const otherBlindSpots = blindSpots.filter(bs => !bs.includes('数据支撑') && !bs.includes('结论依据'));
    const blindSpotPenaltyRaw = (highPriorityBlindSpots.length * 0.08) + (otherBlindSpots.length * 0.04);
    const blindSpotPenalty = Math.min(0.25, blindSpotPenaltyRaw);

    // ── Red Flags with Cap ───────────────────────────────────────────────────
    let redFlagPenaltyRaw = 0;
    if (/TODO|TBD|FIXME|placeholder|待定|待办/i.test(content)) redFlagPenaltyRaw += 0.2;
    if (/假设|推测|可能大概/i.test(content)) redFlagPenaltyRaw += 0.1;
    const redFlagPenalty = Math.min(0.2, redFlagPenaltyRaw);

    // ── P0: Abstain when confidence signal is not meaningful ────────────────
    const coverageEvidence = [
      dimensionScores.EVIDENCE || 0,
      dimensionScores.DATA || 0,
      dimensionScores.LOGIC || 0,
      evidence.coverage || 0,
      slotCoverage.coverage || 0,
    ];
    const avgCoverageEvidence = coverageEvidence.reduce((a, b) => a + b, 0) / coverageEvidence.length;

    if (isMockLlm) {
      // ── P0-B Fix: isMockLlm does NOT mean the artifact is mock ──────────────
      // isMockLlm=true means the LLM *call* was mocked (no LLM rewrite of questions),
      // but the artifact content is REAL (written by the IDE Agent).
      // Previously this branch returned status='na' unconditionally, which caused
      // shouldRetry to ALWAYS be false (shouldRetry requires status='ok').
      //
      // Fix: compute a real confidence score from the artifact content.
      // Use dimensionScore + contentScore as the primary signal.
      // This enables shouldRetry to trigger when artifact quality is genuinely low.
      const rawScore = (dimensionScore * 0.6) + (contentScore * 0.4);
      const finalConfidence = Math.max(0, Math.min(1, rawScore - blindSpotPenalty - redFlagPenalty));
      return {
        confidence: finalConfidence,
        confidenceStatus: 'ok',  // 'ok' enables shouldRetry evaluation
        confidenceReason: 'artifact_content_score',
        dimensionScores,
        evidenceBreakdown: {
          model: 'evidence-chain-v2',
          mode: 'mock_llm_real_artifact',
          claimCount: evidence.claimCount,
          coveredClaims: evidence.coveredClaims,
          supportRatio: evidence.coverage,
          reasoningSignal: evidence.reasoningSignal,
          evidenceSignal: evidence.evidenceSignal,
          slotCoverage: slotCoverage.coverage,
          expectedSlots: slotCoverage.expectedSlots,
          hitSlots: slotCoverage.hitSlots,
          missingSlots: slotCoverage.missingSlots,
          dimensionScore,
          contentScore,
          blindSpotPenalty,
          redFlagPenalty,
          finalConfidence,
        },
      };
    }

    if ((evidence.claimCount < 2 && slotCoverage.hitCount === 0) || avgCoverageEvidence < 0.15) {
      return {
        confidence: 0,
        confidenceStatus: 'na',
        confidenceReason: 'insufficient_evidence',
        dimensionScores,
        evidenceBreakdown: {
          model: 'evidence-chain-v2',
          mode: 'insufficient',
          claimCount: evidence.claimCount,
          coveredClaims: evidence.coveredClaims,
          supportRatio: evidence.coverage,
          reasoningSignal: evidence.reasoningSignal,
          evidenceSignal: evidence.evidenceSignal,
          slotCoverage: slotCoverage.coverage,
          expectedSlots: slotCoverage.expectedSlots,
          hitSlots: slotCoverage.hitSlots,
          missingSlots: slotCoverage.missingSlots,
          avgCoverageEvidence,
          dimensionScore,
          contentScore,
        },
      };
    }

    // ── Final Score ──────────────────────────────────────────────────────────
    // Evidence chain and slot coverage dominate; dimensions are hygiene factors.
    const finalScore =
      evidenceChainScore * 0.45 +
      slotCoverage.coverage * 0.2 +
      dimensionScore * 0.2 +
      contentScore * 0.15 -
      blindSpotPenalty -
      redFlagPenalty;

    const confidence = Math.max(0, Math.min(1, finalScore));

    if (this.verbose) {
      this._log(`[SocraticChallenger] 📊 维度评分 (11维度):`);
      for (const [dimKey, score] of Object.entries(dimensionScores)) {
        const dim = ELEVEN_DIMENSIONS[dimKey];
        const weight = weights[dimKey] || 0;
        const marker = dim?.firstPrinciples ? '🧱' : (dimKey === 'LOGIC' ? '🔴' : '  ');
        this._log(`   ${marker} ${dim?.name || dimKey}: ${(score * 100).toFixed(0)}% (权重 ${(weight * 100).toFixed(0)}%)`);
      }
      this._log(`[SocraticChallenger] 🔍 EvidenceChain: ${(evidenceChainScore * 100).toFixed(0)}% (claims ${evidence.coveredClaims}/${evidence.claimCount || 0})`);
      this._log(`[SocraticChallenger] 🧩 EvidenceSlots: ${(slotCoverage.coverage * 100).toFixed(0)}% (${slotCoverage.hitCount}/${slotCoverage.expectedSlots.length})`);
    }

    return {
      confidence,
      confidenceStatus: 'ok',
      confidenceReason: null,
      dimensionScores,
      evidenceBreakdown: {
        model: 'evidence-chain-v2',
        mode: 'normal',
        claimCount: evidence.claimCount,
        coveredClaims: evidence.coveredClaims,
        supportRatio: evidence.coverage,
        reasoningSignal: evidence.reasoningSignal,
        evidenceSignal: evidence.evidenceSignal,
        evidenceChainScore,
        slotCoverage: slotCoverage.coverage,
        expectedSlots: slotCoverage.expectedSlots,
        hitSlots: slotCoverage.hitSlots,
        missingSlots: slotCoverage.missingSlots,
        dimensionScore,
        contentScore,
        blindSpotPenalty,
        blindSpotPenaltyRaw,
        redFlagPenalty,
        redFlagPenaltyRaw,
      },
    };
  }

  // ─── F1: Stage-Specific Evaluator (Agentless / Claude Code pattern) ──────────
  // Instead of a universal keyword-matching confidence model, each stage has its own
  // "completion detector" that understands the stage's output format.
  // This eliminates the "floor effect" where TEST stage 9/9 passed gets 8.7% confidence.
  //
  // Returns a confidence result object if stage-specific evaluation applies, or null
  // to fall through to the generic evaluator.
  _evaluateStageSpecificConfidence(stageName, content, contentLower, claims, blindSpots) {
    const stageUpper = String(stageName || '').toUpperCase();

    // ── TEST stage: parse pass/fail counts directly (test-based verification) ──
    // Industry reference: Agentless uses test results as the ONLY quality signal.
    // If we can parse "X/Y passed" or "X passed, Y failed", use that directly.
    if (stageUpper === 'TEST') {
      // Match patterns like "9/9 passed", "9 passed, 0 failed", "pass: 9 fail: 0",
      // "Tests: 9 passed", "✅ 9/9", "all tests passed", etc.
      const passFailPatterns = [
        /(\d+)\s*\/\s*(\d+)\s*(?:passed|通过|成功)/i,
        /(\d+)\s*(?:passed|通过|成功)\s*[,，]\s*(\d+)\s*(?:failed|失败)/i,
        /pass(?:ed)?[:\s]+(\d+)\s*[,，\s]+fail(?:ed)?[:\s]+(\d+)/i,
        /tests?[:\s]+(\d+)\s*passed/i,
        /(\d+)\s*tests?\s*passed\s*[,，]\s*(\d+)\s*tests?\s*failed/i,
      ];

      let testPassed = 0, testTotal = 0, testFailed = 0;
      let matched = false;

      for (const pattern of passFailPatterns) {
        const m = contentLower.match(pattern);
        if (m) {
          if (pattern === passFailPatterns[0]) {
            // X/Y passed
            testPassed = parseInt(m[1], 10);
            testTotal = parseInt(m[2], 10);
            testFailed = testTotal - testPassed;
          } else if (pattern === passFailPatterns[3]) {
            // "Tests: X passed" (no fail count)
            testPassed = parseInt(m[1], 10);
            testTotal = testPassed; // Assume all passed if no fail count
            testFailed = 0;
          } else {
            // X passed, Y failed
            testPassed = parseInt(m[1], 10);
            testFailed = parseInt(m[2], 10);
            testTotal = testPassed + testFailed;
          }
          matched = true;
          break;
        }
      }

      // Also check for "all tests passed" / "all X tests passed"
      if (!matched && /all\s+(?:\d+\s+)?tests?\s+passed|所有.*测试.*通过/i.test(content)) {
        const numMatch = content.match(/all\s+(\d+)\s+tests?\s+passed/i);
        testPassed = numMatch ? parseInt(numMatch[1], 10) : 1;
        testTotal = testPassed;
        testFailed = 0;
        matched = true;
      }

      if (matched && testTotal > 0) {
        const passRate = testPassed / testTotal;
        // Direct mapping: 100% pass rate → 0.95 confidence, 0% → 0.05
        // This is a DETERMINISTIC evaluator, not a keyword-matching heuristic.
        const baseConfidence = 0.05 + passRate * 0.90;

        // Small penalty for blind spots (capped)
        const bsPenalty = Math.min(0.15, (blindSpots?.length || 0) * 0.03);

        // Bonus for having test execution evidence (actual command output)
        const hasExecutionEvidence = /\$|npm test|jest|pytest|mocha|vitest|go test|cargo test|dotnet test/i.test(content);
        const executionBonus = hasExecutionEvidence ? 0.05 : 0;

        const confidence = Math.max(0, Math.min(1, baseConfidence - bsPenalty + executionBonus));

        if (this.verbose) {
          this._log(`[SocraticChallenger] 🧪 F1 TEST Stage-Specific: ${testPassed}/${testTotal} passed → confidence=${(confidence * 100).toFixed(0)}%`);
        }

        return {
          confidence,
          confidenceStatus: 'ok',
          confidenceReason: 'stage_specific_test_evaluator',
          dimensionScores: null,
          evidenceBreakdown: {
            model: 'stage-specific-v1',
            mode: 'test_evaluator',
            testPassed,
            testFailed,
            testTotal,
            passRate,
            baseConfidence,
            blindSpotPenalty: bsPenalty,
            executionBonus,
            hasExecutionEvidence,
            finalConfidence: confidence,
          },
        };
      }
    }

    // ── DEVELOP stage: check for code evidence (file paths, diffs) ──
    if (stageUpper === 'DEVELOP' || stageUpper === 'CODE') {
      // Look for actual code change evidence
      const hasDiffMarkers = /^[+-]{3}\s|^@@\s|^diff --git/m.test(content);
      const hasFilePaths = /\b[\w\-./]+\.(js|ts|py|go|java|cs|rb|rs|cpp|c|h|jsx|tsx|vue|svelte)\b/i.test(content);
      const hasCodeBlocks = (content.match(/```/g) || []).length >= 2;

      if (hasDiffMarkers || (hasFilePaths && hasCodeBlocks)) {
        // Count substantive changes
        const addedLines = (content.match(/^\+[^+]/gm) || []).length;
        const removedLines = (content.match(/^-[^-]/gm) || []).length;
        const totalChanges = addedLines + removedLines;

        // More changes = higher confidence (logarithmic scale)
        const changeScore = Math.min(1, Math.log10(Math.max(1, totalChanges)) / 2.5);
        const baseConfidence = 0.4 + changeScore * 0.5;
        const bsPenalty = Math.min(0.15, (blindSpots?.length || 0) * 0.03);
        const confidence = Math.max(0, Math.min(1, baseConfidence - bsPenalty));

        if (this.verbose) {
          this._log(`[SocraticChallenger] 🔧 F1 DEVELOP Stage-Specific: ${totalChanges} changes → confidence=${(confidence * 100).toFixed(0)}%`);
        }

        return {
          confidence,
          confidenceStatus: 'ok',
          confidenceReason: 'stage_specific_develop_evaluator',
          dimensionScores: null,
          evidenceBreakdown: {
            model: 'stage-specific-v1',
            mode: 'develop_evaluator',
            hasDiffMarkers,
            hasFilePaths,
            hasCodeBlocks,
            addedLines,
            removedLines,
            totalChanges,
            changeScore,
            baseConfidence,
            blindSpotPenalty: bsPenalty,
            finalConfidence: confidence,
          },
        };
      }
    }

    // ── ANALYSE stage: check for root cause analysis structure ──
    if (stageUpper === 'ANALYSE') {
      const hasRootCause = /root\s*cause|根因|根本原因|impact|影响范围|affected/i.test(content);
      const hasFileRefs = /\b[\w\-./]+\.(js|ts|py|go|java|cs)\b/i.test(content);
      const hasHeadings = (content.match(/^#+\s+/gm) || []).length >= 3;

      if (hasRootCause && hasFileRefs && hasHeadings) {
        const baseConfidence = 0.75;
        const bsPenalty = Math.min(0.15, (blindSpots?.length || 0) * 0.03);
        const confidence = Math.max(0, Math.min(1, baseConfidence - bsPenalty));
        return {
          confidence,
          confidenceStatus: 'ok',
          confidenceReason: 'stage_specific_analyse_evaluator',
          dimensionScores: null,
          evidenceBreakdown: {
            model: 'stage-specific-v1',
            mode: 'analyse_evaluator',
            hasRootCause,
            hasFileRefs,
            hasHeadings,
            finalConfidence: confidence,
          },
        };
      }
    }

    // No stage-specific evaluator matched — fall through to generic
    return null;
  }

  _scoreEvidenceSlots(content, taskFingerprint = {}, stageName = '') {
    const contentLower = String(content || '').toLowerCase();
    const expectedSlots = this._buildEvidenceSlots(taskFingerprint, stageName);

    const slotSignals = {
      reasoning: [/because|therefore|due to|since|因为|所以|因此|推导/i],
      tests: [/test|测试|assert|spec|case/i],
      logs: [/log|trace|日志|链路/i],
      repro: [/repro|复现|步骤|scenario/i],
      root_cause: [/root cause|根因|本质原因|causal/i],
      metrics: [/metric|指标|qps|latency|p95|p99|throughput/i],
      rollback_proof: [/rollback|回滚|降级|fallback|恢复/i],
      benchmark: [/benchmark|基准|对比实验|ab test/i],
      industry_comparison: [/industry|best practice|业界|竞品|标准/i],
      diff_scope: [/diff|变更范围|scope|impact/i],
      compatibility: [/compat|兼容|migration|breaking change/i],
      threat_model: [/threat|auth|permission|security|攻击/i],
      interfaces: [/api|interface|contract|协议|输入输出/i],
      dependencies: [/depend|依赖|前置|blocked by/i],
      coverage: [/coverage|覆盖率|path coverage|分支覆盖/i],
    };

    const hitSlots = [];
    for (const slot of expectedSlots) {
      const patterns = slotSignals[slot] || [];
      if (patterns.some(p => p.test(contentLower))) {
        hitSlots.push(slot);
      }
    }

    const coverage = expectedSlots.length > 0 ? hitSlots.length / expectedSlots.length : 0;

    return {
      coverage,
      hitCount: hitSlots.length,
      expectedSlots,
      hitSlots,
      missingSlots: expectedSlots.filter(s => !hitSlots.includes(s)),
    };
  }

  _scoreClaimEvidence(content, claims = []) {
    const normalizedContent = String(content || '');
    const contentLower = normalizedContent.toLowerCase();

    const extractedClaims = (claims || [])
      .map(c => String(c || '').trim())
      .filter(Boolean)
      .slice(0, 12);

    const fallbackClaims = extractedClaims.length > 0
      ? extractedClaims
      : this._extractFallbackClaimsFromContent(normalizedContent);

    const claimCount = fallbackClaims.length;
    if (claimCount === 0) {
      return {
        score: 0,
        claimCount: 0,
        coveredClaims: 0,
        coverage: 0,
        reasoningSignal: 0,
        evidenceSignal: 0,
      };
    }

    let coveredClaims = 0;
    for (const claim of fallbackClaims) {
      if (this._isClaimSupported(claim, contentLower)) {
        coveredClaims++;
      }
    }

    const coverage = coveredClaims / claimCount;
    const reasoningSignal = this._computeReasoningSignal(contentLower);
    const evidenceSignal = this._computeEvidenceSignal(contentLower);

    const score = Math.max(0, Math.min(1,
      coverage * 0.6 + reasoningSignal * 0.2 + evidenceSignal * 0.2
    ));

    return {
      score,
      claimCount,
      coveredClaims,
      coverage,
      reasoningSignal,
      evidenceSignal,
    };
  }

  _extractFallbackClaimsFromContent(content) {
    const text = String(content || '');
    const candidates = text
      .split(/\n|\.|。|;|；/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => /实现|完成|支持|提供|improve|optimiz|implement|support|deliver|ensure|verified|tested/i.test(s));

    return candidates.slice(0, 8);
  }

  _isClaimSupported(claim, contentLower) {
    const claimText = String(claim || '').trim().toLowerCase();
    if (!claimText) return false;

    const tokens = claimText.split(/\s+/).filter(t => t.length >= 4).slice(0, 6);
    const tokenHit = tokens.some(t => contentLower.includes(t));

    const hasEvidenceNear = /(test|验证|evidence|proof|benchmark|metric|coverage|assert|日志|trace)/i.test(contentLower);
    const hasReasoningNear = /(because|therefore|due to|since|因为|所以|因此|由于|推导)/i.test(contentLower);

    if (tokens.length === 0) {
      return hasEvidenceNear || hasReasoningNear;
    }

    return tokenHit && (hasEvidenceNear || hasReasoningNear);
  }

  _computeReasoningSignal(contentLower) {
    const markers = [
      /because|therefore|due to|since|derived|hence/i,
      /因为|所以|因此|由于|推导|因果|逻辑链/,
    ];
    const hitCount = markers.reduce((sum, p) => sum + (p.test(contentLower) ? 1 : 0), 0);
    return Math.min(1, hitCount / markers.length);
  }

  _computeEvidenceSignal(contentLower) {
    const markers = [
      /test|verified|validated|coverage|assert|benchmark|metric|trace|log/i,
      /测试|验证|覆盖率|断言|基准|指标|日志|证据/,
      /\d+\s*(ms|s|qps|%|kb|mb|gb|x)/i,
    ];
    const hitCount = markers.reduce((sum, p) => sum + (p.test(contentLower) ? 1 : 0), 0);
    return Math.min(1, hitCount / markers.length);
  }

  _extractRequirementText(context = {}) {
    return context.rawRequirement || context.requirement || context.userRequirement || '';
  }

  _extractStageSnippets(content, stageName) {
    const lines = String(content || '').split('\n').map(l => l.trim()).filter(Boolean);
    const stageHints = {
      ANALYSE: [/requirement/i, /需求/, /functional requirements?/i, /用户故事/],
      ARCHITECT: [/architecture/i, /组件|component/i, /接口|interface/i],
      PLAN: [/plan/i, /task/i, /milestone/i, /依赖/],
      CODE: [/diff/i, /function/i, /class/i, /error|exception/i],
      TEST: [/test/i, /coverage/i, /assert/i, /结果|report/i],
    };

    const hints = stageHints[stageName] || [];
    const matched = [];
    for (const line of lines) {
      if (hints.some(p => p.test(line))) {
        matched.push(line);
      }
      if (matched.length >= 3) break;
    }

    return matched.length > 0 ? matched : lines.slice(0, 2);
  }

  // ─── Artifact Structure Extractor (4-step pipeline) ──────────────────────────
  // Borrowed from EGPAgent's content anchoring approach:
  //   Step 1: Parse — Markdown heading tree
  //   Step 2: Classify — content type per section
  //   Step 3: Anchor — compare vs STAGE_ARTIFACT_SCHEMA
  //   Step 4: Generate — anchored questions for gaps

  /**
   * Extract structured representation of artifact content and generate
   * schema-gap questions anchored to specific sections.
   *
   * @param {string} content - Raw artifact content
   * @param {string} stageName - Stage name (ANALYSE, ARCHITECT, etc.)
   * @returns {{ headings: object[], schemaGaps: object[], anchoredQuestions: object[] }}
   */
  _extractArtifactStructure(content, stageName) {
    const text = String(content || '');

    // Skip schema checking for LIGHTWEIGHT artifacts
    if (text.includes('[LIGHTWEIGHT]')) {
      return { headings: [], schemaGaps: [], anchoredQuestions: [] };
    }

    // Step 1: Parse — extract Markdown heading tree
    const headings = this._parseHeadingTree(text);

    // Step 2: Classify — tag each section with content type
    for (const h of headings) {
      h.contentType = this._classifySectionContent(h.bodyText);
      h.wordCount = (h.bodyText || '').split(/\s+/).filter(Boolean).length;
    }

    // Step 3: Anchor — compare against schema
    const schema = STAGE_ARTIFACT_SCHEMA[stageName];
    const schemaGaps = schema ? this._findSchemaGaps(headings, schema) : [];

    // Step 4: Generate — create anchored questions for each gap
    const anchoredQuestions = this._generateAnchoredQuestions(schemaGaps, stageName, headings);

    return { headings, schemaGaps, anchoredQuestions };
  }

  /**
   * Step 1: Parse Markdown content into a heading tree.
   * @param {string} text - Raw Markdown text
   * @returns {Array<{level: number, title: string, startLine: number, endLine: number, bodyText: string}>}
   */
  _parseHeadingTree(text) {
    const lines = text.split('\n');
    const headings = [];

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(#{1,6})\s+(.+)/);
      if (match) {
        // Close previous heading's body
        if (headings.length > 0) {
          const prev = headings[headings.length - 1];
          prev.endLine = i - 1;
          prev.bodyText = lines.slice(prev.startLine + 1, i).join('\n').trim();
        }
        headings.push({
          level: match[1].length,
          title: match[2].trim(),
          startLine: i,
          endLine: lines.length - 1, // will be updated by next heading
          bodyText: '',
        });
      }
    }

    // Close last heading
    if (headings.length > 0) {
      const last = headings[headings.length - 1];
      last.endLine = lines.length - 1;
      last.bodyText = lines.slice(last.startLine + 1).join('\n').trim();
    }

    return headings;
  }

  /**
   * Step 2: Classify section content type based on keyword patterns.
   * @param {string} bodyText - Section body text
   * @returns {'conclusion'|'evidence'|'assumption'|'decision'|'risk'|'unknown'}
   */
  _classifySectionContent(bodyText) {
    const text = String(bodyText || '').toLowerCase();
    // Order matters: risk before decision to avoid '风险' matching '决' in decision pattern
    const patterns = {
      risk: /风险|问题|缺陷|risk|issue|defect|vulnerability|P[012]/,
      conclusion: /结论|因此|所以|综上|therefore|conclude|in\s*summary|root\s*cause|根因/,
      evidence: /证据|数据|测试|结果|evidence|data|test|result|benchmark|实测/,
      assumption: /假设|前提|如果|假定|assume|premise|if\s+we/,
      decision: /决定|选择|方案|设计|决策|decide|choose|design|approach|trade.?off/,
    };

    for (const [type, pattern] of Object.entries(patterns)) {
      if (pattern.test(text)) return type;
    }
    return 'unknown';
  }

  /**
   * Step 3: Compare parsed headings against stage schema to find gaps.
   * @param {object[]} headings - Parsed heading tree
   * @param {object} schema - STAGE_ARTIFACT_SCHEMA entry
   * @returns {Array<{section: string, status: string, severity: string, reason: string}>}
   */
  _findSchemaGaps(headings, schema) {
    if (!schema || !Array.isArray(schema.expectedSections)) return [];

    const gaps = [];

    for (const expected of schema.expectedSections) {
      // Find matching heading
      const matched = headings.find(h => expected.heading.test(h.title));

      if (!matched) {
        gaps.push({
          section: expected.label || String(expected.heading),
          status: 'missing',
          severity: expected.required ? 'missing_required' : 'missing_optional',
          reason: `Expected section "${expected.label}" not found in artifact`,
        });
        continue;
      }

      // Check word count
      if (expected.minWords && matched.wordCount < expected.minWords) {
        gaps.push({
          section: expected.label || matched.title,
          status: 'weak',
          severity: 'weak_content',
          reason: `Section "${matched.title}" has ${matched.wordCount} words (min: ${expected.minWords})`,
          line: matched.startLine + 1,
        });
        continue;
      }

      // Check quality patterns
      const failedChecks = [];
      for (const checkName of (expected.qualityChecks || [])) {
        const pattern = QUALITY_CHECK_PATTERNS[checkName];
        if (pattern && !pattern.test(matched.bodyText)) {
          failedChecks.push(checkName);
        }
      }

      if (failedChecks.length > 0) {
        gaps.push({
          section: expected.label || matched.title,
          status: 'weak',
          severity: 'weak_content',
          reason: `Section "${matched.title}" missing quality signals: ${failedChecks.join(', ')}`,
          line: matched.startLine + 1,
          failedChecks,
        });
      }
    }

    // ── E3: Rule fallback — untested assumption detection ──
    // Borrowed from EGPAgent's rule_based_gap_diagnosis rule 2
    const assumptionSignals = /假设|前提|假定|assume|premise|if\s+we|预计|估计/i;
    const verificationSignals = /验证|证实|测试|数据表明|实测|verified|tested|confirmed|evidence/i;
    for (const h of headings) {
      if (assumptionSignals.test(h.bodyText) && !verificationSignals.test(h.bodyText)) {
        // Check if this section is not already flagged
        const alreadyFlagged = gaps.some(g => g.section === h.title);
        if (!alreadyFlagged) {
          gaps.push({
            section: h.title,
            status: 'untested_assumption',
            severity: 'untested_assumption',
            reason: `Section "${h.title}" contains assumption signals but no verification evidence`,
            line: h.startLine + 1,
          });
        }
      }
    }

    // ── E3: Rule fallback — quantitative claim without numbers ──
    // Borrowed from EGPAgent's rule_based_gap_diagnosis rule 3
    const quantitativeSignals = /预计|大约|约|估计|approximately|roughly|expected|目标.*达到/i;
    const hasNumbers = /\d+/;
    for (const h of headings) {
      if (quantitativeSignals.test(h.bodyText) && !hasNumbers.test(h.bodyText)) {
        const alreadyFlagged = gaps.some(g => g.section === h.title);
        if (!alreadyFlagged) {
          gaps.push({
            section: h.title,
            status: 'weak_evidence',
            severity: 'weak_evidence',
            reason: `Section "${h.title}" has quantitative claims but no specific numbers`,
            line: h.startLine + 1,
          });
        }
      }
    }

    return gaps;
  }

  /**
   * Step 4: Generate anchored Socratic questions for each schema gap.
   * Questions reference specific section titles and line numbers.
   * @param {object[]} schemaGaps - Gaps from _findSchemaGaps
   * @param {string} stageName - Current stage
   * @param {object[]} headings - Parsed heading tree (for context)
   * @returns {Array<{question: string, anchorSection: string, anchorLine: number, severity: string}>}
   */
  _generateAnchoredQuestions(schemaGaps, stageName, headings) {
    const questions = [];

    for (const gap of schemaGaps) {
      let question;

      // E1: Extract source excerpt from heading bodyText for content anchoring
      const excerptText = this._extractSourceExcerpt(gap, headings);
      const excerptRef = excerptText ? `原文：「${excerptText}」——` : '';

      if (gap.status === 'missing') {
        question = `[Schema缺口][${stageName}] artifact 中缺少"${gap.section}"部分。`
          + (gap.severity === 'missing_required'
            ? `这是必需 section，缺失会导致后续阶段缺乏关键输入。请补充。`
            : `这是可选 section，但补充后能提升产物完整性。`);
      } else if (gap.status === 'weak') {
        const lineRef = gap.line ? `（第 ${gap.line} 行附近）` : '';
        if (gap.failedChecks && gap.failedChecks.length > 0) {
          const checkLabels = gap.failedChecks.map(c => c.replace(/_/g, ' ')).join('、');
          question = `[内容锚定][${stageName}] "${gap.section}"${lineRef}内容不够充分：缺少 ${checkLabels}。`
            + `${excerptRef}当前内容是否足以支撑后续阶段的决策？`;
        } else {
          question = `[内容锚定][${stageName}] "${gap.section}"${lineRef}内容过于简短（${gap.reason}）。`
            + `${excerptRef}是否遗漏了关键信息？`;
        }
      } else if (gap.status === 'untested_assumption') {
        // E3: Untested assumption gap
        question = `[假设验证][${stageName}] "${gap.section}"中存在未验证的假设：${excerptRef}`
          + `该假设的依据是什么？如何验证？`;
      } else if (gap.status === 'weak_evidence') {
        // E3: Quantitative claim without numbers
        question = `[量化缺失][${stageName}] "${gap.section}"中存在量化声明但缺少具体数值：${excerptRef}`
          + `请提供具体的数据支撑。`;
      }

      if (question) {
        questions.push({
          question,
          anchorSection: gap.section,
          anchorLine: gap.line || 0,
          severity: gap.severity,
        });
      }
    }

    return questions;
  }

  /**
   * E1: Extract a source excerpt from the heading's bodyText for content anchoring.
   * Truncates at sentence boundary (。/\n/.) to avoid cutting mid-sentence.
   * Borrowed from EGPAgent's source_excerpt mechanism.
   * @param {object} gap - Schema gap object
   * @param {object[]} headings - Parsed heading tree
   * @returns {string} Excerpt text (max ~60 chars) or empty string
   */
  _extractSourceExcerpt(gap, headings) {
    if (!gap || !headings || headings.length === 0) return '';

    // Find the heading matching this gap's section
    const heading = headings.find(h =>
      h.title === gap.section ||
      (gap.section && h.title && h.title.includes(gap.section))
    );
    if (!heading || !heading.bodyText) return '';

    const body = heading.bodyText.trim();
    if (!body) return '';

    // Extract first meaningful sentence (up to 60 chars)
    const MAX_LEN = 60;
    // Try to cut at sentence boundary
    const sentenceEnd = body.search(/[。\n.!？]/);
    if (sentenceEnd > 0 && sentenceEnd <= MAX_LEN) {
      return body.slice(0, sentenceEnd + 1).trim();
    }
    // Fallback: truncate at MAX_LEN
    if (body.length <= MAX_LEN) return body;
    return body.slice(0, MAX_LEN) + '…';
  }

  _containsSignal(contentLower, signal) {
    const normalized = String(contentLower || '').toLowerCase();
    const candidates = this._expandCheckSignals(signal);
    return candidates.some(s => normalized.includes(String(s).toLowerCase()));
  }

  _expandCheckSignals(check) {
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
    };

    return dict[key] || [check];
  }

  _getStageDimensionChecks(stageName, dimKey) {
    const stageDimensionChecks = {
      ANALYSE: {
        BREADTH: ['用户画像', '场景覆盖'],
        DEPTH: ['问题根因', '价值主张'],
        BOUNDARY: ['异常场景', '边界条件'],
        EVIDENCE: ['需求来源', '优先级依据'],
        DATA: ['用户数据', '业务指标'],
        INDUSTRY_COMPARISON: ['竞品分析', '行业标杆'],
        RELEVANCE: ['关联问题', '上下游依赖'],
        LOGIC: ['需求逻辑一致性', '因果链分析'],
        CLARITY: ['术语定义', '需求清晰度'],
        PRECISION: ['量化指标', '时间线'],
        FIRST_PRINCIPLES: ['需求本质约束', '问题从零推导'],
      },
      ARCHITECT: {
        BREADTH: ['模块划分', '接口设计'],
        DEPTH: ['技术选型理由', '架构权衡'],
        BOUNDARY: ['容错设计', '降级策略'],
        EVIDENCE: ['设计文档', '技术验证'],
        DATA: ['性能预估', '容量规划'],
        INDUSTRY_COMPARISON: ['业界架构对比', '成熟方案参考'],
        RELEVANCE: ['跨模块影响', '系统间依赖'],
        LOGIC: ['架构推理链', '设计决策逻辑'],
        CLARITY: ['架构描述清晰', '接口定义明确'],
        PRECISION: ['性能数值', '容量上限'],
        FIRST_PRINCIPLES: ['架构本质约束', '技术选型从零推导'],
      },
      CODE: {
        BREADTH: ['功能完整性', '模块覆盖'],
        DEPTH: ['算法选择', '代码质量'],
        BOUNDARY: ['异常处理', '边界检查'],
        EVIDENCE: ['代码审查', '测试结果'],
        DATA: ['性能数据', '覆盖率'],
        INDUSTRY_COMPARISON: ['开源实现参考', '最佳实践对比'],
        RELEVANCE: ['代码复用', '相似模块'],
        LOGIC: ['代码逻辑正确', '条件分支完备'],
        CLARITY: ['命名清晰', '注释完整'],
        PRECISION: ['参数范围', '边界值'],
        FIRST_PRINCIPLES: ['实现必要性验证', '算法从基本原理推导'],
      },
      TEST: {
        BREADTH: ['测试类型覆盖', '场景覆盖'],
        DEPTH: ['测试深度', '问题定位'],
        BOUNDARY: ['边界测试', '压力测试'],
        EVIDENCE: ['测试报告', '缺陷分析'],
        DATA: ['覆盖率数据', '性能基准'],
        INDUSTRY_COMPARISON: ['行业标准测试', '竞品测试对比'],
        RELEVANCE: ['关联测试', '集成测试'],
        LOGIC: ['测试逻辑覆盖', '断言正确性'],
        CLARITY: ['测试描述清晰', '预期结果明确'],
        PRECISION: ['覆盖率百分比', '性能基准值'],
        FIRST_PRINCIPLES: ['测试目标本质', '验证策略从零推导'],
      },
      PLAN: {
        BREADTH: ['任务覆盖', '依赖分析'],
        DEPTH: ['风险评估', '资源规划'],
        BOUNDARY: ['应急预案', '回滚策略'],
        EVIDENCE: ['历史数据', '估算依据'],
        DATA: ['工时估算', '里程碑指标'],
        INDUSTRY_COMPARISON: ['业界项目经验', '标准流程参考'],
        RELEVANCE: ['任务依赖', '资源冲突'],
        LOGIC: ['任务顺序逻辑', '依赖关系正确'],
        CLARITY: ['任务描述清晰', '验收标准明确'],
        PRECISION: ['工时估算值', '截止日期'],
        FIRST_PRINCIPLES: ['任务必要性验证', '流程从零推导'],
      },
    };

    return stageDimensionChecks[stageName]?.[dimKey] || [];
  }

  _truncate(text, maxLen = 40) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
  }

  // ─── History & Utilities ────────────────────────────────────────────────────

  /**
   * Get challenge history for a stage.
   */
  getChallengeHistory(stageName) {
    return this._challengeHistory.get(stageName);
  }

  /**
   * Clear challenge history.
   */
  clearHistory() {
    this._challengeHistory.clear();
  }

  // ─── Logging ────────────────────────────────────────────────────────────────

  _log(message) {
    if (this.verbose) {
      console.log(message);
    }
  }
}

// ─── E4: Answer Quality Gate (borrowed from EGPAgent) ─────────────────────────
// 4-dimension evaluation of Socratic question self-answers:
//   1. Length adequacy — is the answer detailed enough?
//   2. Specificity — does it contain numbers, references, causal explanations?
//   3. Relevance — does it mention the questioned section/concept?
//   4. Non-evasion — is it a real answer or a deflection?
//
// Usage (in ide-workflow-bridge.js stage-complete):
//   const { evaluateAnswerQuality } = require('../core/socratic-challenger');
//   const result = evaluateAnswerQuality(questionText, answerText);
//   if (!result.acceptable) { /* flag for retry */ }

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
  // Known type labels to exclude from relevance matching (these are question
  // category tags, not content keywords — answers won't contain them)
  const TYPE_LABELS = new Set([
    'Schema缺口', '内容锚定', '假设验证', '量化缺失', '逻辑性', '精确性',
    '清晰度', '广度', '深度', '边界', '证据', '数据', '行业对比', '相关性',
    '第一性原理', 'ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST',
  ]);

  // (a) Extract from curly/smart quotes: "section name"
  const sectionMatch = question.match(/[""\u201c\u201d]([^""\u201c\u201d]+)[""\u201c\u201d]/);
  if (sectionMatch) relevanceKeywords.push(sectionMatch[1]);

  // (b) Extract from [brackets], filtering out type labels and stage names
  const bracketMatch = question.match(/\[([^\]]+)\]/g);
  if (bracketMatch) {
    for (const m of bracketMatch) {
      const inner = m.slice(1, -1);
      if (inner.length > 1 && inner.length < 30 && !TYPE_LABELS.has(inner)) {
        relevanceKeywords.push(inner);
      }
    }
  }

  // (c) Extract from Chinese corner brackets「...」(used by E1 excerpt anchoring)
  const cornerMatch = question.match(/[「『]([^」』]+)[」』]/g);
  if (cornerMatch) {
    for (const m of cornerMatch) {
      const inner = m.slice(1, -1).trim();
      // Extract meaningful fragments (skip very short or very long)
      if (inner.length > 3 && inner.length < 80) {
        // Split long excerpts into key phrases for partial matching
        const phrases = inner.split(/[，。；、,;.\s]+/).filter(p => p.length > 2);
        relevanceKeywords.push(...phrases.slice(0, 3));
      }
    }
  }

  // (d) Extract key noun phrases from question body (after removing tags)
  const questionBody = question
    .replace(/\[[^\]]+\]/g, '')       // Remove [bracket tags]
    .replace(/[「『][^」』]+[」』]/g, '') // Remove 「corner quotes」
    .trim();
  const nounPhrasePatterns = [
    /[""\u201c\u201d]([^""\u201c\u201d]{2,20})[""\u201c\u201d]/g,  // Remaining quoted terms
    /(?:缺少|缺失|缺乏|补充|验证|提供)\s*([^\s，。？]{2,15})/g,     // Object of action verbs
  ];
  for (const pattern of nounPhrasePatterns) {
    let match;
    while ((match = pattern.exec(questionBody)) !== null) {
      // Clean extracted phrase: strip quote characters that may leak through
      const phrase = match[1].trim().replace(/[""\u201c\u201d「」『』]/g, '').trim();
      if (phrase.length > 1 && !relevanceKeywords.includes(phrase)) {
        relevanceKeywords.push(phrase);
      }
    }
  }

  // Deduplicate keywords (earlier extractions may overlap with later ones)
  const uniqueKeywords = [...new Set(relevanceKeywords)];

  // Score: partial credit for partial matches
  // Use 0.4 threshold so hitting 1 out of 2-3 keywords still scores well
  // For long keywords (>3 chars), also check if answer contains a significant
  // substring (>= 60% of keyword length) — handles cases like "具体数据支撑" vs "具体数据"
  const relevanceHits = uniqueKeywords.filter(kw => {
    if (answer.includes(kw)) return true;
    // Fuzzy substring match for longer keywords
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
    : 0.5; // Default if no keywords extracted
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

  // Weighted average (borrowed from EGPAgent's weights)
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

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  SocraticChallenger,
  evaluateAnswerQuality,
  ANSWER_QUALITY_CONFIG,
  SOCRATIC_LAYERS,
  STAGE_CHALLENGES,
  FIVE_DIMENSIONS,    // Backward compatibility
  SIX_DIMENSIONS,     // Backward compatibility
  SEVEN_DIMENSIONS,   // Backward compatibility
  TEN_DIMENSIONS,     // Backward compatibility (ADR-55)
  ELEVEN_DIMENSIONS,  // Full 11 dimensions (ADR-55 Rev.2)
};
