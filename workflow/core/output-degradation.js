/**
 * Output Degradation Engine (GDE L1) – Single LLM output graceful degradation
 *
 * Combats uncertainty: LLM single-output may have format errors, missing fields, or hollow content.
 *
 * Inspiration: Resilience4j fallback function concept
 * Key difference: Instead of calling a backup service, we structurally repair damaged output.
 *
 * Degradation levels (progressive):
 *   NONE     → Output is perfect, no degradation needed
 *   REPAIRED → Format repaired (JSON fix, Markdown fix)
 *   PARTIAL  → Partially usable (critical fields present, non-critical filled with defaults)
 *   MINIMAL  → Minimum viable (skeleton only, marked for human review)
 *   FAILED   → Completely unusable, triggers rollback
 *
 * Design:
 *   - Zero LLM calls: pure rule engine + templates
 *   - Per-role repair strategies and minimal templates
 *   - Metrics tracking for observability
 *   - Learning loop: degradation events feed into ExperienceStore
 *
 * @module output-degradation
 */

'use strict';

// ─── Degradation Levels ─────────────────────────────────────────────────────

const DegradationLevel = {
  NONE:     'none',
  REPAIRED: 'repaired',
  PARTIAL:  'partial',
  MINIMAL:  'minimal',
  FAILED:   'failed',
};

// ─── Role-specific Field Definitions ────────────────────────────────────────

/**
 * Defines critical and non-critical fields per Agent role.
 * Critical fields: output is FAILED without them.
 * Non-critical fields: can be filled with defaults.
 */
const ROLE_FIELD_SPECS = {
  analyst: {
    critical: ['requirements', 'modules', 'scope'],
    nonCritical: ['risks', 'priorities', 'assumptions', 'constraints'],
    sectionMarkers: {
      requirements: /##?\s*(Requirements?|需求)/i,
      modules:      /##?\s*(Modules?|模块)/i,
      scope:        /##?\s*(Scope|范围)/i,
      risks:        /##?\s*(Risks?|风险)/i,
      priorities:   /##?\s*(Priorit|优先级)/i,
    },
  },
  architect: {
    critical: ['modules', 'interfaces', 'architecture'],
    nonCritical: ['techStack', 'alternatives', 'tradeoffs', 'diagrams'],
    sectionMarkers: {
      modules:      /##?\s*(Modules?|模块划分)/i,
      interfaces:   /##?\s*(Interfaces?|接口定义)/i,
      architecture: /##?\s*(Architecture|架构)/i,
      techStack:    /##?\s*(Tech\s*Stack|技术选型)/i,
      alternatives: /##?\s*(Alternatives?|替代方案)/i,
    },
  },
  developer: {
    critical: ['changes', 'files'],
    nonCritical: ['comments', 'testSuggestions', 'refactorNotes'],
    sectionMarkers: {
      changes: /##?\s*(Changes?|变更|Modifications?)/i,
      files:   /##?\s*(Files?|文件)/i,
    },
  },
  'coding-agent': {
    critical: ['changes', 'files'],
    nonCritical: ['comments', 'testSuggestions', 'refactorNotes'],
    sectionMarkers: {
      changes: /##?\s*(Changes?|变更|Modifications?)/i,
      files:   /##?\s*(Files?|文件)/i,
    },
  },
  tester: {
    critical: ['testCases', 'testPlan'],
    nonCritical: ['coverage', 'edgeCases', 'performanceTests'],
    sectionMarkers: {
      testCases: /##?\s*(Test\s*Cases?|测试用例)/i,
      testPlan:  /##?\s*(Test\s*Plan|测试计划)/i,
      coverage:  /##?\s*(Coverage|覆盖率)/i,
    },
  },
};

// ─── Minimal Templates ──────────────────────────────────────────────────────

/**
 * Minimal viable output templates per role.
 * Used when critical fields are missing and cannot be inferred.
 */
const MINIMAL_TEMPLATES = {
  analyst: [
    '## Requirements',
    '- [ ] [NEEDS HUMAN REVIEW — auto-degraded output]',
    '',
    '## Modules',
    '- [ ] [NEEDS HUMAN REVIEW — modules could not be extracted]',
    '',
    '## Scope',
    '- [Auto-degraded: original output was incomplete]',
    '',
    '> ⚠️ **Degraded Output**: This is a minimal template. The original LLM output',
    '> was missing critical sections. Please review and fill in the details.',
  ].join('\n'),

  architect: [
    '## Architecture',
    '- [ ] [NEEDS HUMAN REVIEW — auto-degraded output]',
    '',
    '## Modules',
    '- [ ] [NEEDS HUMAN REVIEW — module breakdown could not be extracted]',
    '',
    '## Interfaces',
    '- [ ] [NEEDS HUMAN REVIEW — interface definitions missing]',
    '',
    '> ⚠️ **Degraded Output**: This is a minimal architecture template.',
    '> The original LLM output was missing critical sections.',
  ].join('\n'),

  developer: [
    '## Changes',
    '- [ ] [NEEDS HUMAN REVIEW — code changes could not be extracted]',
    '',
    '## Files',
    '- [ ] [NEEDS HUMAN REVIEW — file list missing]',
    '',
    '> ⚠️ **Degraded Output**: This is a minimal template.',
    '> The original LLM output was incomplete.',
  ].join('\n'),

  'coding-agent': [
    '## Changes',
    '- [ ] [NEEDS HUMAN REVIEW — code changes could not be extracted]',
    '',
    '## Files',
    '- [ ] [NEEDS HUMAN REVIEW — file list missing]',
    '',
    '> ⚠️ **Degraded Output**: This is a minimal template.',
  ].join('\n'),

  tester: [
    '## Test Plan',
    '- [ ] [NEEDS HUMAN REVIEW — test plan could not be extracted]',
    '',
    '## Test Cases',
    '- [ ] [NEEDS HUMAN REVIEW — test cases missing]',
    '',
    '> ⚠️ **Degraded Output**: This is a minimal test template.',
  ].join('\n'),
};

// ─── Output Degradation Engine ──────────────────────────────────────────────

class OutputDegradationEngine {
  /**
   * @param {object} [config]
   * @param {number} [config.minContentLength=50]   - Minimum chars for non-empty output
   * @param {number} [config.minWordCount=10]        - Minimum words for meaningful content
   * @param {boolean} [config.enableJsonRepair=true] - Attempt JSON structure repair
   * @param {boolean} [config.enableMarkdownRepair=true] - Attempt Markdown structure repair
   */
  constructor(config = {}) {
    this._config = {
      minContentLength: config.minContentLength || 50,
      minWordCount: config.minWordCount || 10,
      enableJsonRepair: config.enableJsonRepair !== false,
      enableMarkdownRepair: config.enableMarkdownRepair !== false,
    };

    /** @type {{ repaired: number, partial: number, minimal: number, failed: number, none: number }} */
    this._metrics = { none: 0, repaired: 0, partial: 0, minimal: 0, failed: 0 };

    /** @type {Array<{ timestamp: string, role: string, level: string, repairs: string[] }>} */
    this._history = [];
  }

  /**
   * Attempts to degrade/repair an LLM output to the highest usable level.
   *
   * @param {string} rawOutput - Raw LLM output string
   * @param {string} role      - Agent role (analyst/architect/developer/tester)
   * @param {object} [context] - Optional stage context for smarter repair
   * @param {string} [context.taskText]     - Original task description
   * @param {string} [context.previousOutput] - Previous stage output (for continuity)
   * @returns {{ output: string, level: string, repairs: string[], metrics: object }}
   */
  degrade(rawOutput, role, context = {}) {
    const repairs = [];
    const normalizedRole = (role || 'developer').toLowerCase();

    // Phase 0: Check for completely empty/null output
    if (!rawOutput || rawOutput.trim().length === 0) {
      return this._buildResult(
        MINIMAL_TEMPLATES[normalizedRole] || MINIMAL_TEMPLATES.developer,
        DegradationLevel.MINIMAL,
        ['empty_output_replaced_with_template'],
        normalizedRole
      );
    }

    let output = rawOutput;

    // Phase 1: Structural repair (JSON / Markdown)
    const structuralResult = this._repairStructure(output, normalizedRole);
    if (structuralResult.repaired) {
      output = structuralResult.output;
      repairs.push(...structuralResult.repairs);
    }

    // Phase 2: Check critical field completeness
    const fieldCheck = this._checkFieldCompleteness(output, normalizedRole);

    if (fieldCheck.allCriticalPresent) {
      // All critical fields present
      if (fieldCheck.missingNonCritical.length > 0) {
        // Fill non-critical fields with defaults
        output = this._fillNonCriticalDefaults(output, normalizedRole, fieldCheck.missingNonCritical);
        repairs.push(`filled_defaults: ${fieldCheck.missingNonCritical.join(', ')}`);
        const level = repairs.length > 0 ? DegradationLevel.REPAIRED : DegradationLevel.NONE;
        return this._buildResult(output, level, repairs, normalizedRole);
      }
      // Perfect output
      if (repairs.length === 0) {
        return this._buildResult(output, DegradationLevel.NONE, repairs, normalizedRole);
      }
      return this._buildResult(output, DegradationLevel.REPAIRED, repairs, normalizedRole);
    }

    // Phase 3: Some critical fields missing — try partial recovery
    if (fieldCheck.missingCritical.length < fieldCheck.totalCritical) {
      // At least some critical fields present — PARTIAL
      const partialNote = `\n\n> ⚠️ **Partially Degraded**: Missing critical sections: ${fieldCheck.missingCritical.join(', ')}. Please review.`;
      output = output + partialNote;
      repairs.push(`missing_critical: ${fieldCheck.missingCritical.join(', ')}`);
      return this._buildResult(output, DegradationLevel.PARTIAL, repairs, normalizedRole);
    }

    // Phase 4: All critical fields missing — check if content is still meaningful
    const wordCount = output.split(/\s+/).filter(w => w.length > 1).length;
    if (wordCount >= this._config.minWordCount && output.length >= this._config.minContentLength) {
      // Content exists but lacks structure — PARTIAL with warning
      const structureNote = `\n\n> ⚠️ **Degraded**: Output lacks expected structure for ${normalizedRole} role. Content preserved but needs restructuring.`;
      output = output + structureNote;
      repairs.push('unstructured_content_preserved');
      return this._buildResult(output, DegradationLevel.PARTIAL, repairs, normalizedRole);
    }

    // Phase 5: Content is too thin — use minimal template
    repairs.push('insufficient_content_replaced_with_template');
    return this._buildResult(
      MINIMAL_TEMPLATES[normalizedRole] || MINIMAL_TEMPLATES.developer,
      DegradationLevel.MINIMAL,
      repairs,
      normalizedRole
    );
  }

  /**
   * Checks if degradation should be applied (quick pre-check).
   * Returns true if the output looks problematic.
   *
   * @param {string} rawOutput
   * @param {string} role
   * @returns {boolean}
   */
  needsDegradation(rawOutput, role) {
    if (!rawOutput || rawOutput.trim().length < this._config.minContentLength) return true;
    const fieldCheck = this._checkFieldCompleteness(rawOutput, (role || 'developer').toLowerCase());
    return !fieldCheck.allCriticalPresent;
  }

  /**
   * Returns degradation metrics for observability.
   * @returns {{ metrics: object, history: Array, totalDegradations: number }}
   */
  getStats() {
    const totalDegradations = this._metrics.repaired + this._metrics.partial + this._metrics.minimal + this._metrics.failed;
    return {
      metrics: { ...this._metrics },
      history: [...this._history],
      totalDegradations,
      degradationRate: (this._metrics.none + totalDegradations) > 0
        ? `${(totalDegradations / (this._metrics.none + totalDegradations) * 100).toFixed(0)}%`
        : '0%',
    };
  }

  /**
   * Resets metrics and history. Called at the start of a new workflow run.
   */
  reset() {
    this._metrics = { none: 0, repaired: 0, partial: 0, minimal: 0, failed: 0 };
    this._history = [];
  }

  // ─── Private: Structural Repair ───────────────────────────────────────────

  /**
   * Attempts to repair structural issues in the output.
   * @param {string} output
   * @param {string} role
   * @returns {{ output: string, repaired: boolean, repairs: string[] }}
   */
  _repairStructure(output, role) {
    const repairs = [];
    let repaired = false;
    let result = output;

    // 1. JSON repair: fix common LLM JSON mistakes
    if (this._config.enableJsonRepair) {
      const jsonResult = this._repairJson(result);
      if (jsonResult.repaired) {
        result = jsonResult.output;
        repairs.push(...jsonResult.repairs);
        repaired = true;
      }
    }

    // 2. Markdown repair: fix broken headers, unclosed code blocks
    if (this._config.enableMarkdownRepair) {
      const mdResult = this._repairMarkdown(result);
      if (mdResult.repaired) {
        result = mdResult.output;
        repairs.push(...mdResult.repairs);
        repaired = true;
      }
    }

    return { output: result, repaired, repairs };
  }

  /**
   * Repairs common JSON formatting issues in LLM output.
   * @param {string} output
   * @returns {{ output: string, repaired: boolean, repairs: string[] }}
   */
  _repairJson(output) {
    const repairs = [];
    let result = output;
    let repaired = false;

    // Find JSON blocks in the output
    const jsonBlockRegex = /```(?:json)?\s*\n([\s\S]*?)```/g;
    let match;
    while ((match = jsonBlockRegex.exec(output)) !== null) {
      const jsonStr = match[1].trim();
      try {
        JSON.parse(jsonStr);
        // Valid JSON, no repair needed
      } catch (e) {
        // Attempt common repairs
        let fixed = jsonStr;

        // Fix trailing commas
        fixed = fixed.replace(/,\s*([}\]])/g, '$1');
        // Fix single quotes → double quotes
        fixed = fixed.replace(/'/g, '"');
        // Fix unquoted keys
        fixed = fixed.replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":');

        try {
          JSON.parse(fixed);
          result = result.replace(jsonStr, fixed);
          repairs.push('json_trailing_comma_or_quotes_fixed');
          repaired = true;
        } catch (_) {
          // Could not repair — leave as-is
        }
      }
    }

    return { output: result, repaired, repairs };
  }

  /**
   * Repairs common Markdown formatting issues.
   * @param {string} output
   * @returns {{ output: string, repaired: boolean, repairs: string[] }}
   */
  _repairMarkdown(output) {
    const repairs = [];
    let result = output;
    let repaired = false;

    // Fix unclosed code blocks
    const codeBlockCount = (result.match(/```/g) || []).length;
    if (codeBlockCount % 2 !== 0) {
      result = result + '\n```';
      repairs.push('unclosed_code_block_fixed');
      repaired = true;
    }

    // Fix headers without space after #
    const badHeaders = result.match(/^(#{1,6})([^\s#])/gm);
    if (badHeaders && badHeaders.length > 0) {
      result = result.replace(/^(#{1,6})([^\s#])/gm, '$1 $2');
      repairs.push('header_spacing_fixed');
      repaired = true;
    }

    return { output: result, repaired, repairs };
  }

  // ─── Private: Field Completeness Check ────────────────────────────────────

  /**
   * Checks which critical and non-critical fields are present in the output.
   * @param {string} output
   * @param {string} role
   * @returns {{ allCriticalPresent: boolean, missingCritical: string[], missingNonCritical: string[], totalCritical: number }}
   */
  _checkFieldCompleteness(output, role) {
    const spec = ROLE_FIELD_SPECS[role] || ROLE_FIELD_SPECS.developer;
    const markers = spec.sectionMarkers || {};

    const missingCritical = [];
    const missingNonCritical = [];

    for (const field of spec.critical) {
      const marker = markers[field];
      if (marker && !marker.test(output)) {
        missingCritical.push(field);
      }
    }

    for (const field of spec.nonCritical) {
      const marker = markers[field];
      if (marker && !marker.test(output)) {
        missingNonCritical.push(field);
      }
    }

    return {
      allCriticalPresent: missingCritical.length === 0,
      missingCritical,
      missingNonCritical,
      totalCritical: spec.critical.length,
    };
  }

  // ─── Private: Default Filling ─────────────────────────────────────────────

  /**
   * Appends default sections for missing non-critical fields.
   * @param {string} output
   * @param {string} role
   * @param {string[]} missingFields
   * @returns {string}
   */
  _fillNonCriticalDefaults(output, role, missingFields) {
    const defaults = {
      risks:           '\n\n## Risks\n- [Auto-filled: No specific risks identified. Review recommended.]',
      priorities:      '\n\n## Priorities\n- [Auto-filled: Default priority — medium.]',
      assumptions:     '\n\n## Assumptions\n- [Auto-filled: Standard assumptions apply.]',
      constraints:     '\n\n## Constraints\n- [Auto-filled: No additional constraints identified.]',
      techStack:       '\n\n## Tech Stack\n- [Auto-filled: See project-profile.md for detected stack.]',
      alternatives:    '\n\n## Alternatives\n- [Auto-filled: No alternatives documented.]',
      tradeoffs:       '\n\n## Tradeoffs\n- [Auto-filled: See architecture decisions in decision-log.md.]',
      diagrams:        '',
      comments:        '',
      testSuggestions: '\n\n## Test Suggestions\n- [Auto-filled: Add unit tests for new/modified functions.]',
      refactorNotes:   '',
      coverage:        '\n\n## Coverage\n- [Auto-filled: Coverage analysis pending.]',
      edgeCases:       '\n\n## Edge Cases\n- [Auto-filled: Review edge cases manually.]',
      performanceTests:'',
    };

    let result = output;
    for (const field of missingFields) {
      if (defaults[field]) {
        result += defaults[field];
      }
    }
    return result;
  }

  // ─── Private: Result Builder ──────────────────────────────────────────────

  /**
   * Builds the degradation result and updates metrics.
   * @param {string} output
   * @param {string} level
   * @param {string[]} repairs
   * @param {string} role
   * @returns {{ output: string, level: string, repairs: string[], metrics: object }}
   */
  _buildResult(output, level, repairs, role) {
    this._metrics[level]++;
    if (level !== DegradationLevel.NONE) {
      this._history.push({
        timestamp: new Date().toISOString(),
        role,
        level,
        repairs: [...repairs],
      });
      console.log(`[OutputDegradation] ${level === DegradationLevel.REPAIRED ? '🔧' : level === DegradationLevel.PARTIAL ? '⚠️' : '🔴'} Level: ${level} | Role: ${role} | Repairs: ${repairs.join(', ') || 'none'}`);
    }

    return {
      output,
      level,
      repairs,
      metrics: { ...this._metrics },
    };
  }
}

// ─── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  OutputDegradationEngine,
  DegradationLevel,
  ROLE_FIELD_SPECS,
  MINIMAL_TEMPLATES,
};
