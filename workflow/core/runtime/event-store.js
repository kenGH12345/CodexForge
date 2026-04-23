'use strict';

const { SCHEMA_VERSION, EVENT_KINDS } = require('./types');

/**
 * IEventStore — workflow runtime 的唯一 durable append-only event log。
 * 作为恢复与审计的事实源（source of truth）。
 * 实现类必须通过 contract-validator.validateEventStore() 验证。
 *
 * 写入原则：只追加不修改；事件先于投影；health trace 不反向驱动 runtime。
 */
class IEventStore {
  /**
   * @param {import('./types').AppendEventInput} input
   * @returns {import('./types').StoredEvent}
   * @throws {Error} write_failed | schema_error | session_not_found
   */
  append(input) {
    throw new Error('IEventStore.append: not implemented');
  }

  /**
   * @param {import('./types').AppendEventInput[]} inputs
   * @returns {import('./types').StoredEvent[]}
   * @throws {Error} write_failed | schema_error
   */
  appendBatch(inputs) {
    throw new Error('IEventStore.appendBatch: not implemented');
  }

  /**
   * @param {import('./types').ReadStreamInput} input
   * @returns {import('./types').StoredEvent[]}
   */
  readStream(input) {
    throw new Error('IEventStore.readStream: not implemented');
  }

  /**
   * @param {import('./types').QueryEventsInput} input
   * @returns {import('./types').StoredEvent[]}
   */
  query(input) {
    throw new Error('IEventStore.query: not implemented');
  }

  /**
   * @param {string} sessionId
   * @returns {number}
   */
  getLastSeq(sessionId) {
    throw new Error('IEventStore.getLastSeq: not implemented');
  }

  /**
   * @param {import('./types').ReplayInput} input
   * @returns {import('./types').ReplayResult}
   * @throws {Error} stream_missing | corrupt_line | schema_incompatible
   */
  replay(input) {
    throw new Error('IEventStore.replay: not implemented');
  }

  /**
   * @param {import('./types').SubscribeInput} input
   * @param {function(import('./types').StoredEvent): void} handler
   * @returns {function(): void} unsubscribe function
   */
  subscribe(input, handler) {
    throw new Error('IEventStore.subscribe: not implemented');
  }

  /**
   * @param {import('./types').CompactInput} input
   * @returns {import('./types').CompactResult}
   */
  compact(input) {
    throw new Error('IEventStore.compact: not implemented');
  }
}

const EVENT_STORE_METHODS = Object.freeze([
  'append', 'appendBatch', 'readStream', 'query',
  'getLastSeq', 'replay', 'subscribe', 'compact',
]);

module.exports = { IEventStore, EVENT_STORE_METHODS };
