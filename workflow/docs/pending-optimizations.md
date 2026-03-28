# Pending Optimizations — Data-Driven Trigger Tracking

> **Principle**: Don't implement optimizations prematurely. Plant low-cost probes,
> let data tell you when to act.

---

## #2: Interface Contract Structured Storage

**Status**: 📋 Waiting for trigger  
**Trigger Condition**: 3+ `INTERFACE_MISMATCH` negotiations detected across sessions  
**Current Count**: Check via `NegotiationEngine.getInterfaceMismatchCount()`

### Problem Statement

Module-to-module interface contracts (generated in `architecture.md` by ArchitectAgent)
are currently stored as **text blocks** and extracted via regex in `extractInterfaceContracts()`.
The consumers of these contracts are LLM agents (PlannerAgent, DeveloperAgent), for whom
text format is natural.

However, when module count ≥ 4, there is a risk of **contract drift**:
- Module A declares `getUser(id: string): User`
- Module B implements `getUser(userId: number): UserDTO`
- The mismatch is only caught at CODE stage, causing expensive rollbacks

### Proposed Solution

```typescript
interface InterfaceContract {
  moduleId: string;
  exports: Array<{
    name: string;
    type: 'function' | 'class' | 'interface' | 'event';
    signature: string;
    description: string;
  }>;
  imports: Array<{
    fromModule: string;
    contracts: string[]; // Referenced upstream contract IDs
  }>;
}
```

### Detection Points (Already Implemented)

| Layer | Component | What It Detects |
|-------|-----------|-----------------|
| 1 | `SessionSignalDetector` (`CONTRACT_MISMATCH` pattern) | Keywords like "contract mismatch", "interface mismatch", "签名不一致" in session logs |
| 2 | `NegotiationEngine` (interface mismatch counter) | `ConcernType.INTERFACE_MISMATCH` negotiations, warns at threshold |
| 3 | `ExperienceStore` (sentinel experience) | Pre-recorded negative experience auto-injected into ARCHITECT/PLAN/CODE prompts |

### When to Implement

When you see this console warning:
```
⚠️⚠️⚠️ OPTIMIZATION TRIGGER: N interface mismatches detected.
Consider implementing structured InterfaceContract storage (Optimization #2).
```

Or when the sentinel experience keeps appearing in experience context blocks.

### Estimated Effort

- **Work**: 10-15h
- **Risk**: 🟡 Medium — requires modifying contract extraction and downstream consumers
- **Files to modify**: `module-architect-runner.js`, `stage-planner.js`, `stage-developer.js`

---

## Adding New Optimization Triggers

To add a new pending optimization with data-driven triggers:

1. **Signal Layer**: Add keyword patterns to `SIGNAL_PATTERNS` in `session-signal-detector.js`
2. **Counter Layer**: Add a counter in the relevant engine (e.g., `NegotiationEngine`)
3. **Sentinel Layer**: Record a sentinel experience in `ExperienceStore` with relevant tags
4. **Document**: Add an entry to this file with trigger conditions and proposed solution
