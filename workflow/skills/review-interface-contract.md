---
name: review-interface-contract
version: 2.0.0
type: standards
domains: [interface, contract, api, code-review]
dependencies: [api-design]
load_level: task
max_tokens: 800
triggers:
  keywords: [interface, contract, schema, api contract, type mismatch, breaking change, compatibility, export, signature]
  roles: [reviewer]
description: "Interface-contract review pack with breaking change taxonomy and SemVer alignment"
---

# Skill: review-interface-contract

> **Version**: 2.0.0
> **Purpose**: Detect breaking changes, contract violations, and compatibility issues across module boundaries

## Core Principle

Every contract finding needs a **producer/consumer evidence pair**: show the producer's change AND the consumer's expectation. One-sided claims are speculation.

## 1. Breaking Change Taxonomy

### Level 1: API Surface Changes (MAJOR version bump required)

| Change Type | Breaking? | Example |
|------------|-----------|---------|
| Remove public function/method | ✅ BREAKING | `deleteUser()` removed |
| Remove/rename required parameter | ✅ BREAKING | `getUser(id)` → `getUser(uuid)` |
| Change return type | ✅ BREAKING | `string` → `number` |
| Remove field from response object | ✅ BREAKING | Response no longer has `.email` |
| Change error code/format | ✅ BREAKING | `404` → `410` for same condition |
| Narrow accepted input type | ✅ BREAKING | `string|number` → `string` only |
| Add new required parameter | ✅ BREAKING | `getUser(id)` → `getUser(id, tenant)` |

### Level 2: Behavioral Changes (often MAJOR)

| Change Type | Breaking? | Example |
|------------|-----------|---------|
| Change default value | ⚠️ LIKELY | `timeout: 30s` → `timeout: 5s` |
| Change sort order of results | ⚠️ LIKELY | Alphabetical → chronological |
| Add validation that rejects previously valid input | ⚠️ LIKELY | Now rejects empty string |
| Change side effects | ⚠️ LIKELY | Now sends email on create |

### Level 3: Safe Changes (MINOR/PATCH)

| Change Type | Breaking? | Example |
|------------|-----------|---------|
| Add new optional parameter | ✅ SAFE | `getUser(id, options?)` |
| Add new field to response | ✅ SAFE | Response gains `.avatar` |
| Widen accepted input type | ✅ SAFE | `string` → `string|number` |
| Add new endpoint/function | ✅ SAFE | New `POST /users/bulk` |
| Add new enum value | ⚠️ DEPENDS | Safe if consumers use default case |

## 2. Contract Verification Checklist

### Function/Method Contracts

- [ ] **Signature stability**: No removed/renamed public functions
- [ ] **Parameter compatibility**: No new required params; optional params have defaults
- [ ] **Return type stability**: Return shape unchanged or only additive
- [ ] **Error contract**: Same error types/codes for same conditions
- [ ] **Null/undefined handling**: Nullable fields remain nullable; non-null stays non-null

### Module/Package Contracts

- [ ] **Export completeness**: All previously exported symbols still exported
- [ ] **Re-export consistency**: Barrel/index files updated when internal paths change
- [ ] **Dependency direction**: No new circular dependencies introduced
- [ ] **Version alignment**: Package version bumped correctly per SemVer

### API/Schema Contracts

- [ ] **Request schema**: No removed/renamed required fields
- [ ] **Response schema**: No removed fields; new fields are optional
- [ ] **Status codes**: Same codes for same conditions
- [ ] **Content-Type**: No change in accepted/returned media types
- [ ] **Pagination**: Cursor/offset format unchanged
- [ ] **Rate limits**: No reduction without deprecation notice

### Event/Message Contracts

- [ ] **Event schema**: No removed fields in published events
- [ ] **Event name**: No renamed events without dual-publish period
- [ ] **Ordering guarantees**: No change in delivery order semantics
- [ ] **Idempotency**: Consumer-side idempotency not broken by producer changes

## 3. Evidence Requirements

Every contract finding MUST include:

```
[SEVERITY] Contract Violation: <type from taxonomy>
Producer: <file:line> — what changed
Consumer: <file:line> — what expects the old contract
Before:   <old signature/schema>
After:    <new signature/schema>
Impact:   <what breaks for the consumer>
Fix:      <backward-compatible alternative OR migration path>
```

## 4. Deprecation Strategy (for intentional breaking changes)

When a breaking change is necessary:

1. **Announce**: Add `@deprecated` annotation with removal version
2. **Dual-support**: Keep old API working alongside new for ≥1 release cycle
3. **Migrate**: Provide migration guide or automated codemod
4. **Remove**: Only after all known consumers migrated

```
// Phase 1: Deprecate (v2.3.0)
/** @deprecated Use getUserById() instead. Will be removed in v3.0.0 */
function getUser(id) { return getUserById(id); }

// Phase 2: Remove (v3.0.0)
// getUser() removed — BREAKING CHANGE in changelog
```

## 5. Severity Classification

| Severity | Criteria | Action |
|----------|----------|--------|
| **CRITICAL** | Public API breaking change without deprecation | Block merge |
| **HIGH** | Behavioral change affecting known consumers | Block merge; require migration plan |
| **MEDIUM** | Internal module contract change with limited blast radius | Warn; verify all callers updated |
| **LOW** | Potential future incompatibility; no current breakage | Note for awareness |

## Anti-Patterns (in reviewing)

- Declaring "breaking change" without showing a real consumer that breaks
- Assuming dynamic language means no contract risk (JS/Python have implicit contracts)
- Ignoring barrel/index re-export drift (common in monorepos)
- Treating additive changes as breaking (new optional field is safe)
- Missing behavioral changes while only checking type signatures

## Context Hints

- Validate both module boundary and call-site assumptions
- Provide minimum patch that restores compatibility first
- For internal modules: check git blame to find all callers
- For public APIs: assume unknown consumers exist; be conservative
