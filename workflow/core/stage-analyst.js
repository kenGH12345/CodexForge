/**
 * Stage Runner: ANALYST
 *
 * Extracted from orchestrator-stages.js (P0 decomposition – ADR-33).
 * Contains: _runAnalyst, _recordPromptABOutcome (shared helper)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./constants');
const { AgentRole } = require('./types');
const { RequirementClarifier } = require('./requirement-clarifier');
const { DECISION_QUESTIONS } = require('./socratic-engine');
const { Observability } = require('./observability');
const { translateMdFile } = require('./i18n-translator');
const { getPromptSlotManager } = require('./prompt-builder');
const { runEvoMapFeedback, recordSelfReport, runStageMetricsGate } = require('./stage-runner-utils');
const { ContractViolationError } = require('./file-ref-bus');
const { RequestTriage } = require('./request-triage');
const { extractJsonBlock } = require('./agent-output-schema');
const {
  storeAnalyseContext,
  webSearchHelper,
  formatWebSearchBlock,
} = require('./orchestrator-stage-helpers');

// ─── Prompt A/B outcome recording helper ──────────────────────────────────────
/**
 * Records the outcome of a prompt variant usage after a QualityGate decision.
 * Called after each stage's QualityGate.evaluate() to close the A/B feedback loop.
 *
 * @param {string} agentRole       - e.g. 'analyst', 'architect', 'developer', 'tester'
 * @param {boolean} gatePassed     - Did the QualityGate pass?
 * @param {number} correctionRounds - Number of self-correction / review rounds
 * @param {number} [tokensUsed=0]  - Estimated tokens used (from obs)
 */
function _recordPromptABOutcome(agentRole, gatePassed, correctionRounds, tokensUsed = 0) {
  const mgr = getPromptSlotManager();
  if (!mgr) return;
  const variantId = mgr.getSessionVariant(agentRole, 'fixed_prefix');
  if (!variantId) return;
  mgr.recordOutcome(agentRole, 'fixed_prefix', variantId, {
    gatePassed,
    correctionRounds,
    tokensUsed,
  });
}

function _normalizeStableId(prefix, raw, index) {
  const normalized = String(raw || '').trim();
  if (/^[A-Z]{2,6}-\d{1,6}$/i.test(normalized)) {
    return normalized.toUpperCase();
  }
  return `${prefix}-${String(index + 1).padStart(3, '0')}`;
}

function _extractRequirementItemsFromJson(jsonBlock) {
  if (!jsonBlock || !Array.isArray(jsonBlock.requirements)) return [];

  return jsonBlock.requirements.map((req, i) => {
    if (typeof req === 'string') {
      return {
        id: _normalizeStableId('REQ', null, i),
        text: req.trim(),
        acceptanceCriteria: [],
      };
    }

    const acRaw = Array.isArray(req?.acceptanceCriteria)
      ? req.acceptanceCriteria
      : (Array.isArray(req?.acceptance_criteria) ? req.acceptance_criteria : []);

    const acceptanceCriteria = acRaw.map((ac, acIdx) => {
      if (typeof ac === 'string') {
        return {
          id: _normalizeStableId('AC', null, acIdx),
          text: ac.trim(),
        };
      }
      return {
        id: _normalizeStableId('AC', ac?.id, acIdx),
        text: String(ac?.text || ac?.description || '').trim(),
      };
    }).filter(ac => ac.text.length > 0);

    return {
      id: _normalizeStableId('REQ', req?.id, i),
      text: String(req?.text || req?.description || req?.title || '').trim(),
      acceptanceCriteria,
    };
  }).filter(r => r.text.length > 0);
}

function _writeRequirementTraceability(outputDir, analyseContent) {
  try {
    const jsonBlock = extractJsonBlock(analyseContent || '');
    const requirements = _extractRequirementItemsFromJson(jsonBlock);
    if (!Array.isArray(requirements) || requirements.length === 0) return null;

    const totalAcceptanceCriteria = requirements.reduce((sum, r) => sum + (r.acceptanceCriteria?.length || 0), 0);
    const traceability = {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      source: 'ANALYSE',
      requirementFile: 'requirement.md',
      requirements,
      stats: {
        requirementCount: requirements.length,
        acceptanceCriteriaCount: totalAcceptanceCriteria,
      },
    };

    const tracePath = path.join(outputDir, 'requirement-traceability.json');
    const tmpPath = `${tracePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(traceability, null, 2), 'utf-8');
    fs.renameSync(tmpPath, tracePath);
    return traceability;
  } catch {
    return null;
  }
}

/**
 * Runs the ANALYSE stage: requirement clarification, enrichment, and analysis.
 *
 * P1-2 fix: Explicit @this annotation documents the implicit dependency on
 * Orchestrator properties. This enables IDE IntelliSense, makes refactoring
 * safer (renaming Orchestrator properties will surface as JSDoc warnings),
 * and serves as living documentation of the function's runtime contract.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @param {string} rawRequirement - The raw user requirement text
 * @returns {Promise<string>} Path to the generated requirements.md
 */
async function _runAnalyst(rawRequirement) {
  // Print stage header via handoffLog if available
  if (this.handoffLog) {
    this.handoffLog.printStageHeader('ANALYSE', 'AnalystAgent');
  } else {
    console.error(`\n[Orchestrator] Stage: ANALYSE (AnalystAgent)`);
  }
  if (!this.stageCtx) {
    throw new Error('[Orchestrator] stageCtx is not initialised. This is a bug – StageContextStore should be created in the Orchestrator constructor.');
  }

  const clarifier = new RequirementClarifier({
    askUser: this.askUser,
    maxRounds: this._adaptiveStrategy?.maxClarificationRounds ?? 2,
    verbose: true,
    llmCall: this._rawLlmCall,
  });
  const clarResult = await clarifier.clarify(rawRequirement);

  if (clarResult.riskNotes && clarResult.riskNotes.length > 0) {
    try {
      const scopeDecision = this.socratic.askAsync(DECISION_QUESTIONS.SCOPE_CLARIFICATION, 2);
      console.error(`[Orchestrator] ⚡ Scope clarification (non-blocking): "${scopeDecision.optionText}"`);
      if (scopeDecision.optionIndex === 0) {
        clarResult.enrichedRequirement = `[Scope: Minimal – implement only the core feature]\n\n${clarResult.enrichedRequirement}`;
      } else if (scopeDecision.optionIndex === 1) {
        clarResult.enrichedRequirement = `[Scope: Full – implement all mentioned features]\n\n${clarResult.enrichedRequirement}`;
      }
    } catch (err) {
      this.stateMachine.recordRisk('low', `[SocraticEngine] Scope clarification skipped (engine unavailable): ${err.message}`);
      console.warn(`[Orchestrator] ⚠️  SocraticEngine scope clarification skipped – proceeding automatically. Reason: ${err.message}`);
    }
  }

  for (const note of clarResult.riskNotes) {
    this.stateMachine.recordRisk('medium', note);
  }

  // ── Optimization 4: Technical Feasibility Pre-research ───────────────────
  if (clarResult.riskNotes && clarResult.riskNotes.length > 0) {
    try {
      const COMMON_WORDS = new Set([
        'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'What', 'Which',
        'With', 'From', 'Should', 'Would', 'Could', 'Each', 'Every', 'Some', 'None',
        'Only', 'Before', 'After', 'Between', 'During', 'About', 'Below', 'Above',
        'Under', 'Must', 'Also', 'Will', 'Shall', 'Note', 'Make', 'Uses', 'Used',
        'Using', 'However', 'Therefore', 'Consider', 'Ensure', 'Verify', 'Because',
        'Please', 'Implement', 'Create', 'Build', 'Need', 'Want', 'Like', 'Provide',
      ]);
      const techKeywords = clarResult.riskNotes
        .join(' ')
        .match(/\b[A-Z][a-zA-Z0-9.]+\b/g)
        || [];
      const uniqueTechTerms = [...new Set(techKeywords)]
        .filter(t => t.length >= 3)
        .filter(t => !COMMON_WORDS.has(t))
        .filter(t => /\./.test(t) || /\d/.test(t) || /[a-z][A-Z]/.test(t) || /[A-Z]{2,}/.test(t))
        .slice(0, 5);
      if (uniqueTechTerms.length > 0) {
        const reqSnippet = (clarResult.enrichedRequirement || '').slice(0, 100).replace(/\n/g, ' ');
        const searchQuery = `${uniqueTechTerms.join(' ')} latest API compatibility constraints ${reqSnippet}`.slice(0, 200);
        console.error(`[Orchestrator] \uD83C\uDF10 Tech feasibility: searching for: "${searchQuery.slice(0, 80)}..."`);
        const searchResult = await webSearchHelper(this, searchQuery, {
          maxResults: 3,
          label: 'Tech Feasibility (Analyst)',
        });
        if (searchResult) {
          const feasibilityBlock = formatWebSearchBlock(searchResult, {
            title: 'Technical Feasibility Research',
            guidance: 'The following web search results provide latest technical constraints, API changes, and compatibility info. Use these to enrich the Open Questions and Risk sections of the requirement.',
          });
          // Optimization B: structured section header for LLM clarity
          clarResult.enrichedRequirement = `${clarResult.enrichedRequirement}\n\n## Context: Technical Feasibility Research\n${feasibilityBlock}`;
          console.error(`[Orchestrator] 🌐 Tech feasibility: ${searchResult.results.length} result(s) appended to enriched requirement.`);

          // ── ADR-30 P3: Persist ANALYSE search results to project knowledge base ──
          try {
            const knowledgePath = path.join(this._outputDir, 'analyse-search-knowledge.json');
            let existing = [];
            if (fs.existsSync(knowledgePath)) {
              try { existing = JSON.parse(fs.readFileSync(knowledgePath, 'utf-8')); } catch (_) { existing = []; }
            }
            const newEntry = {
              timestamp: new Date().toISOString(),
              query: searchQuery,
              techTerms: uniqueTechTerms,
              results: searchResult.results.map(r => ({
                title: r.title,
                url: r.url,
                snippet: (r.snippet || '').slice(0, 400),
              })),
              provider: searchResult.provider,
            };
            existing = existing.filter(e => e.query !== searchQuery);
            existing.push(newEntry);
            if (existing.length > 50) existing = existing.slice(-50);
            const tmpPath = knowledgePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2), 'utf-8');
            fs.renameSync(tmpPath, knowledgePath);
            console.error(`[Orchestrator] 💾 ANALYSE search results persisted (${existing.length} total entries).`);
          } catch (persistErr) {
            console.warn(`[Orchestrator] ⚠️  Failed to persist ANALYSE search results (non-fatal): ${persistErr.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[Orchestrator] \uD83C\uDF10 Tech feasibility web search failed (non-fatal): ${err.message}`);
    }
  }

  if (!clarResult.skipped && clarResult.rounds > 0) {
    console.error(`[Orchestrator] ✅ Requirement clarified in ${clarResult.rounds} round(s). Proceeding to analysis.`);
  }

  if (clarResult.qualityMetrics && this.obs) {
    this.obs.recordClarificationQuality(clarResult.qualityMetrics, clarResult.rounds);
  }

  // ── P0-1: Inject Code Graph seed information for Module Map generation ────
  // Instead of letting the LLM guess module boundaries from scratch, we provide
  // the real directory-level structure from the Code Graph. This gives the
  // AnalystAgent concrete, grounded data to base its Functional Module Map on.
  try {
    if (this.codeGraph && typeof this.codeGraph.getModuleSummaryMarkdown === 'function') {
      const moduleSeedInfo = this.codeGraph.getModuleSummaryMarkdown({ maxDirs: 15 });
      if (moduleSeedInfo && moduleSeedInfo.length > 0) {
        // Optimization B: structured section header for LLM clarity
        clarResult.enrichedRequirement = `${clarResult.enrichedRequirement}\n\n## Context: Codebase Module Structure\n${moduleSeedInfo}`;
        console.error(`[Orchestrator] 🗺️  Code Graph seed info injected into AnalystAgent (${moduleSeedInfo.length} chars). Module Map will be grounded in real codebase structure.`);
      } else {
        console.error(`[Orchestrator] 🗺️  Code Graph has no module summary (new project or single-directory). Module Map will be generated from scratch.`);
      }
    }
  } catch (seedErr) {
    console.warn(`[Orchestrator] ⚠️  Code Graph seed injection failed (non-fatal): ${seedErr.message}`);
  }

  // ── P1 fix: Inject Experience for ANALYSE stage (was completely missing) ───
  // The ANALYSE stage now learns from past requirement analysis experiences,
  // enabling better clarification questions and risk identification over time.
  let analystInjectedExpIds = [];
  try {
    if (this.experienceStore && typeof this.experienceStore.getContextBlockWithIds === 'function') {
      const maxExpInjected = this._adaptiveStrategy?.maxExpInjected ?? 5;
      const { block: expBlock, ids: expIds } = await this.experienceStore.getContextBlockWithIds(
        'requirement-analysis',
        rawRequirement || '',
        maxExpInjected,
      );
      analystInjectedExpIds = expIds || [];
      if (expBlock && expBlock.trim().length > 0) {
        // Optimization B: structured section header for LLM clarity
        clarResult.enrichedRequirement = `${clarResult.enrichedRequirement}\n\n## Context: Past Experience\n${expBlock}`;
        this.obs.recordExpUsage({ injected: analystInjectedExpIds.length });
        console.error(`[Orchestrator] 📚 ANALYSE experience injection: ${analystInjectedExpIds.length} experience(s) from ExperienceStore (keyword-scored + LLM-expanded)`);
      }
    }
  } catch (expErr) {
    console.warn(`[Orchestrator] ⚠️  ANALYSE experience injection failed (non-fatal): ${expErr.message}`);
  }

  // L3: Inject structured session memory (cross-session continuity, low token cost)
  try {
    const { TaskHistory } = require('./task-history');
    const taskHistory = new TaskHistory();
    const sessionMemoryBlock = taskHistory.getSessionMemoryBlock(3);
    if (sessionMemoryBlock) {
      clarResult.enrichedRequirement = `${clarResult.enrichedRequirement}\n\n${sessionMemoryBlock}`;
      console.error(`[Orchestrator] 🧠 Session Memory injected for AnalystAgent (${sessionMemoryBlock.length} chars)`);
    }
  } catch (memErr) {
    if (process.env.DEBUG) {
      console.warn(`[Orchestrator] Session memory injection failed for ANALYSE (non-fatal): ${memErr.message}`);
    }
  }

  // ── Optimization F: Pre-assess complexity for conditional prompt injection ──
  // Use RequestTriage's rule engine (zero LLM calls, <1ms) to estimate complexity
  // BEFORE calling AnalystAgent.run(). This allows buildPrompt() to conditionally
  // skip verbose output format sections for simple tasks, saving ~500-800 tokens.
  let preComplexityLevel = 'moderate'; // safe default
  try {
    const triage = new RequestTriage();
    const triageResult = triage.triage(rawRequirement, { projectRoot: this._projectRoot });
    if (triageResult.score < 15) preComplexityLevel = 'simple';
    else if (triageResult.score < 40) preComplexityLevel = 'moderate';
    else preComplexityLevel = 'complex';
    console.error(`[Orchestrator] ⚡ Pre-complexity assessment: ${preComplexityLevel} (score=${triageResult.score})`);
  } catch (triageErr) {
    console.warn(`[Orchestrator] ⚠️  Pre-complexity assessment failed (non-fatal): ${triageErr.message}`);
  }

  // Pass pre-assessed complexity to AnalystAgent so buildPrompt() can conditionally
  // trim verbose output format sections for simple tasks.
  this.agents[AgentRole.ANALYST]._preComplexityLevel = preComplexityLevel;

  const outputPath = await this.agents[AgentRole.ANALYST].run(null, clarResult.enrichedRequirement, null, this.handoffLog);

  // ── P0-FIX: Validate ANALYST output is not empty ─────────────────────────
  // If the LLM wrote an empty file (0 bytes or only whitespace), the downstream
  // ARCHITECT Agent will receive garbage input. Detect this early and retry once
  // with an explicit "your output was empty" hint before giving up.
  if (outputPath && fs.existsSync(outputPath)) {
    const outputContent = fs.readFileSync(outputPath, 'utf-8').trim();
    if (outputContent.length === 0) {
      console.warn(`[Orchestrator] ⚠️  ANALYST produced an empty file. Retrying once with explicit hint...`);
      this.stateMachine.recordRisk('medium', '[ANALYST] First attempt produced empty output. Retrying.');
      const retryHint = `[IMPORTANT: Your previous output was EMPTY. You MUST produce a complete requirements analysis document. Do not output an empty file.]\n\n${clarResult.enrichedRequirement}`;
      const retryOutputPath = await this.agents[AgentRole.ANALYST].run(null, retryHint, null, this.handoffLog);
      if (retryOutputPath && fs.existsSync(retryOutputPath)) {
        const retryContent = fs.readFileSync(retryOutputPath, 'utf-8').trim();
        if (retryContent.length > 0) {
          console.error(`[Orchestrator] ✅ ANALYST retry succeeded (${retryContent.length} chars).`);
          // Use the retry output path for the rest of the stage
          return await _finalizeAnalyst.call(this, retryOutputPath, clarResult, analystInjectedExpIds);
        }
      }
      throw new Error('[ANALYST] Agent produced empty output on both attempts. Cannot proceed.');
    }
  }

  // ── Finalize ANALYST stage (extracted for retry reuse) ──────────────────
  return await _finalizeAnalyst.call(this, outputPath, clarResult, analystInjectedExpIds);
}

/**
 * Extracted finalization logic for the ANALYST stage.
 * Called from _runAnalyst after Agent.run() succeeds (or after a retry).
 * Handles: storeAnalyseContext, EvoMap feedback, Prompt A/B, complexity estimation,
 * bus.publish (with ContractViolationError retry), and i18n translation.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @param {string} outputPath - Path to the generated requirements.md
 * @param {object} clarResult - Result from RequirementClarifier
 * @param {string[]} analystInjectedExpIds - Experience IDs injected into the prompt
 * @returns {Promise<string>} outputPath
 */
async function _finalizeAnalyst(outputPath, clarResult, analystInjectedExpIds) {
  const analyseCtx = await storeAnalyseContext(this, outputPath, clarResult);

  // ── P0 traceability: build requirement → acceptance criteria matrix artifact ──
  let traceabilityMeta = null;

  // ── P1 fix: EvoMap feedback loop for ANALYSE stage (was completely missing) ───
  // When the requirement analysis completes successfully, we close the learning loop.
  // This enables the ANALYSE stage to learn from successful requirement analyses.
  try {
    let analyseContent = '';
    if (outputPath && fs.existsSync(outputPath)) {
      analyseContent = fs.readFileSync(outputPath, 'utf-8');
    }

    const traceability = _writeRequirementTraceability(this._outputDir, analyseContent);
    if (traceability) {
      traceabilityMeta = {
        requirementCount: traceability.stats?.requirementCount || 0,
        acceptanceCriteriaCount: traceability.stats?.acceptanceCriteriaCount || 0,
        file: 'requirement-traceability.json',
      };
      console.error(`[Orchestrator] 🔗 Requirement traceability generated: ${traceabilityMeta.requirementCount} REQ, ${traceabilityMeta.acceptanceCriteriaCount} AC.`);
    }

    await runEvoMapFeedback(this, {
      injectedExpIds: analystInjectedExpIds,
      errorContext: analyseContent,
      stageLabel: 'ANALYSE',
    });

    // ── Agent Self-Report: extract self-report from ANALYST output ──
    recordSelfReport('ANALYSE', analyseContent, { agentRole: AgentRole.ANALYST });

    // ── Metrics Quality Gate: validate ANALYSE stage runtime metrics ──────
    // Non-blocking: records threshold violations as risks, does not abort pipeline.
    const analyseDurationMs = (this.obs && typeof this.obs.getTotalDurationMs === 'function')
      ? this.obs.getTotalDurationMs()
      : 0;
    const analyseLlmCalls = (this.obs && this.obs._llmCallCount) ? this.obs._llmCallCount : 0;
    runStageMetricsGate(this, {
      stageName: 'ANALYSE',
      durationMs: analyseDurationMs,
      errorCount: 0,
      llmCalls: analyseLlmCalls,
    });
  } catch (evoErr) {
    console.warn(`[Orchestrator] ⚠️  EvoMap feedback failed for ANALYSE stage (non-fatal): ${evoErr.message}`);
  }

  // ── Prompt A/B: record analyst outcome ──────────────────────────────────
  _recordPromptABOutcome('analyst', true, clarResult.rounds ?? 0);

  // ── Defect J fix: Estimate task complexity from the enriched requirement ───
  if (this.obs) {
    const requirementText = clarResult.enrichedRequirement || '';
    const complexity = Observability.estimateTaskComplexity(requirementText);
    this.obs.recordTaskComplexity(complexity);

    if (this.stageCtx) {
      const existingAnalyse = this.stageCtx.get('ANALYSE') || {};
      this.stageCtx.set('ANALYSE', {
        ...existingAnalyse,
        meta: {
          ...(existingAnalyse.meta || {}),
          complexity,
          traceability: traceabilityMeta || (existingAnalyse.meta || {}).traceability || null,
        },
      });
    }

    console.error(`[Orchestrator] 📊 AEF Complexity Assessment: level=${complexity.level}, score=${complexity.score}`);
    if (complexity.level === 'simple') {
      console.error(`[Orchestrator] ⚡ AEF Fast-Path: Simple task detected — ARCHITECT stage will use streamlined review.`);
    } else if (complexity.level === 'moderate') {
      console.error(`[Orchestrator] ▶️  AEF Standard-Path: Moderate task detected — standard review flow.`);
    } else if (complexity.level === 'complex' || complexity.level === 'very_complex') {
      console.error(`[Orchestrator] 🔍 AEF Full-Path: ${complexity.level === 'very_complex' ? 'Very complex' : 'Complex'} task detected — enhanced review budgets will be applied.`);
    }

    const cfgAutoFix = (this._config && this._config.autoFixLoop) || {};
    const updatedStrategy = Observability.deriveStrategy(PATHS.OUTPUT_DIR, {
      maxFixRounds:    cfgAutoFix.maxFixRounds    ?? 2,
      maxReviewRounds: cfgAutoFix.maxReviewRounds ?? 2,
      maxExpInjected:  cfgAutoFix.maxExpInjected  ?? 5,
      projectId:       this.projectId,
      taskComplexity:  complexity,
    });
    if (updatedStrategy.maxFixRounds !== this._adaptiveStrategy.maxFixRounds ||
        updatedStrategy.maxReviewRounds !== this._adaptiveStrategy.maxReviewRounds) {
      console.error(`[Orchestrator] 📈 Adaptive strategy re-derived after ANALYSE (complexity=${complexity.level}, score=${complexity.score}):`);
      console.error(`[Orchestrator]    maxFixRounds: ${this._adaptiveStrategy.maxFixRounds} → ${updatedStrategy.maxFixRounds} | maxReviewRounds: ${this._adaptiveStrategy.maxReviewRounds} → ${updatedStrategy.maxReviewRounds}`);
      this._adaptiveStrategy = updatedStrategy;
    }

    // ── P1 Auto-Tier Routing ──
    if (this.llmRouter && typeof this.llmRouter.applyTierRouting === 'function') {
      const tierResult = this.llmRouter.applyTierRouting(complexity);
      if (tierResult.applied) {
        console.error(`[Orchestrator] 🎯 P1 Auto-Tier: ${tierResult.changes.length} role(s) re-routed based on complexity=${complexity.level}.`);
        if (this.stageCtx) {
          const existingAnalyseCtx = this.stageCtx.get('ANALYSE') || {};
          this.stageCtx.set('ANALYSE', {
            ...existingAnalyseCtx,
            meta: {
              ...(existingAnalyseCtx.meta || {}),
              tierRouting: { applied: true, complexity: complexity.level, changes: tierResult.changes },
            },
          });
        }
      }
    }
  }

  // ── Publish with ContractViolationError retry ─────────────────────────────
  // If the ANALYST output fails the ARCHITECT's content contract (e.g. too short,
  // missing required sections), catch the error and retry the Agent once.
  try {
    this.bus.publish(AgentRole.ANALYST, AgentRole.ARCHITECT, outputPath, {
      clarificationRounds: clarResult.rounds ?? 0,
      signalCount:         clarResult.allSignals?.length ?? 0,
      riskNotes:           clarResult.riskNotes ?? [],
      skipped:             clarResult.skipped ?? false,
      contextSummary:      analyseCtx.summary,
    });
  } catch (pubErr) {
    if (pubErr instanceof ContractViolationError) {
      console.warn(`[Orchestrator] ⚠️  ANALYST output failed contract: ${pubErr.contractReason}. Retrying Agent once...`);
      this.stateMachine.recordRisk('medium', `[ANALYST] Output failed contract validation: ${pubErr.contractReason}. Retrying.`);
      const retryHint = `[IMPORTANT: Your previous output failed quality validation: ${pubErr.contractReason}. Please produce a COMPLETE requirements analysis document with all required sections.]\n\n${clarResult.enrichedRequirement}`;
      const retryPath = await this.agents[AgentRole.ANALYST].run(null, retryHint, null, this.handoffLog);
      // Retry publish – if this also throws, let it propagate to the orchestrator
      this.bus.publish(AgentRole.ANALYST, AgentRole.ARCHITECT, retryPath, {
        clarificationRounds: clarResult.rounds ?? 0,
        signalCount:         clarResult.allSignals?.length ?? 0,
        riskNotes:           clarResult.riskNotes ?? [],
        skipped:             clarResult.skipped ?? false,
        contextSummary:      analyseCtx.summary,
        contractRetry:       true,
      });
      console.error(`[Orchestrator] ✅ ANALYST contract retry succeeded.`);
    } else {
      throw pubErr;
    }
  }

  // Generate Chinese companion file for developers (non-blocking)
  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  return outputPath;
}

module.exports = { _runAnalyst, _recordPromptABOutcome, _finalizeAnalyst };
