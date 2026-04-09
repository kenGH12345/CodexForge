---
name: review-performance
version: 1.0.0
type: standards
domains: [performance, code-review]
dependencies: [bp-performance-optimization]
load_level: task
max_tokens: 500
triggers:
  keywords: [performance, latency, throughput, n+1, memory leak, blocking, cache, optimize]
  roles: [reviewer]
description: "Performance-focused review pack for diff risk scenarios"
---

# Skill: review-performance

> **Version**: 1.0.0
> **Description**: Performance-focused review pack for diff risk scenarios

## Rules

- Performance findings must map to specific hot path in diff.
- Prefer bounded fixes (batching/cache/async I/O) over broad refactor.
- Distinguish real bottleneck from style-only concerns.

## Checklist

- N+1 patterns in loops and per-item I/O
- Blocking calls in latency-sensitive paths
- Unbounded memory growth or missing cleanup
- Missing cache/batching opportunities for repeated lookups

## Anti-Patterns

- Labeling complexity concerns without runtime impact
- Suggesting cache everywhere without invalidation strategy
- Ignoring upstream/downstream backpressure effects

## Context Hints

- Quantify impact direction (latency/throughput/memory) per finding.
- Prioritize fixes that keep behavior unchanged.
