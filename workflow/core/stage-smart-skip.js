/**
 * StageSmartSkip – Adaptive Stage Skipping Based on Task Complexity & Intent (Direction 5)
 *
 * Dynamically skips non-essential pipeline stages based on:
 *   1. Task complexity assessed during ANALYSE (original mechanism)
 *   2. Task intent detected via two-layer detection:
 *      Layer 1: Regex pre-detection from raw user input (instant, before pipeline)
 *      Layer 2: Semantic confirmation from ANALYSE enriched output (post-ANALYSE, overrides Layer 1)
 *
 * This avoids wasteful LLM calls for simple tasks
 * (e.g. a one-file bug fix doesn't need full architecture + plan phases)
 * AND for non-code tasks (e.g. design/analysis/review/comparison/research
 * don't need CODE + TEST stages).
 *
 * Design references:
 *   - LangGraph conditional edges: dynamic path selection based on state
 *   - Google AI adaptive pipeline: skip unnecessary stages based on input complexity
 *   - Stanford HAI RL workflow automation: self-optimising task pipelines
 *   - DARPA adaptive execution: complexity-driven resource allocation
 *
 * Skip rules (complexity-based):
 *   ┌─────────────────┬──────────┬─────────────┬──────────────┬─────────────┐
 *   │ Complexity       │ ANALYSE  │ ARCHITECT   │ PLANNER      │ CODE + TEST │
 *   ├─────────────────┼──────────┼─────────────┼──────────────┼─────────────┤
 *   │ simple (0-25)    │ ALWAYS   │ SKIP ⏭️     │ SKIP ⏭️      │ ALWAYS      │
 *   │ moderate (26-50) │ ALWAYS   │ ALWAYS      │ SKIP ⏭️      │ ALWAYS      │
 *   │ complex (51-75)  │ ALWAYS   │ ALWAYS      │ ALWAYS       │ ALWAYS      │
 *   │ very_complex(76+)│ ALWAYS   │ ALWAYS      │ ALWAYS       │ ALWAYS      │
 *   └─────────────────┴──────────┴─────────────┴──────────────┴─────────────┘
 *
 * Skip rules (intent-based — non-code tasks):
 *   ┌──────────────────┬──────────┬─────────────┬──────────────┬─────────────┐
 *   │ Task Intent       │ ANALYSE  │ ARCHITECT   │ PLAN         │ CODE + TEST │
 *   ├──────────────────┼──────────┼─────────────┼──────────────┼─────────────┤
 *   │ design_only       │ ALWAYS   │ ALWAYS      │ ALWAYS       │ SKIP ⏭️     │
 *   │ analysis_only     │ ALWAYS   │ SKIP ⏭️     │ SKIP ⏭️      │ SKIP ⏭️     │
 *   │ review_only       │ ALWAYS   │ ALWAYS      │ SKIP ⏭️      │ SKIP ⏭️     │
 *   │ research_only     │ ALWAYS   │ SKIP ⏭️     │ SKIP ⏭️      │ SKIP ⏭️     │
 *   │ full (default)    │ ALWAYS   │ ALWAYS      │ ALWAYS       │ ALWAYS      │
 *   └──────────────────┴──────────┴─────────────┴──────────────┴─────────────┘
 *
 * Safety constraints:
 *   - ANALYSE is NEVER skipped (provides complexity assessment + enriched requirement)
 *   - CODE and TEST are NEVER skipped for full/code tasks
 *   - CODE and TEST CAN be skipped when taskIntent is non-code (design/analysis/review/research)
 *   - Skipping is disabled when config.stageSmartSkip.enabled === false
 *   - Skipping is disabled when no complexity assessment is available
 *   - Each skip decision is recorded in the DecisionTrail for audit
 *
 * Two-Layer Intent Detection:
 *   Layer 1 (regex, instant): detectTaskIntent(rawRequirement) — called before pipeline starts
 *   Layer 2 (semantic, post-ANALYSE): estimateTaskIntent(enrichedRequirement) — called after ANALYSE
 *   Priority: Layer 2 > Layer 1. If Layer 2 disagrees, it overrides Layer 1.
 *   Safety: If Layer 1 says non-code but Layer 2 says full → revert to full (prevent false skip)
 *
 * Integration:
 *   - Called from Orchestrator.run() before each _runStage() invocation
 *   - Reads complexity from stageCtx.get('ANALYSE').meta.complexity
 *   - Reads taskIntent from stageCtx.get('ANALYSE').meta.taskIntent (Layer 2)
 *   - Uses DecisionTrail.record() to log skip decisions
 *
 * @module stage-smart-skip
 */

'use strict';

const { DecisionCategory } = require('./decision-trail');

// ─── Task Intent Detection ──────────────────────────────────────────────────

/**
 * Task intent types that determine which stages to skip.
 * Detected from user's /wf input via keyword matching.
 */
const TaskIntent = {
  FULL: 'full',                 // Default: run all stages (code task)
  DESIGN_ONLY: 'design_only',   // Design/architecture/plan — skip CODE+TEST
  ANALYSIS_ONLY: 'analysis_only', // Analysis/evaluation/comparison — skip ARCHITECT+PLAN+CODE+TEST
  REVIEW_ONLY: 'review_only',   // Review/audit — skip PLAN+CODE+TEST
  RESEARCH_ONLY: 'research_only', // Research/investigation/search — skip ARCHITECT+PLAN+CODE+TEST
};

/**
 * Patterns for detecting task intent from user input.
 * Order matters: first match wins. More specific patterns come first.
 */
const INTENT_PATTERNS = [
  {
    intent: TaskIntent.DESIGN_ONLY,
    patterns: [
      /方案设计|技术设计|设计方案|出个方案|写个设计|架构设计|系统设计/i,
      /design\s*plan|architecture\s*design|system\s*design|technical\s*design/i,
      /实施方案|设计文档|design\s*doc/i,
    ],
    description: 'Design/architecture task — produces analysis + architecture + plan, skips CODE+TEST',
  },
  {
    intent: TaskIntent.ANALYSIS_ONLY,
    patterns: [
      /深度分析|对比分析|评估报告|可行性分析|差距分析|能力评估|深度评估|质量评估/i,
      /分析一下|帮我分析|做个分析|进行分析|对比一下|比较一下/i,
      /deep\s*analysis|comparative\s*analysis|feasibility|gap\s*analysis/i,
      /analyze|evaluate|assess|compare|benchmark/i,
    ],
    description: 'Analysis/evaluation task — produces analysis only, skips ARCHITECT+PLAN+CODE+TEST',
  },
  {
    intent: TaskIntent.REVIEW_ONLY,
    patterns: [
      /代码审查|架构审查|安全审查|质量审查|审查一下|review一下/i,
      /code\s*review|architecture\s*review|security\s*audit|quality\s*audit/i,
      /审查|审计|audit|review/i,
    ],
    description: 'Review/audit task — produces analysis + architecture review, skips PLAN+CODE+TEST',
  },
  {
    intent: TaskIntent.RESEARCH_ONLY,
    patterns: [
      /调研|技术调研|方案调研|搜索|查找|检索|研究一下/i,
      /research|investigate|search|look\s*up|find\s*out|explore/i,
    ],
    description: 'Research/investigation task — produces analysis only, skips ARCHITECT+PLAN+CODE+TEST',
  },
];

/**
 * Intent-based stage skip rules.
 * Key: TaskIntent value. Value: Set of stage names to skip.
 */
const INTENT_SKIP_MAP = {
  [TaskIntent.FULL]: new Set(),
  [TaskIntent.DESIGN_ONLY]: new Set(['CODE', 'TEST']),
  [TaskIntent.ANALYSIS_ONLY]: new Set(['ARCHITECT', 'PLAN', 'CODE', 'TEST']),
  [TaskIntent.REVIEW_ONLY]: new Set(['PLAN', 'CODE', 'TEST']),
  [TaskIntent.RESEARCH_ONLY]: new Set(['ARCHITECT', 'PLAN', 'CODE', 'TEST']),
};

/**
 * Layer 1: Detect task intent from user's raw requirement text via regex.
 * Fast, instant, but may have false positives/negatives.
 *
 * @param {string} requirement - User's raw /wf input
 * @returns {{ intent: string, description: string, matchedPattern: string|null, source: string }}
 */
function detectTaskIntent(requirement) {
  if (!requirement || typeof requirement !== 'string') {
    return { intent: TaskIntent.FULL, description: 'Default: full pipeline', matchedPattern: null, source: 'regex' };
  }

  for (const { intent, patterns, description } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      const match = requirement.match(pattern);
      if (match) {
        return { intent, description, matchedPattern: match[0], source: 'regex' };
      }
    }
  }

  return { intent: TaskIntent.FULL, description: 'Default: full pipeline', matchedPattern: null, source: 'regex' };
}

// ─── Layer 2: Semantic Intent Estimation (post-ANALYSE) ─────────────────────

/**
 * Semantic indicators for non-code task intent.
 * These are checked against the ANALYSE enriched requirement output,
 * which has been processed by the LLM and contains structured analysis.
 *
 * More reliable than Layer 1 regex because:
 *   1. LLM has already understood the full context
 *   2. Enriched requirement disambiguates vague inputs
 *   3. Can detect intent from structured sections (e.g. "Deliverables: design document")
 */
const SEMANTIC_INTENT_INDICATORS = [
  // Order matters: more specific intents first, then broader ones.
  // review_only and research_only must come before analysis_only
  // because analysis_only's patterns are broader and would match review/research text.
  {
    intent: TaskIntent.REVIEW_ONLY,
    strongPatterns: [
      /deliverable[s]?[:\s].*(?:review|audit|inspection|审查|审计)/i,
      /output[:\s].*(?:review\s*report|audit\s*report|findings)/i,
      /目标[：:].*(?:审查|审计|检查|评审)/i,
    ],
    weakPatterns: [
      /code\s*review|architecture\s*review|security\s*audit/i,
      /review.*(?:existing|current|已有|现有)/i,
    ],
    description: 'Review/audit task — produces analysis + architecture review, skips PLAN+CODE+TEST',
  },
  {
    intent: TaskIntent.RESEARCH_ONLY,
    strongPatterns: [
      /deliverable[s]?[:\s].*(?:research|investigation|survey|调研|研究)/i,
      /output[:\s].*(?:research\s*report|findings|recommendations)/i,
      /目标[：:].*(?:调研|研究|探索|搜索)/i,
    ],
    weakPatterns: [
      /investigate|explore|survey|look\s*into/i,
      /调研.*(?:方案|技术|工具|框架)/i,
    ],
    description: 'Research/investigation task — produces analysis only, skips ARCHITECT+PLAN+CODE+TEST',
  },
  {
    intent: TaskIntent.DESIGN_ONLY,
    strongPatterns: [
      /deliverable[s]?[:\s].*(?:design|architecture|plan|方案|设计|文档)/i,
      /output[:\s].*(?:design\s*doc|architecture\s*doc|technical\s*spec|RFC)/i,
      /目标[：:].*(?:方案|设计|架构|规划)/i,
      /scope[:\s].*(?:design|plan|specification).*(?:only|no\s*code|不需要.*代码|不包括.*实现)/i,
    ],
    weakPatterns: [
      /no\s*(?:code|implementation|coding)\s*(?:needed|required|necessary)/i,
      /不需要.*(?:代码|编码|实现|开发)/i,
      /只需要.*(?:方案|设计|分析|评估|报告)/i,
      /不包括.*(?:code|实现|编码)/i,
      /phase\s*1[:\s].*design/i,
    ],
    description: 'Design/architecture task — produces analysis + architecture + plan, skips CODE+TEST',
  },
  {
    intent: TaskIntent.ANALYSIS_ONLY,
    strongPatterns: [
      /deliverable[s]?[:\s].*(?:analysis|evaluation|comparison|评估|分析|对比)/i,
      /deliverable[s]?[:\s].*(?:analysis\s*report|评估报告|分析报告)/i,
      /output[:\s].*(?:analysis|assessment|comparison)/i,
      /目标[：:].*(?:分析|评估|对比|调查)/i,
    ],
    weakPatterns: [
      /no\s*(?:code|implementation)\s*(?:change|modification|needed)/i,
      /read[\s-]*only\s*(?:analysis|review|assessment)/i,
      /不需要.*(?:修改|改动|代码变更)/i,
      /只.*(?:分析|评估|对比|比较)/i,
    ],
    description: 'Analysis/evaluation task — produces analysis only, skips ARCHITECT+PLAN+CODE+TEST',
  },
];

/**
 * Layer 2: Estimate task intent from ANALYSE enriched requirement.
 * Called after ANALYSE completes, uses the LLM-processed output for semantic analysis.
 *
 * Detection logic:
 *   1. Check strong patterns first — any single match is sufficient
 *   2. Check weak patterns — need 2+ matches to trigger
 *   3. Check for explicit code-needed signals — override to FULL if found
 *
 * @param {string} enrichedRequirement - The enriched requirement from ANALYSE stage output
 * @returns {{ intent: string, description: string, confidence: string, signals: string[], source: string }}
 */
function estimateTaskIntent(enrichedRequirement) {
  if (!enrichedRequirement || typeof enrichedRequirement !== 'string') {
    return { intent: TaskIntent.FULL, description: 'Default: full pipeline', confidence: 'none', signals: [], source: 'semantic' };
  }

  // Check for explicit code-needed signals (override to FULL)
  const CODE_NEEDED_PATTERNS = [
    /(?:implement|build|create|develop|code|fix|修复|实现|开发|编写|编码).*(?:feature|module|function|component|service|功能|模块|服务)/i,
    /(?:需要|必须|应该).*(?:编写|实现|开发|修改|创建).*(?:代码|程序|脚本|模块)/i,
    /code\s*change|代码变更|代码修改|implementation\s*required/i,
    /bug\s*fix|hotfix|patch|修复.*bug/i,
  ];

  const codeSignals = [];
  for (const pattern of CODE_NEEDED_PATTERNS) {
    const match = enrichedRequirement.match(pattern);
    if (match) codeSignals.push(match[0]);
  }

  // If strong code signals found, always return FULL
  if (codeSignals.length >= 2) {
    return {
      intent: TaskIntent.FULL,
      description: 'Code implementation required (strong code signals detected)',
      confidence: 'high',
      signals: codeSignals,
      source: 'semantic',
    };
  }

  // Check each non-code intent (ordered array — more specific first)
  for (const indicators of SEMANTIC_INTENT_INDICATORS) {
    const intent = indicators.intent;
    const strongMatches = [];
    const weakMatches = [];

    for (const pattern of indicators.strongPatterns) {
      const match = enrichedRequirement.match(pattern);
      if (match) strongMatches.push(match[0]);
    }

    for (const pattern of indicators.weakPatterns) {
      const match = enrichedRequirement.match(pattern);
      if (match) weakMatches.push(match[0]);
    }

    // Strong signal: any single strong match is sufficient
    if (strongMatches.length > 0) {
      return {
        intent,
        description: indicators.description,
        confidence: 'high',
        signals: [...strongMatches, ...weakMatches],
        source: 'semantic',
      };
    }

    // Weak signals: need 2+ to trigger
    if (weakMatches.length >= 2) {
      return {
        intent,
        description: indicators.description,
        confidence: 'medium',
        signals: weakMatches,
        source: 'semantic',
      };
    }
  }

  // No non-code intent detected → default to FULL
  // But if there's 1 code signal, boost confidence
  return {
    intent: TaskIntent.FULL,
    description: codeSignals.length > 0
      ? 'Code implementation likely required'
      : 'Default: full pipeline (no strong non-code signals)',
    confidence: codeSignals.length > 0 ? 'medium' : 'low',
    signals: codeSignals,
    source: 'semantic',
  };
}

// ─── Default Skip Configuration ─────────────────────────────────────────────

/**
 * Default stage skip rules (complexity-based).
 * Key: stage name. Value: { skipBelow: number } — skip if complexity.score < skipBelow.
 *
 * Stages not listed here are NEVER skipped by complexity rules (implicitly skipBelow: 0).
 * ANALYSE is intentionally absent → always executed.
 * CODE and TEST are absent → always executed for full/code tasks,
 * but CAN be skipped by intent-based rules for non-code tasks.
 */
const DEFAULT_SKIP_RULES = {
  // Simple tasks (score < 26): skip ARCHITECT (design doc is overkill for a one-liner fix)
  ARCHITECT: { skipBelow: 26, reason: 'Simple task — architecture design not needed' },
  // Simple + moderate tasks (score < 51): skip PLANNER (decomposition is overkill for single-module changes)
  PLAN:      { skipBelow: 51, reason: 'Simple/moderate task — sub-task decomposition not needed' },
};

/**
 * Stages that can NEVER be skipped, regardless of any configuration.
 * ANALYSE provides the complexity assessment and enriched requirement.
 * CODE and TEST are core delivery stages — skipping them would produce
 * incomplete or unverified output.
 */
const NEVER_SKIP_STAGES = new Set(['ANALYSE', 'CODE', 'TEST']);

// ─── StageSmartSkip Class ───────────────────────────────────────────────────

class StageSmartSkip {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled=true]  - Set false to disable all skipping
   * @param {object}  [opts.skipRules]     - Custom skip rules (merged with defaults)
   * @param {import('./decision-trail').DecisionTrail} [opts.decisionTrail] - For recording skip decisions
   */
  constructor(opts = {}) {
    this._enabled = opts.enabled !== false;
    this._decisionTrail = opts.decisionTrail || null;
    this._taskIntent = null; // Set via setTaskIntent()

    // Merge custom skip rules with defaults
    this._skipRules = { ...DEFAULT_SKIP_RULES };
    if (opts.skipRules) {
      for (const [stage, rule] of Object.entries(opts.skipRules)) {
        if (NEVER_SKIP_STAGES.has(stage)) {
          console.warn(`[StageSmartSkip] ⚠️  Ignoring skip rule for safety-critical stage "${stage}".`);
          continue;
        }
        this._skipRules[stage] = { ...this._skipRules[stage], ...rule };
      }
    }

    // Track skip decisions for summary
    this._skippedStages = [];
    this._executedStages = [];

    if (this._enabled) {
      const rules = Object.entries(this._skipRules)
        .map(([stage, rule]) => `${stage}(score<${rule.skipBelow})`)
        .join(', ');
      console.error(`[StageSmartSkip] ⏭️  Initialised (rules: ${rules})`);
    }
  }

  // ─── Task Intent API ──────────────────────────────────────────────────

  /**
   * Layer 1: Set the task intent from raw user input (regex pre-detection).
   * Called before pipeline starts for instant feedback.
   * May be overridden by Layer 2 (confirmTaskIntent) after ANALYSE completes.
   *
   * @param {string} requirement - User's raw requirement text
   * @returns {{ intent: string, description: string, matchedPattern: string|null, source: string }}
   */
  setTaskIntent(requirement) {
    const detection = detectTaskIntent(requirement);
    this._taskIntent = detection;
    this._layer1Intent = detection; // Preserve Layer 1 result for comparison
    if (detection.intent !== TaskIntent.FULL) {
      const skipStages = Array.from(INTENT_SKIP_MAP[detection.intent] || []);
      console.error(`[StageSmartSkip] 🎯 Layer 1 (regex): intent=${detection.intent} (matched: "${detection.matchedPattern}")`);
      console.error(`[StageSmartSkip] ⏭️  Preliminary skip stages: [${skipStages.join(', ')}]`);
      console.error(`[StageSmartSkip] 📋 ${detection.description}`);
      console.error(`[StageSmartSkip] ℹ️  Will be confirmed/overridden by Layer 2 after ANALYSE completes.`);
    } else {
      console.error(`[StageSmartSkip] 🎯 Layer 1 (regex): intent=full (no intent-based skipping detected)`);
    }
    return detection;
  }

  /**
   * Layer 2: Confirm or override task intent using ANALYSE enriched output.
   * Called after ANALYSE completes. Uses semantic analysis of the enriched requirement.
   *
   * Priority rules:
   *   - If Layer 2 detects a different intent with high confidence → override Layer 1
   *   - If Layer 2 detects FULL but Layer 1 detected non-code → revert to FULL (safety)
   *   - If Layer 2 has low confidence → keep Layer 1 result
   *   - If Layer 2 agrees with Layer 1 → confirm (boost confidence)
   *
   * @param {object} context - Context with stageCtx containing ANALYSE results
   * @param {object} [context.stageCtx] - StageContextStore with ANALYSE results
   * @returns {{ intent: string, source: string, layer1: object, layer2: object, overridden: boolean }}
   */
  confirmTaskIntent(context = {}) {
    // Extract enriched requirement from ANALYSE output
    let enrichedRequirement = null;
    if (context.stageCtx) {
      const analyseData = typeof context.stageCtx.get === 'function'
        ? context.stageCtx.get('ANALYSE')
        : null;
      // Try meta.taskIntent first (if already estimated by stage-analyst)
      if (analyseData?.meta?.taskIntent) {
        const layer2 = analyseData.meta.taskIntent;
        // If LLM provided the intent directly, treat it as highest confidence
        if (layer2.source === 'llm') {
          console.error(`[StageSmartSkip] 🧠 LLM-assessed task intent: ${layer2.intent} (bypassing regex Layer 2)`);
        }
        return this._resolveIntentLayers(layer2);
      }
      // Fallback: read enriched requirement from artifact
      if (analyseData?.artifacts?.[0]) {
        try {
          const fs = require('fs');
          const content = fs.readFileSync(analyseData.artifacts[0], 'utf-8');
          enrichedRequirement = content;
        } catch (e) {
          console.warn(`[StageSmartSkip] ⚠️  Could not read ANALYSE artifact: ${e.message}`);
        }
      }
    }

    if (!enrichedRequirement) {
      console.error(`[StageSmartSkip] ℹ️  Layer 2: No enriched requirement available — keeping Layer 1 result.`);
      return {
        intent: this._taskIntent?.intent || TaskIntent.FULL,
        source: 'regex',
        layer1: this._layer1Intent,
        layer2: null,
        overridden: false,
      };
    }

    // Run Layer 2 semantic estimation
    const layer2 = estimateTaskIntent(enrichedRequirement);
    return this._resolveIntentLayers(layer2);
  }

  /**
   * Resolve Layer 1 vs Layer 2 intent with priority rules.
   * @param {object} layer2 - Layer 2 estimation result
   * @returns {{ intent: string, source: string, layer1: object, layer2: object, overridden: boolean }}
   * @private
   */
  _resolveIntentLayers(layer2) {
    const layer1 = this._layer1Intent || { intent: TaskIntent.FULL, source: 'regex' };
    const l1Intent = layer1.intent;
    const l2Intent = layer2.intent;
    // LLM-sourced intent is always treated as high confidence
    const l2Confidence = layer2.source === 'llm' ? 'high' : (layer2.confidence || 'low');

    let finalIntent = l1Intent;
    let overridden = false;
    let source = 'regex';

    if (l1Intent === l2Intent) {
      // Agreement — confirm Layer 1 with boosted confidence
      finalIntent = l1Intent;
      source = 'confirmed';
      console.error(`[StageSmartSkip] ✅ Layer 2 (semantic) confirms Layer 1: intent=${finalIntent}`);
    } else if (l2Confidence === 'high') {
      // Layer 2 disagrees with high confidence → override
      finalIntent = l2Intent;
      source = 'semantic';
      overridden = true;
      console.error(`[StageSmartSkip] 🔄 Layer 2 OVERRIDES Layer 1: ${l1Intent} → ${l2Intent} (confidence: ${l2Confidence})`);
      if (l2Intent === TaskIntent.FULL && l1Intent !== TaskIntent.FULL) {
        console.error(`[StageSmartSkip] ⚠️  Safety override: Layer 1 detected non-code task but ANALYSE found code is needed.`);
      }
    } else if (l2Confidence === 'medium' && l2Intent !== TaskIntent.FULL && l1Intent === TaskIntent.FULL) {
      // Layer 2 found non-code intent with medium confidence, Layer 1 missed it → adopt Layer 2
      finalIntent = l2Intent;
      source = 'semantic';
      overridden = true;
      console.error(`[StageSmartSkip] 🔄 Layer 2 detects non-code intent missed by Layer 1: ${l1Intent} → ${l2Intent} (confidence: ${l2Confidence})`);
    } else if (l2Confidence === 'medium' && l2Intent === TaskIntent.FULL && l1Intent !== TaskIntent.FULL) {
      // Safety: Layer 2 thinks code is needed but only medium confidence → still revert to FULL
      finalIntent = TaskIntent.FULL;
      source = 'semantic';
      overridden = true;
      console.error(`[StageSmartSkip] ⚠️  Safety revert: Layer 2 suggests code may be needed (medium confidence) — reverting to full pipeline.`);
    } else {
      // Low confidence or ambiguous → keep Layer 1
      console.error(`[StageSmartSkip] ℹ️  Layer 2 (confidence: ${l2Confidence}) — keeping Layer 1 result: ${l1Intent}`);
    }

    // Update the active task intent
    this._taskIntent = {
      ...layer2,
      intent: finalIntent,
      source,
    };

    // Log final decision
    if (finalIntent !== TaskIntent.FULL) {
      const skipStages = Array.from(INTENT_SKIP_MAP[finalIntent] || []);
      console.error(`[StageSmartSkip] 🎯 Final intent: ${finalIntent} (source: ${source})`);
      console.error(`[StageSmartSkip] ⏭️  Final skip stages: [${skipStages.join(', ')}]`);
    } else {
      console.error(`[StageSmartSkip] 🎯 Final intent: full pipeline (source: ${source})`);
    }

    // Record in decision trail
    this._recordDecision('INTENT_RESOLUTION', overridden, 
      `Layer 1: ${l1Intent} (regex) → Layer 2: ${l2Intent} (${l2Confidence}) → Final: ${finalIntent} (${source})`,
      null);

    return {
      intent: finalIntent,
      source,
      layer1,
      layer2,
      overridden,
    };
  }

  /**
   * Get the current task intent.
   * @returns {{ intent: string, description: string, source: string }|null}
   */
  getTaskIntent() {
    return this._taskIntent;
  }

  // ─── Core API ───────────────────────────────────────────────────────────

  /**
   * Evaluates whether a stage should be skipped based on task complexity.
   *
   * @param {string} stageName - The pipeline stage name (e.g. 'ARCHITECT', 'PLAN')
   * @param {object} context   - Orchestrator context for accessing complexity data
   * @param {object} [context.stageCtx]  - StageContextStore with ANALYSE results
   * @param {object} [context.complexity] - Direct complexity override (for testing)
   * @returns {{ skip: boolean, reason: string, complexity?: object }}
   */
  shouldSkip(stageName, context = {}) {
    // Disabled → never skip
    if (!this._enabled) {
      return { skip: false, reason: 'Stage smart-skip is disabled' };
    }

    // Safety-critical stages → never skip (only ANALYSE is unconditional)
    if (NEVER_SKIP_STAGES.has(stageName)) {
      return { skip: false, reason: `${stageName} is a safety-critical stage and cannot be skipped` };
    }

    // ── Intent-based skipping (highest priority) ─────────────────────────
    // If task intent is non-code, skip stages that don't produce the expected deliverable.
    if (this._taskIntent && this._taskIntent.intent !== TaskIntent.FULL) {
      const intentSkipSet = INTENT_SKIP_MAP[this._taskIntent.intent];
      if (intentSkipSet && intentSkipSet.has(stageName)) {
        const reason = `Task intent "${this._taskIntent.intent}" — ${stageName} not needed (${this._taskIntent.description})`;
        this._skippedStages.push({ stage: stageName, reason, skipSource: 'intent' });
        this._recordDecision(stageName, true, reason, null);
        console.error(`[StageSmartSkip] ⏭️  Skipping ${stageName}: ${reason}`);
        return { skip: true, reason, skipSource: 'intent', taskIntent: this._taskIntent.intent };
      }
    }

    // ── Complexity-based skipping (original mechanism) ───────────────────
    const rule = this._skipRules[stageName];
    if (!rule) {
      return { skip: false, reason: `No skip rule defined for stage ${stageName}` };
    }

    // Get complexity assessment
    const complexity = this._getComplexity(context);
    if (!complexity || complexity.score == null) {
      // No complexity data available → conservative: don't skip
      this._recordDecision(stageName, false, 'No complexity assessment available — executing stage', null);
      return { skip: false, reason: 'No complexity assessment available — executing stage as precaution' };
    }

    // Evaluate skip condition
    if (complexity.score < rule.skipBelow) {
      const reason = `${rule.reason} (complexity: ${complexity.level}, score=${complexity.score}, threshold=${rule.skipBelow})`;
      this._skippedStages.push({ stage: stageName, complexity, reason, skipSource: 'complexity' });
      this._recordDecision(stageName, true, reason, complexity);
      console.error(`[StageSmartSkip] ⏭️  Skipping ${stageName}: ${reason}`);
      return { skip: true, reason, complexity, skipSource: 'complexity' };
    }

    // Complexity above threshold → execute normally
    const reason = `Task complexity (${complexity.level}, score=${complexity.score}) exceeds skip threshold (${rule.skipBelow})`;
    this._executedStages.push({ stage: stageName, complexity });
    this._recordDecision(stageName, false, reason, complexity);
    return { skip: false, reason, complexity };
  }

  // ─── Summary ────────────────────────────────────────────────────────────

  /**
   * Returns a structured summary of skip decisions.
   * @returns {{ enabled: boolean, skipped: object[], executed: object[], savedCalls: number }}
   */
  getSummary() {
    return {
      enabled: this._enabled,
      skipped: [...this._skippedStages],
      executed: [...this._executedStages],
      skippedCount: this._skippedStages.length,
      executedCount: this._executedStages.length,
    };
  }

  /**
   * Formats the skip summary for console output.
   * @returns {string}
   */
  formatSummary() {
    if (!this._enabled) return '';
    if (this._skippedStages.length === 0 && this._executedStages.length === 0) return '';

    const lines = [];

    if (this._skippedStages.length > 0) {
      lines.push(`  ⏭️  Smart-Skip: ${this._skippedStages.length} stage(s) skipped`);
      for (const s of this._skippedStages) {
        lines.push(`    ⏭️ ${s.stage} — ${s.reason}`);
      }
    }

    return lines.join('\n');
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  /**
   * Extracts complexity assessment from the context.
   * Priority: LLM taskClassification > regex complexity > Observability fallback.
   *
   * @param {object} context
   * @returns {{ level: string, score: number }|null}
   * @private
   */
  _getComplexity(context) {
    // Direct override (for testing)
    if (context.complexity) return context.complexity;

    // From StageContextStore (production path)
    if (context.stageCtx) {
      const analyseData = typeof context.stageCtx.get === 'function'
        ? context.stageCtx.get('ANALYSE')
        : null;
      if (analyseData && analyseData.meta) {
        // Priority 1: LLM-assessed complexity (from taskClassification in JSON block)
        if (analyseData.meta.llmClassification) {
          const llm = analyseData.meta.llmClassification;
          return {
            level: llm.complexity,
            score: llm.complexityScore,
            source: 'llm',
            requiresCodeChange: llm.requiresCodeChange,
          };
        }
        // Priority 2: Regex-based complexity estimation
        if (analyseData.meta.complexity) {
          return analyseData.meta.complexity;
        }
      }
    }

    // From Observability (fallback)
    if (context.obs && context.obs._taskComplexity) {
      return context.obs._taskComplexity;
    }

    return null;
  }

  /**
   * Records a skip decision in the DecisionTrail.
   * @param {string} stageName
   * @param {boolean} skipped
   * @param {string} reason
   * @param {object|null} complexity
   * @private
   */
  _recordDecision(stageName, skipped, reason, complexity) {
    if (!this._decisionTrail) return;

    this._decisionTrail.record({
      category: DecisionCategory.SKIP,
      stage: stageName,
      action: skipped ? 'skip_stage' : 'execute_stage',
      reason,
      evidence: complexity ? {
        level: complexity.level,
        score: complexity.score,
        threshold: this._skipRules[stageName]?.skipBelow || 0,
      } : null,
      outcome: skipped ? 'skipped' : 'will_execute',
    });
  }
}

module.exports = {
  StageSmartSkip,
  DEFAULT_SKIP_RULES,
  NEVER_SKIP_STAGES,
  TaskIntent,
  INTENT_PATTERNS,
  INTENT_SKIP_MAP,
  SEMANTIC_INTENT_INDICATORS,
  detectTaskIntent,
  estimateTaskIntent,
};
