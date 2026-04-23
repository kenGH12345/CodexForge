/**
 * Review Checklists – Centralized checklist definitions for CodeReviewAgent
 *
 * ADR-33 Refactor: Moved from architecture-review-agent.js to enable
 * CodeReviewAgent reuse for both code and architecture reviews.
 *
 * @module workflow/core/review-checklists
 */

'use strict';

/**
 * Architecture checklist for reviewing architecture.md documents.
 * Each item: id, category, severity, description, hint, evaluationGuide.
 */
const ARCHITECTURE_CHECKLIST = [
  // ── Decision Justification ────────────────────────────────────────────────
  {
    id: 'ARCH-001', category: 'Decision Justification', severity: 'high',
    description: 'Every major technology choice has a stated rationale',
    hint: 'Database, framework, messaging system, caching layer choices must explain WHY.',
    evaluationGuide: 'For each major technology mentioned (DB, cache, queue, framework), check if the document explains WHY it was chosen over alternatives. A choice without justification is a red flag.',
  },
  {
    id: 'ARCH-002', category: 'Decision Justification', severity: 'medium',
    description: 'Trade-offs of the chosen approach are acknowledged',
    hint: 'Every architectural decision has trade-offs. They should be explicitly stated.',
    evaluationGuide: 'Check if the document acknowledges the downsides or trade-offs of key decisions. A document that only lists benefits without trade-offs is incomplete.',
  },
  {
    id: 'ARCH-003', category: 'Decision Justification', severity: 'medium',
    description: 'Rejected alternatives are briefly mentioned with reasons',
    hint: 'Knowing what was NOT chosen and why helps future maintainers.',
    evaluationGuide: 'Check if the document mentions at least one alternative that was considered and rejected, with a brief reason. This is optional but strongly recommended for major decisions.',
  },

  // ── Scalability ───────────────────────────────────────────────────────────
  {
    id: 'ARCH-004', category: 'Scalability', severity: 'high',
    description: 'Horizontal scaling strategy is defined for stateful components',
    hint: 'Databases, caches, and session stores need explicit sharding/replication strategies.',
    evaluationGuide: 'Identify all stateful components (DB, cache, file storage). For each, check if the document describes how it scales horizontally (sharding, read replicas, partitioning). Stateless services that can simply add instances are fine without explicit strategy.',
  },
  {
    id: 'ARCH-005', category: 'Scalability', severity: 'medium',
    description: 'Bottlenecks and capacity limits are identified',
    hint: 'Every system has a bottleneck. Identifying it early prevents surprises.',
    evaluationGuide: 'Check if the document identifies the expected bottleneck (e.g. DB write throughput, network bandwidth, CPU). If the system has performance requirements, verify the architecture addresses them.',
  },
  {
    id: 'ARCH-006', category: 'Scalability', severity: 'medium',
    description: 'Stateless service design is maintained where applicable',
    hint: 'Stateless services scale trivially. Session state should be externalised.',
    evaluationGuide: 'Check if application services are designed to be stateless (no in-memory session state). If session state exists, verify it is stored in an external store (Redis, DB) not in the service instance.',
  },

  // ── Reliability ───────────────────────────────────────────────────────────
  {
    id: 'ARCH-007', category: 'Reliability', severity: 'high',
    description: 'No single point of failure (SPOF) for critical paths',
    hint: 'Any component that, if it fails, takes down the whole system is a SPOF.',
    evaluationGuide: 'Identify all components in the critical path (the path a user request takes). For each, check if there is redundancy or failover. A single-instance DB with no replica is a SPOF. A load balancer with a single backend is a SPOF.',
  },
  {
    id: 'ARCH-008', category: 'Reliability', severity: 'high',
    description: 'Data durability and backup strategy is defined',
    hint: 'How is data protected against loss? Backup frequency, retention, restore procedure.',
    evaluationGuide: 'Check if the document describes: (1) how data is persisted durably, (2) backup frequency and retention policy, (3) how to restore from backup. If the system stores user data, this is mandatory.',
  },
  {
    id: 'ARCH-009', category: 'Reliability', severity: 'medium',
    description: 'Failure modes and recovery strategies are described',
    hint: 'What happens when component X fails? Circuit breaker, retry, graceful degradation.',
    evaluationGuide: 'Check if the document describes what happens when key components fail (DB down, cache miss, external API timeout). Look for: circuit breakers, retry policies, fallback strategies, graceful degradation.',
  },

  // ── Security ──────────────────────────────────────────────────────────────
  {
    id: 'ARCH-010', category: 'Security', severity: 'high',
    description: 'Authentication and authorisation architecture is defined',
    hint: 'Who can access what? How is identity verified? How are permissions enforced?',
    evaluationGuide: 'Check if the document describes: (1) how users/services authenticate (JWT, OAuth, API key), (2) how authorisation is enforced (RBAC, ABAC, middleware), (3) where auth checks happen in the request flow.',
  },
  {
    id: 'ARCH-011', category: 'Security', severity: 'high',
    description: 'Sensitive data handling is addressed (encryption at rest and in transit)',
    hint: 'PII, credentials, payment data must be encrypted. TLS for all external communication.',
    evaluationGuide: 'Check if the document addresses: (1) TLS/HTTPS for all external communication, (2) encryption at rest for sensitive data (PII, credentials, payment info), (3) secret management (no hardcoded secrets, use vault/env vars).',
  },
  {
    id: 'ARCH-012', category: 'Security', severity: 'medium',
    description: 'Attack surface is minimised (principle of least privilege)',
    hint: 'Services should only have access to what they need. Expose minimum ports/APIs.',
    evaluationGuide: 'Check if the document applies least privilege: (1) services only have DB access they need, (2) internal services are not exposed to the internet, (3) API endpoints are protected appropriately.',
  },

  // ── Observability ─────────────────────────────────────────────────────────
  {
    id: 'ARCH-013', category: 'Observability', severity: 'medium',
    description: 'Logging strategy is defined (what to log, where to store)',
    hint: 'Structured logs, log levels, centralised log aggregation.',
    evaluationGuide: 'Check if the document describes: (1) what events are logged (errors, key business events), (2) log format (structured JSON preferred), (3) where logs are stored/aggregated (ELK, CloudWatch, etc.).',
  },
  {
    id: 'ARCH-014', category: 'Observability', severity: 'medium',
    description: 'Key metrics and alerting thresholds are identified',
    hint: 'What metrics indicate the system is healthy? What triggers an alert?',
    evaluationGuide: 'Check if the document identifies: (1) key health metrics (latency p99, error rate, throughput), (2) alerting thresholds, (3) monitoring tool (Prometheus, Datadog, etc.). For simple systems, basic health checks are acceptable.',
  },

  // ── Requirements Alignment ────────────────────────────────────────────────
  {
    id: 'ARCH-015', category: 'Requirements Alignment', severity: 'high',
    description: 'All non-functional requirements (NFRs) are addressed in the architecture',
    hint: 'Performance, availability, scalability, security NFRs must map to architectural decisions.',
    evaluationGuide: 'If a requirements document is provided, check each NFR (performance targets, availability SLA, security requirements) and verify the architecture explicitly addresses it. An NFR without a corresponding architectural decision is a gap.',
  },
  {
    id: 'ARCH-016', category: 'Requirements Alignment', severity: 'high',
    description: 'Architecture supports all core functional requirements',
    hint: 'Every major feature in requirements.md must have a corresponding component in the architecture.',
    evaluationGuide: 'If a requirements document is provided, check each major functional requirement and verify there is a corresponding component, service, or data flow in the architecture. Missing components are gaps.',
  },

  // ── Consistency ───────────────────────────────────────────────────────────
  {
    id: 'ARCH-017', category: 'Consistency', severity: 'high',
    description: 'No internal contradictions between architecture sections',
    hint: 'Section A says stateless, Section B stores session in memory – contradiction.',
    evaluationGuide: 'Read the document holistically. Look for contradictions: (1) a component described as stateless but storing state, (2) HA requirement but single-instance deployment, (3) microservices architecture but shared database, (4) async processing described but synchronous flow shown.',
  },
  {
    id: 'ARCH-018', category: 'Consistency', severity: 'medium',
    description: 'Diagrams and text descriptions are consistent',
    hint: 'If a diagram shows component X, the text should describe it and vice versa.',
    evaluationGuide: 'Check if components mentioned in text are also shown in diagrams (if any), and vice versa. Inconsistencies between diagrams and text descriptions indicate incomplete documentation.',
  },
];

const ARCHITECTURE_SCORECARD_DIMENSIONS = [
  ...new Map(
    ARCHITECTURE_CHECKLIST.map((item) => [
      item.category,
      {
        category: item.category,
        itemIds: [],
        highSeverityCount: 0,
        mediumSeverityCount: 0,
        lowSeverityCount: 0,
      },
    ])
  ).values(),
].map((dimension) => {
  const items = ARCHITECTURE_CHECKLIST.filter((item) => item.category === dimension.category);
  for (const item of items) {
    dimension.itemIds.push(item.id);
    if (item.severity === 'high') dimension.highSeverityCount += 1;
    else if (item.severity === 'medium') dimension.mediumSeverityCount += 1;
    else dimension.lowSeverityCount += 1;
  }
  return dimension;
});

const ARCHITECTURE_SCORECARD_WEIGHTS = {
  high: 5,
  medium: 3,
  low: 1,
};

const ARCHITECTURE_SCORECARD_HEURISTICS = {
  'ARCH-001': [/\brationale\b/i, /\bwhy\b/i, /\bchosen\b/i, /because/i],
  'ARCH-002': [/trade-?off/i, /downside/i, /cost/i, /limitation/i],
  'ARCH-003': [/alternative/i, /rejected/i, /not chosen/i],
  'ARCH-004': [/horizontal/i, /scale/i, /replica/i, /shard/i, /partition/i],
  'ARCH-005': [/bottleneck/i, /capacity/i, /throughput/i, /limit/i],
  'ARCH-006': [/stateless/i, /session state/i, /external/i],
  'ARCH-007': [/single point of failure/i, /spof/i, /failover/i, /redundan/i],
  'ARCH-008': [/backup/i, /restore/i, /retention/i, /durab/i],
  'ARCH-009': [/failure/i, /fallback/i, /retry/i, /recovery/i, /degrad/i],
  'ARCH-010': [/auth/i, /authorization/i, /authentication/i, /rbac/i, /jwt/i, /oauth/i],
  'ARCH-011': [/encrypt/i, /tls/i, /https/i, /secret/i, /in transit/i, /at rest/i],
  'ARCH-012': [/least privilege/i, /minimi[sz]e/i, /internal/i, /permission/i],
  'ARCH-013': [/logging/i, /log /i, /structured log/i, /observability/i],
  'ARCH-014': [/metric/i, /alert/i, /threshold/i, /p99/i, /latency/i],
  'ARCH-015': [/non-functional/i, /\bnfr\b/i, /availability/i, /performance/i, /security/i],
  'ARCH-016': [/requirement/i, /user story/i, /flow/i, /component/i],
  'ARCH-017': [/consisten/i, /constraint/i],
  'ARCH-018': [/```mermaid/i, /diagram/i, /component/i],
};

const ARCHITECTURE_SCORECARD_NA_CONDITIONS = {
  'ARCH-004': { missing: [/stateful/i, /database/i, /cache/i, /session/i], reason: 'No stateful components identified — horizontal scaling strategy not applicable.' },
  'ARCH-007': { missing: [/stateful/i, /database/i, /critical/i], reason: 'No critical-path stateful components identified — SPOF analysis not applicable.' },
  'ARCH-008': { missing: [/data store/i, /database/i, /persist/i, /storage/i], reason: 'No persistent data stores identified — backup strategy not applicable.' },
  'ARCH-010': { missing: [/user/i, /client/i, /api/i, /endpoint/i, /auth/i], reason: 'No user-facing or inter-service endpoints identified — auth architecture not applicable.' },
  'ARCH-011': { missing: [/sensitive/i, /pii/i, /credential/i, /payment/i, /encrypt/i], reason: 'No sensitive data handling identified — encryption strategy not applicable.' },
  'ARCH-012': { missing: [/service/i, /api/i, /endpoint/i, /network/i], reason: 'No service/API boundaries identified — attack surface minimisation not applicable.' },
  'ARCH-013': { missing: [/service/i, /api/i, /runtime/i, /deploy/i], reason: 'No runtime services identified — logging strategy not applicable.' },
  'ARCH-014': { missing: [/service/i, /api/i, /performance/i, /latency/i], reason: 'No measurable services identified — metric/alert strategy not applicable.' },
};

function _roundPercent(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 100);
}

function _normaliseResult(result) {
  const normalised = String(result || 'MISSING').toUpperCase();
  if (normalised === 'PASS' || normalised === 'FAIL' || normalised === 'N/A' || normalised === 'MISSING' || normalised === 'UNASSESSED') {
    return normalised;
  }
  return 'MISSING';
}

function _getResultWeight(item) {
  return ARCHITECTURE_SCORECARD_WEIGHTS[item.severity] || ARCHITECTURE_SCORECARD_WEIGHTS.medium;
}

function _indexReviewResults(reviewResult) {
  const rawResults = Array.isArray(reviewResult)
    ? reviewResult
    : Array.isArray(reviewResult?.allResults)
      ? reviewResult.allResults
      : Array.isArray(reviewResult?.failures)
        ? reviewResult.failures
        : [];

  const resultMap = new Map();
  for (const item of rawResults) {
    if (!item || !item.id) continue;
    resultMap.set(String(item.id).toUpperCase(), {
      id: String(item.id).toUpperCase(),
      result: _normaliseResult(item.result),
      finding: item.finding || '',
      fixInstruction: item.fixInstruction || null,
      source: 'review-result',
    });
  }
  return resultMap;
}

function _buildHeuristicResult(item, artifactContent) {
  const text = String(artifactContent || '');
  if (!text.trim()) {
    return {
      id: item.id,
      result: 'UNASSESSED',
      finding: 'No architecture artifact content available for heuristic assessment.',
      fixInstruction: 'Write architecture.md before building the scorecard.',
      source: 'artifact-heuristic',
    };
  }

  const naCondition = ARCHITECTURE_SCORECARD_NA_CONDITIONS[item.id];
  if (naCondition) {
    const hasRelevantContext = naCondition.missing.some((pattern) => pattern.test(text));
    if (!hasRelevantContext) {
      return {
        id: item.id,
        result: 'N/A',
        finding: naCondition.reason,
        fixInstruction: null,
        source: 'artifact-heuristic-na',
      };
    }
  }

  const patterns = ARCHITECTURE_SCORECARD_HEURISTICS[item.id] || [];
  if (patterns.length === 0) {
    return {
      id: item.id,
      result: 'UNASSESSED',
      finding: 'No heuristic rule is defined for this checklist item yet.',
      fixInstruction: null,
      source: 'artifact-heuristic',
    };
  }

  const passed = patterns.some((pattern) => pattern.test(text));
  return {
    id: item.id,
    result: passed ? 'PASS' : 'FAIL',
    finding: passed
      ? 'Heuristic evidence for this checklist item was found in architecture.md.'
      : 'Heuristic evidence for this checklist item was not found in architecture.md.',
    fixInstruction: passed ? null : item.hint,
    source: 'artifact-heuristic',
  };
}

function buildArchitectureScorecard({ reviewResult = null, artifactContent = '' } = {}) {
  const indexedReviewResults = _indexReviewResults(reviewResult);
  const itemResults = ARCHITECTURE_CHECKLIST.map((item) => {
    const resolved = indexedReviewResults.get(item.id) || _buildHeuristicResult(item, artifactContent);
    return {
      id: item.id,
      category: item.category,
      severity: item.severity,
      description: item.description,
      hint: item.hint,
      result: _normaliseResult(resolved.result),
      finding: resolved.finding || '',
      fixInstruction: resolved.fixInstruction || null,
      source: resolved.source || 'review-result',
      weight: _getResultWeight(item),
    };
  });

  const dimensions = ARCHITECTURE_SCORECARD_DIMENSIONS.map((dimension) => {
    const items = itemResults.filter((item) => item.category === dimension.category);
    const scoreEligible = items.filter((item) => item.result !== 'N/A' && item.result !== 'UNASSESSED');
    const coverageEligible = items.filter((item) => item.result !== 'N/A');
    const earnedWeight = scoreEligible
      .filter((item) => item.result === 'PASS')
      .reduce((sum, item) => sum + item.weight, 0);
    const possibleWeight = scoreEligible.reduce((sum, item) => sum + item.weight, 0);
    const assessedWeight = scoreEligible.reduce((sum, item) => sum + item.weight, 0);
    const coverageWeight = coverageEligible.reduce((sum, item) => sum + item.weight, 0);
    const failedItems = items.filter((item) => item.result === 'FAIL' || item.result === 'MISSING');
    const unassessedItems = items.filter((item) => item.result === 'UNASSESSED');
    const notApplicableItems = items.filter((item) => item.result === 'N/A');

    return {
      category: dimension.category,
      totalScore: _roundPercent(earnedWeight, possibleWeight),
      coverageScore: _roundPercent(assessedWeight, coverageWeight),
      passedCount: items.filter((item) => item.result === 'PASS').length,
      failedCount: failedItems.length,
      unassessedCount: unassessedItems.length,
      notApplicableCount: notApplicableItems.length,
      itemIds: items.map((item) => item.id),
      failedItemIds: failedItems.map((item) => item.id),
      unassessedItemIds: unassessedItems.map((item) => item.id),
    };
  });

  const scoreEligibleItems = itemResults.filter((item) => item.result !== 'N/A' && item.result !== 'UNASSESSED');
  const coverageEligibleItems = itemResults.filter((item) => item.result !== 'N/A');
  const earnedWeight = scoreEligibleItems
    .filter((item) => item.result === 'PASS')
    .reduce((sum, item) => sum + item.weight, 0);
  const possibleWeight = scoreEligibleItems.reduce((sum, item) => sum + item.weight, 0);
  const assessedWeight = scoreEligibleItems.reduce((sum, item) => sum + item.weight, 0);
  const coverageWeight = coverageEligibleItems.reduce((sum, item) => sum + item.weight, 0);
  const failedItems = itemResults.filter((item) => item.result === 'FAIL' || item.result === 'MISSING');
  const unassessedItems = itemResults.filter((item) => item.result === 'UNASSESSED');
  const notApplicableItems = itemResults.filter((item) => item.result === 'N/A');
  const highSeverityGaps = failedItems.filter((item) => item.severity === 'high').map((item) => item.id);

  return {
    version: 'architecture-scorecard-v1',
    scoringMode: indexedReviewResults.size > 0 ? 'review-result' : 'artifact-heuristic',
    totalScore: _roundPercent(earnedWeight, possibleWeight),
    coverageScore: _roundPercent(assessedWeight, coverageWeight),
    assessedItems: scoreEligibleItems.length,
    notApplicableItems: notApplicableItems.length,
    totalItems: itemResults.length,
    dimensions,
    gapSummary: {
      failedItemIds: failedItems.map((item) => item.id),
      unassessedItemIds: unassessedItems.map((item) => item.id),
      notApplicableItemIds: notApplicableItems.map((item) => item.id),
      highSeverityGapIds: highSeverityGaps,
      summaryText: failedItems.length > 0
        ? `${failedItems.length} checklist gap(s), including ${highSeverityGaps.length} high-severity gap(s).`
        : unassessedItems.length > 0
          ? `No confirmed failures, but ${unassessedItems.length} item(s) remain unassessed.`
          : 'No architecture checklist gaps detected.',
    },
    itemResults,
  };
}

function renderArchitectureScorecardMarkdown(scorecard) {
  if (!scorecard) return '## Architecture Scorecard\n\n- Scorecard unavailable.';

  const lines = [
    '## Architecture Scorecard',
    '',
    `- Total Score: ${scorecard.totalScore ?? 'N/A'}`,
    `- Coverage Score: ${scorecard.coverageScore ?? 'N/A'}`,
    `- Scoring Mode: ${scorecard.scoringMode}`,
    `- Gap Summary: ${scorecard.gapSummary.summaryText}`,
    '',
    '| Dimension | Score | Coverage | Failed | Unassessed |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];

  for (const dimension of scorecard.dimensions) {
    lines.push(
      `| ${dimension.category} | ${dimension.totalScore ?? 'N/A'} | ${dimension.coverageScore ?? 'N/A'} | ${dimension.failedCount} | ${dimension.unassessedCount} |`
    );
  }

  return lines.join('\n');
}

module.exports = {
  ARCHITECTURE_CHECKLIST,
  ARCHITECTURE_SCORECARD_DIMENSIONS,
  buildArchitectureScorecard,
  renderArchitectureScorecardMarkdown,
};