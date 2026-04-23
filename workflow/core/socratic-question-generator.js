/**
 * Socratic Challenger – Question Generator (ADR-56 Decomposition)
 *
 * Extracted from socratic-challenger.js.
 * Handles the core question generation pipeline:
 *   P0: Schema-gap → F6: Rule-driven → T1+T2: Entity-grounded →
 *   T4: Dimension → Task → Stage → Claim → What-if → D7: Cross-stage
 *
 * Also includes: question selection, reranking, claim challenge,
 * dimension question generation, and LLM rewriting.
 *
 * @module workflow/core/socratic-question-generator
 */

'use strict';

const {
  ELEVEN_DIMENSIONS,
  SOCRATIC_LAYERS,
  STAGE_CHALLENGES,
  STAGE_POSITION_WEIGHTS,
  getStageDimensionChecks,
} = require('./socratic-constants');
const { extractEntities, generateEntityGroundedQuestions, extractArtifactStructure } = require('./socratic-entity-extractor');
const { collectRuleDrivenQuestions, buildRuleConfig } = require('./socratic-blind-spot-detector');
const { SemanticSimilarityEngine } = require('./socratic-relevance-scorer');
const { DiversityMixer } = require('./socratic-diversity-mixer');
const { ExplorationQuestionGenerator } = require('./socratic-exploration-generator');

const _sharedSimilarityEngine = new SemanticSimilarityEngine();
const _sharedDiversityMixer = new DiversityMixer();
const _sharedExplorationGenerator = new ExplorationQuestionGenerator();

/**
 * Core question generation pipeline.
 * @param {object} instance - SocraticChallenger instance (for utility methods and LLM)
 * @param {string} stageName - Current stage
 * @param {string[]} claims - Extracted claims
 * @param {string} content - Artifact content
 * @param {object} context - Additional context
 * @returns {string[]} Selected and ranked questions
 */
function generateSocraticQuestions(instance, stageName, claims, content, context = {}, blindSpots = []) {
  const stageConfig = STAGE_CHALLENGES[stageName];
  const requirement = _extractRequirementText(instance, context);
  const snippets = _extractStageSnippets(instance, content, stageName);
  const taskFingerprint = inferTaskFingerprint(stageName, content, context);

  const candidates = [];

  // Blind-spot-derived questions — each BLIND SPOT spawns a targeted question
  for (const bs of (blindSpots || []).slice(0, 3)) {
    const bsText = String(bs || '').replace(/^⚠️\s*\[BLIND SPOT\][^\]]*\]\s*/i, '').replace(/^⚠️\s*\[BLIND SPOT\]\s*/i, '').trim();
    if (!bsText) continue;
    const q = `针对盲点"${instance._truncate(bsText, 60)}"，你的 artifact 中有哪些具体证据可以排除这个风险？`;
    candidates.push({
      question: q,
      reasonTag: 'blindspot_derived',
      source: 'blindspot',
      priority: 0.97,
    });
  }

  // P0: Schema-gap questions (highest priority — content anchoring + schema mapping)
  if (!String(content || '').includes('[LIGHTWEIGHT]')) {
    const artifactStructure = extractArtifactStructure(content, stageName, instance._truncate.bind(instance));
    instance._lastArtifactStructure = artifactStructure;
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
  const ruleDriven = collectRuleDrivenQuestions(stageName, content, context, instance._lastArtifactStructure);
  instance._lastRuleDiagnostics = ruleDriven.diagnostics;
  for (const q of (ruleDriven.questions || [])) {
    candidates.push({
      question: q,
      reasonTag: 'missing_evidence',
      source: 'rule',
      priority: 0.65,
    });
  }

  // T1+T2: Entity-grounded questions
  const entities = extractEntities(content, stageName);
  const entityQuestions = generateEntityGroundedQuestions(entities, stageName, content, requirement, instance._truncate.bind(instance));
  for (const q of entityQuestions) {
    candidates.push({
      question: q.question,
      reasonTag: q.reasonTag || 'entity_grounded',
      source: 'entity',
      priority: 0.95,
    });
  }

  // Eleven-dimension questions — DEMOTED to backfill priority (T4)
  const dimensionQuestions = generateDimensionQuestions(instance, stageName, content, context, snippets, taskFingerprint);
  for (const q of dimensionQuestions) {
    candidates.push({
      question: q,
      reasonTag: 'coverage_gap',
      source: 'dimension',
      priority: 0.30,
    });
  }

  // Task-type specific probes
  const taskProbes = generateTaskSpecificProbes(taskFingerprint, stageName, content, requirement, instance);
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
      const keyWords = _extractKeyWords(instance, probe);
      return !keyWords.some(kw => contentLower.includes(kw.toLowerCase()));
    });

    for (const probe of relevantProbes.slice(0, 2)) {
      const q = requirement
        ? `针对需求"${instance._truncate(requirement, 50)}"，${probe}`
        : probe;
      candidates.push({
        question: q,
        reasonTag: 'stage_probe',
        source: 'stage',
        priority: 0.72,
      });
    }
  }

  // F6: Challenge specific claims using Socratic layers — PRIORITY ELEVATED
  for (const claim of claims.slice(0, 3)) {
    const layerQuestions = challengeClaimWithLayers(instance, claim, content);
    for (const q of layerQuestions) {
      candidates.push({
        question: q,
        reasonTag: 'claim_verification',
        source: 'claim',
        priority: 0.96,
      });
    }
  }

  // What-if scenario
  const whatIfQuestion = generateWhatIfQuestion(stageName, content, instance);
  if (whatIfQuestion) {
    candidates.push({
      question: whatIfQuestion,
      reasonTag: 'boundary_risk',
      source: 'what_if',
      priority: 0.74,
    });
  }

  // D7: Cross-stage consistency questions
  const crossStageQuestions = generateCrossStageQuestions(instance, stageName, content, context);
  for (const q of crossStageQuestions) {
    candidates.push({
      question: q,
      reasonTag: 'cross_stage_gap',
      source: 'cross_stage',
      priority: 0.92,
    });
  }

  // Generate exploratory questions — blind-spot-aware when blindSpots provided
  const exploratoryQuestions = _sharedExplorationGenerator.generate(content, stageName, requirement, blindSpots);
  for (const eq of exploratoryQuestions) {
    candidates.push({
      question: eq.question,
      reasonTag: 'exploratory',
      source: 'exploration',
      priority: eq.score || 0.65,
      isExploratory: true,
      strategy: eq.strategy,
    });
  }

  const selected = selectAndRerankQuestions(instance, candidates, taskFingerprint, content, context);
  rememberQuestions(instance, selected);

  return selected;
}

/**
 * Generate questions for each of the twelve dimensions.
 */
function generateDimensionQuestions(instance, stageName, content, context = {}, snippets = [], taskFingerprint = 'general') {
  const questions = [];
  const contentLower = content.toLowerCase();
  const stageDimChecks = getStageDimensionChecks(stageName, taskFingerprint);

  for (const [dimKey, dim] of Object.entries(ELEVEN_DIMENSIONS)) {
    const stageWeight = stageDimChecks[dimKey] || 1;
    if (stageWeight < 1) continue;

    const checks = dim.checks || [];
    let hitCount = 0;
    for (const check of checks) {
      const signals = _expandCheckSignals(check);
      const hit = signals.some(s => contentLower.includes(String(s).toLowerCase()));
      if (hit) hitCount++;
    }
    const coverage = checks.length > 0 ? hitCount / checks.length : 0.5;

    if (coverage < 0.5) {
      const templates = dim.questionTemplates || [];
      const templateIdx = Math.min(Math.floor(coverage * templates.length), templates.length - 1);
      const template = templates[templateIdx] || templates[0] || `${dim.description}？`;

      let question;
      if (snippets.length > 0 && snippets[0].length > 20) {
        question = `针对 artifact 中的"${instance._truncate(snippets[0], 40)}"，${template}`;
      } else {
        question = template;
      }
      questions.push(question);
    }
  }

  return questions.slice(0, 3);
}

/**
 * Challenge a claim using What → Why → How → What-if layers.
 */
function challengeClaimWithLayers(instance, claim, content) {
  const claimText = String(claim || '').trim();
  if (!claimText) return [];

  const questions = [];
  const layers = Object.entries(SOCRATIC_LAYERS);

  for (const [layerName, layer] of layers) {
    const templates = layer.templates || [];
    const template = templates[Math.floor(Math.random() * templates.length)];
    if (!template) continue;

    const question = template
      .replace('{claim}', instance._truncate(claimText, 60))
      .replace('{alternative}', '其他方案')
      .replace('{stress_condition}', '高并发或异常情况')
      .replace('{edge_case}', '边界场景')
      .replace('{assumption}', '这个假设')
      .replace('{unexpected_behavior}', '执行了非预期操作');

    questions.push(question);
  }

  return questions.slice(0, 3);
}

/**
 * Generate a What-if question for the stage.
 */
function generateWhatIfQuestion(stageName, content, instance) {
  const stageWhatIfs = {
    ANALYSE: '如果需求理解与实际意图不一致，会导致什么后果？',
    ARCHITECT: '如果并发量是预期的 10 倍，当前架构能否支撑？',
    PLAN: '如果关键任务延期，对整体进度的影响是什么？',
    CODE: '如果输入数据格式异常，代码会怎样？',
    DEVELOP: '如果依赖服务不可用，系统会怎样？',
    TEST: '如果测试数据与生产数据差异很大，测试结果还可靠吗？',
  };
  return stageWhatIfs[stageName] || '如果当前假设不成立，会发生什么？';
}

/**
 * D7: Cross-stage consistency questions.
 */
function generateCrossStageQuestions(instance, stageName, content, context) {
  const questions = [];
  const history = instance._challengeHistory;
  if (!history || history.size === 0) return questions;

  const stageOrder = ['ANALYSE', 'ARCHITECT', 'PLAN', 'CODE', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
  const currentIdx = stageOrder.indexOf(String(stageName).toUpperCase());
  if (currentIdx <= 0) return questions;

  // Check for contradictions with previous stage
  const prevStageName = stageOrder[currentIdx - 1];
  const prevEntry = history.get(prevStageName);
  if (!prevEntry || !prevEntry.claims) return questions;

  const contentLower = String(content || '').toLowerCase();
  for (const prevClaim of prevEntry.claims.slice(0, 2)) {
    const claimLower = String(prevClaim || '').toLowerCase();
    const tokens = claimLower.split(/\s+/).filter(t => t.length >= 4).slice(0, 4);
    const claimReferenced = tokens.some(t => contentLower.includes(t));
    if (!claimReferenced) {
      questions.push(
        `前一阶段(${prevStageName})声明"${instance._truncate(prevClaim, 50)}"，` +
        `但当前阶段(${stageName})的 artifact 中未体现。是否需要在此阶段处理？`
      );
    }
  }

  return questions.slice(0, 2);
}

/**
 * Infer task type fingerprint from content and context.
 */
function inferTaskFingerprint(stageName, content, context = {}) {
  const text = String(content || '').toLowerCase();
  const requirement = String(context.requirement || '').toLowerCase();
  const combined = text + ' ' + requirement;

  const fingerprints = {
    bugfix: /bug|缺陷|fix|修复|问题|issue|defect|错误|异常|fault/i.test(combined),
    feature: /feature|新功能|新增|add|implement|开发|开发新/i.test(combined),
    refactor: /refactor|重构|优化|restructur|清理|simplif/i.test(combined),
    performance: /performance|性能|optim|提速|latency|吞吐|throughput|qps/i.test(combined),
    security: /security|安全|漏洞|vulnerability|xss|csrf|inject|auth/i.test(combined),
    test: /test|测试|coverage|覆盖率|unit.*test|集成测试/i.test(combined),
  };

  const matched = Object.entries(fingerprints)
    .filter(([, match]) => match)
    .map(([type]) => type);

  return matched.length > 0 ? matched[0] : 'general';
}

/**
 * Generate task-type specific probes.
 */
function generateTaskSpecificProbes(taskFingerprint, stageName, content, requirement, instance) {
  const _truncate = instance ? instance._truncate.bind(instance) : (s, n) => String(s || '').slice(0, n);
  const probes = [];

  const taskProbes = {
    bugfix: [
      '修复是否只针对根因，还是也处理了表面症状？',
      '修复是否可能引入新的副作用？回归测试如何覆盖？',
      '类似 bug 在其他模块是否也存在？',
    ],
    feature: [
      '新功能是否与现有功能有冲突或重叠？',
      '新功能的边界条件是否已定义？',
      '新功能是否需要数据迁移或配置变更？',
    ],
    refactor: [
      '重构后的行为是否与重构前完全一致？如何验证？',
      '重构是否影响了公共 API 或接口契约？',
      '重构的范围是否过大？能否分步进行？',
    ],
    performance: [
      '性能优化是否有基准测试数据支撑？',
      '优化是否可能在其他场景下导致性能回退？',
      '优化后的内存/CPU 使用是否经过测量？',
    ],
    security: [
      '安全修复是否覆盖了所有攻击向量？',
      '修复是否可能引入新的安全漏洞？',
      '是否有安全审计或渗透测试的验证？',
    ],
    test: [
      '测试用例是否覆盖了正常路径和异常路径？',
      '测试数据是否具有代表性？是否存在偏差？',
      '是否有集成测试或端到端测试验证？',
    ],
  };

  const probeList = taskProbes[taskFingerprint] || [];
  const contentLower = String(content || '').toLowerCase();

  for (const probe of probeList) {
    const keyWords = probe.split(/[，？?、]/).filter(w => w.length >= 2).slice(0, 3);
    const alreadyAddressed = keyWords.some(kw => contentLower.includes(kw.toLowerCase()));
    if (!alreadyAddressed) {
      const reqPrefix = requirement ? `针对需求"${_truncate(requirement, 50)}"，` : '';
      probes.push(`${reqPrefix}${probe}`);
    }
  }

  return probes.slice(0, 2);
}

/**
 * Select and rerank question candidates.
 * Preserves the original ADR-56 implementation with:
 *   - Semantic similarity dedup (_semanticSimilarity > 0.82)
 *   - Cross-stage history dedup (_questionHistory)
 *   - Core hash dedup (_computeQuestionCoreHash + _sessionQuestionCoreHashes)
 *   - P0/P1/P2 layered selection with schema_gap priority
 */
function selectAndRerankQuestions(instance, candidates, taskFingerprint, content, context) {
  if (candidates.length === 0) return [];

  const maxQuestions = Math.max(1, instance.maxQuestions || 3);

  // Step 1: Exact-string dedup
  const dedup = [];
  const seen = new Set();
  for (const item of candidates || []) {
    const q = String(item?.question || '').trim();
    if (!q) continue;
    if (seen.has(q)) continue;
    seen.add(q);
    dedup.push({ ...item, question: q });
  }

  // Step 2: Score each candidate using the full multi-factor scorer
  const scored = dedup.map(item => ({
    ...item,
    score: _scoreQuestionCandidate(instance, item, taskFingerprint, content, context),
  }));

  // Step 3: Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Step 4: P0/P1/P2 layered selection with semantic dedup
  const MAX_PER_LAYER = 2;
  // Use DiversityMixer for balanced selection (85-90% relevant + 10-15% exploratory)
  const exploratoryScored = scored.filter(i => i.isExploratory === true);
  const relevantScored = scored.filter(i => i.isExploratory !== true);

  const mixerCandidates = [
    ...relevantScored.map(i => ({ ...i, isExploratory: false })),
    ...exploratoryScored.map(i => ({ ...i, isExploratory: true })),
  ];

  const mixerSelected = _sharedDiversityMixer.select(mixerCandidates, maxQuestions, taskFingerprint);

  // Apply session-level dedup on mixer output
  const selected = [];

  const isSimilar = (q) => {
    const tooSimilarToSelected = selected.some(s => _semanticSimilarity(s, q) > 0.82);
    const tooSimilarToHistory = (instance._questionHistory || []).some(s => _semanticSimilarity(s, q) > 0.82);
    // D1: Cross-stage session-level dedup
    const coreHash = _computeQuestionCoreHash(q);
    const alreadyAskedInSession = (instance._sessionQuestionCoreHashes || new Set()).has(coreHash);
    return tooSimilarToSelected || tooSimilarToHistory || alreadyAskedInSession;
  };

  // Apply dedup to mixer-selected questions first
  for (const q of mixerSelected) {
    if (selected.length >= maxQuestions) break;
    if (!isSimilar(q)) selected.push(q);
  }

  // Layer P0: missing_required (fallback if mixer didn't fill quota)
  const p0 = scored.filter(i => i.severity === 'missing_required');
  for (const item of p0) {
    if (selected.length >= maxQuestions) break;
    if (selected.length >= MAX_PER_LAYER && item.severity === 'missing_required') {
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

/**
 * Score a question candidate using the original multi-factor scoring model.
 * Factors: evidence slot coverage, risk profile, requirement keywords,
 * novelty, schema gap severity, stage position, confidence inversion.
 */
function _scoreQuestionCandidate(instance, candidate, taskFingerprint, content, context = {}) {
  const q = String(candidate?.question || '').toLowerCase();
  const base = Number(candidate?.priority || 0.5);

  // Evidence slot coverage boost
  const evidenceNeeds = Array.isArray(taskFingerprint?.evidenceNeeds) ? taskFingerprint.evidenceNeeds : [];
  const evidenceHits = evidenceNeeds.filter(slot => q.includes(slot.replace('_', '')) || q.includes(_slotDisplayText(slot).toLowerCase()));
  const evidenceBoost = evidenceHits.length > 0 ? 0.15 : 0;

  // Risk profile boost
  const riskProfile = Array.isArray(taskFingerprint?.riskProfile) ? taskFingerprint.riskProfile : [];
  const riskBoost = riskProfile.some(r => q.includes(String(r).toLowerCase())) ? 0.08 : 0;

  // Requirement keyword boost
  const requirement = _extractRequirementText(instance, context).toLowerCase();
  const requirementBoost = requirement && _extractKeyWords(instance, requirement).some(k => q.includes(k.toLowerCase())) ? 0.06 : 0;

  // Novelty boost — question mentions keywords NOT in content
  const contentLower = String(content || '').toLowerCase();
  const noveltyBoost = _extractKeyWords(instance, q).some(k => !contentLower.includes(k.toLowerCase())) ? 0.04 : 0;

  // Schema gap severity boost
  const severity = candidate?.severity || '';
  const schemaGapBoost = severity === 'missing_required' ? 0.25
    : severity === 'weak_content' ? 0.15
    : severity === 'missing_optional' ? 0.05
    : severity === 'untested_assumption' ? 0.20
    : severity === 'weak_evidence' ? 0.18
    : 0;

  // Stage position boost
  const stageName = String(context?.stageName || context?.stage || '').toUpperCase();
  const stagePositionBoost = STAGE_POSITION_WEIGHTS[stageName] || 0;

  // E2: Confidence inversion boost
  const confidenceInversionBoost = _detectLowConfidenceSignals(q, content) ? 0.12 : 0;

  // Factor 8: Semantic similarity boost (TF-IDF based)
  const contentSample = String(content || '').slice(0, 1000);
  const semanticResult = _sharedSimilarityEngine.calculate(q, contentSample);
  const semanticBoost = semanticResult.score > 0.3 ? semanticResult.score * 0.12 : 0;

  // Factor 9: Domain anchoring boost
  const entities = extractEntities(content, String(context?.stageName || context?.stage || ''));
  const allEntityTexts = [
    ...entities.filePaths,
    ...entities.functionNames,
    ...entities.decisions.map(d => d.slice(0, 30)),
  ];
  const anchoringScore = _sharedSimilarityEngine.calculateAnchoring(q, allEntityTexts);
  const domainBoost = anchoringScore * 0.08;

  return base + evidenceBoost + riskBoost + requirementBoost + noveltyBoost + schemaGapBoost + stagePositionBoost + confidenceInversionBoost + semanticBoost + domainBoost;
}

/**
 * E2: Detect low-confidence signals in question text or artifact content.
 */
function _detectLowConfidenceSignals(questionText, content) {
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
  return hits >= 2;
}

/**
 * Map evidence slot names to display text for question matching.
 */
function _slotDisplayText(slot) {
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

/**
 * Compute Jaccard similarity between two texts using token sets.
 */
function _semanticSimilarity(a, b) {
  const sa = new Set(_normalizeForSimilarity(a));
  const sb = new Set(_normalizeForSimilarity(b));
  if (sa.size === 0 || sb.size === 0) return 0;

  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) inter++;
  }

  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Normalize text for similarity comparison.
 * Uses Unicode property regex to strip non-letter/number characters.
 */
function _normalizeForSimilarity(text) {
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
 * section names, and dimension tags for cross-stage dedup.
 */
function _computeQuestionCoreHash(question) {
  const q = String(question || '');
  const core = q
    .replace(/\[[^\]]{1,20}\]/g, '')
    .replace(/[（(]第\s*\d+\s*行[^)）]*[)）]/g, '')
    .replace(/["\u201c\u201d][^"\u201c\u201d]{1,20}["\u201c\u201d]/g, '')
    .replace(/需求["\u201c][^"\u201d]*["\u201d]/g, '')
    .replace(/当前输出中["\u201c][^"\u201d]*["\u201d]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  let hash = 5381;
  for (let i = 0; i < core.length; i++) {
    hash = ((hash << 5) + hash + core.charCodeAt(i)) & 0x7fffffff;
  }
  return String(hash);
}

/**
 * Remember questions and update session-level core hash set.
 */
function rememberQuestions(instance, questions) {
  const incoming = (questions || []).map(q => String(q || '').trim()).filter(Boolean);
  if (incoming.length === 0) return;

  if (!instance._questionHistory) instance._questionHistory = [];
  instance._questionHistory.push(...incoming);
  if (instance._questionHistory.length > 30) {
    instance._questionHistory = instance._questionHistory.slice(-30);
  }

  // D1: Sync session-level core hashes for cross-stage dedup
  if (!instance._sessionQuestionCoreHashes) instance._sessionQuestionCoreHashes = new Set();
  for (const q of incoming) {
    instance._sessionQuestionCoreHashes.add(_computeQuestionCoreHash(q));
  }
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

function _extractRequirementText(instance, context) {
  if (!context) return '';
  return String(context.requirement || context.rawRequirement || '').trim();
}

function _extractStageSnippets(instance, content, stageName) {
  const text = String(content || '');
  const stageHeader = text.match(new RegExp(`#+\\s*${stageName}`, 'i'));
  if (!stageHeader) return [];

  const startIdx = stageHeader.index + stageHeader[0].length;
  const nextHeader = text.slice(startIdx).match(/\n#{1,4}\s+/);
  const endIdx = nextHeader ? startIdx + nextHeader.index : text.length;
  const sectionText = text.slice(startIdx, endIdx).trim();

  const sentences = sectionText
    .split(/[。\n.!?！？]/)
    .map(s => s.trim())
    .filter(s => s.length > 15)
    .slice(0, 3);

  return sentences;
}

function _extractKeyWords(instance, text) {
  return String(text || '')
    .replace(/[?？!！。，,.\s]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .slice(0, 5);
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

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  generateSocraticQuestions,
  generateDimensionQuestions,
  challengeClaimWithLayers,
  generateWhatIfQuestion,
  generateCrossStageQuestions,
  inferTaskFingerprint,
  generateTaskSpecificProbes,
  selectAndRerankQuestions,
  rememberQuestions,
  _scoreQuestionCandidate,
  _detectLowConfidenceSignals,
  _slotDisplayText,
  _semanticSimilarity,
  _normalizeForSimilarity,
  _computeQuestionCoreHash,
};
