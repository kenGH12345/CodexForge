/**
 * Deep Audit Expert Panel Configuration
 *
 * Defines the expert panel for deep audit reviews.
 * Each expert is assigned specific dimensions and provides
 * domain-specific perspectives for audit findings.
 *
 * @module workflow/core/deep-audit-experts
 */

'use strict';

/**
 * Expert panel configuration for deep audit reviews.
 * Each expert has:
 *   - name: Display name
 *   - title: Professional title
 *   - role: 'chair' | 'reviewer'
 *   - expertise: Domain expertise summary
 *   - dimensions: AuditCategory values they cover
 *   - promptPersona: LLM prompt for generating expert reviews
 */
const EXPERT_PANEL = [
  {
    name: 'Andrej Karpathy',
    title: 'Former OpenAI Research Scientist & Tesla AI Director',
    role: 'chair',
    expertise: 'Agent architecture, system design, LLM integration',
    dimensions: ['logic-consistency', 'knowledge-quality'],
    promptPersona: 'You are Andrej Karpathy, renowned for deep systems thinking and Agent architecture design. Evaluate this module from the perspective of AI agent collaboration, boundary enforcement, and knowledge flow efficiency.',
  },
  {
    name: 'Martin Fowler',
    title: 'ThoughtWorks Chief Scientist',
    role: 'reviewer',
    expertise: 'Software architecture patterns, maintainability, refactoring',
    dimensions: ['architecture-compliance', 'module-coupling'],
    promptPersona: 'You are Martin Fowler, expert in software architecture patterns and code maintainability. Evaluate this module for SOLID violations, excessive coupling, God Objects, and adherence to the project\'s own architecture constraints.',
  },
  {
    name: 'Kelsey Hightower',
    title: 'Former Google Principal Engineer',
    role: 'reviewer',
    expertise: 'Engineering practices, operations, portability, developer experience',
    dimensions: ['config-consistency', 'performance-efficiency'],
    promptPersona: 'You are Kelsey Hightower, known for pragmatic engineering and zero-config philosophy. Evaluate this module for operational readiness, configuration hygiene, error handling robustness, and developer experience friction.',
  },
  {
    name: 'Sanjay Ghemawat',
    title: 'Google Fellow, MapReduce/Bigtable co-author',
    role: 'reviewer',
    expertise: 'State management, reliability, concurrency, data integrity',
    dimensions: ['logic-consistency', 'functional-completeness'],
    promptPersona: 'You are Sanjay Ghemawat, expert in distributed systems and data integrity. Evaluate this module for state management correctness, concurrency safety, checkpoint/recovery robustness, and data migration concerns.',
  },
  {
    name: 'Lea Verou',
    title: 'MIT HCI Researcher & Web Standards Expert',
    role: 'reviewer',
    expertise: 'Developer experience, API design, documentation quality',
    dimensions: ['knowledge-quality', 'functional-completeness'],
    promptPersona: 'You are Lea Verou, expert in developer experience and API usability. Evaluate this module for API clarity, error message quality, documentation completeness, and TypeScript integration friendliness.',
  },
];

/**
 * Finds experts for a given audit category.
 *
 * @param {string} category - AuditCategory value
 * @returns {Array<{ name: string, title: string, role: string, expertise: string, dimensions: string[], promptPersona: string }>}
 */
function getExpertsForCategory(category) {
  return EXPERT_PANEL.filter(expert => expert.dimensions.includes(category));
}

/**
 * Gets the primary reviewer for a category.
 * Returns the chair if they cover the category, otherwise the first matching expert.
 *
 * @param {string} category - AuditCategory value
 * @returns {object|null} Expert object or null
 */
function getPrimaryReviewer(category) {
  const experts = getExpertsForCategory(category);
  if (experts.length === 0) return null;
  const chair = experts.find(e => e.role === 'chair');
  return chair || experts[0];
}

/**
 * Builds an expert review prompt for a finding.
 *
 * @param {object} finding - Audit finding object
 * @returns {string|null} Expert-contextualised review prompt
 */
function buildExpertReviewPrompt(finding) {
  const experts = getExpertsForCategory(finding.category);
  if (experts.length === 0) return null;

  const primary = experts.find(e => e.role === 'chair') || experts[0];
  return [
    primary.promptPersona,
    '',
    '## Finding to Review',
    `- **Severity**: ${finding.severity}`,
    `- **Category**: ${finding.category}`,
    `- **Title**: ${finding.title}`,
    `- **Description**: ${finding.description}`,
    finding.suggestion ? `- **Current Suggestion**: ${finding.suggestion}` : '',
    finding.locations ? `- **Locations**: ${JSON.stringify(finding.locations).slice(0, 300)}` : '',
    '',
    'Please provide:',
    '1. Your assessment of the severity (agree/disagree, with reasoning)',
    '2. A specific, actionable fix with code example if applicable',
    '3. Any related issues this finding might indicate',
  ].filter(Boolean).join('\n');
}

/**
 * Enriches findings with expert reviewer information.
 *
 * @param {Array<object>} findings - Array of audit findings
 * @returns {void} Modifies findings in place
 */
function enrichFindingsWithExperts(findings) {
  for (const finding of findings) {
    const matchedExperts = getExpertsForCategory(finding.category);

    if (matchedExperts.length > 0) {
      finding.expertReviewers = matchedExperts.map(e => ({
        name: e.name,
        role: e.role,
        perspective: e.expertise,
      }));
      const chair = matchedExperts.find(e => e.role === 'chair');
      finding.primaryReviewer = chair ? chair.name : matchedExperts[0].name;
    }
  }
}

module.exports = {
  EXPERT_PANEL,
  getExpertsForCategory,
  getPrimaryReviewer,
  buildExpertReviewPrompt,
  enrichFindingsWithExperts,
};
