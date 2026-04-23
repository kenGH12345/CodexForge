# Runtime Layer API Reference

## Overview

The Runtime Layer provides structured state management and event sourcing for workflow execution.
It replaces ad-hoc file reads/writes with a typed, contract-validated interface.

**Module path**: `workflow/core/runtime`

```js
const {
  FileStateStore, JsonlEventStore, RuntimeEventStore,
  RuntimeProjector, validateStateManager, validateEventStore,
  SCHEMA_VERSION, SESSION_STATUS, STAGE_STATUS, TASK_STATUS,
} = require('../core/runtime');
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  StateMachine│────▶│ FileStateStore│────▶│ session-state.json│
│   (Facade)  │     │  (IStateManager)│    │ index.json        │
└─────────────┘     └──────────────┘     │ checkpoints/      │
       │                                  └──────────────────┘
       ▼
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│ EventJournal│────▶│RuntimeEvent  │────▶│ event-log.jsonl   │
│  (Adapter)  │     │   Store      │     └──────────────────┘
│             │     │ (IEventStore)│
└─────────────┘     └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ JsonlEvent   │
                    │   Store      │
                    │ (backing)    │
                    └──────────────┘
```

## IStateManager

The primary interface for workflow state read/write. All session, stage, task,
checkpoint, and recovery metadata must flow through this interface.

### Methods

| Method | Input | Returns | Description |
|--------|-------|---------|-------------|
| `createSession(input)` | `{projectId?, requirement, requirementFingerprint?, mode?, initialStage?}` | `WorkflowSession` | Create new session; returns full session object |
| `loadSession(sessionId)` | `string` | `WorkflowSession \| null` | Load session by ID |
| `beginStage(input)` | `{sessionId, stage, stageInput?}` | `StageRun` | Transition to a new stage |
| `completeStage(input)` | `{stage, outputRefs?, eventSeq?}` | `StageRun` | Mark stage as completed |
| `beginTask(input)` | `{taskId, stage, subtask?, idempotencyKey?}` | `TaskRun` | Start a task within a stage |
| `completeTask(input)` | `{taskId, resultRef?, eventSeq?}` | `TaskRun` | Mark task as completed |
| `failTask(input)` | `{taskId, error, eventSeq?}` | `TaskRun` | Mark task as failed |
| `saveCheckpoint(input)` | `{sessionId, stage?, eventSeq?, taskCursor?}` | `Checkpoint` | Snapshot current session state |
| `setRecovery(input)` | `{sessionId, recoverable, pendingRetry?, retryCount?, questions?, blindSpots?}` | `void` | Update recovery metadata |
| `loadRecovery(sessionId)` | `string` | `RecoveryMeta \| null` | Read recovery metadata |
| `projectCompatibility(input)` | `{sessionId, format}` | `object` | Project to legacy format |

### FileStateStore (Implementation)

```js
const sm = new FileStateStore({
  runtimeDir: '/path/to/output/runtime',  // default: output/runtime
  projector: projectorInstance,            // optional: for projectCompatibility
});
```

**Storage layout**:
- `session-state.json` — current session (atomic write)
- `index.json` — session index for quick lookup
- `checkpoints/{sessionId}.json` — checkpoint snapshots

**Version tracking**: Each `_saveUpdated()` call increments `session.version` by 1.

## IEventStore

Durable append-only event log. Source of truth for recovery and audit.

### Methods

| Method | Input | Returns | Description |
|--------|-------|---------|-------------|
| `append(input)` | `{sessionId?, kind, stage?, payload?, causationId?, correlationId?}` | `StoredEvent` | Append single event |
| `appendBatch(inputs)` | `AppendEventInput[]` | `StoredEvent[]` | Append multiple events atomically |
| `query(filter)` | `{sessionId?, stage?, kind?, since?, until?, limit?}` | `StoredEvent[]` | Query events by filter |
| `queryByCategory(category)` | `string` | `StoredEvent[]` | Filter by event category |
| `getCausationChain(eventId)` | `string` | `StoredEvent[]` | Trace causation chain |
| `getStats()` | — | `{totalEvents, eventsByCategory, firstEventTs, lastEventTs}` | Event statistics |
| `subscribeLive(callback)` | `(event) => void` | `() => void` | Real-time event subscription; returns unsubscribe fn |
| `attachToHookSystem(hookSystem)` | `HookSystem` | `void` | Auto-capture hook events |

### RuntimeEventStore (Implementation)

```js
const backingStore = new JsonlEventStore({ dir: '/path/to/events' });
const eventStore = new RuntimeEventStore({
  backingStore,
  sessionId: 'wf-123',  // optional: auto-set on events
});
```

**Event enrichment**: Auto-adds `sessionId`, `stage`, `category`, `iso` timestamp.
**Sanitization**: Truncates strings >500 chars, removes functions, limits depth to 3.
**Categories**: `LIFECYCLE`, `GUARD`, `TRACE`, `RECOVERY`, `SYSTEM`.

### JsonlEventStore (Backing Store)

```js
const store = new JsonlEventStore({ dir: '/path/to/events' });
```

Simple JSONL file-based append-only log. Each line is a JSON event with auto-generated
`eventId`, `ts`, and `seq` fields.

## RuntimeProjector

Projects runtime state to legacy-compatible formats for Hook system and Bridge compatibility.

```js
const projector = new RuntimeProjector(stateManager, eventStore);
```

| Method | Returns | Description |
|--------|---------|-------------|
| `projectManifest(sessionId)` | `{version, projectId, currentState, history, artifacts, risks, meta}` | Manifest-compatible view |
| `projectWorkflowStatus(sessionId)` | `{activeWorkflow: {session, projectId, currentStage, completedStages[], stageStartTime, ...}}` | Workflow status view for Hook system |
| `projectHealthTrace(sessionId)` | `HealthTraceEntry[]` | Ordered health trace entries |

## Contract Validation

```js
const { validateStateManager, validateEventStore } = require('../core/runtime');

const smResult = validateStateManager(stateManagerInstance);
// { pass: true/false, missing: [], extra: [] }

const esResult = validateEventStore(eventStoreInstance);
// { pass: true/false, missing: [], extra: [] }
```

## Types & Constants

| Constant | Values |
|----------|--------|
| `SESSION_STATUS` | `CREATED`, `RUNNING`, `PAUSED`, `COMPLETED`, `FAILED`, `ABORTED` |
| `STAGE_STATUS` | `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `SKIPPED` |
| `TASK_STATUS` | `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `SKIPPED` |
| `RUNTIME_MODE` | `SEQUENTIAL`, `TASK_BASED` |
| `SCHEMA_VERSION` | `2.0` |
| `EVENT_CATEGORY` | `LIFECYCLE`, `GUARD`, `TRACE`, `RECOVERY`, `SYSTEM` |

## Write Protocol

Event-first, then state:

```
1. EventStore.append({ kind: 'stage_started', ... })   // immutable fact
2. StateManager.beginStage({ ... })                     // mutable projection
3. HookSystem.emit('stage:started', ...)                 // side effects
```

This ensures the event log is always the source of truth for recovery,
even if the state write fails.
