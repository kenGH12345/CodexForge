/**
 * Self-Audit Questions – Pre-defined self-questioning dimensions
 *
 * This module defines the multi-dimensional audit questions used by SelfAuditSocratic.
 * Each question follows the Socratic self-questioning pattern:
 *   - Designed to be answered by the system itself
 *   - Multiple choice with confidence implications
 *   - Evidence-based reasoning
 */

'use strict';

const { buildQuestion } = require('./socratic-engine');
const { validateModuleFunctionality, generateFunctionalityAuditQuestion } = require('./module-functionality-contracts');

// ─── Self-Audit Question Dimensions ─────────────────────────────────────────

/**
 * Pre-defined self-audit questions organized by dimension.
 * Each question is designed to be answered by the system itself (self-questioning).
 */
const SELF_AUDIT_QUESTIONS = {
  // ═══════════════════════════════════════════════════════════════════════════
  // Dimension 1: Output Completeness (输出完整性)
  // ═══════════════════════════════════════════════════════════════════════════
  OUTPUT_COMPLETENESS: buildQuestion(
    'output_completeness',
    'Does the output cover all requirements from the original request?',
    [
      '✅ Fully covered – every requirement has corresponding output',
      '⚠️ Partially covered – some requirements may be missing',
      '❌ Significant gaps – key requirements not addressed',
    ],
    'Check each requirement item against the generated output. Verify no requirements are silently dropped.'
  ),

  MODULE_COMPLETENESS: buildQuestion(
    'module_completeness',
    'For each module mentioned, is the implementation complete? (entry, logic, error handling, exports)',
    [
      '✅ All modules have complete implementations',
      '⚠️ Some modules have incomplete parts (missing error handling, partial exports)',
      '❌ Critical modules are incomplete or stub-only',
    ],
    'Review each module: does it have proper entry point, business logic, error handling, and exports?'
  ),

  // ═══════════════════════════════════════════════════════════════════════════
  // Dimension 2: Data Flow Integrity (数据链通畅性)
  // ═══════════════════════════════════════════════════════════════════════════
  DATA_FLOW_PRODUCER_CONSUMER: buildQuestion(
    'data_flow_producer_consumer',
    'Is the producer-consumer chain intact? Every output has a consumer; every input has a producer.',
    [
      '✅ Chain intact – all data flows are connected',
      '⚠️ Some orphan outputs – data produced but never consumed',
      '❌ Broken chain – critical data missing producer or consumer',
    ],
    'Trace data from source to destination. Identify any "orphan" outputs or "orphan" consumers.'
  ),

  DATA_FLOW_CROSS_STAGE: buildQuestion(
    'data_flow_cross_stage',
    'Does data flow correctly across pipeline stages? (ANALYSE→ARCHITECT→PLAN→CODE→TEST)',
    [
      '✅ Cross-stage data flow is correct',
      '⚠️ Some stage boundaries have data transformation issues',
      '❌ Critical data lost or corrupted between stages',
    ],
    'Verify that outputs from one stage correctly feed into the next stage as inputs.'
  ),

  // ═══════════════════════════════════════════════════════════════════════════
  // Dimension 3: Logical Consistency (逻辑一致性)
  // ═══════════════════════════════════════════════════════════════════════════
  CONSISTENCY_NAMING: buildQuestion(
    'consistency_naming',
    'Are names consistent across all files and stages? (same concept = same name)',
    [
      '✅ Naming is consistent throughout',
      '⚠️ Some naming inconsistencies (e.g., userId vs user_id)',
      '❌ Major naming conflicts causing confusion',
    ],
    'Check if the same concept is referred to by different names in different places.'
  ),

  CONSISTENCY_REFERENCES: buildQuestion(
    'consistency_references',
    'Are all references (IDs, names, imports) resolvable? No dangling references.',
    [
      '✅ All references are valid and resolvable',
      '⚠️ Some references may be broken or ambiguous',
      '❌ Critical dangling references detected',
    ],
    'Verify every import, reference, and ID mention points to something that exists.'
  ),

  // ═══════════════════════════════════════════════════════════════════════════
  // Dimension 4: Architecture Constraints (架构约束)
  // ═══════════════════════════════════════════════════════════════════════════
  ARCHITECTURE_IDE_FIRST: buildQuestion(
    'architecture_ide_first',
    'Does the solution follow ADR-37 IDE-First principle? (use IDE tools before building custom solutions)',
    [
      '✅ IDE-First principle followed correctly',
      '⚠️ Some violations – custom solutions where IDE tools would suffice',
      '❌ Major violation – reinventing wheels that IDE already provides',
    ],
    'Check if the solution leverages IDE capabilities (codebase_search, grep_search, LSP) before custom implementations.'
  ),

  ARCHITECTURE_FILE_SIZE: buildQuestion(
    'architecture_file_size',
    'Do all files comply with line-count limits from architecture-constraints.md?',
    [
      '✅ All files within size limits',
      '⚠️ Some files approaching or slightly over limits',
      '❌ Critical files significantly over size limits',
    ],
    'Verify file sizes against architecture constraints (index.js: 600, core/*.js: 400, agents/*.js: 300)'
  ),

  // ═══════════════════════════════════════════════════════════════════════════
  // Dimension 5: Historical Pitfalls (历史教训)
  // ═══════════════════════════════════════════════════════════════════════════
  HISTORICAL_PITFALLS: buildQuestion(
    'historical_pitfalls',
    'Does the output repeat any known anti-patterns from reflections.json?',
    [
      '✅ No known anti-patterns detected',
      '⚠️ Potential similarity to past issues – needs review',
      '❌ Clear repetition of known problematic patterns',
    ],
    'Compare output against recorded reflections and known pitfall patterns.'
  ),

  // ═══════════════════════════════════════════════════════════════════════════
  // Dimension 6: Format Compliance (格式合规)
  // ═══════════════════════════════════════════════════════════════════════════
  FORMAT_COMPLIANCE: buildQuestion(
    'format_compliance',
    'Does the output match the expected schema/format? (JSON structure, required fields, types)',
    [
      '✅ Output format is correct and complete',
      '⚠️ Minor format deviations (missing optional fields, slight type mismatch)',
      '❌ Major format violations – missing required fields or wrong structure',
    ],
    'Validate output against expected schema. Check required fields, types, and structure.'
  ),

  // ═══════════════════════════════════════════════════════════════════════════
  // Dimension 7: End-to-End Integrity (端到端完整性)
  // ═══════════════════════════════════════════════════════════════════════════
  E2E_INTEGRITY: buildQuestion(
    'e2e_integrity',
    'Can the output be used end-to-end without manual intervention?',
    [
      '✅ Complete E2E – ready for use without fixes',
      '⚠️ Minor gaps – needs small adjustments before use',
      '❌ Not E2E ready – significant manual work required',
    ],
    'Test if the output can be directly used from start to finish without manual patching.'
  ),

  // ═══════════════════════════════════════════════════════════════════════════
  // Dimension 8: Module Functionality Correctness (模块功能正确性)
  // ═══════════════════════════════════════════════════════════════════════════
  MODULE_FUNCTIONALITY: buildQuestion(
    'module_functionality',
    'Is each module producing output that matches its expected behavior?',
    [
      '✅ All modules function correctly – output matches contracts',
      '⚠️ Some modules have minor deviations – warnings detected',
      '❌ Module(s) not functioning as designed – violations detected',
    ],
    'Validate each module\'s output against its FunctionalityContract. Check expectedBehavior, postconditions, and validationRules.'
  ),

  AGENT_OUTPUT_CORRECTNESS: buildQuestion(
    'agent_output_correctness',
    'For each Agent: does the output satisfy the expected semantics (not just format)?',
    [
      '✅ All agent outputs are semantically correct',
      '⚠️ Some outputs have minor semantic issues',
      '❌ Agent output(s) have significant semantic errors',
    ],
    'For AnalystAgent: requirements extracted correctly? For ArchitectAgent: modules match requirements? For DeveloperAgent: code implements plan?'
  ),
};

// ─── User Review Points Categories ───────────────────────────────────────────

/**
 * User review points are loaded from reflections.json where source='user:review'.
 * These become additional audit dimensions that evolve over time.
 */
const USER_REVIEW_CATEGORIES = {
  'naming-consistency': {
    question: 'Are names consistent throughout? (User has flagged this before)',
    evidence: 'Check for userId vs user_id, functionName vs function_name style mixing',
  },
  'missing-error-handling': {
    question: 'Is error handling complete for all edge cases? (User has flagged this before)',
    evidence: 'Check try-catch blocks, error return handling, and edge case coverage',
  },
  'incomplete-module': {
    question: 'Are all modules fully implemented? (User has flagged this before)',
    evidence: 'Check for TODO comments, stub functions, or missing exports',
  },
  'data-flow-break': {
    question: 'Is data flowing correctly between components? (User has flagged this before)',
    evidence: 'Trace data from producer to consumer, check for orphan outputs',
  },
  'architecture-violation': {
    question: 'Does the code follow architecture constraints? (User has flagged this before)',
    evidence: 'Check against architecture-constraints.md and ADR documents',
  },
  'output-completeness': {
    question: 'Does output fully address the requirement? (User has flagged this before)',
    evidence: 'Compare each requirement item against generated output',
  },
};

// ─── Stage-to-Question Mapping ───────────────────────────────────────────────

/**
 * Maps stages to relevant audit questions.
 */
const STAGE_QUESTIONS = {
  ANALYSE: ['OUTPUT_COMPLETENESS', 'FORMAT_COMPLIANCE'],
  ARCHITECT: ['MODULE_COMPLETENESS', 'ARCHITECTURE_IDE_FIRST', 'ARCHITECTURE_FILE_SIZE'],
  PLAN: ['DATA_FLOW_CROSS_STAGE', 'CONSISTENCY_REFERENCES'],
  CODE: ['MODULE_COMPLETENESS', 'CONSISTENCY_NAMING', 'ARCHITECTURE_FILE_SIZE', 'HISTORICAL_PITFALLS'],
  TEST: ['E2E_INTEGRITY', 'FORMAT_COMPLIANCE'],
};

module.exports = {
  SELF_AUDIT_QUESTIONS,
  USER_REVIEW_CATEGORIES,
  STAGE_QUESTIONS,
};
