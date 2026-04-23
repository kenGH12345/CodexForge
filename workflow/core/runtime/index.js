'use strict';

const { IStateManager, STATE_MANAGER_METHODS } = require('./state-manager');
const { IEventStore, EVENT_STORE_METHODS } = require('./event-store');
const { IRuntimeProjector, RuntimeProjector, RUNTIME_PROJECTOR_METHODS } = require('./runtime-projector');
const { FileStateStore } = require('./file-state-store');
const { JsonlEventStore } = require('./jsonl-event-store');
const { RuntimeEventStore } = require('./runtime-event-store');
const { ProjectionContractValidator } = require('./projection-contract-validator');
const { validateStateManager, validateEventStore, validateRuntimeProjector, validateAll } = require('./contract-validator');
const {
  EVENT_KINDS, SESSION_STATUS, STAGE_STATUS, TASK_STATUS,
  RUNTIME_MODE, SCHEMA_VERSION, EVENT_CATEGORY, HOOK_TO_CATEGORY_MAP,
} = require('./types');
const { ResumeEngine } = require('./resume-engine');
const { CompensationLedger } = require('./compensation-ledger');

module.exports = {
  IStateManager, STATE_MANAGER_METHODS,
  IEventStore, EVENT_STORE_METHODS,
  IRuntimeProjector, RuntimeProjector, RUNTIME_PROJECTOR_METHODS,
  FileStateStore,
  JsonlEventStore,
  RuntimeEventStore,
  ProjectionContractValidator,
  validateStateManager, validateEventStore, validateRuntimeProjector, validateAll,
  EVENT_KINDS, SESSION_STATUS, STAGE_STATUS, TASK_STATUS,
  RUNTIME_MODE, SCHEMA_VERSION, EVENT_CATEGORY, HOOK_TO_CATEGORY_MAP,
  ResumeEngine,
  CompensationLedger,
};
