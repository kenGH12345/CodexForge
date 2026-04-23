# Runtime Layer Migration Guide

## Migration: Legacy State → Runtime Layer

### Quick Reference

| Legacy Pattern | Runtime Replacement | Notes |
|---|---|---|
| Read `manifest.json` directly | `stateManager.loadSession(sessionId)` | Typed access, version tracking |
| Write `manifest.json` directly | `stateManager.createSession()` / `beginStage()` | Atomic writes, no corruption |
| Read `workflow-status.json` | `projector.projectWorkflowStatus(sessionId)` | Compat projection, same shape |
| Write `workflow-status.json` | Auto via `stateManager` + Bridge dual-write | No manual writes needed |
| `EventJournal.append()` | `runtimeEventStore.append()` | Same API, enriched with category |
| `EventJournal.query()` | `runtimeEventStore.query()` | Same filter shape |
| `EventJournal.getStats()` | `runtimeEventStore.getStats()` | Same return shape |
| `StateMachine` constructor | Same API, `useRuntimeState: true` (default) | Zero-breaking change |

### Step-by-Step Migration

#### 1. StateMachine (Already Migrated)

The `StateMachine` facade already delegates to `FileStateStore` when `useRuntimeState`
is `true` (the default). No caller changes needed.

```js
// Before and After — identical API
const sm = new StateMachine({ useRuntimeState: true });
sm.init('my-project');    // internally uses FileStateStore.createSession()
sm.transition('ANALYSE'); // internally uses FileStateStore.beginStage()
```

#### 2. EventJournal → RuntimeEventStore

The `EventJournal` class now delegates to `RuntimeEventStore` when the option is passed:

```js
// Before
const journal = new EventJournal({ dir: 'output/', sessionId: 'wf-1' });

// After (dual-write mode)
const backingStore = new JsonlEventStore({ dir: 'output/events' });
const runtimeES = new RuntimeEventStore({ backingStore, sessionId: 'wf-1' });
const journal = new EventJournal({ dir: 'output/', runtimeEventStore: runtimeES });
```

In dual-write mode, `EventJournal.append()` writes to both the old JSONL file and
the new `RuntimeEventStore`. This enables zero-downtime migration.

#### 3. Bridge Dual-Write (Already Implemented)

The IDE workflow bridge writes to both legacy files and the runtime layer:

```js
// In ide-workflow-bridge.js
function writeWorkflowStatus(data, projectRoot) {
  // Legacy write
  fs.writeFileSync(legacyPath, JSON.stringify(data, null, 2));
  // Runtime write (if enabled)
  if (stateManager) { stateManager.beginStage({ ... }); }
}
```

#### 4. Reading State

| What you need | Use this |
|---|---|
| Current stage | `session.currentStage` from `loadSession()` |
| Stage status | `session.stages[stageName].status` |
| Task list | `session.tasks` (flat map keyed by taskId) |
| Recovery info | `stateManager.loadRecovery(sessionId)` |
| Checkpoint data | `stateManager.saveCheckpoint({ sessionId, stage })` |
| Legacy manifest | `projector.projectManifest(sessionId)` |
| Legacy status | `projector.projectWorkflowStatus(sessionId)` |
| Health trace | `projector.projectHealthTrace(sessionId)` |

### Key Differences from Legacy

| Aspect | Legacy | Runtime |
|---|---|---|
| State file | `manifest.json` (untyped JSON) | `session-state.json` (typed, versioned) |
| Event log | `event-journal-*.jsonl` (per-session) | `event-log.jsonl` (append-only, global) |
| Version tracking | None | `session.version` auto-increment |
| Crash recovery | Manual file inspection | `loadSession()` + `loadRecovery()` |
| Checkpointing | Not supported | `saveCheckpoint()` with snapshot |
| Task tracking | Not available | `beginTask/completeTask/failTask` |
| Contract validation | None | `validateStateManager/EventStore()` |

### Common Pitfalls

1. **`createSession()` returns full session object** — extract `sessionId` from result:
   ```js
   const result = stateManager.createSession({ requirement: '...' });
   const sessionId = result.sessionId; // NOT result itself
   ```

2. **Initial `currentStage` is `null`** — not `'INIT'`, unless `initialStage` is provided:
   ```js
   stateManager.createSession({ ..., initialStage: 'INIT' }); // explicit
   ```

3. **`completeStage()` does NOT take `sessionId`** — only `{ stage, outputRefs?, eventSeq? }`

4. **`beginTask()` uses `taskId` not `taskName`** — tasks are keyed by arbitrary unique IDs

5. **`projectHealthTrace()` returns array** — not an object with entries

6. **`RuntimeEventStore` requires `backingStore`** — not `dir`:
   ```js
   // WRONG
   new RuntimeEventStore({ dir: '/path' });
   // CORRECT
   new RuntimeEventStore({ backingStore: new JsonlEventStore({ dir: '/path' }) });
   ```

7. **Contract validation returns `.pass` not `.valid`**:
   ```js
   const result = validateStateManager(sm);
   result.pass;  // boolean
   result.valid; // undefined!
   ```

### Rollback Plan

If issues arise, disable runtime layer:

```js
const sm = new StateMachine({ useRuntimeState: false }); // falls back to legacy
```

Or in `workflow.config.js`:
```js
module.exports = {
  runtime: { enabled: false }
};
```

## Phase 4: Runtime State Manager (Façade Layer)

**Status**: ✅ COMPLETED
**Date**: 2026-04-19
**Commit**: Runtime State System Migration

### 4.1 Overview

The `WorkRuntimeStateManager` provides a unified façade over all Runtime State components:
- **FileStateStore** - State persistence
- **RuntimeEventStore** - Event storage and replay
- **ResumeEngine** - Recovery orchestration
- **CompensationLedger** - Compensation transactions

### 4.2 Architecture

```
CLI/Bridge
    ↓
WorkRuntimeStateManager (Façade)
    ├── createSession() / getSession() / listSessions()
    ├── getCurrentStage() / getStageStatus() / getTaskStatus()
    ├── inspect() / canResume() / buildPlan() / resume()
    └── markBlocked() / unblock()
    ↓
ResumeEngine (per-session instances)
    ├── FileStateStore
    ├── RuntimeEventStore ← JsonlEventStore
    └── CompensationLedger
```

### 4.3 CLI Commands

| Command | Description | Example |
|---------|-------------|---------|
| `runtime create` | Create new session | `runtime --operation create --requirement "..."` |
| `runtime list` | List all sessions | `runtime --operation list [--statusFilter active]` |
| `runtime status` | Get session status | `runtime --operation status --session <id>` |
| `runtime inspect` | Inspect resumability | `runtime --operation inspect --session <id>` |
| `runtime plan` | Build resume plan | `runtime --operation plan --session <id>` |
| `runtime resume` | Execute resume | `runtime --operation resume --session <id>` |
| `runtime block` | Mark unrecoverable | `runtime --operation block --session <id> --reason "..."` |
| `runtime unblock` | Remove block | `runtime --operation unblock --session <id>` |

### 4.4 File Changes

#### New
- `workflow/core/runtime/work-runtime-state-manager.js` - Core façade implementation

#### Modified
- `workflow/tools/ide-workflow-bridge.js` - Added `runtime` command handler

### 4.5 Verification

```bash
# Verify commands work
node workflow/tools/ide-workflow-bridge.js runtime --operation list
node workflow/tools/ide-workflow-bridge.js runtime --operation create --requirement "test"
node workflow/tools/ide-workflow-bridge.js runtime --operation status --session <id>
```

### 4.6 Quality Metrics

- Test Pass Rate: 100% (12/12)
- Code Coverage: Runtime State module
- Lines Added: ~250
- Files Modified: 2

---
