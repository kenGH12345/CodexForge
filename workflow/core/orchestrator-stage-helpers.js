/**
 * Orchestrator Stage Helpers — Thin Re-export Facade
 *
 * ARCHITECTURE REFACTOR: The original 1,800+ line monolith has been decomposed into
 * focused, independently testable modules:
 *
 *   ┌────────────────────────────────────┬────────────────────────────────────────┐
 *   │ Module                             │ Responsibility                         │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ context-budget-manager.js          │ Token budget, BLOCK_PRIORITY,          │
 *   │                                    │ web search cache/helpers,              │
 *   │                                    │ all MCP adapter helpers                │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ architect-context-builder.js       │ buildArchitectUpstreamCtx(),           │
 *   │                                    │ buildArchitectContextBlock()           │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ developer-context-builder.js       │ buildDeveloperUpstreamCtx(),           │
 *   │                                    │ buildDeveloperContextBlock()           │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ tester-context-builder.js          │ buildTesterUpstreamCtx(),              │
 *   │                                    │ buildTesterContextBlock()              │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ context-helpers.js                 │ _getContextProfile() shared utility    │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ orchestrator-stage-helpers.js      │ THIS FILE — stage context storage      │
 *   │ (facade)                           │ helpers + re-exports for backward      │
 *   │                                    │ compatibility                          │
 *   └────────────────────────────────────┴────────────────────────────────────────┘
 *
 * This facade re-exports ALL original symbols so that consumers
 * (e.g. orchestrator-stages.js) require NO import changes.
 */

'use strict';

const { StageContextStore } = require('./stage-context-store');
const { WorkflowState } = require('./types');

// ─── Re-exports from sub-modules ─────────────────────────────────────────────

const {
  STAGE_TOKEN_BUDGET_CHARS,
  BLOCK_PRIORITY,
  _applyTokenBudget,
  webSearchHelper,
  formatWebSearchBlock,
  externalExperienceFallback,
  enrichSkillFromExternalKnowledge,
  preheatExperienceStore,
  packageRegistryHelper,
  securityCVEHelper,
  ciStatusHelper,
  licenseComplianceHelper,
  docGenHelper,
  llmCostRouterHelper,
  figmaDesignHelper,
  testInfraHelper,
  codeQualityHelper,
  formatCodeQualityBlock,
} = require('./context-budget-manager');

const { buildArchitectUpstreamCtx, buildArchitectContextBlock } = require('./architect-context-builder');
const { buildDeveloperUpstreamCtx, buildDeveloperContextBlock } = require('./developer-context-builder');
const { buildTesterUpstreamCtx, buildTesterContextBlock }       = require('./tester-context-builder');

// ─── Stage context storage helpers (owned by this module) ────────────────────

/**
 * Defect E fix: Distils a raw correction history array into a compact,
 * token-efficient format suitable for injection into downstream agent prompts.
 *
 * @param {object[]} rawHistory
 * @returns {{ round: number, issuesFixed: string[], source?: string }[]}
 */
function _extractCorrectionHistory(rawHistory) {
  if (!Array.isArray(rawHistory) || rawHistory.length === 0) return [];

  return rawHistory.map(h => {
    const entry = { round: h.round };

    if (Array.isArray(h.failures) && h.failures.length > 0) {
      entry.issuesFixed = h.failures
        .slice(0, 3)
        .map(f => f.finding ? f.finding.slice(0, 120) : (f.id || 'unknown issue'));
    }
    else if (Array.isArray(h.signals) && h.signals.length > 0) {
      entry.issuesFixed = h.signals
        .slice(0, 3)
        .map(s => s.label ? `[${s.severity || 'medium'}] ${s.label.slice(0, 100)}` : 'signal resolved');
    }
    else {
      entry.issuesFixed = [];
    }

    if (h.source) entry.source = h.source;

    return entry;
  });
}

/**
 * Stores ANALYSE stage context for downstream stage consumption.
 *
 * @param {Orchestrator} orch
 * @param {string} outputPath
 * @param {object} clarResult
 */
function storeAnalyseContext(orch, outputPath, clarResult) {
  if (!orch.stageCtx) throw new Error('[storeAnalyseContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.ANALYSE);

  // ── Extract Functional Module Map from JSON block ────────────────────────
  // P1-ModuleMap: If the analyst output contains a structured moduleMap in
  // the JSON block, extract it and store it in meta for downstream consumption.
  // The ARCHITECT stage reads this to enable module-aware architecture design.
  let moduleMap = null;
  if (ctx.jsonBlock && ctx.jsonBlock.moduleMap) {
    const mm = ctx.jsonBlock.moduleMap;
    if (Array.isArray(mm.modules) && mm.modules.length > 0) {
      moduleMap = {
        modules: mm.modules.filter(m => m.id && m.name).map(m => ({
          id:           m.id,
          name:         m.name,
          description:  m.description || '',
          boundaries:   Array.isArray(m.boundaries) ? m.boundaries : [],
          dependencies: Array.isArray(m.dependencies) ? m.dependencies : [],
          complexity:   m.complexity || 'medium',
          isolatable:   Boolean(m.isolatable),
        })),
        crossCuttingConcerns: Array.isArray(mm.crossCuttingConcerns) ? mm.crossCuttingConcerns : [],
      };

      // P1-D: Auto-calculate isolatable field based on dependency graph.
      // A module is isolatable if:
      //   1. It has zero in-map dependencies (leaf module), OR
      //   2. All its in-map dependencies are themselves isolatable (transitive leaf)
      // AND it has no circular dependencies with other modules.
      // This replaces the unreliable LLM-annotated isolatable field.
      const moduleIds = new Set(moduleMap.modules.map(m => m.id));
      const depGraph = new Map(moduleMap.modules.map(m => [m.id, (m.dependencies || []).filter(d => moduleIds.has(d))]));

      // Detect circular dependencies
      const circularModules = new Set();
      for (const [modId, deps] of depGraph) {
        for (const dep of deps) {
          const depDeps = depGraph.get(dep) || [];
          if (depDeps.includes(modId)) {
            circularModules.add(modId);
            circularModules.add(dep);
          }
        }
      }

      // Compute isolatable: leaf modules first, then propagate
      const isolatableSet = new Set();
      let changed = true;
      while (changed) {
        changed = false;
        for (const mod of moduleMap.modules) {
          if (isolatableSet.has(mod.id)) continue;
          if (circularModules.has(mod.id)) continue;
          const inMapDeps = depGraph.get(mod.id) || [];
          if (inMapDeps.length === 0 || inMapDeps.every(d => isolatableSet.has(d))) {
            isolatableSet.add(mod.id);
            changed = true;
          }
        }
      }

      // Apply auto-calculated isolatable (overrides LLM annotation)
      for (const mod of moduleMap.modules) {
        const wasIsolatable = mod.isolatable;
        mod.isolatable = isolatableSet.has(mod.id);
        if (wasIsolatable !== mod.isolatable) {
          console.log(`[Orchestrator] 🔄 Module "${mod.id}" isolatable: ${wasIsolatable} → ${mod.isolatable} (auto-calculated from dependency graph)`);
        }
      }
      console.log(`[Orchestrator] 🗺️  Module Map extracted: ${moduleMap.modules.length} module(s), ${moduleMap.crossCuttingConcerns.length} cross-cutting concern(s).`);
    }
  }

  orch.stageCtx.set(WorkflowState.ANALYSE, {
    summary:      ctx.summary,
    keyDecisions: ctx.keyDecisions,
    artifacts:    [outputPath],
    risks:        clarResult.riskNotes ?? [],
    meta: {
      clarificationRounds: clarResult.rounds ?? 0,
      signalCount:         clarResult.allSignals?.length ?? 0,
      skipped:             clarResult.skipped ?? false,
      moduleMap,
    },
  });
  const mmMsg = moduleMap ? `, ${moduleMap.modules.length} module(s) mapped` : '';
  console.log(`[Orchestrator] 🔗 ANALYSE context stored: ${ctx.keyDecisions.length} key decision(s)${mmMsg}.`);
  return ctx;
}

/**
 * Stores ARCHITECT stage context.
 *
 * @param {Orchestrator} orch
 * @param {string} outputPath
 * @param {object} archReviewResult
 * @param {object} coverageResult
 * @param {object} [opts]
 * @param {object|null} [opts.moduleSplitMeta] - P2: metadata from module-split architecture design
 * @returns {{ summary: string, keyDecisions: string[] }}
 */
function storeArchitectContext(orch, outputPath, archReviewResult, coverageResult, opts = {}) {
  if (!orch.stageCtx) throw new Error('[storeArchitectContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.ARCHITECT);

  const correctionHistory = _extractCorrectionHistory(archReviewResult.history);
  const moduleSplitMeta = opts.moduleSplitMeta || null;

  orch.stageCtx.set(WorkflowState.ARCHITECT, {
    summary:           ctx.summary,
    keyDecisions:      ctx.keyDecisions,
    artifacts:         [outputPath],
    risks:             archReviewResult.riskNotes ?? [],
    correctionHistory,
    meta: {
      reviewRounds: archReviewResult.rounds ?? 0,
      failedItems:  archReviewResult.failed ?? 0,
      coverageRate: coverageResult.coverageRate ?? null,
      moduleSplit:  moduleSplitMeta,
    },
  });
  const corrMsg = correctionHistory.length > 0 ? `, ${correctionHistory.length} correction round(s)` : '';
  const msMsg = moduleSplitMeta ? `, module-split (${moduleSplitMeta.moduleCount} modules)` : '';
  console.log(`[Orchestrator] 🔗 ARCHITECT context stored: ${ctx.keyDecisions.length} key decision(s), ${archReviewResult.riskNotes?.length ?? 0} risk(s)${corrMsg}${msMsg}.`);
  return ctx;
}

/**
 * Stores PLAN stage context for downstream stage consumption.
 *
 * @param {Orchestrator} orch
 * @param {string} outputPath
 * @returns {{ summary: string, keyDecisions: string[], taskCount: number }}
 */
function storePlannerContext(orch, outputPath) {
  if (!orch.stageCtx) throw new Error('[storePlannerContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.PLAN);

  // Extract task count from the plan content
  let taskCount = 0;
  let moduleGrouping = null;
  try {
    const fs = require('fs');
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8');
      const taskMatches = content.match(/#### Task T-/g);
      taskCount = taskMatches ? taskMatches.length : 0;
    }
  } catch (_) { /* non-fatal */ }

  // Extract moduleGrouping from JSON block (Phase 2.5A)
  try {
    const { extractJsonBlock } = require('./agent-output-schema');
    const fs = require('fs');
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8');
      const jsonBlock = extractJsonBlock(content);
      if (jsonBlock && jsonBlock.moduleGrouping) {
        const mg = jsonBlock.moduleGrouping;
        if (Array.isArray(mg.groups) && mg.groups.length > 0) {
          moduleGrouping = {
            groups: mg.groups.filter(g => g.moduleId && g.moduleName).map(g => ({
              moduleId:   g.moduleId,
              moduleName: g.moduleName,
              taskIds:    Array.isArray(g.taskIds) ? g.taskIds : [],
            })),
            crossModuleTasks: Array.isArray(mg.crossModuleTasks) ? mg.crossModuleTasks : [],
          };
          console.log(`[Orchestrator] 📦 Module-Task Grouping extracted: ${moduleGrouping.groups.length} group(s), ${moduleGrouping.crossModuleTasks.length} cross-module task(s).`);
        }
      }
    }
  } catch (_) { /* non-fatal */ }

  orch.stageCtx.set(WorkflowState.PLAN, {
    summary:      ctx.summary,
    keyDecisions: ctx.keyDecisions,
    artifacts:    [outputPath],
    risks:        [],
    meta: {
      taskCount,
      moduleGrouping,
    },
  });
  const mgMsg = moduleGrouping ? `, ${moduleGrouping.groups.length} module group(s)` : '';
  console.log(`[Orchestrator] 🔗 PLAN context stored: ${ctx.keyDecisions.length} key decision(s), ${taskCount} task(s)${mgMsg}.`);
  return { ...ctx, taskCount, moduleGrouping };
}

/**
 * Stores CODE stage context.
 *
 * @param {Orchestrator} orch
 * @param {string} outputPath
 * @param {object} reviewResult
 * @returns {{ summary: string, keyDecisions: string[] }}
 */
function storeCodeContext(orch, outputPath, reviewResult) {
  if (!orch.stageCtx) throw new Error('[storeCodeContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.CODE);

  const correctionHistory = _extractCorrectionHistory(reviewResult.history);

  orch.stageCtx.set(WorkflowState.CODE, {
    summary:           ctx.summary,
    keyDecisions:      ctx.keyDecisions,
    artifacts:         [outputPath],
    risks:             reviewResult.riskNotes ?? [],
    correctionHistory,
    meta: {
      reviewRounds: reviewResult.rounds ?? 0,
      failedItems:  reviewResult.failed ?? 0,
    },
  });
  const corrMsg = correctionHistory.length > 0 ? `, ${correctionHistory.length} correction round(s)` : '';
  console.log(`[Orchestrator] 🔗 CODE context stored: ${ctx.keyDecisions.length} key decision(s), ${reviewResult.riskNotes?.length ?? 0} risk(s)${corrMsg}.`);
  return ctx;
}

/**
 * Stores TEST stage context (merges _pendingTestMeta).
 *
 * @param {Orchestrator} orch
 * @param {string} outputPath
 * @param {object} tcGenResult
 * @param {object|null} tcExecutionReport
 * @param {object|null} [corrResult]
 */
function storeTestContext(orch, outputPath, tcGenResult, tcExecutionReport, corrResult = null) {
  if (!orch.stageCtx) throw new Error('[storeTestContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.TEST);
  const pendingMeta = orch._pendingTestMeta || {};

  const correctionHistory = _extractCorrectionHistory(corrResult?.history || []);

  orch.stageCtx.set(WorkflowState.TEST, {
    summary:           ctx.summary,
    keyDecisions:      ctx.keyDecisions,
    artifacts:         [outputPath],
    risks:             [],
    correctionHistory,
    meta: {
      ...pendingMeta,
      tcGenerated: tcGenResult.caseCount ?? 0,
      tcExecuted:  tcExecutionReport ? (tcExecutionReport.automatedTotal ?? 0) : 0,
      tcPassed:    tcExecutionReport ? (tcExecutionReport.passed ?? 0) : 0,
    },
  });
  orch._pendingTestMeta = null;
  const corrMsg = correctionHistory.length > 0 ? `, ${correctionHistory.length} correction round(s)` : '';
  console.log(`[Orchestrator] 🔗 TEST context stored: ${ctx.keyDecisions.length} key decision(s)${corrMsg}.`);
}

// ─── Module exports (backward-compatible with original monolith) ─────────────

module.exports = {
  // Upstream context builders (from sub-modules)
  buildArchitectUpstreamCtx,
  buildDeveloperUpstreamCtx,
  buildTesterUpstreamCtx,
  // Agent context block assemblers (from sub-modules)
  buildArchitectContextBlock,
  buildDeveloperContextBlock,
  buildTesterContextBlock,
  // Stage context storage helpers (owned by this module)
  storeAnalyseContext,
  storeArchitectContext,
  storePlannerContext,
  storeCodeContext,
  storeTestContext,
  // Web search utilities (from context-budget-manager)
  webSearchHelper,
  formatWebSearchBlock,
  // Package registry + security CVE utilities (from context-budget-manager)
  packageRegistryHelper,
  securityCVEHelper,
  // Code quality utilities (from context-budget-manager)
  codeQualityHelper,
  formatCodeQualityBlock,
  // CI status utilities (from context-budget-manager)
  ciStatusHelper,
  // License compliance utilities (from context-budget-manager)
  licenseComplianceHelper,
  // DocGen utilities (from context-budget-manager)
  docGenHelper,
  // LLM cost router utilities (from context-budget-manager)
  llmCostRouterHelper,
  // Test infra utilities (from context-budget-manager)
  testInfraHelper,
  // Figma design utilities (from context-budget-manager)
  figmaDesignHelper,
  // External experience fallback (from context-budget-manager)
  externalExperienceFallback,
  // External knowledge → Skill enrichment (from context-budget-manager, ADR-29)
  enrichSkillFromExternalKnowledge,
  // Experience Store cold-start preheating (from context-budget-manager, ADR-30)
  preheatExperienceStore,
};
