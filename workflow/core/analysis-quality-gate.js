'use strict';

const fs = require('fs');

const CHECK_IDS = {
  S1: 'hasUserStories',
  S2: 'hasAcceptanceCriteria',
  S3: 'hasFunctionalRequirements',
  S4: 'hasRiskAnalysis',
  S5: 'hasModuleMap',
  S6: 'meetsMinimumLength',
  S7: 'hasEarsPattern',
  S8: 'hasQuantifiedNfr',
  M1: 'hasClearSectionStructure',
  M2: 'hasRequirementIds',
  M3: 'hasBoundaryDefinitions',
  M4: 'hasDependencyMapping',
  M5: 'hasTechnicalConstraints',
};

const SECTION_PATTERNS = {
  userStory: [
    /##\s*(?:用户故事|User\s+Stories?)/i,
    /作为.*我希望.*以便/i,
    /As\s+a\b.*I\s+(?:want|need)\b.*(?:so\s+that|in\s+order\s+to)/i,
  ],
  acceptanceCriteria: [
    /##\s*(?:验收标准|Acceptance\s+Criteria)/i,
    /WHEN.*THEN/i,
    /如果.*那么/i,
    /GIVEN.*WHEN.*THEN/i,
  ],
  functionalReq: [
    /##\s*(?:功能需求|Functional\s+Requirements?)/i,
    /##\s*(?:需求|Requirements?)(?:\s+|$)/i,
  ],
  riskAnalysis: [
    /##\s*(?:风险|Risk\s+Analy(?:sis|sis))/i,
    /##\s*(?:技术风险|Technical\s+Risk)/i,
  ],
  moduleMap: [
    /##\s*(?:模块|Module\s+Map)/i,
    /##\s*(?:功能模块|Functional\s+Module)/i,
    /模块[图映射]/i,
  ],
  earsPattern: [
    /(?:WHEN|IF|WHERE|WHILE|AT\s+(?:START|END))\b.*(?:SHALL|SHOULD|MUST|WILL)\b/i,
    /(?:当|如果|在)\b.*(?:应|须|将|需要)\b/i,
  ],
  quantifiedNfr: [
    /(?:<|>|≤|≥|at\s+least|at\s+most|within|under|no\s+more\s+than|minimum|maximum)\s*\d+/i,
    /(?:P\d{2}|p\d{2})\s*(?:<|>|≤|≥)/i,
    /(?:毫秒|ms|秒|秒级|秒内)\b/i,
    /(?:%\s*(?:above|below|不低于|不超过))/i,
  ],
  sectionStructure: [
    /^#{1,3}\s+/m,
  ],
  requirementIds: [
    /(?:REQ-?\d+|FR-?\d+|US-?\d+|需求[-#]?\d+)/i,
  ],
  boundaryDefs: [
    /(?:边界|Boundary|Scope|范围|责任|Responsibility)/i,
  ],
  dependencyMapping: [
    /(?:依赖|Depend|Import|耦合|Coupling)/i,
  ],
  techConstraints: [
    /(?:约束|Constraint|限制|Limitation|兼容|Compatibility)/i,
  ],
};

function _checkPattern(content, patterns) {
  return patterns.some(p => p.test(content));
}

function _runCheck(checkId, content, minLength) {
  switch (checkId) {
    case 'S1':
      return { id: checkId, name: 'Has User Stories', passed: _checkPattern(content, SECTION_PATTERNS.userStory), severity: 'critical', weight: 15 };
    case 'S2':
      return { id: checkId, name: 'Has Acceptance Criteria', passed: _checkPattern(content, SECTION_PATTERNS.acceptanceCriteria), severity: 'critical', weight: 15 };
    case 'S3':
      return { id: checkId, name: 'Has Functional Requirements', passed: _checkPattern(content, SECTION_PATTERNS.functionalReq), severity: 'critical', weight: 12 };
    case 'S4':
      return { id: checkId, name: 'Has Risk Analysis', passed: _checkPattern(content, SECTION_PATTERNS.riskAnalysis), severity: 'high', weight: 10 };
    case 'S5':
      return { id: checkId, name: 'Has Module Map', passed: _checkPattern(content, SECTION_PATTERNS.moduleMap), severity: 'medium', weight: 6 };
    case 'S6':
      return { id: checkId, name: 'Meets Minimum Length', passed: content.length >= minLength, severity: 'critical', weight: 15 };
    case 'S7':
      return { id: checkId, name: 'Uses EARS Pattern', passed: _checkPattern(content, SECTION_PATTERNS.earsPattern), severity: 'medium', weight: 5 };
    case 'S8':
      return { id: checkId, name: 'Has Quantified NFR', passed: _checkPattern(content, SECTION_PATTERNS.quantifiedNfr), severity: 'medium', weight: 5 };
    case 'M1':
      return { id: checkId, name: 'Has Clear Section Structure', passed: (content.match(/^#{1,3}\s+/gm) || []).length >= 3, severity: 'medium', weight: 5 };
    case 'M2':
      return { id: checkId, name: 'Has Requirement IDs', passed: _checkPattern(content, SECTION_PATTERNS.requirementIds), severity: 'low', weight: 3 };
    case 'M3':
      return { id: checkId, name: 'Has Boundary Definitions', passed: _checkPattern(content, SECTION_PATTERNS.boundaryDefs), severity: 'low', weight: 3 };
    case 'M4':
      return { id: checkId, name: 'Has Dependency Mapping', passed: _checkPattern(content, SECTION_PATTERNS.dependencyMapping), severity: 'low', weight: 3 };
    case 'M5':
      return { id: checkId, name: 'Has Technical Constraints', passed: _checkPattern(content, SECTION_PATTERNS.techConstraints), severity: 'low', weight: 3 };
    default:
      return { id: checkId, name: checkId, passed: true, severity: 'low', weight: 0 };
  }
}

function validateAnalysisQuality(contentOrPath, opts = {}) {
  const minLength = opts.minLength || 500;
  const failThreshold = opts.failThreshold || 50;
  let content;
  if (typeof contentOrPath === 'string' && contentOrPath.endsWith('.md') && fs.existsSync(contentOrPath)) {
    content = fs.readFileSync(contentOrPath, 'utf-8');
  } else {
    content = String(contentOrPath);
  }

  const allCheckIds = Object.keys(CHECK_IDS);
  const checks = allCheckIds.map(id => _runCheck(id, content, minLength));
  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earnedWeight = checks.filter(c => c.passed).reduce((s, c) => s + c.weight, 0);
  const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
  const passed = score >= failThreshold;
  const failedChecks = checks.filter(c => !c.passed);
  const criticalFailed = failedChecks.filter(c => c.severity === 'critical');
  const highFailed = failedChecks.filter(c => c.severity === 'high');

  return {
    score,
    passed,
    failThreshold,
    checks,
    failedChecks,
    criticalFailed,
    highFailed,
    summary: _buildSummary(score, passed, criticalFailed, highFailed),
  };
}

function _buildSummary(score, passed, criticalFailed, highFailed) {
  const parts = [`Score: ${score}/100`];
  if (passed) {
    parts.push('PASSED');
  } else {
    parts.push('FAILED');
  }
  if (criticalFailed.length > 0) {
    parts.push(`Critical gaps: ${criticalFailed.map(c => c.name).join(', ')}`);
  }
  if (highFailed.length > 0) {
    parts.push(`High gaps: ${highFailed.map(c => c.name).join(', ')}`);
  }
  return parts.join(' | ');
}

function extractUserStories(content) {
  const stories = [];
  const enRegex = /As\s+a\s+([^,.]+)[,.]?\s*I\s+(?:want|need)\s+([^,.]+)[,.]?\s*(?:so\s+that|in\s+order\s+to)\s+([^.\n]+)/gi;
  let match;
  while ((match = enRegex.exec(content)) !== null) {
    stories.push({ actor: match[1].trim(), goal: match[2].trim(), benefit: match[3].trim(), lang: 'en' });
  }
  const cnRegex = /作为([^，。]+)[，。]?\s*我(?:希望|需要)([^，。]+)[，。]?\s*(?:以便|为了|从而)([^。\n]+)/g;
  while ((match = cnRegex.exec(content)) !== null) {
    stories.push({ actor: match[1].trim(), goal: match[2].trim(), benefit: match[3].trim(), lang: 'zh' });
  }
  return stories;
}

function extractAcceptanceCriteria(content) {
  const criteria = [];
  const whenThenEn = /WHEN\s+(.+?)\s+THEN\s+(.+?)(?:\n|$)/gi;
  let match;
  while ((match = whenThenEn.exec(content)) !== null) {
    criteria.push({ condition: match[1].trim(), expectation: match[2].trim(), lang: 'en' });
  }
  const ifThenCn = /如果(.+?)(?:，那么|，则|，那么应当)(.+?)(?:\n|$)/g;
  while ((match = ifThenCn.exec(content)) !== null) {
    criteria.push({ condition: match[1].trim(), expectation: match[2].trim(), lang: 'zh' });
  }
  return criteria;
}

function extractRiskSummary(content) {
  const risks = [];
  const riskSection = content.match(/##\s*(?:风险|Risk[^#\n]*)\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!riskSection) return risks;
  const lines = riskSection[1].split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('*') || l.trim().match(/^\d+\./));
  for (const line of lines) {
    const text = line.replace(/^[\s\-\*\d.]+/, '').trim();
    if (text.length > 5) {
      const severity = /高|HIGH|严重|CRITICAL/i.test(text) ? 'high' : /中|MEDIUM|MODERATE/i.test(text) ? 'medium' : 'low';
      risks.push({ text: text.slice(0, 200), severity });
    }
  }
  return risks;
}

module.exports = {
  validateAnalysisQuality,
  extractUserStories,
  extractAcceptanceCriteria,
  extractRiskSummary,
  CHECK_IDS,
  SECTION_PATTERNS,
};
