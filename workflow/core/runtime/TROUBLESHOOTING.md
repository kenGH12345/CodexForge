# Runtime Layer Troubleshooting

## Common Issues

### 1. "stateManager.listCheckpoints is not a function"

**Cause**: `listCheckpoints` does not exist on `FileStateStore`. Checkpoints are stored
per-session in `checkpoints/{sessionId}.json`, overwriting on each save.

**Fix**: Use `saveCheckpoint()` return value instead:
```js
const cp = stateManager.saveCheckpoint({ sessionId, stage: 'ANALYSE' });
// cp.checkpointId, cp.snapshot, cp.ts
```

---

### 2. "Cannot read properties of undefined (reading 'append')"

**Cause**: `RuntimeEventStore` constructed without `backingStore`:
```js
// WRONG
new RuntimeEventStore({ dir: '/path' });
```

**Fix**: Always pass a `JsonlEventStore` as `backingStore`:
```js
const backing = new JsonlEventStore({ dir: '/path' });
new RuntimeEventStore({ backingStore: backing, sessionId: 'wf-1' });
```

---

### 3. `createSession()` result is not a string

**Cause**: `createSession()` returns the full `WorkflowSession` object, not just the ID.

**Fix**: Extract `sessionId` from the result:
```js
const session = stateManager.createSession({ requirement: '...' });
const id = session.sessionId; // extract ID
```

---

### 4. Session `currentStage` is `null` after `createSession()`

**Cause**: Without `initialStage`, the session starts with `currentStage: null`.

**Fix**: Either pass `initialStage` or call `beginStage()`:
```js
stateManager.createSession({ ..., initialStage: 'INIT' });
// or
stateManager.beginStage({ sessionId, stage: 'INIT' });
```

---

### 5. `completeStage()` throws "missing sessionId"

**Cause**: `completeStage()` takes `{ stage, outputRefs? }` — no `sessionId` parameter.

**Fix**: The current session is tracked internally by `FileStateStore`:
```js
stateManager.completeStage({ stage: 'ANALYSE', outputRefs: ['output/req.md'] });
```

---

### 6. Contract validation returns `.valid` as undefined

**Cause**: The validator uses `.pass` not `.valid`:
```js
// WRONG
if (validateStateManager(sm).valid) { ... }
// CORRECT
if (validateStateManager(sm).pass) { ... }
```

---

### 7. `projectManifest()` returns `currentState` not `currentStage`

**Cause**: The manifest projection maps to the legacy `manifest.json` shape which uses
`currentState` as the field name.

**Fix**: Use `manifest.currentState` or access `session.currentStage` directly.

---

### 8. `projectHealthTrace()` returns array, not object

**Cause**: Health trace entries are returned as a flat array, not wrapped in an object.

**Fix**:
```js
const trace = projector.projectHealthTrace(sessionId);
// trace is Array, NOT { entries: [...] }
```

---

### 9. Concurrent writes silently overwrite

**Cause**: `FileStateStore._saveUpdated()` does not implement optimistic locking.
The last writer wins by overwriting the file.

**Mitigation**: In single-process IDE mode this is safe. For multi-process scenarios,
use separate session directories or implement a file-lock wrapper.

---

### 10. EventJournal events not appearing in RuntimeEventStore

**Cause**: Dual-write mode requires passing `runtimeEventStore` to `EventJournal`:
```js
const journal = new EventJournal({
  dir: 'output/',
  runtimeEventStore: myRuntimeES,  // REQUIRED for dual-write
});
```

Without this option, `EventJournal` only writes to its own JSONL file.

---

## Diagnostic Commands

```bash
# Validate all runtime contracts
node -e "const {validateAll} = require('./workflow/core/runtime'); validateAll();"

# Check session state file
node -e "console.log(JSON.stringify(require('./output/runtime/session-state.json'), null, 2))"

# Query recent events
node -e "const {JsonlEventStore} = require('./workflow/core/runtime'); \
  const es = new JsonlEventStore({dir:'output/runtime/events'}); \
  console.log(es.query({limit:5}).map(e=>e.kind));"
```
