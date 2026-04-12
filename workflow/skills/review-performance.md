---
name: review-performance
version: 2.0.0
type: standards
domains: [performance, code-review]
dependencies: [bp-performance-optimization]
load_level: task
max_tokens: 800
triggers:
  keywords: [performance, latency, throughput, n+1, memory leak, blocking, cache, optimize]
  roles: [reviewer]
description: "Performance-focused review pack with systematic anti-pattern detection"
---

# Skill: review-performance

> **Version**: 2.0.0
> **Purpose**: Systematic performance review based on common anti-patterns and bottleneck categories

## Core Principle

Performance findings must map to a **specific hot path** in the diff with **quantifiable impact direction** (latency/throughput/memory). "This could be slow" is not a finding.

## 1. Performance Anti-Pattern Catalog

### Category A: Database & Query Patterns

| Anti-Pattern | Detection Signal | Impact | Fix Pattern |
|-------------|-----------------|--------|-------------|
| **N+1 Query** | Loop containing DB call; ORM lazy-load in iteration | O(N) queries → latency | Batch fetch / JOIN / eager load |
| **Missing Index** | WHERE/ORDER BY on unindexed column in new query | Full table scan | Add covering index |
| **SELECT \*** | Fetching all columns when only 2-3 needed | Bandwidth + memory | Explicit column list |
| **Unbounded Query** | No LIMIT/pagination on user-facing list endpoint | Memory explosion | Add pagination with cursor/offset |
| **Write Amplification** | UPDATE entire row when only 1 field changed | Lock contention | Partial update |

### Category B: Memory & Resource Patterns

| Anti-Pattern | Detection Signal | Impact | Fix Pattern |
|-------------|-----------------|--------|-------------|
| **Unbounded Collection** | Appending to list/map without size limit | OOM over time | Ring buffer / LRU / max-size check |
| **Missing Cleanup** | Open file/connection/stream without close/defer/finally | Resource leak | try-finally / using / defer |
| **Large Object in Closure** | Lambda/callback capturing entire object when only 1 field needed | GC pressure | Extract needed field before closure |
| **Goroutine/Thread Leak** | Spawning without cancellation/timeout context | Thread exhaustion | Context with timeout + WaitGroup |
| **String Concatenation in Loop** | `+=` on string in hot loop | O(N²) allocation | StringBuilder / join / buffer |

### Category C: I/O & Network Patterns

| Anti-Pattern | Detection Signal | Impact | Fix Pattern |
|-------------|-----------------|--------|-------------|
| **Sync I/O on Hot Path** | Blocking file/network call in request handler | Thread starvation | Async I/O / worker pool |
| **Missing Timeout** | HTTP/DB/RPC call without timeout | Cascading failure | Set explicit timeout |
| **Chatty API** | Multiple sequential API calls that could be batched | Latency × N | Batch endpoint / GraphQL |
| **Missing Connection Pool** | Creating new DB/HTTP connection per request | Connection overhead | Pool with max-size + idle timeout |
| **No Backpressure** | Producer faster than consumer without buffering limit | Memory explosion | Bounded channel / rate limiter |

### Category D: Algorithm & Data Structure Patterns

| Anti-Pattern | Detection Signal | Impact | Fix Pattern |
|-------------|-----------------|--------|-------------|
| **O(N²) in Disguise** | Nested loops; `.includes()` / `.indexOf()` in loop | Latency at scale | Set/Map lookup; sort + binary search |
| **Redundant Computation** | Same expensive calculation repeated in loop | CPU waste | Memoize / compute once outside loop |
| **Wrong Data Structure** | Array for frequent lookups; LinkedList for random access | Suboptimal complexity | Match structure to access pattern |

## 2. Severity Classification

| Severity | Criteria | Action |
|----------|----------|--------|
| **P0-CRITICAL** | Will cause outage/OOM in production at current scale | Block merge |
| **P1-HIGH** | Measurable degradation (>2x latency or >50% memory increase) | Fix before release |
| **P2-MEDIUM** | Suboptimal but acceptable at current scale; will bite at 10x | Track in backlog |
| **P3-LOW** | Style/best-practice; no measurable impact | Note for awareness |

## 3. Evidence Requirements

Every performance finding MUST include:

```
[SEVERITY] Anti-Pattern: <name from catalog>
Location: <file:line> in <function>
Hot path: <request flow that triggers this code>
Impact:   <latency|throughput|memory> — <estimated magnitude>
Fix:      <specific remediation>
```

## Checklist (per diff)

- [ ] No N+1 query patterns in loops (check ORM lazy-loading)
- [ ] All DB queries have appropriate indexes and LIMIT clauses
- [ ] No blocking I/O on latency-sensitive request paths
- [ ] All external calls (HTTP/DB/RPC) have explicit timeouts
- [ ] No unbounded collections growing without size limits
- [ ] Resources (files/connections/streams) properly closed in all paths
- [ ] No O(N²) algorithms hidden in nested loops or repeated lookups
- [ ] Connection pools used for DB/HTTP clients (not per-request creation)
- [ ] Cache usage includes invalidation strategy (TTL/event-based)
- [ ] Goroutines/threads have cancellation context and bounded concurrency

## Anti-Patterns (in reviewing)

- Labeling O(N) as "slow" without knowing N or the hot path
- Suggesting cache everywhere without invalidation strategy
- Ignoring upstream/downstream backpressure effects
- Premature optimization on cold paths (< 1 req/min)
- "This could be slow" without specifying at what scale

## Context Hints

- Quantify impact direction (latency/throughput/memory) per finding
- Prioritize fixes that keep behavior unchanged (pure optimization)
- Consider current scale AND 10x growth when assessing severity
- Hot path = request handler > background job > startup code (priority order)
