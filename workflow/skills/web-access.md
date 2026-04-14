---
name: web-access
version: 1.0.0
type: domain-skill
domains: [web, search, research, documentation]
dependencies: []
load_level: task
max_tokens: 1500
triggers:
  keywords: [web, search, browse, fetch, url, documentation, api-docs, online,
             internet, real-time, latest, current, up-to-date, version,
             compatibility, migration, deprecated, upgrade]
  roles: [analyst, architect, developer, tester]
description: "Web access strategy skill: when to search, how to construct queries,
  how to evaluate results. Adapted from eze-is/web-access (v2.4.3) strategy essence."
---
# Skill: web-access

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: Web access strategy for IDE Agents — when to search, how to query, how to evaluate results.
> **Domains**: web, search, research, documentation
> **Industry References**: [eze-is/web-access](https://github.com/eze-is/web-access) (v2.4.3, strategy layer adapted)

---

## Rules

### R1: Mandatory Search Triggers
You MUST initiate a web search when ANY of these conditions is true:
1. **Unknown API/library**: The task references a technology, API, or library you are not confident about (version-specific behavior, deprecation status, breaking changes)
2. **Version compatibility**: The task involves upgrading, migrating, or checking compatibility between specific versions
3. **Security vulnerability**: The task touches authentication, encryption, or user input handling — search for known CVEs and current best practices
4. **Deprecation warning**: Code uses APIs marked as deprecated — search for recommended replacements
5. **Error resolution**: A runtime error message is unfamiliar — search for the exact error string before guessing

### R2: Search Prohibition
Do NOT search when:
1. **Stable, well-known knowledge**: Language syntax, standard library APIs that haven't changed in years (e.g. `Array.prototype.map`)
2. **Project-internal logic**: Business rules, internal naming conventions, project-specific patterns — these exist in the codebase, not on the internet
3. **Recently searched**: If you searched the same topic within the current session and got results, use the cached result instead of re-searching

### R3: Tool Selection Strategy (adapted from eze-is/web-access "three-layer channel dispatch")
Choose the right tool for the right job:

| Scenario | Tool | Why |
|----------|------|-----|
| General knowledge query (best practices, comparisons, "how to X") | `web_search` | Fast, returns multiple snippets for broad understanding |
| Read a specific URL (official docs, GitHub README, blog post) | `fetchPage` via WebSearchAdapter | Extracts full page content for deep reading |
| Multi-source research (tech evaluation, architecture decision) | `KnowledgePipeline` with `WEB_ARTICLE` source | Orchestrates search + fetch + dedup + analysis |
| Quick error lookup | `web_search` with exact error string | Fastest path to Stack Overflow / GitHub Issues |

**Fallback chain**: If `web_search` returns no results → rephrase query → try broader terms → try `fetchPage` on a known documentation URL.

### R4: Result Freshness Requirement
1. **Always check publication date** — reject technical articles older than 2 years for fast-moving technologies (React, Node.js, TypeScript, Python)
2. **Prefer official documentation** over blog posts — official docs are maintained, blogs are not
3. **Prefer links from search results** over manually constructed URLs — search-result URLs carry full context; hand-crafted URLs may miss required parameters (adapted from eze-is/web-access "site URL reliability" insight)

### R5: Error Response Skepticism (adapted from eze-is/web-access "platform error messages are unreliable")
When a search or fetch returns "page not found", "content does not exist", or empty results:
1. Do NOT immediately conclude the information doesn't exist
2. Try a different query formulation (more specific or more general)
3. Try a different tool (switch from `web_search` to `fetchPage` or vice versa)
4. The error may be a rate limit, geo-restriction, or anti-bot measure — not a genuine 404

### R6: Evidence-Based Application
1. Every piece of information obtained from web search MUST be cited with its source URL
2. Do NOT silently incorporate web knowledge — always attribute: "According to [source]..."
3. Cross-verify critical information (security fixes, breaking changes) with at least 2 independent sources
4. Never apply a web-sourced solution without understanding WHY it works

---

## SOP (Standard Operating Procedure)

### Phase 1: DECIDE — Should I search?
1. Check R1 triggers — if ANY match, proceed to Phase 2
2. Check R2 prohibitions — if ANY match, skip search and use existing knowledge
3. If uncertain, default to searching — the cost of a search is low, the cost of wrong information is high

### Phase 2: QUERY — Construct effective search queries
1. **Be specific**: Include technology name + version + specific problem
   - ❌ "how to handle errors" → ✅ "Node.js 20 unhandledRejection best practice 2025"
2. **Use multiple queries**: Search from at least 2 different angles
   - Query A: Problem-focused ("express.js CORS error preflight OPTIONS 403")
   - Query B: Solution-focused ("express.js configure CORS middleware allow all origins")
3. **Time-bound when relevant**: Add year for fast-moving tech ("React 19 Server Components 2026")
4. **Use exact error strings**: For error resolution, quote the exact message ("Cannot find module 'X'")

### Phase 3: EXECUTE — Run the search
1. Select tool per R3 (Tool Selection Strategy)
2. Execute search with constructed query
3. If no results: rephrase and retry (max 3 attempts with different phrasings)
4. If results are poor quality: try a more specific or more general query

### Phase 4: EVALUATE — Assess and apply results (adapted from eze-is/web-access result evaluation)
1. **Authority**: Official docs (10/10) > Reputable tech blogs (7/10) > Stack Overflow answers (6/10) > Random forums (3/10) > AI-generated content (2/10)
2. **Freshness**: Check publication date — apply R4 freshness rules
3. **Relevance**: Does this answer the ORIGINAL question? Not a tangentially related topic?
4. **Consensus**: Do multiple sources agree? If sources conflict, prefer the more authoritative one
5. **Apply with attribution**: Cite the source per R6

---

## Checklist

### Before Searching
- [ ] Confirmed this is NOT stable/well-known knowledge (R2)
- [ ] Confirmed this is NOT project-internal logic (R2)
- [ ] Identified the specific question to answer (not a vague topic)
- [ ] Prepared at least 2 query formulations (Phase 2)

### After Searching
- [ ] Verified result freshness — publication date within acceptable range (R4)
- [ ] Verified result authority — official docs or reputable source (Phase 4)
- [ ] Cross-verified critical information with 2+ sources (R6)
- [ ] Cited source URL in output (R6)
- [ ] Confirmed the result answers the ORIGINAL question, not a tangent

---

## Best Practices

### BP1: Goal-Driven Search (adapted from eze-is/web-access "think like a human" philosophy)
> "Know what you're looking for BEFORE you search."
Define the specific question first, then search. Do not browse aimlessly hoping to find something useful. Every search should have a clear success criterion: "I will know the answer when I find X."

### BP2: Multi-Angle Search
For important decisions (architecture choices, library selection, migration paths), search from multiple angles:
- **Comparison**: "X vs Y for [use case] 2026"
- **Migration**: "migrate from X to Y step by step"
- **Pitfalls**: "X common mistakes gotchas production"
- **Performance**: "X benchmark performance [metric]"
This prevents anchoring on the first result and ensures a balanced view.

### BP3: Progressive Deepening (adapted from eze-is/web-access "three-layer channel dispatch")
Start broad, then narrow:
1. **Broad search** (`web_search`): Understand the landscape — what solutions exist?
2. **Targeted fetch** (`fetchPage`): Deep-read the most promising result's full page
3. **Structured pipeline** (`KnowledgePipeline`): For complex research, use the full pipeline with dedup and analysis
Do not jump to deep reading before understanding the landscape.

### BP4: Cross-Verification for Critical Decisions
For security patches, breaking changes, and deprecation replacements:
- Find the **official announcement** (changelog, release notes, security advisory)
- Find an **independent confirmation** (blog post, Stack Overflow answer, GitHub issue)
- If the two sources conflict, trust the official announcement

### BP5: Token-Efficient Searching
Web search consumes tokens. Minimize waste:
- Use `web_search` (returns snippets) before `fetchPage` (returns full pages)
- Set `maxResults: 3` for exploratory searches, `maxResults: 5` only when comparing options
- Cache results mentally within a session — do not re-search the same topic
- For `KnowledgePipeline`, set `maxFetchPages: 2` to limit deep fetching

---

## Anti-Patterns

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Search with vague queries ("how to code better") | Use specific queries with technology + version + problem |
| Accept first result without checking date | Always verify publication date — reject stale content (R4) |
| Manually construct URLs to documentation pages | Use URLs from search results — they carry full context (R4.3) |
| Trust "page not found" errors at face value | Retry with different query or tool — errors may be false (R5) |
| Apply web-sourced solutions without citing source | Always attribute with source URL (R6) |
| Search for project-internal business logic on the internet | Read the codebase instead — business rules are not on Stack Overflow (R2) |

---

## Context Hints

### ANALYSE Stage
- **When**: Investigating technical feasibility, researching industry approaches, competitive analysis
- **Strategy**: Broad searches with `web_search`. Focus on "how does X solve Y" and "X vs Y comparison"
- **Tool**: `web_search` with `maxResults: 5` for breadth
- **Example queries**: "real-time notification architecture patterns 2026", "WebSocket vs SSE vs long polling comparison"

### ARCHITECT Stage
- **When**: Evaluating technology choices, checking library maturity, reviewing architecture patterns
- **Strategy**: Targeted searches + deep reading. Use `web_search` to find candidates, then `fetchPage` to read official docs
- **Tool**: `web_search` → `fetchPage` for top results
- **Example queries**: "Redis vs Memcached for session storage benchmark", "express.js middleware ordering best practice"

### CODE Stage
- **When**: Looking up API signatures, resolving specific errors, checking version-specific behavior
- **Strategy**: Precise searches with exact terms. Use error strings verbatim. Prefer official API docs
- **Tool**: `web_search` with exact error strings or API names
- **Example queries**: "Node.js crypto.createHash deprecated replacement", "TypeError: Cannot read properties of undefined at Array.map fix"

### TEST Stage
- **When**: Checking test framework features, finding CVE details, verifying expected behavior
- **Strategy**: Quick lookups. Use `web_search` for test framework docs and CVE databases
- **Tool**: `web_search` with `maxResults: 3`
- **Example queries**: "jest mock ES module import 2026", "CVE-2024-XXXX severity impact mitigation"

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-04-13 | Initial creation. Strategy essence adapted from eze-is/web-access (v2.4.3): tool selection strategy (R3), result freshness (R4), error skepticism (R5), goal-driven search (BP1), progressive deepening (BP3). Browser automation and platform-specific features were excluded as out of scope for coding workflows. |
