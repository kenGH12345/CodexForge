/**
 * Core Module Index
 *
 * Central exports for all core workflow modules.
 */

'use strict';

module.exports = {
  // Token Management
  ...require('./token-budget'),
  ...require('./prompt-builder'),

  // Context Decision Signals (T-0: shared by G3/G4/G5/G6 context engineering)
  ...require('./context-decision-signals'),
  
  // Compression (P0 Enhancements)
  ...require('./block-compressor'),
  ...require('./semantic-compressor'),
  
  // Task Execution (P0 Enhancement)
  ...require('./task-batcher'),
  
  // Context & Knowledge
  ...require('./context-loader'),
  ...require('./arch-knowledge-cache'),
  
  // Self-Evolution Enhancement (Intent Tracking + Session Cache)
  ...require('./intent-tracker'),
  ...require('./session-error-cache'),
  ...require('./evolution-loop-intent-mixin'),
  
  // Orchestration
  ...require('./memory-manager'),
  
  // Utilities
  IDEDetection: require('./ide-detection'),
};
