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
  
  // Compression (P0 Enhancements)
  ...require('./block-compressor'),
  ...require('./semantic-compressor'),
  
  // Task Execution (P0 Enhancement)
  ...require('./task-batcher'),
  
  // Context & Knowledge
  ...require('./context-loader'),
  ...require('./arch-knowledge-cache'),
  
  // Orchestration
  ...require('./memory-manager'),
  
  // Utilities
  IDEDetection: require('./ide-detection'),
};
