/**
 * PlannerAgent – Execution Planning Agent
 *
 * Domain Expert: Frederick Brooks (Turing Award laureate, author of "The Mythical Man-Month")
 * Philosophy: "Conceptual integrity is the most important consideration in system design" — plan for essential complexity, manage communication overhead, preserve architectural coherence.
 *
 * Role: Strategic planner — decomposes architecture into dependency-aware, architecturally-cohesive tasks.
 * Input:  output/architecture.md  (file path passed by orchestrator)
 * Output: output/execution-plan.md
 *
 * Responsibilities:
 *  - Read the architecture document and decompose it into actionable implementation tasks
 *  - Define task dependencies, ordering, and acceptance criteria (TDD mindset: criteria before implementation)
 *  - Estimate complexity for each task
 *  - Group tasks into vertical-slice implementation phases
 *  - Apply XP principles: small steps, embrace change, feedback loops
 *
 * Constraints:
 *  - MUST NOT write any code
 *  - MUST NOT modify requirement.md or architecture.md
 *  - MUST produce a plan that the Developer agent can follow step by step
 */

'use strict';

const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');
const { buildJsonBlockInstruction, extractJsonBlock, validateJsonBlock } = require('../core/agent-output-schema');
const { checkMandatorySections } = require('./agent-section-check');

class PlannerAgent extends BaseAgent {
  constructor(llmCall, hookEmitter, opts = {}) {
    super(AgentRole.PLANNER, llmCall, hookEmitter, opts);
  }

  /**
   * Tries to load upstream digest. Falls back to full artifact if unavailable.
   */
  _loadDigestFirst(inputContent, digestStage) {
    try {
      const fs = require('fs');
      const path = require('path');
      const { getDigestFileName } = require('../core/context-digest-store');
      const fname = getDigestFileName(digestStage);
      const digestPath = path.join(this._outputDir || 'output', 'context-digests', fname);
      if (fs.existsSync(digestPath)) {
        const digest = JSON.parse(fs.readFileSync(digestPath, 'utf-8'));
        const dig = digest.content || {};
        const parts = [];
        if (dig.summary) parts.push(`## Upstream Digest (${digestStage})\n${dig.summary}`);
        if (Array.isArray(dig.decisions) && dig.decisions.length > 0) {
          parts.push('### Key Decisions\n' + dig.decisions.map((d, i) => `${i + 1}. ${d}`).join('\n'));
        }
        if (Array.isArray(dig.risks) && dig.risks.length > 0) {
          parts.push('### Key Risks\n' + dig.risks.map(r => `- ${r}`).join('\n'));
        }
        if (parts.length > 0) {
          return parts.join('\n\n') + '\n\n> ⚠️ Digest summary. Full artifact: ' + (digest.source?.path || '');
        }
      }
    } catch (_) { /* non-fatal */ }
    return inputContent;
  }

  /**
   * Builds the planner prompt.
   * Input content is the full text of architecture.md, enriched with analysis.md context.
   *
   * @param {string} inputContent - Content of architecture.md
   * @param {string|null} expContext - Experience context block from ExperienceStore (optional)
   * @returns {string}
   */
  buildPrompt(inputContent, expContext = null) {
    const expSection = expContext
      ? `\n## Accumulated Experience (Reference Before Planning)\n${expContext}\n`
      : '';
    const jsonInstruction = buildJsonBlockInstruction('planner');

    // ── Digest-first: prefer ARCHITECT digest over full architecture.md ────
    const digestContent = this._loadDigestFirst(inputContent, 'ARCHITECT');

    // Check BOTH expContext and inputContent(architecture.md) for the Module Map.
    // Also attempt to read analysis.md directly to catch Module Map if ARCHITECT
    // didn't forward it into architecture.md (same gap as ANALYSE→ARCHITECT handoff).
    let moduleMapFound = false;
    const hasModuleMap = (str) => str && typeof str === 'string' && (
      str.includes('Functional Module Map') || str.includes('功能模块') || str.includes('moduleMap')
    );
    if (hasModuleMap(expContext) || hasModuleMap(inputContent)) {
      moduleMapFound = true;
    }

    // Fallback: read analysis.md directly to recover Module Map
    if (!moduleMapFound) {
      try {
        const fs = require('fs');
        const path = require('path');
        const analysisPath = path.join(this._outputDir || 'output', '..', 'output', 'analysis.md');
        if (fs.existsSync(analysisPath)) {
          const analysisContent = fs.readFileSync(analysisPath, 'utf-8');
          if (hasModuleMap(analysisContent)) {
            moduleMapFound = true;
          }
        }
      } catch (_) { /* non-fatal */ }
    }

    const moduleMapContext = moduleMapFound
      ? this._buildModuleMapGuidance()
      : `No Functional Module Map available from ANALYSE stage. Proceed with standard task decomposition.`;

    const codeGraphContext = this._loadCodeGraphContext();
    const knowledgeContext = this._loadKnowledgeContext();
    const requireEdgeContext = this._buildRequireEdgeGuidance();

    const template = this.loadPersona('planner');
    return this.buildPromptFromTemplate(template, {
      inputContent: digestContent,
      expSection,
      jsonInstruction,
      moduleMapContext,
      codeGraphContext,
      knowledgeContext,
      requireEdgeContext,
    });
  }

  /**
   * Returns structured guidance for using the Module Map.
   * Extracted as a method for readability.
   */
  _buildModuleMapGuidance() {
    return `The Functional Module Map is available in the upstream context (analysis.md or architecture.md). You MUST use it to:
1. Group tasks by module in Section 7 (Module-Task Grouping table)
2. Include a "moduleGrouping" field in the JSON metadata block with this structure:
   "moduleGrouping": {
     "groups": [
       { "moduleId": "mod-xxx", "moduleName": "Module Name", "taskIds": ["T-1", "T-2"] }
     ],
     "crossModuleTasks": ["T-6"]
   }
3. Prefer scheduling isolatable modules in parallel phases
4. Schedule modules with dependencies after their dependencies are complete`;
  }

  /**
   * Builds require-edge based dependency guidance from CodeGraph._importEdges.
   * Replaces keyword-based heuristic with full require()/import scanning.
   *
   * @returns {string} Markdown table of file-level import dependencies
   */
  _buildRequireEdgeGuidance() {
    try {
      const CodeGraph = require('../core/code-graph');
      const codeGraph = CodeGraph.getInstance ? CodeGraph.getInstance() : null;
      if (!codeGraph || !codeGraph._importEdges || codeGraph._importEdges.size === 0) {
        return '';
      }
      const importEdges = codeGraph._importEdges;
      const lines = ['\n## File-Level Import Dependencies (from require() scan)\n'];
      lines.push('| File | Imported by (callers) |');
      lines.push('|------|----------------------|');
      let count = 0;
      for (const [filePath, imported] of importEdges) {
        if (count >= 50) break; // guard against massive output
        const shortPath = filePath.replace(/^.*[\\/]workflow[\\/]/, 'workflow/');
        const importedShort = imported.map(p => p.replace(/^.*[\\/]workflow[\\/]/, 'workflow/'));
        lines.push(`| ${shortPath} | ${importedShort.join(', ') || '(no importers)'} |`);
        count++;
      }
      lines.push(`\n> **Source**: CodeGraph._importEdges (${importEdges.size} files scanned). ` +
        `Use this to assess modification impact precisely — a file listed as "0 callers" is safe to delete.`);
      return lines.join('\n');
    } catch (_) {
      return '';
    }
  }

  /**
   * Parses the LLM response.
   * Validates JSON block and checks for mandatory sections.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // Validate JSON block presence (imports hoisted to file top – P1-1 fix)
    const jsonBlock = extractJsonBlock(llmResponse);
    if (!jsonBlock) {
      console.warn(`[PlannerAgent] ⚠️  No structured JSON block found in output. Downstream agents will use regex-based extraction (degraded mode).`);
    } else {
      const check = validateJsonBlock(jsonBlock, 'planner');
      if (!check.valid) {
        console.warn(`[PlannerAgent] ⚠️  JSON block validation failed: ${check.reason}`);
      } else {
        console.error(`[PlannerAgent] ✅ Structured JSON block validated (${Object.keys(jsonBlock).length} fields).`);
      }
    }

    // Mandatory section compliance check (P1-4: bilingual support)
    checkMandatorySections(llmResponse, [
      { en: 'Plan Overview', zh: '计划概览' },
      { en: 'Implementation Phases', zh: '实施阶段' },
      { en: 'Task Breakdown', zh: '任务分解' },
      { en: 'Dependency Graph', zh: '依赖图' },
      { en: 'Risk Assessment', zh: '风险评估' },
      { en: 'Verification Checklist', zh: '验证清单' },
      { en: 'Module-Task Grouping', zh: '模块-任务分组' },
      { en: 'Traceability Coverage', zh: '追溯覆盖' },
      { en: 'ADR-to-Task Linkage', zh: 'ADR 到任务关联' },
    ], { agentName: 'PlannerAgent', mode: 'warn' });

    // Check for acceptance criteria presence
    const taskPattern = /#### Task T-/g;
    const taskCount = (llmResponse.match(taskPattern) || []).length;
    const criteriaPattern = /Acceptance Criteria/gi;
    const criteriaCount = (llmResponse.match(criteriaPattern) || []).length;
    if (taskCount > 0 && criteriaCount < taskCount) {
      throw new Error(`[PlannerAgent] RTM_GATE_FAILED: Only ${criteriaCount}/${taskCount} tasks have acceptance criteria.`);
    }

    // Check for complexity field presence (warn mode — not blocking for backward compatibility)
    const complexityPattern = /\bComplexity\b.*?(?:Lite|Standard|Senior)/gi;
    const complexityCount = (llmResponse.match(complexityPattern) || []).length;
    if (taskCount > 0 && complexityCount < taskCount) {
      console.warn(`[PlannerAgent] ⚠️  Only ${complexityCount}/${taskCount} tasks have Complexity annotation (lite/standard/senior). Missing tasks will default to "standard" in TEST stage.`);
    }

    // Validate complexity field in JSON block
    if (jsonBlock && Array.isArray(jsonBlock.tasks)) {
      const tasksMissingComplexity = jsonBlock.tasks.filter(t => !t.complexity || !['lite', 'standard', 'senior'].includes(t.complexity));
      if (tasksMissingComplexity.length > 0) {
        console.warn(`[PlannerAgent] ⚠️  ${tasksMissingComplexity.length}/${jsonBlock.tasks.length} task(s) in JSON block have no valid complexity field. Defaulting to "standard". Tasks: ${tasksMissingComplexity.map(t => t.id || '?').join(', ')}`);
      }

      // Validate subtask ID naming: must follow T-001/A format
      for (const task of jsonBlock.tasks) {
        if (task.subTasks && Array.isArray(task.subTasks)) {
          const badIds = task.subTasks.filter(st => !/^T-\d+\/[A-Z]$/.test(st.id));
          if (badIds.length > 0) {
            console.warn(`[PlannerAgent] ⚠️  Task ${task.id}: ${badIds.length} subtask(s) have invalid ID format: ${badIds.map(st => st.id).join(', ')}. Expected format: T-001/A, T-001/B`);
          }
        }
      }

      // Quality gate: detect file-centric task naming (e.g. "实现 auth.js" instead of "实现登录功能")
      const fileCentricPattern = /\.[a-z]+$/i; // title ends with file extension
      const fileCentricTasks = jsonBlock.tasks.filter(t => t.title && fileCentricPattern.test(t.title.trim()));
      if (fileCentricTasks.length > 0) {
        console.warn(`[PlannerAgent] ⚠️  ${fileCentricTasks.length} task(s) have file-centric names (e.g. ending with .js, .ts): ${fileCentricTasks.map(t => t.id).join(', ')}. Prefer feature-centric names like "实现登录功能" instead of "实现 auth.js".`);
      }
    }

    // Phase 2.5A: Validate moduleGrouping in JSON block
    if (jsonBlock && jsonBlock.moduleGrouping) {
      const mg = jsonBlock.moduleGrouping;
      if (Array.isArray(mg.groups) && mg.groups.length > 0) {
        const totalGroupedTasks = mg.groups.reduce((sum, g) => sum + (Array.isArray(g.taskIds) ? g.taskIds.length : 0), 0);
        const crossCount = Array.isArray(mg.crossModuleTasks) ? mg.crossModuleTasks.length : 0;
        console.error(`[PlannerAgent] ✅ Module-Task Grouping: ${mg.groups.length} module group(s), ${totalGroupedTasks} grouped task(s), ${crossCount} cross-module task(s).`);

        // Validate: every task should appear in some group or crossModuleTasks
        const allGroupedTaskIds = new Set();
        for (const g of mg.groups) {
          for (const tid of (g.taskIds || [])) allGroupedTaskIds.add(tid);
        }
        for (const tid of (mg.crossModuleTasks || [])) allGroupedTaskIds.add(tid);

        if (taskCount > 0 && allGroupedTaskIds.size < taskCount) {
          throw new Error(`[PlannerAgent] RTM_GATE_FAILED: Module grouping covers ${allGroupedTaskIds.size}/${taskCount} tasks.`);
        }
      } else {
        throw new Error(`[PlannerAgent] RTM_GATE_FAILED: moduleGrouping present but has no valid groups.`);
      }
    } else if (llmResponse.includes('Functional Module Map')) {
      // Module Map was available but no moduleGrouping was produced
      throw new Error(`[PlannerAgent] RTM_GATE_FAILED: Functional Module Map was available but no moduleGrouping was produced in JSON block.`);
    }

    // ── Traceability coverage check (REQ/AC -> TASK) ───────────────────────
    const requirementIds = [...new Set(llmResponse.match(/\b(?:REQ|AC)-\d{3,}\b/g) || [])];
    if (requirementIds.length > 0) {
      const mappedIds = new Set();
      const lineMatches = llmResponse.match(/^.*(?:REQ|AC)-\d{3,}.*$/gim) || [];
      for (const line of lineMatches) {
        const idsInLine = line.match(/\b(?:REQ|AC)-\d{3,}\b/g) || [];
        const hasTask = /\bT-\d+\b/i.test(line);
        const unplanned = /\bUNPLANNED\b/i.test(line);
        if (hasTask && !unplanned) {
          for (const id of idsInLine) mappedIds.add(id.toUpperCase());
        }
      }

      if (jsonBlock && jsonBlock.adrTaskLinkage && Array.isArray(jsonBlock.adrTaskLinkage.links)) {
        for (const link of jsonBlock.adrTaskLinkage.links) {
          if (link && typeof link.reqId === 'string' && /^((REQ|AC)-\d{3,})$/i.test(link.reqId) && Array.isArray(link.taskIds) && link.taskIds.length > 0) {
            mappedIds.add(link.reqId.toUpperCase());
          }
        }
      }

      const uncovered = requirementIds.filter(id => !mappedIds.has(id.toUpperCase()));
      if (uncovered.length > 0) {
        throw new Error(`[PlannerAgent] RTM_GATE_FAILED: Traceability coverage gap ${uncovered.length}/${requirementIds.length}. Uncovered: ${uncovered.slice(0, 8).join(', ')}${uncovered.length > 8 ? '...' : ''}`);
      } else {
        console.error(`[PlannerAgent] ✅ Traceability coverage: ${mappedIds.size}/${requirementIds.length} REQ/AC item(s) mapped to task(s).`);
      }
    }

    // ── ADR-to-Task linkage structure check (REQ/AC -> ADR -> TASK) ─────────
    if (jsonBlock && jsonBlock.adrTaskLinkage) {
      const links = jsonBlock.adrTaskLinkage.links;
      if (!Array.isArray(links) || links.length === 0) {
        throw new Error(`[PlannerAgent] RTM_GATE_FAILED: adrTaskLinkage.links must be a non-empty array.`);
      } else {
        let malformed = 0;
        let brokenChain = 0;
        for (const link of links) {
          const validShape = link
            && typeof link.reqId === 'string'
            && typeof link.adrId === 'string'
            && Array.isArray(link.taskIds);
          if (!validShape) {
            malformed += 1;
            continue;
          }
          const reqOk = /^((REQ|AC)-\d{3,})$/i.test(link.reqId);
          const adrOk = /^ADR-\d{3,}$/i.test(link.adrId);
          const taskOk = link.taskIds.length > 0 && link.taskIds.every(t => /^T-\d+(?:\/[A-Z])?$/i.test(String(t)));
          if (!reqOk || !adrOk || !taskOk) brokenChain += 1;
        }
        if (malformed > 0) {
          throw new Error(`[PlannerAgent] RTM_GATE_FAILED: adrTaskLinkage.links has ${malformed} malformed item(s). Expected { reqId, adrId, taskIds[] }.`);
        }
        if (brokenChain > 0) {
          throw new Error(`[PlannerAgent] RTM_GATE_FAILED: adrTaskLinkage has ${brokenChain} broken chain item(s). Expected REQ/AC -> ADR -> T-N or T-N/A.`);
        }
        console.error(`[PlannerAgent] ✅ ADR-to-Task linkage validated: ${links.length} chain item(s).`);

        // ── P1: Reverse coverage — detect orphan tasks (T-N not mapped to any AC/REQ) ──
        if (jsonBlock && Array.isArray(jsonBlock.tasks)) {
          const allMappedTaskIds = new Set();
          for (const link of links) {
            if (Array.isArray(link.taskIds)) {
              for (const tid of link.taskIds) allMappedTaskIds.add(String(tid).toUpperCase());
            }
          }
          // Also collect from Markdown Traceability table (supplement adrTaskLinkage)
          const mdLines = llmResponse.match(/^.*T-\d+.*$/gim) || [];
          for (const line of mdLines) {
            if (/(?:REQ|AC)-\d{3,}/i.test(line)) {
              const tids = line.match(/T-\d+/gi) || [];
              for (const t of tids) allMappedTaskIds.add(t.toUpperCase());
            }
          }
          // Q1: Also collect from moduleGrouping (optional, tasks listed here but not in adrTaskLinkage)
          if (jsonBlock.moduleGrouping && Array.isArray(jsonBlock.moduleGrouping.groups)) {
            for (const g of jsonBlock.moduleGrouping.groups) {
              if (Array.isArray(g.taskIds)) {
                for (const tid of g.taskIds) allMappedTaskIds.add(String(tid).toUpperCase());
              }
            }
            if (Array.isArray(jsonBlock.moduleGrouping.crossModuleTasks)) {
              for (const tid of jsonBlock.moduleGrouping.crossModuleTasks) allMappedTaskIds.add(String(tid).toUpperCase());
            }
          }

          const allTaskIds = jsonBlock.tasks.map(t => String(t.id).toUpperCase());
          const orphans = allTaskIds.filter(tid => !allMappedTaskIds.has(tid));
          if (orphans.length > 0) {
            console.warn(`[PlannerAgent] ⚠️  ${orphans.length} orphan task(s) not mapped to any AC/REQ: ${orphans.join(', ')}. These tasks cannot be verified by TEST stage.`);
          } else {
            console.error(`[PlannerAgent] ✅ Reverse coverage: all ${allTaskIds.length} task(s) mapped to at least one requirement/AC.`);
          }
        }

        // ── P2: Consistency — cross-check Markdown Traceability vs JSON adrTaskLinkage ──
        const mdAcToTasks = new Map();
        const mdRe = /\b(?:REQ|AC)-\d{3,}\b/gi;
        const mdLines2 = llmResponse.match(/^.*(?:REQ|AC)-\d{3,}.*T-\d+.*$/gim) || [];
        for (const line of mdLines2) {
          const acIds = [...new Set(line.match(mdRe) || [])];
          const taskIds = [...new Set(line.match(/T-\d+/gi) || [])];
          for (const ac of acIds) {
            if (!mdAcToTasks.has(ac.toUpperCase())) mdAcToTasks.set(ac.toUpperCase(), new Set());
            for (const t of taskIds) mdAcToTasks.get(ac.toUpperCase()).add(t.toUpperCase());
          }
        }

        let consistencyIssues = 0;
        for (const link of links) {
          const acId = String(link.reqId).toUpperCase();
          const jsonTasks = new Set((link.taskIds || []).map(t => String(t).toUpperCase()));
          const mdTasks = mdAcToTasks.get(acId);
          if (!mdTasks || mdTasks.size === 0) {
            // Q2: warn when an AC in adrTaskLinkage has no corresponding Markdown Traceability row
            console.warn(`[PlannerAgent] ⚠️  Consistency: adrTaskLinkage maps ${acId} → tasks, but no matching row found in Traceability Coverage table.`);
            consistencyIssues++;
            continue;
          }

          // Check 1: JSON task NOT in Markdown table
          for (const jt of jsonTasks) {
            if (!mdTasks.has(jt)) {
              console.warn(`[PlannerAgent] ⚠️  Consistency: adrTaskLinkage maps ${acId} → ${jt}, but Traceability table does not.`);
              consistencyIssues++;
            }
          }
          // Check 2: Markdown task NOT in JSON
          for (const mt of mdTasks) {
            if (!jsonTasks.has(mt)) {
              console.warn(`[PlannerAgent] ⚠️  Consistency: Traceability table maps ${acId} → ${mt}, but adrTaskLinkage does not.`);
              consistencyIssues++;
            }
          }
        }
        if (consistencyIssues > 0) {
          console.warn(`[PlannerAgent] ⚠️  ${consistencyIssues} consistency gap(s) between Traceability table and adrTaskLinkage JSON.`);
        } else if (mdAcToTasks.size > 0) {
          console.error(`[PlannerAgent] ✅ Traceability ↔ adrTaskLinkage consistent (${links.length} links).`);
        }
      }
    } else {
      throw new Error(`[PlannerAgent] RTM_GATE_FAILED: Missing adrTaskLinkage in JSON block.`);
    }

    // Detect implementation code (multi-line code blocks with logic)
    const codeBlockPattern = /```[\w]*\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockPattern.exec(llmResponse)) !== null) {
      const blockContent = match[1];
      // Allow Mermaid and JSON blocks, but flag code blocks
      if (/[=;{}]/.test(blockContent) && !/^[\s#\-*>|]/.test(blockContent.trim()) && !blockContent.includes('graph ') && !blockContent.includes('"role"')) {
        console.warn(`[PlannerAgent] WARNING: Possible implementation code detected in execution-plan.md. Review recommended.`);
        break;
      }
    }

    // ── P2-1: Task dependency cycle detection ────────────────────────────
    this._detectCycleInTaskGraph(llmResponse);

    // ── P2-2: Risk scheduling verification ───────────────────────────────
    this._verifyRiskScheduling(llmResponse);

    // ── P2-4: Mermaid graph validation ───────────────────────────────────
    this._validateMermaidGraph(llmResponse);

    return llmResponse;
  }

  /**
   * P2-1: Detect cycles in the task dependency graph from LLM output.
   * Non-fatal: only console.warn on detection.
   */
  _detectCycleInTaskGraph(llmResponse) {
    try {
      // Extract task dependency edges like: T-1 --> T-2, T-1 ──> T-2
      const edgePattern = /T-(\d+)\s*[-─]{2,}>\s*T-(\d+)/gi;
      const edges = [];
      let edgeMatch;
      while ((edgeMatch = edgePattern.exec(llmResponse)) !== null) {
        edges.push([parseInt(edgeMatch[1]), parseInt(edgeMatch[2])]);
      }
      if (edges.length === 0) return;

      // Build adjacency list
      const graph = new Map();
      for (const [from, to] of edges) {
        if (!graph.has(from)) graph.set(from, []);
        graph.get(from).push(to);
      }

      // DFS cycle detection
      const visited = new Set();
      const inStack = new Set();
      const hasCycle = (node) => {
        visited.add(node);
        inStack.add(node);
        for (const neighbor of (graph.get(node) || [])) {
          if (inStack.has(neighbor)) return true;
          if (!visited.has(neighbor) && hasCycle(neighbor)) return true;
        }
        inStack.delete(node);
        return false;
      };

      for (const node of graph.keys()) {
        if (!visited.has(node) && hasCycle(node)) {
          console.warn(`[PlannerAgent] P2-1 ⚠️ Cycle detected in task dependency graph. Verify Dependency Graph section.`);
          return;
        }
      }
    } catch (_) { /* non-fatal */ }
  }

  /**
   * P2-2: Verify high-risk tasks are scheduled in Phase 1 (fail fast).
   * Non-fatal: only console.warn if high-risk tasks are in later phases.
   */
  _verifyRiskScheduling(llmResponse) {
    try {
      // Extract high-risk tasks from Risk Assessment section
      const riskSection = llmResponse.match(/## (?:Risk Assessment|风险评估)[\s\S]*?(?=##|$)/i);
      if (!riskSection) return;

      // Match all T-N references in the Risk Assessment section
      const taskRefs = riskSection[0].match(/T-(\d+)/g) || [];
      const hasHighRisk = /(?:最高风险|High Risk|高风险|critical)/i.test(riskSection[0]);
      if (!hasHighRisk || taskRefs.length === 0) return;

      // Check phase positions: Phase 1 should contain these tasks
      const phase1Match = llmResponse.match(/## (?:Implementation Phases|实施阶段)[\s\S]*?Phase 1[\s\S]*?(?=## Phase 2|##|$)/i);
      if (!phase1Match) return;

      const phase1Tasks = new Set((phase1Match[0].match(/T-(\d+)/g) || []));
      for (const ref of taskRefs) {
        if (!phase1Tasks.has(ref)) {
          console.warn(`[PlannerAgent] P2-2 ⚠️ High-risk task ${ref} is not in Phase 1. Move it earlier for fail-fast.`);
        }
      }
    } catch (_) { /* non-fatal */ }
  }

  /**
   * P2-4: Validate Mermaid dependency graph syntax.
   * Non-fatal: only console.warn on invalid/empty graphs.
   */
  _validateMermaidGraph(llmResponse) {
    try {
      const mermaidMatch = llmResponse.match(/```mermaid\n([\s\S]*?)```/);
      if (!mermaidMatch) return;

      const graph = mermaidMatch[1].trim();
      if (!graph) return;

      const lines = graph.split('\n').filter(l => l.includes('-->'));
      if (lines.length === 0) {
        console.warn(`[PlannerAgent] P2-4 ⚠️ Mermaid dependency graph has no edges (-->). Review graph syntax.`);
        return;
      }

      // Check for basic valid syntax: each line should have at least one -->
      const malformed = lines.filter(l => !/^[\s\w[\]"'-]+-->[\s\w[\]"'-]+$/.test(l.trim()));
      if (malformed.length > lines.length * 0.5) {
        console.warn(`[PlannerAgent] P2-4 ⚠️ ${malformed.length}/${lines.length} Mermaid graph lines appear malformed.`);
      }
    } catch (_) { /* non-fatal */ }
  }
}

module.exports = { PlannerAgent };
