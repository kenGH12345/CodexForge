---
name: test-generation
version: 1.0.0
type: domain-skill
domains: [testing, qa, test-design, test-generation]
dependencies: [test-report]
load_level: task
max_tokens: 1500
triggers:
  keywords: [test, test case, test generation, boundary, edge case, coverage, equivalence, partition, state transition, mutation]
  roles: [tester, coding-agent]
description: "Systematic test case design methodology: equivalence partitioning, boundary value analysis, state transition, cause-effect graphing, and diff-driven test generation"
---
# Skill: test-generation

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: Systematic test case design methodology for generating high-quality, high-coverage test cases
> **Domains**: testing, qa, test-design, test-generation
> **Industry References**: Qodo Cover (CodiumAI), BitsAI-CR (ByteDance), ISTQB test design techniques

---

## Rules

### R1: Diff-Driven Test Design (Mandatory)
When generating test cases from a code diff:
1. **Extract changed functions**: Identify every function/method that was added or modified in the diff
2. **Analyse function signatures**: Input types, return types, parameter constraints, default values
3. **Identify state changes**: What data/state does this function read or mutate?
4. **Map to test techniques**: For each function, select the most appropriate technique(s) from the SOP below
5. **Never generate tests for unchanged code** unless it's a dependency of changed code

### R2: Minimum Test Technique Coverage
Every test suite MUST apply at least 3 of the following 6 techniques:
- Equivalence Partitioning (EP)
- Boundary Value Analysis (BVA)
- State Transition Testing (STT)
- Decision Table Testing (DTT)
- Error Guessing (EG)
- Property-Based Testing (PBT)

If fewer than 3 techniques are applicable, document WHY with evidence.

### R3: Test Case Completeness
Every test case MUST include ALL of the following:
- **case_id**: Unique identifier (format: TC_FEATURE_NNN)
- **technique**: Which test design technique generated this case (EP/BVA/STT/DTT/EG/PBT)
- **precondition**: System state before test execution
- **input**: Exact input values (concrete, not "some value")
- **expected_output**: Exact expected result (measurable, not "should work")
- **priority**: P0 (critical path) / P1 (important) / P2 (nice-to-have)
- **code_reference**: file:line or function name being tested

### R4: Anti-Hallucination for Test Data
- All test data MUST be derived from the code's actual type constraints
- Do NOT invent test data that the code cannot accept (e.g., string for a number parameter)
- If the code has validation, test data must include both valid and invalid inputs per the actual validation rules
- Reference the exact validation logic from the diff when designing boundary values

---

## SOP (Standard Operating Procedure)

### Phase 1: Change Impact Analysis
1. Parse the code diff to identify all changed files, functions, and classes
2. For each changed function, extract:
   - Function signature (parameters, types, return type)
   - Input validation rules (if any)
   - State dependencies (what it reads: DB, config, global state)
   - Side effects (what it writes: DB, files, events, logs)
3. Build a **Change Impact Map**: `function → [inputs, outputs, state, side-effects]`
4. Prioritise functions by risk: public API > business logic > utility > internal helper

### Phase 2: Equivalence Partitioning (EP)
For each input parameter, divide the input domain into equivalence classes:

| Class Type | Description | Example |
|-----------|-------------|---------|
| **Valid** | Inputs the function is designed to handle | `age: 25` (valid range 0-150) |
| **Invalid** | Inputs that should trigger error handling | `age: -1`, `age: "abc"` |
| **Special** | Edge values with special semantics | `age: 0` (newborn), `age: null` |

Rules:
- At least 1 test case per equivalence class
- For N input parameters with M classes each, use **pairwise combination** (not full cartesian product) to keep test count manageable
- Document which classes were combined and why

### Phase 3: Boundary Value Analysis (BVA)
For each numeric/string/collection parameter with defined boundaries:

| Boundary Point | Test Values |
|---------------|-------------|
| Minimum | min-1, min, min+1 |
| Maximum | max-1, max, max+1 |
| Zero/Empty | 0, "", [], {} |
| Type boundary | MAX_SAFE_INTEGER, Number.EPSILON |

Rules:
- **3-point BVA** (minimum): test at boundary, just below, just above
- **7-point BVA** (thorough): add nominal value + extreme values
- For string inputs: empty string, single char, max length, max length + 1
- For arrays: empty, single element, max size, max size + 1

### Phase 4: State Transition Testing (STT)
For functions that change system state (e.g., workflow stages, order status):

1. Draw the state transition diagram:
   ```
   INIT → ANALYSE → ARCHITECT → PLAN → CODE → TEST → FINISHED
   ```
2. Generate test cases for:
   - **Valid transitions**: Every arrow in the diagram
   - **Invalid transitions**: Transitions NOT in the diagram (e.g., TEST → INIT)
   - **Transition sequences**: Common paths through the state machine (happy path + error recovery)
3. For each transition, verify:
   - Pre-condition (source state)
   - Trigger (what causes the transition)
   - Post-condition (target state + side effects)
   - Guard conditions (what prevents the transition)

### Phase 5: Decision Table Testing (DTT)
For functions with complex conditional logic (multiple if/else, switch):

1. List all conditions (inputs/states that affect the decision)
2. List all actions (outputs/side-effects)
3. Build the decision table:
   | Condition 1 | Condition 2 | Condition 3 | → Action |
   |------------|------------|------------|----------|
   | T | T | T | Action A |
   | T | T | F | Action B |
   | T | F | * | Action C |
4. Collapse redundant rows (use `*` for "don't care")
5. Generate one test case per unique row

### Phase 6: Error Guessing & Exploratory
Based on common defect patterns in the technology stack:

**JavaScript/Node.js specific:**
- `undefined` vs `null` vs `0` vs `""` vs `false` (falsy confusion)
- Prototype pollution via `__proto__` or `constructor`
- Async/await without try-catch (unhandled rejection)
- `parseInt("08")` octal parsing
- `typeof null === "object"` surprise
- Array methods on non-arrays (`.map()` on undefined)
- RegExp catastrophic backtracking (ReDoS)

**General patterns:**
- Concurrent access / race conditions
- Resource exhaustion (memory, file handles, connections)
- Timezone-dependent logic
- Unicode edge cases (emoji, RTL, zero-width chars)
- Large input (10x expected size)
- Rapid repeated calls (idempotency)

### Phase 7: Property-Based Testing (PBT)
For pure functions or serialization/deserialization:

1. **Round-trip property**: `deserialize(serialize(x)) === x`
2. **Idempotency**: `f(f(x)) === f(x)` (for normalisation functions)
3. **Monotonicity**: If `x < y` then `f(x) <= f(y)` (for sorting/ranking)
4. **Invariant preservation**: After any operation, invariants still hold
5. Use libraries: fast-check (JS), Hypothesis (Python), QuickCheck (Haskell)

---

## Checklist

### Pre-Generation
- [ ] Code diff parsed and change impact map built
- [ ] All changed functions identified with signatures
- [ ] Input validation rules extracted from code
- [ ] Risk prioritisation completed (public API first)

### Test Design Quality
- [ ] At least 3 test design techniques applied
- [ ] Every equivalence class has at least 1 test case
- [ ] Boundary values tested for all numeric/string parameters
- [ ] State transitions tested (valid + invalid)
- [ ] Error paths tested (not just happy path)
- [ ] All test data is concrete (no "some value" placeholders)

### Coverage Verification
- [ ] Every changed function has at least 1 test case
- [ ] Every public API endpoint has happy path + error path tests
- [ ] Coverage matrix maps test cases to requirements
- [ ] No orphan test cases (every test traces to a requirement or risk)

---

## Best Practices

### 1. Risk-Based Test Prioritisation
> "Test the riskiest things first, not the easiest things."
Prioritise test cases by: `Risk = Probability of Failure × Impact of Failure`
- P0: Authentication, payment, data integrity, security boundaries
- P1: Core business logic, API contracts, state transitions
- P2: UI rendering, logging, non-critical utilities

### 2. Test Data as Code (Qodo Cover Pattern)
Generate test data programmatically from function signatures:
```javascript
// Instead of hand-crafting test data:
const testUser = { name: "Test", age: 25 };

// Generate from schema:
const testUser = generateFromSchema(UserSchema, {
  strategy: 'boundary',  // or 'equivalence', 'random'
  seed: 42,              // deterministic
});
```

### 3. Diff-Aware Test Selection (Regression Optimisation)
When code changes are small, don't re-run the entire test suite:
1. Map changed functions to their test cases (via code_reference)
2. Run only affected test cases + their transitive dependents
3. Always run P0 tests regardless of change scope

### 4. Mutation Testing for Test Quality Validation
After generating tests, validate their quality:
- Introduce small mutations to the code (e.g., change `>` to `>=`)
- If tests still pass after mutation → test is weak, needs strengthening
- Target: <20% mutation survival rate for critical code

### 5. Contract-First Test Design
For API functions, design tests from the contract (types + docs) BEFORE reading implementation:
- This prevents "testing the implementation" bias
- Tests become specification-as-code
- Implementation changes that preserve the contract won't break tests

---

## Anti-Patterns

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Generate tests only for happy path | Apply EP: valid + invalid + special classes |
| Use "magic" test data without explanation | Document WHY each test value was chosen (technique + boundary) |
| Test every method mechanically | Test behaviours and scenarios, not methods |
| Copy-paste test cases with minor variations | Use parameterised tests / data-driven testing |
| Ignore the code diff, test everything | Diff-driven: focus on changed functions first |
| Generate 100+ shallow tests | Generate 20-30 deep tests with clear technique attribution |
| Test internal implementation details | Test through public interfaces only |
| Skip error path testing ("it probably works") | Error paths are where most production bugs hide |

---

## Context Hints

- When the diff modifies a **state machine** (e.g., workflow stages), prioritise STT (Phase 4)
- When the diff modifies **validation logic**, prioritise BVA (Phase 3) + EP (Phase 2)
- When the diff modifies **business rules with conditions**, prioritise DTT (Phase 5)
- When the diff modifies **pure functions** (no side effects), prioritise PBT (Phase 7)
- When the diff modifies **API endpoints**, prioritise contract testing + error codes
- When the diff is **security-related**, add fuzzing-style inputs (Phase 6)
- For **JavaScript/TypeScript** projects, always include falsy value confusion tests (Phase 6)

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-04-09 | Initial creation. Systematic test design methodology incorporating: Qodo Cover diff-driven approach, ISTQB test design techniques (EP, BVA, STT, DTT), property-based testing, BitsAI-CR data flywheel concept, and JavaScript-specific error guessing patterns. |
