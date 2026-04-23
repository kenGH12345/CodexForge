'use strict';

const { SCHEMA_VERSION, SESSION_STATUS, STAGE_STATUS, TASK_STATUS, RUNTIME_MODE, EVENT_KINDS } = require('./types');

/**
 * IStateManager — workflow runtime 的唯一状态读写入口。
 * 所有 session / stage / task / checkpoint / recovery meta 的读写必须经过此接口。
 * 实现类必须通过 contract-validator.validateStateManager() 验证。
 *
 * 协作协议：事件先写（EventStore.append），再写状态（StateManager.xxx）。
 * 旧 manifest / workflow-status 退化为 RuntimeProjector 输出的兼容视图。
 */
class IStateManager {
  /**
   * @param {import('./types').CreateSessionInput} input
   * @returns {import('./types').WorkflowSession}
   * @throws {Error} conflict | io_error | validation_error
   */
  createSession(input) {
    throw new Error('IStateManager.createSession: not implemented');
  }

  /**
   * @param {string} sessionId
   * @returns {import('./types').WorkflowSession|null}
   */
  loadSession(sessionId) {
    throw new Error('IStateManager.loadSession: not implemented');
  }

  /**
   * @param {import('./types').WorkflowSession} session
   * @param {import('./types').SaveOptions} [opts]
   * @returns {import('./types').SaveResult}
   * @throws {Error} version_conflict | io_error
   */
  saveSession(session, opts) {
    throw new Error('IStateManager.saveSession: not implemented');
  }

  /**
   * @param {import('./types').BeginStageInput} input
   * @returns {import('./types').StageRun}
   * @throws {Error} invalid_transition | version_conflict
   */
  beginStage(input) {
    throw new Error('IStateManager.beginStage: not implemented');
  }

  /**
   * @param {import('./types').CompleteStageInput} input
   * @returns {import('./types').StageRun}
   * @throws {Error} invalid_transition | version_conflict
   */
  completeStage(input) {
    throw new Error('IStateManager.completeStage: not implemented');
  }

  /**
   * @param {import('./types').FailStageInput} input
   * @returns {import('./types').StageRun}
   * @throws {Error} invalid_transition | version_conflict
   */
  failStage(input) {
    throw new Error('IStateManager.failStage: not implemented');
  }

  /**
   * @param {import('./types').BeginTaskInput} input
   * @returns {import('./types').TaskRun}
   */
  beginTask(input) {
    throw new Error('IStateManager.beginTask: not implemented');
  }

  /**
   * @param {import('./types').CompleteTaskInput} input
   * @returns {import('./types').TaskRun}
   */
  completeTask(input) {
    throw new Error('IStateManager.completeTask: not implemented');
  }

  /**
   * @param {import('./types').FailTaskInput} input
   * @returns {import('./types').TaskRun}
   */
  failTask(input) {
    throw new Error('IStateManager.failTask: not implemented');
  }

  /**
   * @param {import('./types').SaveCheckpointInput} input
   * @returns {import('./types').Checkpoint}
   */
  saveCheckpoint(input) {
    throw new Error('IStateManager.saveCheckpoint: not implemented');
  }

  /**
   * @param {string} sessionId
   * @returns {import('./types').Checkpoint|null}
   */
  getLatestCheckpoint(sessionId) {
    throw new Error('IStateManager.getLatestCheckpoint: not implemented');
  }

  /**
   * @param {import('./types').RollbackMetaInput} input
   * @returns {import('./types').RecoveryMeta}
   */
  markRollback(input) {
    throw new Error('IStateManager.markRollback: not implemented');
  }

  /**
   * @param {import('./types').RetryMetaInput} input
   * @returns {import('./types').RecoveryMeta}
   */
  markRetry(input) {
    throw new Error('IStateManager.markRetry: not implemented');
  }

  /**
   * @param {string} sessionId
   * @returns {import('./types').CompatibilityView}
   */
  projectCompatibility(sessionId) {
    throw new Error('IStateManager.projectCompatibility: not implemented');
  }
}

const STATE_MANAGER_METHODS = Object.freeze([
  'createSession', 'loadSession', 'saveSession',
  'beginStage', 'completeStage', 'failStage',
  'beginTask', 'completeTask', 'failTask',
  'saveCheckpoint', 'getLatestCheckpoint',
  'markRollback', 'markRetry',
  'projectCompatibility',
]);

module.exports = { IStateManager, STATE_MANAGER_METHODS };
