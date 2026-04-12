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

const path = require('path');
const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');
const { buildJsonBlockInstruction, extractJsonBlock, validateJsonBlock } = require('../core/agent-output-schema');

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

  // Pattern 2: Explicit file names with known extensions
  // Matches things like: FarmRobotSettingSubUICtrl.lua, UserService.ts, config.yaml
  const fileNamePattern = /(?:^|[\s"'`(,])([A-Za-z_][\w\-.]*\.(?:lua|js|ts|tsx|jsx|py|java|cs|cpp|c|h|go|rs|rb|php|swift|kt|vue|svelte|yaml|yml|json|xml|sql|sh|bat|ps1|css|scss|less|html))(?=[\s"'`),;]|$)/gm;
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
    const expSection = expContext
      ? `\n## Accumulated Experience (Reference Before Analysis)\n${expContext}\n`
      : '';
    // P0-NEW-1: inject structured JSON output instruction
    const jsonInstruction = buildJsonBlockInstruction('analyst');

    // ── Anchor File Extraction ────────────────────────────────────────────
    // Extract user-referenced files (@file or explicit names) from the requirement.
    // These are injected as an "Anchor Files" section so the LLM focuses its
    // codebase research on these files and their direct dependencies, instead
    // of performing broad exploratory searches across the entire project.
    const { anchorFiles, anchorNames } = extractAnchorFiles(inputContent);
    let anchorSection = '';
    if (anchorFiles.length > 0) {
      console.error(`[AnalystAgent] \uD83D\uDCCC Anchor files extracted: [${anchorFiles.join(', ')}]`);
      anchorSection = `\n## Anchor Files (User-Referenced)\nThe user has explicitly referenced the following files. **Focus your codebase research on these files and their direct dependencies ONLY.** Do NOT search broadly across the project.\n${anchorFiles.map(f => `- \`${f}\``).join('\n')}\n\n**Search strategy**: Start by reading these anchor files. Then identify their imports/dependencies and callers. Do NOT search for unrelated files.\n`;
    } else {
      // No explicit file references — extract entity names for focused search
      const entityPattern = /\b([A-Z][a-zA-Z0-9]{2,}(?:[A-Z][a-z]+)+)\b/g;
      const entities = [];
      const entitySeen = new Set();
      let m;
      while ((m = entityPattern.exec(inputContent)) !== null) {
        if (!entitySeen.has(m[1])) {
          entitySeen.add(m[1]);
          entities.push(m[1]);
        }
      }
      if (entities.length > 0) {
        console.error(`[AnalystAgent] \uD83D\uDD0D Inferred entity names: [${entities.slice(0, 8).join(', ')}]`);
        anchorSection = `\n## Inferred Entities\nNo explicit file references found. The following entity names were extracted from the requirement. **Search for these specific names only** — do NOT perform broad exploratory searches.\n${entities.slice(0, 8).map(e => `- \`${e}\``).join('\n')}\n`;
      }
    }

    // NOTE: Role identity, thinking process, analysis principles, negative examples,
    // complexity assessment, module map construction, and output language are all
    // defined in AGENT_FIXED_PREFIXES.analyst (prompt-agent-prefixes.js).
    // This buildPrompt() only defines the OUTPUT FORMAT and injects dynamic content
    // (anchor files, experience, JSON instruction). See Optimization A (token dedup).

    // Optimization F: Conditional prompt injection based on pre-assessed complexity.
    // For simple tasks, skip verbose section descriptions (5-8) and Module Map example.
    // The Fixed Prefix already instructs: "Simple tasks: streamline to minimal spec,
    // skip chapters 5-8. Still produce Module Map (even if just 1 module)."
    const isSimple = this._preComplexityLevel === 'simple';

    // Sections 1-4 are always included (core requirement structure)
    const coreSections = `## Output Format
Produce a Markdown document with the following sections:
1. **Overview** – One-paragraph summary of the business goal
2. **User Stories** – Bullet list of "As a [role], I want [goal], so that [benefit]"
3. **Acceptance Criteria** – Numbered list of verifiable conditions (WHEN/THEN/IF format)
4. **Out of Scope** – Explicit list of things NOT included in this requirement`;

    // Sections 5-8: verbose for complex tasks, compact for simple tasks
    const extendedSections = isSimple
      ? `5. **Open Questions** – List any ambiguities (keep brief for simple tasks)
6. **Architecture Design** *(mandatory)* – Key entities, functional boundaries, constraints. ⚠️ REQUIRED.
7. **Execution Plan** *(mandatory)* – Clarifications applied, assumptions made, remaining risks. ⚠️ REQUIRED.
8. **Functional Module Map** *(mandatory)* – Module ID, name, boundaries, dependencies, complexity, isolatable. ⚠️ REQUIRED. Even for 1-module changes, include the map.`
      : `5. **Open Questions** – Any ambiguities that need clarification before implementation
6. **Architecture Design** *(mandatory)* – High-level analysis of the problem domain:
   - Key entities and their relationships
   - Major functional boundaries (what subsystems are implied by the requirements)
   - Constraints and non-functional requirements identified from the user's request
   - ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.
7. **Execution Plan** *(mandatory)* – Ordered list of analysis steps taken and decisions made:
   - What clarifications were applied to the raw requirement
   - What assumptions were made and why
   - What risks or ambiguities remain unresolved
   - ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.
8. **Functional Module Map** *(mandatory)* – A structured decomposition of the codebase into functional modules:
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

    // P1 optimization: structured requirement quality constraints
    const qualitySection = `9. **Requirements Quality Checks** *(mandatory)*:
   - Provide stable IDs for requirements and acceptance criteria (e.g. REQ-001, AC-001)
   - Prefer EARS-style acceptance criteria: use structured forms such as
     - WHEN <trigger>, the system SHALL <response>
     - IF <precondition>, THEN the system SHALL <response>
     - WHILE <state>, the system SHALL <response>
   - User stories should satisfy INVEST (Independent, Negotiable, Valuable, Estimable, Small, Testable)
   - Include a **Non-Functional Requirements** subsection with measurable targets (e.g. latency, throughput, error rate, security, reliability)
   - ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance warning.`;

    // ── Task Classification instruction (LLM-assessed complexity & code-change detection) ──
    // This replaces the regex-based complexity estimation with a direct LLM judgment.
    // The LLM has already read the code, searched files, and analyzed the root cause —
    // its assessment of "does this need code changes" and "how complex is it" is far
    // more accurate than any keyword-matching heuristic.
    const taskClassificationInstruction = `
**CRITICAL: Task Classification (REQUIRED in JSON block)**
You MUST include a "taskClassification" field in your JSON block. This is used to determine which pipeline stages to run.
Assess based on your ACTUAL analysis of the requirement and codebase — do NOT guess.
\`\`\`
"taskClassification": {
  "requiresCodeChange": true|false,   // Does this task require modifying/creating source code files?
  "codeChangeReason": "Brief explanation of why code changes are/aren't needed",
  "complexity": "simple|moderate|complex|very_complex",  // Overall task complexity
  "complexityScore": 0-100,           // Numeric score: 0-25=simple, 26-50=moderate, 51-75=complex, 76-100=very_complex
  "complexityReason": "Brief explanation of complexity assessment",
  "taskIntent": "full|design_only|analysis_only|review_only|research_only",  // What type of deliverable does the user want?
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
- **research_only**: User wants research, investigation, or information gathering`;

    // JSON block instruction: compact for simple tasks
    const jsonSection = isSimple
      ? `${jsonInstruction}

**IMPORTANT**: JSON block MUST include "moduleMap" with modules array (id, name, description, boundaries, dependencies, complexity, isolatable) and crossCuttingConcerns array.
${taskClassificationInstruction}`
      : `${jsonInstruction}

**IMPORTANT for JSON block**: The JSON metadata block MUST include a "moduleMap" field with this structure:
\`\`\`
"moduleMap": {
  "modules": [
    {
      "id": "mod-xxx",
      "name": "Module Name",
      "description": "One-line description",
      "boundaries": ["src/xxx/*", "src/yyy/*"],
      "dependencies": ["mod-yyy"],
      "complexity": "low|medium|high",
      "isolatable": true|false
    }
  ],
  "crossCuttingConcerns": ["logging", "error-handling"]
}
\`\`\`
${taskClassificationInstruction}`;

    return `${coreSections}
${extendedSections}
${qualitySection}

${jsonSection}

## User Requirement
${inputContent}
${anchorSection}${expSection}
## Instructions
First output the JSON metadata block (as instructed above), then write the full Markdown document.
Remember: NO technical details, NO code, NO architecture.
**CRITICAL**: Sections 6 (Architecture Design) and 7 (Execution Plan) are MANDATORY. Do not omit them.
**CRITICAL**: Include stable requirement IDs (REQ-xxx / AC-xxx) and measurable NFR targets.`;
  }

  /**
   * Parses the LLM response.
   * Validates that no code blocks or technical keywords slipped through.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
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

    // ── Mandatory section compliance check (P1-4: bilingual support) ────────
    // Verify that the mandatory sections are present (English or Chinese).
    const mandatorySections = [
      { en: 'Architecture Design', zh: '架构设计' },
      { en: 'Execution Plan', zh: '执行计划' },
      { en: 'Functional Module Map', zh: '功能模块' },
      { en: 'Requirements Quality Checks', zh: '需求质量检查' },
    ];
    const missingSections = mandatorySections.filter(s => !llmResponse.includes(s.en) && !llmResponse.includes(s.zh));
    if (missingSections.length > 0) {
      console.warn(`[AnalystAgent] ⚠️  COMPLIANCE: Missing mandatory section(s): ${missingSections.map(s => s.en).join(', ')}. The agent output specification requires these sections.`);
    } else {
      console.error(`[AnalystAgent] ✅ Mandatory sections present: Architecture Design, Execution Plan, Functional Module Map.`);
    }

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
        const warnings = [];

        for (const mod of mm.modules) {
          if (!mod.id) continue; // Already reported above

          // Check boundaries: must be non-empty array of non-empty strings
          if (!Array.isArray(mod.boundaries) || mod.boundaries.length === 0) {
            warnings.push(`Module "${mod.id}": missing or empty 'boundaries' array`);
          } else {
            const emptyBoundaries = mod.boundaries.filter(b => typeof b !== 'string' || !b.trim());
            if (emptyBoundaries.length > 0) {
              warnings.push(`Module "${mod.id}": ${emptyBoundaries.length} invalid boundary value(s)`);
            }
          }

          // Check dependencies: must reference existing module IDs
          if (Array.isArray(mod.dependencies)) {
            const unknownDeps = mod.dependencies.filter(dep => !moduleIds.has(dep));
            if (unknownDeps.length > 0) {
              warnings.push(`Module "${mod.id}": unknown dependency ID(s): [${unknownDeps.join(', ')}]`);
            }
          }

          // Check complexity: must be one of low/medium/high
          if (mod.complexity && !VALID_COMPLEXITY.has(mod.complexity)) {
            warnings.push(`Module "${mod.id}": invalid complexity "${mod.complexity}" (expected: low/medium/high)`);
          }

          // Check isolatable: must be boolean
          if (mod.isolatable !== undefined && typeof mod.isolatable !== 'boolean') {
            warnings.push(`Module "${mod.id}": 'isolatable' should be boolean, got ${typeof mod.isolatable}`);
          }
        }

        if (warnings.length > 0) {
          console.warn(`[AnalystAgent] ⚠️  Module Map structural issues (${warnings.length}):`);
          for (const w of warnings.slice(0, 8)) {
            console.warn(`[AnalystAgent]    - ${w}`);
          }
          if (warnings.length > 8) {
            console.warn(`[AnalystAgent]    ... and ${warnings.length - 8} more`);
          }
        } else {
          console.error(`[AnalystAgent] ✅ Module Map structural validation passed (${validModules.length} module(s), all fields valid).`);
        }
      } else {
        console.warn(`[AnalystAgent] ⚠️  Module Map: 'modules' array is empty or missing. Downstream ARCHITECT may not benefit from parallel design.`);
      }
    } else if (jsonBlock) {
      console.warn(`[AnalystAgent] ⚠️  Module Map: No 'moduleMap' field found in JSON block. ARCHITECT stage will use single-pass design.`);
    }

    return llmResponse;
  }
}

module.exports = { AnalystAgent, extractAnchorFiles };
