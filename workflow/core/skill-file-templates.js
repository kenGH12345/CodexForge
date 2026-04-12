/**
 * Skill File Templates
 *
 * Extracted from skill-evolution.js for maintainability (ADR-41).
 * Contains skill file creation and template generation logic.
 *
 * @module workflow/core/skill-file-templates
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Section Templates ────────────────────────────────────────────────────────

/**
 * Returns section templates for troubleshooting skills.
 */
function getTroubleshootingSections() {
  return [
    `## Common Errors`,
    `<!-- PURPOSE: Document specific error messages, stack traces, and symptoms that developers encounter. Each entry should include the exact error text and a brief description of when it occurs. -->`,
    ``,
    `_No errors documented yet. Errors will be added from complaint resolutions._`,
    ``,
    `## Root Cause Analysis`,
    `<!-- PURPOSE: Explain WHY each common error occurs at a technical level. Link symptoms to underlying causes (misconfiguration, race condition, version incompatibility, etc.). -->`,
    ``,
    `_No root causes documented yet._`,
    ``,
    `## Fix Recipes`,
    `<!-- PURPOSE: Step-by-step fix instructions for each error. Must be copy-paste actionable: "1. Open X, 2. Change Y to Z, 3. Verify by running W". -->`,
    ``,
    `_No fix recipes documented yet._`,
    ``,
    `## Prevention Rules`,
    `<!-- PURPOSE: Prescriptive rules that PREVENT errors from occurring in the first place. Written as imperatives: "Always X", "Never Y", "Before doing Z, check W". -->`,
    ``,
    `_No prevention rules defined yet._`,
  ];
}

/**
 * Returns section templates for standards skills.
 */
function getStandardsSections() {
  return [
    `## Coding Standards`,
    `<!-- PURPOSE: Language-specific coding rules enforced across the project. Each rule should be testable (a linter or reviewer can verify compliance). -->`,
    ``,
    `_No coding standards defined yet._`,
    ``,
    `## Naming Conventions`,
    `<!-- PURPOSE: Naming patterns for files, variables, functions, classes, constants, and database entities. Include examples for each pattern. -->`,
    ``,
    `_No naming conventions defined yet._`,
    ``,
    `## Directory Structure`,
    `<!-- PURPOSE: Expected project layout rules. Describe where different types of files should live and why. -->`,
    ``,
    `_No directory structure rules defined yet._`,
    ``,
    `## Commit Conventions`,
    `<!-- PURPOSE: Git commit message format, branch naming, PR title conventions. Include templates and examples. -->`,
    ``,
    `_No commit conventions defined yet._`,
  ];
}

/**
 * Returns section templates for documentation skills.
 */
function getDocumentationSections() {
  return [
    `## Rules`,
    `<!-- PURPOSE: Prescriptive constraints for documentation quality. Written as imperatives ("Always X", "Never Y"). -->`,
    ``,
    `_No rules defined yet._`,
    ``,
    `## SOP (Standard Operating Procedure)`,
    `<!-- PURPOSE: Step-by-step workflow for generating documentation. Numbered phases with clear entry/exit criteria. -->`,
    ``,
    `_No SOP defined yet._`,
    ``,
    `## Checklist`,
    `<!-- PURPOSE: Verification checklist for documentation completeness. Each item is a yes/no assertion. -->`,
    ``,
    `_No checklist defined yet._`,
    ``,
    `## Best Practices`,
    `<!-- PURPOSE: Recommended documentation patterns. Audience-first writing, example-driven docs, docs-as-code. -->`,
    ``,
    `_No best practices defined yet._`,
    ``,
    `## Anti-Patterns`,
    `<!-- PURPOSE: Common documentation mistakes to avoid. Format: ❌ Anti-Pattern | ✅ Correct Approach. -->`,
    ``,
    `_No anti-patterns defined yet._`,
    ``,
    `## Templates`,
    `<!-- PURPOSE: Reusable documentation templates (README, CHANGELOG, API doc, JSDoc/Javadoc). -->`,
    ``,
    `_No templates defined yet._`,
  ];
}

/**
 * Returns section templates for domain skills (default).
 */
function getDomainSkillSections() {
  return [
    `## Rules`,
    `<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->`,
    ``,
    `_No rules defined yet. Rules will be added as experience accumulates._`,
    ``,
    `## SOP (Standard Operating Procedure)`,
    `<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->`,
    ``,
    `_No SOP defined yet._`,
    ``,
    `## Checklist`,
    `<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->`,
    ``,
    `_No checklist defined yet._`,
    ``,
    `## Best Practices`,
    `<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->`,
    ``,
    `_No best practices defined yet._`,
    ``,
    `## Anti-Patterns`,
    `<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. Use a table format: ❌ Anti-Pattern | ✅ Correct Approach. -->`,
    ``,
    `_No anti-patterns defined yet._`,
    ``,
    `## Gotchas`,
    `<!-- PURPOSE: Environment/version/platform-SPECIFIC traps that are NOT general anti-patterns. A gotcha is something that works in one context but breaks in another (e.g. "Works in Node 18 but fails in Node 20 due to X"). -->`,
    ``,
    `_No gotchas documented yet. Environment/version/platform-specific pitfalls will appear here._`,
    ``,
    `## Context Hints`,
    `<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context (e.g. "This project uses X library which has a known limitation Y", "The team prefers Z approach for historical reasons"). -->`,
    ``,
    `_No context hints defined yet._`,
    ``,
    `## Code Snippets`,
    `<!-- PURPOSE: Reusable code patterns, utility function signatures, and common implementation templates for this skill's domain. Each snippet should be copy-paste ready and include a brief description of WHEN to use it. Populated automatically from high-frequency utility_class and code_snippet experiences. -->`,
    ``,
    `_No code snippets collected yet. Snippets will be added from utility class scanning and experience evolution._`,
  ];
}

/**
 * Returns appropriate sections based on skill type.
 *
 * @param {string} skillType - 'troubleshooting' | 'standards' | 'domain-skill'
 * @returns {string[]}
 */
function getSectionsForType(skillType) {
  if (skillType === 'troubleshooting') {
    return getTroubleshootingSections();
  } else if (skillType === 'standards') {
    return getStandardsSections();
  } else if (skillType === 'documentation') {
    return getDocumentationSections();
  }
  return getDomainSkillSections();
}

// ─── Skill File Creation ──────────────────────────────────────────────────────

/**
 * Creates a new skill file with standard template.
 *
 * @param {object} options
 * @param {object} options.meta - Skill metadata
 * @param {string} options.skillsDir - Skills directory path
 * @param {Function} [options.onSkillFileCreated] - Optional callback after file creation
 */
function createSkillFile({ meta, skillsDir, onSkillFileCreated }) {
  // Build YAML frontmatter with structured metadata
  const triggerKeywords = (meta.triggers && meta.triggers.keywords) || [];
  const triggerRoles = (meta.triggers && meta.triggers.roles) || [];
  const frontmatter = [
    `---`,
    `name: ${meta.name}`,
    `version: ${meta.version}`,
    `type: ${meta.type || 'domain-skill'}`,
    `domains: [${(meta.domains || []).join(', ')}]`,
    `dependencies: [${(meta.dependencies || []).join(', ')}]`,
    `load_level: ${meta.loadLevel || 'task'}`,
    `max_tokens: ${meta.maxTokens || 800}`,
    `triggers:`,
    `  keywords: [${triggerKeywords.join(', ')}]`,
    `  roles: [${triggerRoles.join(', ')}]`,
    `description: "${meta.description}"`,
    `---`,
  ].join('\n');

  const sections = getSectionsForType(meta.type);

  const content = [
    frontmatter,
    ``,
    `# Skill: ${meta.name}`,
    ``,
    `> **Version**: ${meta.version}`,
    `> **Description**: ${meta.description}`,
    `> **Domains**: ${(meta.domains || []).join(', ') || 'general'}`,
    ``,
    `---`,
    ``,
    ...sections,
    ``,
    `## Evolution History`,
    ``,
    `| Version | Date | Change |`,
    `|---------|------|--------|`,
    `| v1.0.0 | ${new Date().toISOString().slice(0, 10)} | Initial creation |`,
    ``,
    `---`,
    ``,
    `<!-- KNOWLEDGE_SOURCES -->`,
    `<!-- `,
    `  This skill can be auto-enriched with knowledge from:`,
    `  `,
    `  1. AgentHub Knowledge Base (UUID: 86d363ab81634904b1cbc1b46acc66bc)`,
    `     - Use MCP tool: knowledge.knowledgebase_search`,
    `     - Query: "${meta.description} best practices patterns"`,
    `     - Domains: ${(meta.domains || []).join(', ') || 'software development'}`,
    `  `,
    `  2. Web Search + LLM Analysis`,
    `     - Automatically triggered via enrichSkillFromExternalKnowledge()`,
    `     - When WebSearch MCP adapter is available`,
    `  `,
    `  To manually enrich this skill, run:`,
    `  > /wf enrich-skill ${meta.name}`,
    `-->`,
  ].join('\n');

  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // N48 fix: atomic write – write to .tmp first, then rename over the target.
  const tmpPath = meta.filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, meta.filePath);
  console.log(`[SkillEvolution] Skill file created: ${meta.filePath}`);

  // ADR-29: Notify listeners that a placeholder skill was created.
  if (typeof onSkillFileCreated === 'function') {
    try {
      onSkillFileCreated(meta);
    } catch (hookErr) {
      console.warn(`[SkillEvolution] onSkillFileCreated hook error (non-fatal): ${hookErr.message}`);
    }
  }
}

module.exports = {
  getTroubleshootingSections,
  getStandardsSections,
  getDocumentationSections,
  getDomainSkillSections,
  getSectionsForType,
  createSkillFile,
};
