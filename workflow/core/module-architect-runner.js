/**
 * Module-Aware Architect Runner
 *
 * Phase 2 of the Module Map architecture upgrade.
 *
 * When the ANALYSE stage produces a moduleMap with ≥2 isolatable modules,
 * this runner splits the single ARCHITECT call into N focused calls:
 *
 *   Module Map: [A, B, C]
 *     → ARCHITECT Call 1: Design module A (full focus)
 *     → ARCHITECT Call 2: Design module B (injected: A's interface contracts)
 *     → ARCHITECT Call 3: Design module C (injected: A+B's interface contracts)
 *     → Merge: Combine into unified architecture.md
 *
 * Benefits:
 *   - Each call has a smaller, more focused context (reduces attention decay)
 *   - Modules are designed with explicit interface contracts between them
 *   - Cross-cutting concerns are addressed in a final integration pass
 *   - Naturally avoids interface conflicts (serial with contract injection)
 *
 * Fallback: If module count is 1 or no isolatable modules exist, returns null
 * and the caller falls back to standard single-pass ArchitectAgent.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./constants');
const { AgentRole } = require('./types');
const { buildJsonBlockInstruction } = require('./agent-output-schema');

// ─── Constants ───────────────────────────────────────────────────────────────

/** Minimum number of isolatable modules required to trigger module-split mode */
const MIN_ISOLATABLE_FOR_SPLIT = 2;

/** Maximum number of modules to design in split mode (safety cap) */
const MAX_MODULES_SPLIT = 6;

// ─── Module-focused prompt builder ──────────────────────────────────────────

/**
 * Builds a focused prompt for designing a single module's architecture.
 *
 * @param {string} requirementContent - Full requirement document content
 * @param {object} focusModule - The module to design { id, name, description, boundaries, dependencies, complexity, isolatable }
 * @param {object[]} allModules - All modules in the map (for context)
 * @param {string[]} crossCuttingConcerns - Cross-cutting concerns
 * @param {string[]} upstreamContracts - Interface contracts from previously designed modules
 * @param {string|null} expContext - Experience context
 * @returns {string}
 */
function buildModuleFocusedPrompt(requirementContent, focusModule, allModules, crossCuttingConcerns, upstreamContracts, expContext = null) {
  const expSection = expContext
    ? `\n## Accumulated Experience (Reference Before Designing)\n${expContext}\n`
    : '';

  const otherModules = allModules.filter(m => m.id !== focusModule.id);
  const depModules = otherModules.filter(m => focusModule.dependencies.includes(m.id));
  const dependentOnMe = otherModules.filter(m => m.dependencies.includes(focusModule.id));

  const otherModulesList = otherModules.map(m =>
    `- **${m.id}** (${m.name}): ${m.description} [complexity: ${m.complexity}]`
  ).join('\n');

  const depList = depModules.length > 0
    ? depModules.map(m => `- **${m.id}** (${m.name}): ${m.description}`).join('\n')
    : '(none)';

  const dependentList = dependentOnMe.length > 0
    ? dependentOnMe.map(m => `- **${m.id}** (${m.name}): ${m.description}`).join('\n')
    : '(none)';

  const upstreamContractsSection = upstreamContracts.length > 0
    ? `\n## Upstream Module Interface Contracts (MUST RESPECT)\nThe following interface contracts have been defined by previously designed modules. Your design MUST be compatible with these contracts.\n\n${upstreamContracts.join('\n\n---\n\n')}\n`
    : '';

  const crossCuttingSection = crossCuttingConcerns.length > 0
    ? `\n**Cross-cutting concerns** (handled at integration level, NOT in your module): ${crossCuttingConcerns.join(', ')}\n> Do not design internal implementations for these. Only specify what your module needs from them (e.g. "needs logging via ILogger interface").`
    : '';

  const jsonInstruction = buildJsonBlockInstruction('architect');

  return `You are **Martin Fowler** – Chief Scientist at ThoughtWorks, author of *Patterns of Enterprise Application Architecture*.
You are designing the architecture for a **single module** within a larger system. Other modules are being designed separately.

## Your Assignment: Module "${focusModule.name}" (${focusModule.id})
- **Description**: ${focusModule.description}
- **File boundaries**: ${(focusModule.boundaries || []).join(', ') || 'N/A'}
- **Complexity**: ${focusModule.complexity}
- **Dependencies** (modules I depend on):
${depList}
- **Dependents** (modules that depend on me):
${dependentList}

## Module Map Context (Other Modules)
These modules exist in the system but are NOT your responsibility. You only need to define interface contracts with modules you depend on or that depend on you.
${otherModulesList}
${crossCuttingSection}

## Boundary Rules (CRITICAL)
1. **ONLY** design the internal architecture of module "${focusModule.name}" (${focusModule.id}).
2. **DO NOT** design the internal architecture of any other module.
3. **DO** define explicit Interface Contracts for every dependency edge:
   - For modules you depend on: specify what you NEED from them (function signatures, data structures, events).
   - For modules that depend on you: specify what you PROVIDE to them (exported interfaces, data contracts).
4. If you discover a need that crosses module boundaries, note it as "Cross-Module Concern" — do NOT attempt to solve it.

## Output Format
Produce a Markdown document with these sections:
1. **Module Overview** – What this module does, its core responsibility
2. **Internal Component Breakdown** – Components WITHIN this module
3. **Internal Data Flow** – How data moves within this module
4. **Technology Choices** – Technology decisions specific to this module (with justification)
5. **Interface Contracts** *(CRITICAL)* – For EACH dependency edge:
   - Provide: function signatures / API endpoints / event schemas / data structures
   - Direction: who calls whom, data flow direction
   - Error handling: what errors can propagate across the boundary
6. **Non-Functional Considerations** – Performance, security, scalability for THIS module
7. **Risks & Open Questions** – Technical risks specific to this module
8. **Architecture Decisions** *(mandatory)* – Key architectural decisions made for this module and WHY
9. **Execution Plan** *(mandatory)* – Implementation order for components within this module

${jsonInstruction}
${upstreamContractsSection}

## Requirement Document (Full)
${requirementContent}
${expSection}

## Codebase Research Rules (CRITICAL)
- Focus your research on files within this module's boundaries: ${(focusModule.boundaries || []).join(', ') || 'the relevant directory'}
- **Search budget**: at most 6 file searches and 4 file reads. Stop once you have enough context.
- Do NOT search files belonging to other modules unless checking an interface boundary.

## Output Language
**You MUST write the entire document in Chinese (简体中文).** Only keep technical terms, proper nouns, file names, code identifiers in English.

## Instructions
First output the JSON metadata block, then write the full Markdown document.
Remember: Design ONLY module "${focusModule.name}". NO code, NO implementation. Interface Contracts are your #1 priority.
**CRITICAL**: Sections 8 (Architecture Decisions) and 9 (Execution Plan) are MANDATORY.`;
}

// ─── Interface contract extractor ───────────────────────────────────────────

/**
 * Extracts interface contract sections from a module architecture output.
 *
 * @param {string} moduleOutput - The full markdown output for a module
 * @param {string} moduleId - The module ID
 * @param {string} moduleName - The module name
 * @returns {string} Formatted interface contract block
 */
function extractInterfaceContracts(moduleOutput, moduleId, moduleName) {
  // Try to find the Interface Contracts section
  const contractPatterns = [
    /#{1,3}\s*(?:\d+\.\s*)?Interface Contracts?\s*[\s\S]*?(?=\n#{1,3}\s|\n---|\Z)/i,
    /#{1,3}\s*(?:\d+\.\s*)?接口(?:契约|合约|定义|协议)\s*[\s\S]*?(?=\n#{1,3}\s|\n---|\Z)/i,
  ];

  let contractSection = '';
  for (const pattern of contractPatterns) {
    const match = moduleOutput.match(pattern);
    if (match) {
      contractSection = match[0].trim();
      break;
    }
  }

  if (!contractSection) {
    // Fallback: try to extract any function signatures or API definitions
    const sigPatterns = [
      /```[\w]*\n[\s\S]*?(?:function|interface|class|type|export|def|fn)\s[\s\S]*?```/g,
      /`[^`]+\([^)]*\)[^`]*`/g,
    ];
    const sigs = [];
    for (const p of sigPatterns) {
      const matches = moduleOutput.match(p);
      if (matches) sigs.push(...matches.slice(0, 5));
    }
    contractSection = sigs.length > 0
      ? `Interface signatures found:\n${sigs.join('\n')}`
      : '(No explicit interface contracts extracted)';
  }

  return `### Module: ${moduleName} (${moduleId})\n\n${contractSection}`;
}

// ─── Merge function ─────────────────────────────────────────────────────────

/**
 * Merges multiple module architecture outputs into a unified architecture.md
 *
 * @param {object[]} moduleResults - Array of { moduleId, moduleName, output, contracts }
 * @param {string[]} crossCuttingConcerns - Cross-cutting concerns
 * @param {string} requirementContent - Original requirement for context
 * @returns {string} Merged architecture document
 */
function mergeModuleArchitectures(moduleResults, crossCuttingConcerns, requirementContent) {
  const lines = [];

  lines.push(`# Architecture Design Document`);
  lines.push(``);
  lines.push(`> Generated via Module-Aware Architecture Design (Phase 2)`);
  lines.push(`> ${moduleResults.length} module(s) designed with explicit interface contracts`);
  lines.push(``);

  // ── 1. Architecture Overview ──────────────────────────────────────────────
  lines.push(`## 1. Architecture Overview`);
  lines.push(``);
  lines.push(`This architecture is decomposed into ${moduleResults.length} functional modules:`);
  lines.push(``);
  lines.push(`| Module | Responsibility | Complexity |`);
  lines.push(`|--------|---------------|------------|`);
  for (const r of moduleResults) {
    lines.push(`| **${r.moduleName}** (${r.moduleId}) | See module section below | ${r.complexity || 'medium'} |`);
  }
  lines.push(``);

  if (crossCuttingConcerns.length > 0) {
    lines.push(`### Cross-Cutting Concerns`);
    lines.push(``);
    lines.push(`The following concerns span multiple modules and should be addressed at the system level:`);
    for (const c of crossCuttingConcerns) {
      lines.push(`- **${c}**`);
    }
    lines.push(``);
  }

  // ── 2. Interface Contracts (Cross-Module) ─────────────────────────────────
  lines.push(`## 2. Interface Contracts (Cross-Module)`);
  lines.push(``);
  lines.push(`> These contracts define the boundaries between modules. They are the #1 architectural artifact.`);
  lines.push(``);
  for (const r of moduleResults) {
    if (r.contracts) {
      lines.push(r.contracts);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }
  }

  // ── 3. Per-Module Architecture ────────────────────────────────────────────
  for (let i = 0; i < moduleResults.length; i++) {
    const r = moduleResults[i];
    lines.push(`## ${i + 3}. Module: ${r.moduleName} (${r.moduleId})`);
    lines.push(``);
    lines.push(r.output);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  // ── N. Architecture Design (mandatory section marker) ─────────────────────
  lines.push(`## Architecture Design`);
  lines.push(``);
  lines.push(`This architecture uses a module-decomposed design approach:`);
  for (const r of moduleResults) {
    lines.push(`- **${r.moduleName}** (${r.moduleId}): Independently designed with explicit interface contracts`);
  }
  lines.push(``);

  // ── N+1. Execution Plan (mandatory section marker) ────────────────────────
  lines.push(`## Execution Plan`);
  lines.push(``);
  lines.push(`Recommended implementation order (high-complexity modules first):`);
  const sorted = [...moduleResults].sort((a, b) => {
    const complexityOrder = { high: 0, medium: 1, low: 2 };
    return (complexityOrder[a.complexity] || 1) - (complexityOrder[b.complexity] || 1);
  });
  sorted.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.moduleName}** (${r.moduleId}) — complexity: ${r.complexity || 'medium'}`);
  });
  lines.push(``);

  return lines.join('\n');
}

// ─── Main runner ────────────────────────────────────────────────────────────

/**
 * Determines whether module-split architecture design should be used,
 * and if so, executes the module-by-module serial design pipeline.
 *
 * @param {object} orch - Orchestrator instance (bound as `this` in _runArchitect)
 * @param {string} requirementContent - Content of requirement.md
 * @param {string|null} expContext - Experience context (from buildArchitectContextBlock)
 * @param {object} opts
 * @param {string} opts.inputPath - Path to requirement.md
 * @param {string} opts.outputPath - Path where architecture.md should be written
 * @returns {Promise<{ used: boolean, outputPath?: string, moduleCount?: number, meta?: object }>}
 */
async function runModuleAwareArchitect(orch, requirementContent, expContext, opts = {}) {
  // ── 1. Check if module-split is applicable ────────────────────────────────
  const analyseCtx = orch.stageCtx?.get('ANALYSE');
  const moduleMap = analyseCtx?.meta?.moduleMap;

  if (!moduleMap || !Array.isArray(moduleMap.modules) || moduleMap.modules.length < MIN_ISOLATABLE_FOR_SPLIT) {
    console.log(`[ModuleArchitect] Module map absent or < ${MIN_ISOLATABLE_FOR_SPLIT} modules. Using standard single-pass design.`);
    return { used: false };
  }

  const isolatableModules = moduleMap.modules.filter(m => m.isolatable);
  if (isolatableModules.length < MIN_ISOLATABLE_FOR_SPLIT) {
    console.log(`[ModuleArchitect] Only ${isolatableModules.length} isolatable module(s). Using standard single-pass design.`);
    return { used: false };
  }

  // Cap module count to avoid excessive LLM calls
  const modulesToDesign = moduleMap.modules.slice(0, MAX_MODULES_SPLIT);
  const crossCutting = moduleMap.crossCuttingConcerns || [];

  console.log(`\n[ModuleArchitect] ════════════════════════════════════════════════════`);
  console.log(`[ModuleArchitect]   Module-Aware Architecture Design (Phase 2)`);
  console.log(`[ModuleArchitect]   ${modulesToDesign.length} module(s) to design, ${crossCutting.length} cross-cutting concern(s)`);
  console.log(`[ModuleArchitect]   Mode: Serial with interface contract propagation`);
  console.log(`[ModuleArchitect] ════════════════════════════════════════════════════\n`);

  // ── 2. Sort modules by dependency order ───────────────────────────────────
  // Modules with fewer dependencies go first (leaf modules before dependents)
  const sortedModules = _topologicalSort(modulesToDesign);

  const moduleResults = [];
  const upstreamContracts = [];
  const startTime = Date.now();

  // ── 3. Serial module-by-module design ─────────────────────────────────────
  for (let i = 0; i < sortedModules.length; i++) {
    const mod = sortedModules[i];
    const stepStart = Date.now();
    console.log(`\n[ModuleArchitect] ── Module ${i + 1}/${sortedModules.length}: ${mod.name} (${mod.id}) ──`);
    console.log(`[ModuleArchitect]   Complexity: ${mod.complexity} | Dependencies: ${(mod.dependencies || []).join(', ') || 'none'}`);
    console.log(`[ModuleArchitect]   Upstream contracts available: ${upstreamContracts.length}`);

    const prompt = buildModuleFocusedPrompt(
      requirementContent,
      mod,
      modulesToDesign,
      crossCutting,
      upstreamContracts,
      expContext,
    );

    try {
      // Call the LLM directly via the ArchitectAgent's llmCall adapter.
      // We bypass agent.run() because it expects a file path and writes output
      // to a fixed location. Here we need multiple independent LLM calls whose
      // outputs are collected and merged.
      const agent = orch.agents[AgentRole.ARCHITECT];
      const rawOutput = await agent.llmCall(prompt);
      const moduleOutput = agent.parseResponse(rawOutput);

      // Extract interface contracts for downstream modules
      const contracts = extractInterfaceContracts(moduleOutput, mod.id, mod.name);
      upstreamContracts.push(contracts);

      moduleResults.push({
        moduleId: mod.id,
        moduleName: mod.name,
        complexity: mod.complexity,
        output: moduleOutput,
        contracts,
      });

      const elapsed = Date.now() - stepStart;
      console.log(`[ModuleArchitect] ✅ Module ${mod.id} designed in ${elapsed}ms (output: ${moduleOutput.length} chars)`);
    } catch (err) {
      console.error(`[ModuleArchitect] ❌ Module ${mod.id} design failed: ${err.message}`);
      // Record the failure but continue with remaining modules
      moduleResults.push({
        moduleId: mod.id,
        moduleName: mod.name,
        complexity: mod.complexity,
        output: `> ⚠️ Module design failed: ${err.message}\n\nThis module needs to be designed manually.`,
        contracts: `### Module: ${mod.name} (${mod.id})\n\n(Design failed — contracts unavailable)`,
      });
    }
  }

  // ── 4. Merge into unified architecture.md ─────────────────────────────────
  const mergedDoc = mergeModuleArchitectures(moduleResults, crossCutting, requirementContent);

  const outputPath = opts.outputPath || path.join(PATHS.OUTPUT_DIR, 'architecture.md');
  fs.writeFileSync(outputPath, mergedDoc, 'utf-8');

  const totalElapsed = Date.now() - startTime;
  const successCount = moduleResults.filter(r => !r.output.includes('design failed')).length;
  console.log(`\n[ModuleArchitect] ════════════════════════════════════════════════════`);
  console.log(`[ModuleArchitect]   Complete: ${successCount}/${sortedModules.length} modules designed`);
  console.log(`[ModuleArchitect]   Total time: ${totalElapsed}ms`);
  console.log(`[ModuleArchitect]   Output: ${outputPath} (${mergedDoc.length} chars)`);
  console.log(`[ModuleArchitect] ════════════════════════════════════════════════════\n`);

  return {
    used: true,
    outputPath,
    moduleCount: sortedModules.length,
    meta: {
      moduleSplit: true,
      moduleCount: sortedModules.length,
      successCount,
      failedCount: sortedModules.length - successCount,
      totalElapsedMs: totalElapsed,
      moduleOrder: sortedModules.map(m => m.id),
      crossCuttingConcerns: crossCutting,
    },
  };
}

// ─── Topological sort (dependency-aware ordering) ───────────────────────────

/**
 * Sorts modules so that dependencies come before dependents.
 * Falls back to complexity-based ordering if the graph has cycles.
 *
 * @param {object[]} modules
 * @returns {object[]} Sorted modules
 */
function _topologicalSort(modules) {
  const moduleIds = new Set(modules.map(m => m.id));
  const adjList = new Map();
  const inDegree = new Map();

  for (const m of modules) {
    adjList.set(m.id, []);
    inDegree.set(m.id, 0);
  }

  for (const m of modules) {
    for (const dep of (m.dependencies || [])) {
      if (moduleIds.has(dep)) {
        // dep → m (dep must come before m)
        adjList.get(dep).push(m.id);
        inDegree.set(m.id, (inDegree.get(m.id) || 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted = [];
  while (queue.length > 0) {
    // Among zero-inDegree nodes, prefer higher complexity first (fail fast)
    queue.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      const modA = modules.find(m => m.id === a);
      const modB = modules.find(m => m.id === b);
      return (order[modA?.complexity] || 1) - (order[modB?.complexity] || 1);
    });

    const current = queue.shift();
    sorted.push(current);

    for (const neighbor of (adjList.get(current) || [])) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Handle cycles: if some nodes weren't visited, add them at the end
  if (sorted.length < modules.length) {
    console.warn(`[ModuleArchitect] ⚠️  Dependency cycle detected. ${modules.length - sorted.length} module(s) added in arbitrary order.`);
    for (const m of modules) {
      if (!sorted.includes(m.id)) sorted.push(m.id);
    }
  }

  // Map back to module objects
  return sorted.map(id => modules.find(m => m.id === id));
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  runModuleAwareArchitect,
  buildModuleFocusedPrompt,
  extractInterfaceContracts,
  mergeModuleArchitectures,
  MIN_ISOLATABLE_FOR_SPLIT,
  MAX_MODULES_SPLIT,
  _topologicalSort,
};
