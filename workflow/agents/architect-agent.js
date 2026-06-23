/**
 * ArchitectAgent – Architecture Design Agent
 *
 * Role: Technical planner.
 * Input:  output/requirement.md  (file path passed by orchestrator)
 * Output: output/architecture.md
 *
 * Constraints:
 *  - MUST NOT write any code
 *  - MUST NOT modify requirement.md
 *  - MUST focus on system design: components, interfaces, data flow, tech stack choices
 */

'use strict';

const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');
const { buildJsonBlockInstruction, extractJsonBlock, validateJsonBlock } = require('../core/agent-output-schema');
const { PersonaLoader } = require('../core/persona-loader');
const { checkMandatorySections } = require('./agent-section-check');
// Arch-Fix-3: Removed direct import of extractAnchorFiles from analyst-agent.
// Agents must not have cross-agent dependencies. If Architect needs anchor file
// extraction in the future, the function should be moved to a shared utility
// (e.g. workflow/utils/text-extraction.js) and imported from there.

class ArchitectAgent extends BaseAgent {
  constructor(llmCall, hookEmitter, opts = {}) {
    super(AgentRole.ARCHITECT, llmCall, hookEmitter, opts);
  }

  /**
   * Builds the architect prompt.
   * Input content is the full text of analysis.md (from ANALYSE stage).
   *
   * @param {string} inputContent - Content of analysis.md (primary upstream artifact)
   * @param {string|null} expContext - Experience context block from ExperienceStore (optional)
   * @returns {string}
   */
  /**
   * P1-1: Load upstream context digest-first, falling back to full artifact.
   * @param {string} inputContent - Full upstream artifact content (fallback)
   * @param {string} digestStage - Stage name for digest lookup (e.g. 'ANALYSE')
   * @returns {string} Digest-formatted context or full content
   */
  _loadDigestFirst(inputContent, digestStage) {
    try {
      const fs = require('fs');
      const path = require('path');
      const { getDigestFileName } = require('../core/context-digest-store.js');
      const fname = getDigestFileName(digestStage);
      const digestPath = path.join(this._outputDir || 'output', 'context-digests', fname);
      if (fs.existsSync(digestPath)) {
        const digest = JSON.parse(fs.readFileSync(digestPath, 'utf-8'));
        const dig = digest.content || {};
        const parts = [];
        if (dig.summary) parts.push(`## Upstream Digest (${digestStage})\n${dig.summary}`);
        if (Array.isArray(dig.keyPoints) && dig.keyPoints.length > 0) {
          parts.push('### Key Points\n' + dig.keyPoints.map(k => `- ${k}`).join('\n'));
        }
        if (Array.isArray(dig.decisions) && dig.decisions.length > 0) {
          parts.push('### Decisions\n' + dig.decisions.map(d => `- ${d}`).join('\n'));
        }
        if (Array.isArray(dig.outline) && dig.outline.length > 0) {
          parts.push('### Sections\n' + dig.outline.slice(0, 15).map(s => `- ${s}`).join('\n'));
        }
        if (parts.length > 0) {
          console.error(`[ArchitectAgent] ✅ Digest-first: loaded ${digestStage} digest (${JSON.stringify(digest).length}b vs full artifact)`);
          return parts.join('\n\n') + '\n\n> ⚠️ This is a digest summary. Full artifact available at: ' + digest.source.path;
        }
      }
    } catch (_) { /* non-fatal — fall through */ }
    console.warn(`[ArchitectAgent] ⚠️ Digest unavailable for ${digestStage}, falling back to full artifact.`);
    return inputContent;
  }

  buildPrompt(inputContent, expContext = null) {
    const expSection = expContext
      ? `\n## Accumulated Experience (Reference Before Designing)\n${expContext}\n`
      : '';
    const jsonInstruction = buildJsonBlockInstruction('architect');
    // P1-1: Load digest-first; fall back to full inputContent when unavailable
    const digestContent = this._loadDigestFirst(inputContent, 'ANALYSE');
    const moduleMapContext = this._extractModuleMapFromUpstream(digestContent || inputContent);
    const codeGraphContext = this._loadCodeGraphContext();
    const knowledgeContext = this._loadKnowledgeContext();
    const importEdgeContext = this._buildImportEdgeContext();

    const template = this.loadPersona('architect');
    const skillConstraints = PersonaLoader.extractSpecTemplateConstraints();
    return this.buildPromptFromTemplate(template, {
      inputContent: digestContent,
      expSection,
      jsonInstruction,
      skillConstraints,
      moduleMapContext,
      codeGraphContext,
      knowledgeContext,
      importEdgeContext,
    });
  }

  /**
   * Extracts and formats the Module Map for the architect.
   * Reuses the PlannerAgent pattern to bridge ANALYSE→ARCHITECT handoff.
   *
   * @param {string|null} inputContent - analysis.md content that may contain module map
   * @returns {string} Formatted module map section or empty guidance
   */
  _extractModuleMapFromUpstream(inputContent) {
    // Robust detection: check for structured module data in analysis.md.
    // Priority: 1) JSON moduleMap block  2) Markdown table with module columns
    // 3) Heuristic keyword match  4) stageCtx structured data (via buildArchitectUpstreamCtx fallback)
    const hasStructuredModuleMap = (str) => {
      if (!str || typeof str !== 'string') return false;
      // Method 1: JSON block with moduleMap or modules array
      if (str.includes('"moduleMap"') && (str.includes('"modules"') || str.includes('"crossCuttingConcerns"'))) return true;
      // Method 2: Markdown table with Module ID column header
      if (/\|.*Module\s+ID.*\|/i.test(str) || /\|.*模块.*\|/i.test(str)) return true;
      // Method 3: Legacy keyword match (broad detection)
      if (str.includes('Functional Module Map') || str.includes('功能模块') || str.includes('Module Map')) return true;
      // Method 4: Recognizable module table pattern (ID | Name | Description | Boundaries)
      if (/\| *(mod-\w+|[\w-]+) *\| *.+ *\| *.+ *\|/i.test(str)) return true;
      return false;
    };

    if (hasStructuredModuleMap(inputContent)) {
      return `The Functional Module Map from the ANALYSE stage is present in the upstream analysis.md above. You MUST:
1. **Map each module to components** — every module should become one or more components in your Component Breakdown.
2. **Define Interface Contracts** between modules where dependencies exist.
3. **Respect module boundaries** — isolatable modules should have clean separation.
4. **Address cross-cutting concerns** at the architecture level.
5. **Prioritize high-complexity/risk modules** earlier in your execution plan (fail fast).
6. **Include a "moduleArchitecture" field** in the JSON metadata block mapping modules to components.`;
    }
    return `No structured Functional Module Map detected in the upstream analysis. You must:
1. Derive module boundaries from the user stories and acceptance criteria.
2. Create your own module-to-component mapping.
3. Flag any modules where boundaries are unclear as Open Architecture Questions.`;
  }

  /**
   * Builds import-edge based dependency context from CodeGraph._importEdges.
   * Helps architect understand actual file-level dependencies when designing components.
   *
   * @returns {string} Markdown table of file-level import dependencies
   */
  _buildImportEdgeContext() {
    try {
      const CodeGraph = require('../core/code-graph');
      const codeGraph = CodeGraph.getInstance ? CodeGraph.getInstance() : null;
      if (!codeGraph || !codeGraph._importEdges || codeGraph._importEdges.size === 0) {
        return '';
      }
      const importEdges = codeGraph._importEdges;
      const lines = ['\n## File-Level Import Dependencies (from require() scan)\n'];
      lines.push('| File | Imported by |');
      lines.push('|------|------------|');
      let count = 0;
      for (const [filePath, imported] of importEdges) {
        if (count >= 50) break;
        const shortPath = filePath.replace(/^.*[\\/]workflow[\\/]/, 'workflow/');
        const importers = imported.map(p => p.replace(/^.*[\\/]workflow[\\/]/, 'workflow/'));
        lines.push(`| ${shortPath} | ${importers.join(', ') || '(no importers)'} |`);
        count++;
      }
      lines.push(`\n> **Source**: CodeGraph._importEdges (${importEdges.size} files).`);
      lines.push(`> Use actual file dependencies to validate your component boundaries and interface contracts.`);
      return lines.join('\n');
    } catch (_) {
      return '';
    }
  }

  /**
   * Parses the LLM response.
   * Warns if actual code implementations are detected.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // P0-NEW-1: validate JSON block presence (imports hoisted to file top – P1-1 fix)
    const jsonBlock = extractJsonBlock(llmResponse);
    if (!jsonBlock) {
      console.warn(`[ArchitectAgent] ⚠️  No structured JSON block found in output. Downstream agents will use regex-based extraction (degraded mode).`);
    } else {
      const check = validateJsonBlock(jsonBlock, 'architect');
      if (!check.valid) {
        console.warn(`[ArchitectAgent] ⚠️  JSON block validation failed: ${check.reason}`);
      } else {
        console.error(`[ArchitectAgent] ✅ Structured JSON block validated (${Object.keys(jsonBlock).length} fields).`);
      }
    }

    // Detect implementation code (multi-line code blocks with logic)
    const codeBlockPattern = /```[\w]*\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockPattern.exec(llmResponse)) !== null) {
      const blockContent = match[1];
      // Heuristic: if block contains assignment operators or control flow, it's likely code
      // P2-5 fix: exclude Mermaid diagrams and JSON/config blocks from false positives
      if (/[=;{}]/.test(blockContent) && !/^[\s#\-*>|]/.test(blockContent.trim())
        && !blockContent.includes('graph ') && !blockContent.includes('"role"')
        && !blockContent.includes('sequenceDiagram') && !blockContent.includes('classDiagram')) {
        console.warn(`[ArchitectAgent] WARNING: Possible implementation code detected in architecture.md. Review recommended.`);
        break;
      }
    }

    // ── Mandatory section compliance check (P1-4: bilingual support) ─────────
    checkMandatorySections(llmResponse, [
      { en: 'Tree of Thoughts Evaluation', zh: '多方案思维树评估' },
      { en: 'Architecture Design', zh: '架构设计' },
      { en: 'Execution Plan', zh: '执行计划' },
      { en: 'Traceability Coverage', zh: '追溯覆盖' },
      { en: 'ADR Linkage', zh: 'ADR 关联' },
    ], { agentName: 'ArchitectAgent', mode: 'strict' });

    // ── Traceability coverage check (REQ/AC -> architecture mapping) ────────
    const requirementIds = [...new Set(llmResponse.match(/\b(?:REQ|AC)-\d{3,}\b/g) || [])];
    if (requirementIds.length > 0) {
      const mappedIds = new Set();

      // Parse markdown table/list rows in Traceability Coverage section heuristically
      const lineMatches = llmResponse.match(/^.*(?:REQ|AC)-\d{3,}.*$/gim) || [];
      for (const line of lineMatches) {
        const idsInLine = line.match(/\b(?:REQ|AC)-\d{3,}\b/g) || [];
        const hasUnmapped = /\bUNMAPPED\b/i.test(line);
        const hasTarget = /\b(?:mod-|ADR-|API|data model|module|decision|component)\b/i.test(line);
        if (!hasUnmapped && hasTarget) {
          for (const id of idsInLine) mappedIds.add(id);
        }
      }

      // Parse structured adrLinkage links
      if (jsonBlock && jsonBlock.adrLinkage && Array.isArray(jsonBlock.adrLinkage.links)) {
        for (const link of jsonBlock.adrLinkage.links) {
          if (link && typeof link.reqId === 'string' && /^((REQ|AC)-\d{3,})$/i.test(link.reqId) && typeof link.adrId === 'string' && /^ADR-\d{3,}$/i.test(link.adrId)) {
            mappedIds.add(link.reqId.toUpperCase());
          }
        }
      }

      const uncovered = requirementIds.filter(id => !mappedIds.has(id.toUpperCase()));
      if (uncovered.length > 0) {
        throw new Error(`[ArchitectAgent] RTM_GATE_FAILED: Traceability coverage gap ${uncovered.length}/${requirementIds.length}. Uncovered: ${uncovered.slice(0, 8).join(', ')}${uncovered.length > 8 ? '...' : ''}`);
      } else {
        console.error(`[ArchitectAgent] ✅ Traceability coverage: ${mappedIds.size}/${requirementIds.length} REQ/AC item(s) mapped to architecture artifacts.`);
      }
    }

    // ── ADR linkage structure check ──────────────────────────────────────────
    if (jsonBlock && jsonBlock.adrLinkage) {
      const links = jsonBlock.adrLinkage.links;
      if (!Array.isArray(links) || links.length === 0) {
        throw new Error(`[ArchitectAgent] RTM_GATE_FAILED: adrLinkage.links must be a non-empty array.`);
      } else {
        const badLinks = links.filter(l => !l || typeof l.reqId !== 'string' || typeof l.adrId !== 'string' || typeof l.decisionRef !== 'string');
        if (badLinks.length > 0) {
          throw new Error(`[ArchitectAgent] RTM_GATE_FAILED: adrLinkage.links has ${badLinks.length} malformed item(s). Expected { reqId, adrId, decisionRef }.`);
        }

        const invalidLinks = links.filter(l => !/^((REQ|AC)-\d{3,})$/i.test(String(l.reqId)) || !/^ADR-\d{3,}$/i.test(String(l.adrId)));
        if (invalidLinks.length > 0) {
          throw new Error(`[ArchitectAgent] RTM_GATE_FAILED: adrLinkage.links has ${invalidLinks.length} invalid reqId/adrId value(s). Expected REQ/AC and ADR ID formats.`);
        }

        console.error(`[ArchitectAgent] ✅ ADR linkage validated: ${links.length} REQ/AC → ADR link(s).`);
      }
    } else {
      throw new Error(`[ArchitectAgent] RTM_GATE_FAILED: Missing adrLinkage in JSON block.`);
    }

    // ── P0 Fix: Architecture Self-Review Checklist (MANDATORY) ──────────────
    if (!llmResponse.includes('## Architecture Self-Review') && !llmResponse.includes('## 架构自评')) {
      const SELF_REVIEW_CHECKS = [
        { id: 'ARCH-001', sev: 'HIGH',   check: 'Every major tech choice has a stated rationale' },
        { id: 'ARCH-007', sev: 'HIGH',   check: 'No single point of failure for critical paths' },
        { id: 'ARCH-010', sev: 'HIGH',   check: 'Authentication and authorisation architecture defined' },
        { id: 'ARCH-015', sev: 'HIGH',   check: 'All NFRs addressed in architecture' },
        { id: 'ARCH-017', sev: 'HIGH',   check: 'No internal contradictions between sections' },
      ];
      const missing = SELF_REVIEW_CHECKS.map(c =>
        `⚠️  ${c.id} [${c.sev}]: ${c.check} — NOT found in architecture output`
      );
      console.warn(`[ArchitectAgent] ⚠️  Architecture Self-Review Checklist not found. Missing checks:\n${missing.join('\n')}`);
      console.warn(`[ArchitectAgent] ℹ️  Pass will still proceed — review gate is user-driven. Add '## Architecture Self-Review' section to fix.`);
    } else {
      console.error(`[ArchitectAgent] ✅ Architecture Self-Review Checklist present in output.`);
    }

    return llmResponse;
  }
}

module.exports = { ArchitectAgent };
