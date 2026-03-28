/**
 * Experience Event Bus – Decoupled, Event-Driven Architecture for Experience Library
 *
 * Replaces direct method calls between modules with async event-based communication:
 *   - ExperienceStore: Publishes EXPERIENCE_RECORDED, EXPERIENCE_RETRIEVED
 *   - ExperienceEvolution: Subscribes to EXPERIENCE_RECORDED for evolution triggers
 *   - ExperienceDistillation: Subscribes to CAPACITY_WARNING for auto-distillation
 *   - ProblemAbstractionEngine: Subscribes to EXPERIENCE_RECORDED for pattern detection
 *
 * Benefits:
 *   - Loose coupling: Modules communicate via events, not direct calls
 *   - Extensibility: New features subscribe to events without modifying existing code
 *   - Testability: Events can be mocked, timing can be controlled
 *   - Observability: Full event history for debugging and auditing
 *
 * Event Types:
 *   EXPERIENCE_RECORDED     – New experience created (data: experience)
 *   EXPERIENCE_RETRIEVED    – Experience queried (data: experience, query)
 *   EXPERIENCE_EVOLVED      – Skill evolved from experience (data: skillName, experience)
 *   EXPERIENCE_DISTILLED    – Similar experiences merged (data: result)
 *   EXPERIENCE_CONFLICT     – Contradictory experiences detected (data: older, newer)
 *   PATTERN_TRIGGERED       – Anti-pattern detected (data: patternId, experience)
 *   CAPACITY_WARNING        – Store near capacity (data: count, threshold)
 *   HEALTH_DEGRADED         – Trend analysis shows declining health
 *
 * Architecture Compliance:
 *   - ADR-37 IDE-First: No LLM calls in event bus core
 *   - Non-blocking: All handlers execute asynchronously
 *   - Error resilience: Handler errors don't affect other handlers
 *
 * @module experience-event-bus
 */

'use strict';

/**
 * Experience Library Event Types
 * Central registry of all event types for type safety and documentation.
 */
const ExperienceEvents = {
  // Experience Lifecycle Events
  EXPERIENCE_RECORDED: 'experience:recorded',
  EXPERIENCE_RETRIEVED: 'experience:retrieved',
  EXPERIENCE_UPDATED: 'experience:updated',
  EXPERIENCE_DELETED: 'experience:deleted',
  EXPERIENCE_EXPIRED: 'experience:expired',

  // Processing Events
  EXPERIENCE_EVOLVED: 'experience:evolved',
  EXPERIENCE_DISTILLED: 'experience:distilled',
  EXPERIENCE_ARCHIVED: 'experience:archived',
  EXPERIENCE_CONFLICT: 'experience:conflict',

  // Pattern & Abstraction Events
  PATTERN_TRIGGERED: 'pattern:triggered',
  PATTERN_CLEARED: 'pattern:cleared',
  PATTERN_EVOLVED: 'pattern:evolved',
  ABSTRACTION_DETECTED: 'abstraction:detected',

  // System & Health Events
  CAPACITY_WARNING: 'system:capacity_warning',
  CAPACITY_CRITICAL: 'system:capacity_critical',
  HEALTH_DEGRADED: 'system:health_degraded',
  HEALTH_IMPROVED: 'system:health_improved',
  QUALITY_GATE_PASSED: 'system:quality_gate_passed',
  QUALITY_GATE_FAILED: 'system:quality_gate_failed',

  // Skill Events
  SKILL_CREATED: 'skill:created',
  SKILL_EVOLVED: 'skill:evolved',
  SKILL_MERGED: 'skill:merged',

  // Agent Feedback Events
  AGENT_FEEDBACK: 'agent:feedback',
};

/**
 * Priority levels for event handlers
 */
const HandlerPriority = {
  CRITICAL: 0,   // Must execute first (e.g., persistence)
  HIGH: 1,       // Core functionality (e.g., indexing)
  NORMAL: 2,     // Standard processing (e.g., pattern detection)
  LOW: 3,        // Non-essential (e.g., analytics)
  BACKGROUND: 4, // Deferred work (e.g., LLM enrichment)
};

/**
 * Event Bus – Central pub/sub system for experience library
 */
class ExperienceEventBus {
  constructor(options = {}) {
    this._handlers = new Map();        // eventType -> Map(priority -> Set(handler))
    this._onceHandlers = new Map();    // eventType -> Map(priority -> Set(handler))
    this._history = [];                // Event history for debugging
    this._maxHistorySize = options.maxHistorySize || 1000;
    this._debug = options.debug || false;
    this._stats = {
      published: 0,
      handled: 0,
      errors: 0,
    };

    // Wildcard handlers (receive all events)
    this._wildcardHandlers = new Set();
  }

  /**
   * Subscribe to an event type
   *
   * @param {string} eventType – Event type from ExperienceEvents
   * @param {Function} handler – Event handler function
   * @param {object} [options] – Subscription options
   * @param {number} [options.priority=HandlerPriority.NORMAL] – Handler priority
   * @param {boolean} [options.once=false] – Auto-unsubscribe after first call
   * @returns {Function} Unsubscribe function
   */
  on(eventType, handler, options = {}) {
    const priority = options.priority ?? HandlerPriority.NORMAL;
    const once = options.once ?? false;

    if (typeof handler !== 'function') {
      throw new TypeError('Handler must be a function');
    }

    const targetMap = once ? this._onceHandlers : this._handlers;

    if (!targetMap.has(eventType)) {
      targetMap.set(eventType, new Map());
    }

    const priorityMap = targetMap.get(eventType);
    if (!priorityMap.has(priority)) {
      priorityMap.set(priority, new Set());
    }

    priorityMap.get(priority).add(handler);

    this._log('debug', `[EventBus] Subscribed to ${eventType} (priority: ${priority}, once: ${once})`);

    // Return unsubscribe function
    return () => this.off(eventType, handler, { once });
  }

  /**
   * Subscribe to an event type (one-time only)
   *
   * @param {string} eventType – Event type from ExperienceEvents
   * @param {Function} handler – Event handler function
   * @param {object} [options] – Subscription options
   * @returns {Function} Unsubscribe function
   */
  once(eventType, handler, options = {}) {
    return this.on(eventType, handler, { ...options, once: true });
  }

  /**
   * Subscribe to all events (wildcard)
   *
   * @param {Function} handler – Handler receives (eventType, data)
   * @returns {Function} Unsubscribe function
   */
  onAny(handler) {
    this._wildcardHandlers.add(handler);
    return () => this._wildcardHandlers.delete(handler);
  }

  /**
   * Unsubscribe from an event type
   *
   * @param {string} eventType
   * @param {Function} handler
   * @param {object} [options]
   * @param {boolean} [options.once=false]
   */
  off(eventType, handler, options = {}) {
    const targetMap = options.once ? this._onceHandlers : this._handlers;
    const priorityMap = targetMap.get(eventType);
    if (!priorityMap) return;

    for (const [priority, handlers] of priorityMap) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        priorityMap.delete(priority);
      }
    }

    if (priorityMap.size === 0) {
      targetMap.delete(eventType);
    }
  }

  /**
   * Publish an event (async, non-blocking)
   *
   * @param {string} eventType – Event type from ExperienceEvents
   * @param {object} data – Event payload
   * @param {object} [options] – Publishing options
   * @param {boolean} [options.async=true] – Execute handlers asynchronously
   * @returns {Promise<object>} Result summary
   */
  async emit(eventType, data, options = {}) {
    const async = options.async ?? true;
    const timestamp = Date.now();
    const eventId = `${eventType}-${timestamp}-${Math.random().toString(36).slice(2, 7)}`;

    // Record in history
    this._recordHistory({
      id: eventId,
      type: eventType,
      timestamp,
      data: this._sanitize(data),
    });

    this._stats.published++;
    this._log('debug', `[EventBus] 📤 ${eventType} published (id: ${eventId})`);

    // Execute handlers
    const results = await this._executeHandlers(eventType, data, async);

    // Execute wildcard handlers
    for (const handler of this._wildcardHandlers) {
      try {
        handler(eventType, data);
      } catch (err) {
        this._log('error', `[EventBus] Wildcard handler error: ${err.message}`);
      }
    }

    return {
      eventId,
      handlersExecuted: results.executed,
      errors: results.errors,
    };
  }

  /**
   * Execute all handlers for an event
   *
   * @private
   */
  async _executeHandlers(eventType, data, async) {
    const handlers = [];
    const onceHandlers = [];

    // Collect regular handlers by priority
    const priorityMap = this._handlers.get(eventType);
    if (priorityMap) {
      const sortedPriorities = Array.from(priorityMap.keys()).sort((a, b) => a - b);
      for (const priority of sortedPriorities) {
        handlers.push(...priorityMap.get(priority));
      }
    }

    // Collect once handlers by priority
    const oncePriorityMap = this._onceHandlers.get(eventType);
    if (oncePriorityMap) {
      const sortedPriorities = Array.from(oncePriorityMap.keys()).sort((a, b) => a - b);
      for (const priority of sortedPriorities) {
        onceHandlers.push(...oncePriorityMap.get(priority));
      }
      // Clear once handlers after collecting
      this._onceHandlers.delete(eventType);
    }

    const allHandlers = [...handlers, ...onceHandlers];
    const results = { executed: 0, errors: [] };

    const executeHandler = async (handler) => {
      try {
        await handler(data);
        results.executed++;
        this._stats.handled++;
      } catch (err) {
        results.errors.push({ handler: handler.name || 'anonymous', error: err.message });
        this._stats.errors++;
        this._log('error', `[EventBus] Handler error for ${eventType}: ${err.message}`);
      }
    };

    if (async) {
      // Execute all handlers concurrently
      await Promise.all(allHandlers.map(executeHandler));
    } else {
      // Execute synchronously in priority order
      for (const handler of allHandlers) {
        await executeHandler(handler);
      }
    }

    return results;
  }

  /**
   * Wait for a specific event (returns promise)
   *
   * @param {string} eventType
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<object>}
   */
  waitFor(eventType, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout waiting for ${eventType}`));
      }, timeoutMs);

      const unsubscribe = this.once(eventType, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  /**
   * Get event history
   *
   * @param {object} [filter]
   * @param {string} [filter.eventType]
   * @param {number} [filter.limit=100]
   * @returns {object[]}
   */
  getHistory(filter = {}) {
    let events = [...this._history];

    if (filter.eventType) {
      events = events.filter(e => e.type === filter.eventType);
    }

    if (filter.limit) {
      events = events.slice(-filter.limit);
    }

    return events;
  }

  /**
   * Get statistics
   *
   * @returns {object}
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * Clear all handlers and history
   */
  clear() {
    this._handlers.clear();
    this._onceHandlers.clear();
    this._wildcardHandlers.clear();
    this._history = [];
    this._stats = { published: 0, handled: 0, errors: 0 };
    this._log('info', '[EventBus] Cleared all handlers and history');
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  _recordHistory(event) {
    this._history.push(event);
    if (this._history.length > this._maxHistorySize) {
      this._history.shift();
    }
  }

  _sanitize(data) {
    // Remove circular references and sensitive data for history
    try {
      return JSON.parse(JSON.stringify(data, (key, value) => {
        if (key.startsWith('_')) return undefined; // Private fields
        if (typeof value === 'function') return undefined;
        return value;
      }));
    } catch {
      return { _unserializable: true };
    }
  }

  _log(level, message) {
    if (this._debug || level === 'error') {
      console[level === 'debug' ? 'log' : level](message);
    }
  }
}

/**
 * Global event bus instance (singleton)
 */
let globalEventBus = null;

function getGlobalEventBus(options = {}) {
  if (!globalEventBus) {
    globalEventBus = new ExperienceEventBus(options);
  }
  return globalEventBus;
}

function resetGlobalEventBus() {
  globalEventBus = null;
}

module.exports = {
  ExperienceEvents,
  HandlerPriority,
  ExperienceEventBus,
  getGlobalEventBus,
  resetGlobalEventBus,
};
