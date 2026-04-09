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

module.exports = { ARCHITECTURE_CHECKLIST };