/**
 * AnalystAgent – Requirement Analysis Agent
 *
 * Role: Business translator.
 * Input:  Raw user requirement string (no input file)
 * Output: output/requirement.md
 *
 * Constraints:
 *  - MUST NOT produce technical implementation details
 *  - MUST NOT write code, architecture docs, or test reports
 *  - MUST focus solely on clarifying WHAT the user wants, not HOW
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');
const { buildJsonBlockInstruction, extractJsonBlock, validateJsonBlock } = require('../core/agent-output-schema');
const { PersonaLoader } = require('../core/persona-loader');
const { checkMandatorySections } = require('./agent-section-check');

// ─── Anchor File Extraction ──────────────────────────────────────────────────

/**
 * Extracts anchor file references from user requirement text.
 *
 * Supports multiple formats that IDE Copilot may use:
 *   1. @file:path/to/file.ext or @path/to/file.ext
 *   2. Explicit file names with common extensions (e.g. "FarmRobotSettingSubUICtrl.lua")
 *   3. Markdown-style references [filename](path)
 *   4. Backtick-wrapped file references `path/to/file.ext`
 *
 * @param {string} text - User requirement text
 * @returns {{ anchorFiles: string[], anchorNames: string[] }}
 *   anchorFiles  – full paths or identifiable file references
 *   anchorNames  – just the base names (for display and search hinting)
 */
function extractAnchorFiles(text) {
  const anchorFiles = [];
  const seen = new Set();

  // P1-3 fix: Cap input length to prevent ReDoS on pathological inputs.
  // 50 KB is generous enough for any real requirement text.
  const MAX_INPUT_LENGTH = 50000;
  if (text.length > MAX_INPUT_LENGTH) {
    text = text.slice(0, MAX_INPUT_LENGTH);
  }

  // Pattern 1: @file:path or @path/to/file.ext (IDE @ reference)
  const atFilePattern = /@(?:file:)?([\w\\/.\-]+\.\w{1,10})/g;
  let match;
  while ((match = atFilePattern.exec(text)) !== null) {
    const filePath = match[1].trim();
    if (!seen.has(filePath.toLowerCase())) {
      seen.add(filePath.toLowerCase());
      anchorFiles.push(filePath);
    }
  }

  // Pattern 2: Explicit file names with known extensions (P2-5: Set-based extension check)
  // Matches things like: FarmRobotSettingSubUICtrl.lua, UserService.ts, config.yaml
  const CODE_EXTENSIONS = new Set([
    'lua', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'cs', 'cpp', 'c',
    'h', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'vue', 'svelte',
    'yaml', 'yml', 'json', 'xml', 'sql', 'sh', 'bat', 'ps1', 'css', 'scss', 'less', 'html',
  ]);
  const extAlternation = [...CODE_EXTENSIONS].join('|');
  const fileNamePattern = new RegExp('(?:^|[\\s"\'`(,])([A-Za-z_][\\w\\-.]*\\.(?:' + extAlternation + '))(?=[\\s"\'`),;]|$)', 'gm');
  while ((match = fileNamePattern.exec(text)) !== null) {
    const fileName = match[1].trim();
    if (!seen.has(fileName.toLowerCase())) {
      seen.add(fileName.toLowerCase());
      anchorFiles.push(fileName);
    }
  }

  // Pattern 3: Markdown-style [name](path) references
  const mdLinkPattern = /\[([^\]]+)\]\(([^)]+\.\w{1,10})\)/g;
  while ((match = mdLinkPattern.exec(text)) !== null) {
    const filePath = match[2].trim();
    if (!seen.has(filePath.toLowerCase())) {
      seen.add(filePath.toLowerCase());
      anchorFiles.push(filePath);
    }
  }

  // Pattern 4: Backtick-wrapped paths that look like files
  const backtickPattern = /`([\w\\/.\-]+\.\w{1,10})`/g;
  while ((match = backtickPattern.exec(text)) !== null) {
    const filePath = match[1].trim();
    // Accept if: has path separator, starts with uppercase, or has a source-code extension
    const hasPath = filePath.includes('/') || filePath.includes('\\');
    const hasCodeExt = /\.(lua|js|ts|tsx|jsx|py|java|cs|cpp|c|h|go|rs|rb|php|swift|kt|vue|svelte|yaml|yml|json|xml|sql|sh|bat|css|scss|html)$/i.test(filePath);
    if (hasPath || hasCodeExt || /^[A-Z]/.test(filePath)) {
      if (!seen.has(filePath.toLowerCase())) {
        seen.add(filePath.toLowerCase());
        anchorFiles.push(filePath);
      }
    }
  }

  const anchorNames = anchorFiles.map(f => path.basename(f).replace(/\.[^.]+$/, ''));

  return { anchorFiles, anchorNames };
}

class AnalystAgent extends BaseAgent {
  constructor(llmCall, hookEmitter, opts = {}) {
    super(AgentRole.ANALYST, llmCall, hookEmitter, opts);
    this._preComplexityLevel = opts.complexityLevel || null;
  }

  /**
   * Builds the analyst prompt.
   * Enforces strict role boundary: no technical details, no code.
   *
   * @param {string} inputContent - Raw user requirement text
   * @param {string|null} expContext - Experience context block from ExperienceStore (optional)
   * @returns {string}
   */
  buildPrompt(inputContent, expContext = null) {
    // ── CORE: Experience & Knowledge (loaded first — guides analysis) ──
    const expSection = expContext
      ? `\n### Past Experiences (Reference Before Analysis)\n${expContext}\n`
      : '';
    const knowledgeContext = this._loadKnowledgeContext();

    // ── CORE: JSON output instructions (requirement structure) ──
    const jsonInstruction = buildJsonBlockInstruction('analyst');

    // ── AUX: Code Graph seed (used for Module Map verification only) ──
    const codeGraphSeed = this._loadCodeGraphSeed();
    const importEdgeContext = this._buildImportEdgeContext();

    const { anchorFiles } = extractAnchorFiles(inputContent);
    let anchorSection = '';
    if (anchorFiles.length > 0) {
      console.error(`[AnalystAgent] Anchor files extracted: [${anchorFiles.join(', ')}]`);
      const topoCtx = this._loadTopologicalContext(anchorFiles);
      anchorSection = `\n### Anchor Files — Verify Your Module Map Against These\n${anchorFiles.map(f => `- \`${f}\``).join('\n')}\n\n**Usage**: Read the anchor files (offset/limit, NOT full file) to confirm module boundaries in your Module Map. Do NOT search broadly.\n${topoCtx}`;
    } else {
      const entityPattern = /\b([A-Z][a-zA-Z0-9]{2,}(?:[A-Z][a-z]+)+)\b/g;
      const entities = [];
      const entitySeen = new Set();
      let m;
      while ((m = entityPattern.exec(inputContent)) !== null) {
        if (!entitySeen.has(m[1])) { entitySeen.add(m[1]); entities.push(m[1]); }
      }
      if (entities.length > 0) {
        console.error(`[AnalystAgent] Inferred entity names: [${entities.slice(0, 8).join(', ')}]`);
        anchorSection = `\n### Inferred Entities — Verify Your Module Map Against These\n${entities.slice(0, 8).map(e => `- \`${e}\``).join('\n')}\n`;
      }
    }

    const isSimple = this._preComplexityLevel === 'simple';

    const extendedSections = isSimple
      ? `5. **Open Questions** – List any ambiguities (keep brief for simple tasks)
6. **Module Map** *(mandatory)* – Module ID, name, boundaries, dependencies, complexity, isolatable. ⚠️ REQUIRED. Even for 1-module changes, include the map.`
      : `5. **Open Questions** – Any ambiguities that need clarification before implementation
6. **Module Map** *(mandatory)* – A structured decomposition of the codebase into functional modules:
   - Based on your codebase research, identify the distinct functional modules affected by this requirement.
   - For each module, provide: a short ID (e.g. "mod-auth"), a descriptive name, a one-line description, file path boundaries (glob patterns), dependencies on other modules, complexity estimate (low/medium/high), and whether it is isolatable (can be designed/implemented independently).
   - Also identify cross-cutting concerns that span multiple modules (e.g. logging, error-handling, config).
   - This module map is used by downstream ARCHITECT stage to enable parallel architecture design.
   - If the requirement is small and touches only 1 module, still produce the map with that single module.
   - **If a "Codebase Module Structure (from Code Graph)" section is provided below, use it as seed information** to align your module boundaries with the actual directory structure. Your module boundaries (glob patterns) should correspond to real directories listed in the Code Graph summary.
   - ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.
   - Output format example:
     \`\`\`
     | Module ID | Name | Description | Boundaries | Dependencies | Complexity | Isolatable |
     |-----------|------|-------------|------------|--------------|------------|------------|
     | mod-auth  | Authentication | User login, registration, token management | src/auth/*, src/middleware/auth* | mod-db, mod-config | medium | yes |
     \`\`\`
     Cross-cutting concerns: logging, error-handling, configuration`;
// Section 6 "Architecture Design" and 7 "Execution Plan" moved to ARCHITECT/PLAN stages (Spec/Design 分离)
// Analyst contract (line 8-11) now consistent with output template

    const taskClassificationInstruction = `
**CRITICAL: Task Classification (REQUIRED in JSON block)**
You MUST include a "taskClassification" field in your JSON block. This is used to determine which pipeline stages to run.
Assess based on your ACTUAL analysis of the requirement and codebase — do NOT guess.
\`\`\`
"taskClassification": {
  "requiresCodeChange": true|false,
  "codeChangeReason": "Brief explanation of why code changes are/aren't needed",
  "complexity": "simple|moderate|complex|very_complex",
  "complexityScore": 0-100,
  "complexityReason": "Brief explanation of complexity assessment",
  "taskIntent": "full|design_only|analysis_only|review_only|research_only",
  "taskIntentReason": "Brief explanation of why this intent was chosen"
}
\`\`\`
Complexity guidelines:
- **simple** (0-25): Single file change, straightforward fix, no new dependencies
- **moderate** (26-50): 2-5 files, some logic changes, limited cross-module impact
- **complex** (51-75): Multiple modules, new APIs/interfaces, significant refactoring
- **very_complex** (76-100): System-wide changes, new subsystems, migration, multi-service coordination
Task intent guidelines:
- **full**: User wants working code — implement, fix, build, create, develop (DEFAULT if unclear)
- **design_only**: User wants a design/architecture plan — no code implementation needed
- **analysis_only**: User wants analysis, evaluation, comparison — no code changes, no architecture
- **review_only**: User wants a review/audit of existing code or architecture
- **research_only**: User wants research, investigation, or information gathering

**CRITICAL: Acceptance Criteria (AC) ID Format (MANDATORY)**
You MUST assign a unique ID to each Acceptance Criteria in the format \`AC-<3-digit-number>\` (e.g., AC-001, AC-002, AC-003).
These IDs MUST be consistent between:
  1. The markdown sections in \`output/requirement.md\` (format: \`### AC-001: <title>\`)
  2. The \`requirementsCheck\` array in the JSON block (format: \`"acId": "AC-001"\`)
  3. The Functional Acceptance Checklist in \`output/test-report.md\` (column: AC ID)

Example markdown section in requirement.md:
\`\`\`markdown
### AC-001: User can login with valid credentials
**WHEN** user enters valid username and password
**THEN** system should authenticate and redirect to dashboard
**IF** credentials are valid
\`\`\`

Example JSON block entry:
\`\`\`json
{
  "reqId": "REQ-1",
  "description": "User Authentication",
  "acId": "AC-001",
  "chkId": "CHK-1.1",
  "chkDescription": "Verify user can login with valid credentials",
  "priority": "HIGH"
}
\`\`\`

**WARNING**: Missing or inconsistent AC IDs will cause TEST stage validation to FAIL.`;

    const jsonSection = `${jsonInstruction}\n\n**IMPORTANT for JSON block**: The JSON metadata block MUST include a "moduleMap" field with this structure:\n\`\`\`\n"moduleMap": {\n  "modules": [\n    {\n      "id": "mod-xxx",\n      "name": "Module Name",\n      "description": "One-line description",\n      "boundaries": ["src/xxx/*", "src/yyy/*"],\n      "dependencies": ["mod-yyy"],\n      "complexity": "low|medium|high",\n      "isolatable": true|false\n    }\n  ],\n  "crossCuttingConcerns": ["logging", "error-handling"]\n}\n\`\`\`\n${taskClassificationInstruction}`;

    const template = this.loadPersona('analyst');
    const skillConstraints = PersonaLoader.extractSpecTemplateConstraints();
    return this.buildPromptFromTemplate(template, {
      inputContent,
      anchorSection,
      expSection,
      extendedSections,
      jsonSection,
      skillConstraints,
      codeGraphSeed,
      importEdgeContext,
      knowledgeContext,
      requirementsCheckInstruction: `
## Requirements Check Table (MANDATORY in JSON block)

You MUST include a "requirementsCheck" field in your JSON output. This is the structured checklist
that the TEST stage will use to verify every requirement one-by-one.

\`\`\`
"requirementsCheck": [
  {
    "reqId": "REQ-1",
    "description": "Brief requirement description",
    "chkId": "CHK-1.1",
    "chkDescription": "Verifiable condition (WHEN ... THEN ...)",
    "priority": "HIGH|MEDIUM|LOW"
  }
]
\`\`\`

Rules:
- Each requirement (REQ-xxx) may have 1-5 checks (CHK-xxx.y)
- Each CHK must be a verifiable condition using WHEN/THEN format
- All HIGH priority CHKs must pass before TEST stage can succeed
- Maximum 20 CHKs total across all requirements`,
    });
  }

  /**
   * Loads a compact Code Graph summary to seed the Module Map.
   * Reads output/code-graph.md and extracts module structure + hotspot data.
   * Non-fatal: returns empty string if the file is unavailable.
   */
  _loadCodeGraphSeed() {
    try {
      const cgPath = path.join(this._outputDir, 'code-graph.md');
      if (!fs.existsSync(cgPath)) {
        // Fallback to project-root-relative path
        const altPath = path.join(path.dirname(this._outputDir), 'output', 'code-graph.md');
        if (!fs.existsSync(altPath)) {
          this._logContextUsage('code-graph', 'miss');
          return '';
        }
        this._logContextUsage('code-graph', 'hit', { source: 'code-graph.md' });
        return this._formatCodeGraphSeed(fs.readFileSync(altPath, 'utf-8'));
      }
      this._logContextUsage('code-graph', 'hit', { source: 'code-graph.md' });
      return this._formatCodeGraphSeed(fs.readFileSync(cgPath, 'utf-8'));
    } catch (_) {
      return '';
    }
  }

  /**
   * Loads transitive call chain context for anchor files via CodeGraph BFS.
   * Temporarily bypasses IDE detection to ensure call edges are built.
   * @param {string[]} anchorFiles
   * @returns {string} Markdown summary of 2-hop call chain
   */
  _loadTopologicalContext(anchorFiles) {
    if (!anchorFiles || anchorFiles.length === 0) return '';
    try {
      // Temporarily bypass IDE detection so CodeGraph builds call edges
      const saveVsCode = process.env.VSCODE_PID;
      const saveVsCodeCwd = process.env.VSCODE_CWD;
      delete process.env.VSCODE_PID;
      delete process.env.VSCODE_CWD;
      try {
        const { getCodeGraph } = require('../core/code-graph');
        const cg = typeof getCodeGraph === 'function'
          ? getCodeGraph({ projectRoot: this._projectRoot || path.resolve(this._outputDir, '..') })
          : null;
        if (!cg || typeof cg.getTopologicalContext !== 'function') return '';
        const topo = cg.getTopologicalContext(anchorFiles, 2);
        if (!topo || !topo.symbols || topo.symbols.length === 0) return '';
        const byHop = topo.byHop;
        let ctx = '\n\n### Call Chain Analysis (2-hop)\n';
        for (const [hop, syms] of byHop) {
          if (hop === 0 || !syms || syms.length === 0) continue;
          const names = syms.slice(0, 12).map(s => s.name || s.id).filter(Boolean);
          if (names.length === 0) continue;
          ctx += `- Hop ${hop}: ${names.join(', ')}${syms.length > 12 ? ' ...' : ''}\n`;
        }
        return ctx;
      } finally {
        if (saveVsCode) process.env.VSCODE_PID = saveVsCode;
        if (saveVsCodeCwd) process.env.VSCODE_CWD = saveVsCodeCwd;
      }
    } catch (_) {
      return '';
    }
  }

  _formatCodeGraphSeed(content) {
    // Extract Overview metrics + Directory Groups (the most useful data for Module Map)
    // DELIBERATELY skip Hotspot Analysis — individual symbol names are noise.
    const overviewMatch = content.match(/## Overview[\s\S]*?(?=##\s|$)/i);
    const dirGroupsMatch = content.match(/## Directory Groups[\s\S]*?(?=##\s|$)/i);
    // Fallback to Top Files if Directory Groups not yet generated
    const topFilesMatch = content.match(/## Top Files by Symbol Count[\s\S]*?(?=##\s|$)/i);

    const parts = [];
    if (overviewMatch) parts.push(`## Codebase Metrics\n${overviewMatch[0].match(/^\|.*\|/gm)?.join('\n') || overviewMatch[0].trim()}`);
    if (dirGroupsMatch) {
      parts.push(dirGroupsMatch[0].trim());
    } else if (topFilesMatch) {
      const lines = topFilesMatch[0].split('\n');
      parts.push([lines[0], lines[1], ...lines.slice(2).filter(l => l.includes('|')).slice(0, 8)].join('\n'));
    }

    if (parts.length === 0) return '';

    const combined = `## Codebase Structure (from Code Graph)\n${parts.join('\n\n')}`;
    const CAP = 1200;
    const seed = combined.length > CAP ? combined.slice(0, CAP) + '\n> ... (truncated)' : combined;

    return `\n${seed}\n\n> ⚠️ These are static facts (metrics, directory distribution).\n> Use them to understand WHERE code lives and estimate complexity.\n> You determine business module boundaries — Code Graph only shows file/symbol distribution.\n`;
  }

  /**
   * Builds import-edge based dependency context from CodeGraph._importEdges.
   * Cross-validates LLM-generated moduleMap against actual file-level dependencies.
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
      lines.push(`> Use this to verify your Module Map — actual file dependencies should align with declared module dependencies.`);
      lines.push(`> A file with 0 importers in a module vs 5+ importers in another signals a boundary error.`);
      return lines.join('\n');
    } catch (_) {
      return '';
    }
  }

  /**
   * Parses the LLM response.
   * Validates that no code blocks or technical keywords slipped through.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // ── P1-9: Verify Socratic reasoning section presence ───────────────
    if (!llmResponse.includes('## 🧠') && !llmResponse.includes('## 思考推理过程') && !llmResponse.includes('## Analysis Reasoning') && !llmResponse.includes('## 分析推理')) {
      console.warn(`[AnalystAgent] ⚠️  Socratic reasoning section missing. Add '## 🧠 Analysis Reasoning' or '## 思考推理过程' with: (1) what user REALLY needs, (2) complexity assessment, (3) unstated assumptions, (4) minimal requirements capturing full intent.`);
    }

    // P0-NEW-1: validate JSON block presence (imports hoisted to file top – P1-1 fix)
    const jsonBlock = extractJsonBlock(llmResponse);
    if (!jsonBlock) {
      console.warn(`[AnalystAgent] ⚠️  No structured JSON block found in output. Downstream agents will use regex-based extraction (degraded mode).`);
    } else {
      const check = validateJsonBlock(jsonBlock, 'analyst');
      if (!check.valid) {
        console.warn(`[AnalystAgent] ⚠️  JSON block validation failed: ${check.reason}`);
      } else {
        console.error(`[AnalystAgent] ✅ Structured JSON block validated (${Object.keys(jsonBlock).length} fields).`);
      }
    }

    // Warn if technical content detected (soft check – does not block)
    const technicalPatterns = [/```[\w]*\n/, /class\s+\w+/, /function\s+\w+\s*\(/, /import\s+\w+/];
    for (const pattern of technicalPatterns) {
      if (pattern.test(llmResponse)) {
        console.warn(`[AnalystAgent] WARNING: Technical content detected in requirement.md output. Review recommended.`);
        break;
      }
    }

    // ── P2: Parse validation state (initialised before checks) ──────────
    let parseWarnings = [];
    let parseModuleCount = 0;
    let parseModuleMapValid = false;

    // ── Mandatory section compliance check (P1-4: bilingual support) ────────
    // Architecture Design + Execution Plan moved to ARCHITECT/PLAN (Spec/Design 分离)
    checkMandatorySections(llmResponse, [
      { en: 'Module Map', zh: '功能模块' },
      { en: 'Requirements Quality Checks', zh: '需求质量检查' },
    ], { agentName: 'AnalystAgent', mode: 'warn' });

    // ── P1 quality diagnostics: EARS / IDs / measurable NFR ───────────────
    const hasReqIds = /REQ-\d{3,}/i.test(llmResponse) || /AC-\d{3,}/i.test(llmResponse);
    if (!hasReqIds) {
      console.warn(`[AnalystAgent] ⚠️  QUALITY: No stable requirement IDs detected (expected REQ-xxx / AC-xxx).`);
    }

    const hasEarsPattern = /(\bWHEN\b[\s\S]{0,120}\bSHALL\b)|(\bIF\b[\s\S]{0,120}\bTHEN\b[\s\S]{0,120}\bSHALL\b)|(\bWHILE\b[\s\S]{0,120}\bSHALL\b)/i.test(llmResponse);
    if (!hasEarsPattern) {
      console.warn(`[AnalystAgent] ⚠️  QUALITY: EARS-style acceptance criteria pattern not detected (WHEN/IF-THEN/WHILE + SHALL).`);
    }

    const hasMeasurableNfr = /(latency|throughput|error\s*rate|availability|uptime|p95|p99|qps|rps|sla|slo|mttr|security|reliability)/i.test(llmResponse)
      && /(\d+\s*(ms|s|sec|seconds|%|qps|rps|requests|req\/s|ops))/i.test(llmResponse);
    if (!hasMeasurableNfr) {
      console.warn(`[AnalystAgent] ⚠️  QUALITY: Measurable NFR targets not clearly detected (e.g. p95 latency < 200ms, error rate < 0.1%).`);
    }

    // ── Module Map validation ──────────────────────────────────────────────
    // Verify that the JSON block contains a valid moduleMap structure.
    // Enhanced validation: checks id/name, boundaries, dependencies cross-ref,
    // complexity enum, and isolatable type to prevent invalid data reaching ARCHITECT.
    if (jsonBlock && jsonBlock.moduleMap) {
      const mm = jsonBlock.moduleMap;
      if (Array.isArray(mm.modules) && mm.modules.length > 0) {
        const validModules = mm.modules.filter(m => m.id && m.name);
        const isolatableCount = mm.modules.filter(m => m.isolatable).length;
        console.error(`[AnalystAgent] 🗺️  Module Map: ${validModules.length} module(s), ${isolatableCount} isolatable, ${(mm.crossCuttingConcerns || []).length} cross-cutting concern(s).`);
        if (validModules.length < mm.modules.length) {
          console.warn(`[AnalystAgent] ⚠️  Module Map: ${mm.modules.length - validModules.length} module(s) missing required 'id' or 'name' field.`);
        }

        // ── Enhanced validation (P2): structural integrity checks ──────────
        const moduleIds = new Set(mm.modules.map(m => m.id).filter(Boolean));
        const VALID_COMPLEXITY = new Set(['low', 'medium', 'high']);

        for (const mod of mm.modules) {
          if (!mod.id) continue;

          if (!Array.isArray(mod.boundaries) || mod.boundaries.length === 0) {
            parseWarnings.push(`Module "${mod.id}": missing or empty 'boundaries' array`);
          } else {
            const emptyBoundaries = mod.boundaries.filter(b => typeof b !== 'string' || !b.trim());
            if (emptyBoundaries.length > 0) {
              parseWarnings.push(`Module "${mod.id}": ${emptyBoundaries.length} invalid boundary value(s)`);
            }
          }

          if (Array.isArray(mod.dependencies)) {
            const unknownDeps = mod.dependencies.filter(dep => !moduleIds.has(dep));
            if (unknownDeps.length > 0) {
              parseWarnings.push(`Module "${mod.id}": unknown dependency ID(s): [${unknownDeps.join(', ')}]`);
            }
          }

          if (mod.complexity && !VALID_COMPLEXITY.has(mod.complexity)) {
            parseWarnings.push(`Module "${mod.id}": invalid complexity "${mod.complexity}" (expected: low/medium/high)`);
          }

          if (mod.isolatable !== undefined && typeof mod.isolatable !== 'boolean') {
            parseWarnings.push(`Module "${mod.id}": 'isolatable' should be boolean, got ${typeof mod.isolatable}`);
          }
        }

        parseModuleCount = validModules.length;
        parseModuleMapValid = parseModuleCount > 0;

        if (parseWarnings.length > 0) {
          console.warn(`[AnalystAgent] ⚠️  Module Map structural issues (${parseWarnings.length}):`);
          for (const w of parseWarnings.slice(0, 8)) {
            console.warn(`[AnalystAgent]    - ${w}`);
          }
          if (parseWarnings.length > 8) {
            console.warn(`[AnalystAgent]    ... and ${parseWarnings.length - 8} more`);
          }
        } else {
          console.error(`[AnalystAgent] ✅ Module Map structural validation passed (${parseModuleCount} module(s), all fields valid).`);
        }
      } else {
        console.warn(`[AnalystAgent] ⚠️  Module Map: 'modules' array is empty or missing. Downstream ARCHITECT may not benefit from parallel design.`);
      }
    } else if (jsonBlock) {
      console.warn(`[AnalystAgent] ⚠️  Module Map: No 'moduleMap' field found in JSON block. ARCHITECT stage will use single-pass design.`);
    }

    // ── P2: Store validation results for downstream consumption ───────
    this._parseWarnings = parseWarnings;
    this._parseModuleMapValid = parseModuleMapValid;
    this._parseModuleCount = parseModuleCount;

    return llmResponse;
  }
}

module.exports = { AnalystAgent, extractAnchorFiles };
