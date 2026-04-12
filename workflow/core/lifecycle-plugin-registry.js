'use strict';

/**
 * Lifecycle Plugin Registry — Declarative Module Integration
 *
 * Problem: Each ADR adds a new module's definition, but integrating it into
 * the main flow requires modifying 3+ files (init/run/teardown + stage runners
 * + Bridge). The contract between ADR and code has no compiler — the only
 * consistency guarantee is human memory and manual cross-referencing.
 *
 * Solution: A declarative plugin system where each module defines its lifecycle
 * integration in ONE place (a plugin manifest), and the Registry automatically
 * discovers and executes it at the right lifecycle points.
 *
 * Inspiration:
 *   - FastAPI on_startup/on_shutdown — declarative lifecycle hooks
 *   - VS Code Extension API — activate(context) / deactivate()
 *   - Go init() — automatic registration via file discovery
 *   - React Hooks — from scattered lifecycle methods to co-located declarations
 *
 * Architecture Compliance:
 *   - ADR-37 IDE-First: No LLM calls in the registry core
 *   - Non-blocking: Plugin errors are caught and logged, never crash the host
 *   - Dual-mode: Works identically in Node Orchestrator and IDE Agent (Bridge)
 *   - Contracts: Integrates with existing assertContract() for runtime validation
 *
 * @module lifecycle-plugin-registry
 */

const path = require('path');
const fs = require('fs');

// ─── Plugin Lifecycle Phases ────────────────────────────────────────────────

const PluginPhase = {
  INIT:     'init',      // Called during orchestrator initialization
  RUN:      'run',       // Called during workflow execution (stage-level hooks)
  TEARDOWN: 'teardown',  // Called during _finalizeWorkflow()
  BOTH:     'both',      // Init + Teardown (most common)
};

// ─── Plugin Priority ────────────────────────────────────────────────────────

const PluginPriority = {
  CRITICAL:   10,   // Must run first (e.g. RollbackCoordinator)
  HIGH:       25,   // Core quality guards (e.g. RegressionGuard)
  NORMAL:     50,   // Standard modules (e.g. FailurePatternAnalyzer)
  LOW:        75,   // Optional enhancements (e.g. DeepAudit)
  BACKGROUND: 100,  // Fire-and-forget (e.g. telemetry, reporting)
};

// ─── LifecyclePlugin ────────────────────────────────────────────────────────

/**
 * A declarative plugin manifest that describes how a module integrates
 * into the Orchestrator lifecycle.
 */
class LifecyclePlugin {
  /**
   * @param {object} manifest
   * @param {string}   manifest.name          - Unique module name (e.g. 'regression-guard')
   * @param {string}   [manifest.phase='both'] - Lifecycle phase(s) from PluginPhase
   * @param {string[]} [manifest.hooks=[]]     - HookSystem events to subscribe to
   * @param {string[]} [manifest.contracts=[]] - Contract names for runtime validation
   * @param {Function} manifest.activate       - (orch) => void | Promise — Initialize the module
   * @param {Function} [manifest.deactivate]   - (orch) => void | Promise — Teardown/cleanup
   * @param {Function} [manifest.onStage]      - (stageName, orch) => void | Promise — Stage callback
   * @param {object}   [manifest.bridge]       - { subcommand, handler } — Bridge subcommand
   * @param {number}   [manifest.priority=50]  - Execution priority (lower = earlier)
   * @param {string}   [manifest.description]  - Human-readable description
   */
  constructor(manifest) {
    if (!manifest || !manifest.name) {
      throw new Error('[LifecyclePlugin] manifest.name is required');
    }
    if (typeof manifest.activate !== 'function') {
      throw new Error(`[LifecyclePlugin] "${manifest.name}" must provide an activate() function`);
    }

    this.name        = manifest.name;
    this.phase        = manifest.phase || PluginPhase.BOTH;
    this.hooks        = manifest.hooks || [];
    this.contracts    = manifest.contracts || [];
    this.activate     = manifest.activate;
    this.deactivate   = manifest.deactivate || null;
    this.onStage      = manifest.onStage || null;
    this.bridge       = manifest.bridge || null;
    this.priority     = manifest.priority ?? PluginPriority.NORMAL;
    this.description  = manifest.description || '';

    // Runtime state
    this._activated = false;
    this._instance  = null;
  }

  /** Whether this plugin has been successfully activated */
  get isActivated() { return this._activated; }

  /** The instance returned by activate() (if any) */
  get instance() { return this._instance; }
}

// ─── LifecyclePluginRegistry ────────────────────────────────────────────────

class LifecyclePluginRegistry {
  constructor() {
    /** @type {Map<string, LifecyclePlugin>} */
    this._plugins = new Map();
    /** @type {string[]} Ordered plugin names by priority */
    this._order = [];
    /** @type {Map<string, Function>} Bridge subcommand handlers */
    this._bridgeHandlers = new Map();
    /** @type {Map<string, { event: string, handler: Function }[]>} Hook subscriptions */
    this._hookSubscriptions = new Map();
  }

  // ─── Registration ──────────────────────────────────────────────────────

  /**
   * Register a plugin manifest.
   *
   * @param {LifecyclePlugin|object} plugin - Plugin manifest or instance
   * @returns {LifecyclePluginRegistry} this (for chaining)
   */
  register(plugin) {
    const p = plugin instanceof LifecyclePlugin ? plugin : new LifecyclePlugin(plugin);
    if (this._plugins.has(p.name)) {
      console.warn(`[PluginRegistry] Plugin "${p.name}" already registered. Skipping duplicate.`);
      return this;
    }
    this._plugins.set(p.name, p);

    // Register bridge handler if provided
    if (p.bridge && p.bridge.subcommand && p.bridge.handler) {
      this._bridgeHandlers.set(p.bridge.subcommand, p.bridge.handler);
    }

    // Recompute execution order (sorted by priority, then by registration order)
    this._recomputeOrder();

    return this;
  }

  /**
   * Auto-discover plugins from a directory.
   * Each .js file in the directory should export a LifecyclePlugin instance or manifest object.
   *
   * @param {string} dirPath - Absolute path to plugins directory
   * @returns {number} Number of plugins discovered
   */
  autoDiscover(dirPath) {
    if (!fs.existsSync(dirPath)) {
      console.warn(`[PluginRegistry] Plugin directory not found: ${dirPath}`);
      return 0;
    }

    let discovered = 0;
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.js')).sort();

    for (const file of files) {
      try {
        const pluginModule = require(path.join(dirPath, file));
        // Support both default export and named export
        const plugin = pluginModule.default || pluginModule;
        if (plugin && (plugin instanceof LifecyclePlugin || (plugin.name && plugin.activate))) {
          this.register(plugin);
          discovered++;
        } else {
          console.warn(`[PluginRegistry] ${file} does not export a valid plugin manifest`);
        }
      } catch (err) {
        console.warn(`[PluginRegistry] Failed to load plugin ${file}: ${err.message}`);
      }
    }

    if (discovered > 0) {
      console.log(`[PluginRegistry] Auto-discovered ${discovered} plugin(s) from ${path.basename(dirPath)}/`);
    }
    return discovered;
  }

  // ─── Execution ─────────────────────────────────────────────────────────

  /**
   * Activate all plugins for a given phase.
   * Plugins are activated in priority order (lower priority value = earlier).
   * Errors are caught and logged — a failing plugin never crashes the host.
   *
   * @param {string} phase - One of PluginPhase values
   * @param {object} orch  - Orchestrator instance (or context object)
   * @returns {{ activated: string[], failed: Array<{ name: string, error: string }> }}
   */
  async activateAll(phase, orch) {
    const activated = [];
    const failed = [];

    for (const name of this._order) {
      const plugin = this._plugins.get(name);

      // Check phase compatibility
      if (!this._matchesPhase(plugin.phase, phase)) continue;

      // Validate contracts before activation
      if (plugin.contracts.length > 0) {
        const contractResult = this._validateContracts(plugin, orch);
        if (!contractResult.valid) {
          console.warn(`[PluginRegistry] ⚠️  "${name}" contract validation failed: ${contractResult.violations.join('; ')}`);
          failed.push({ name, error: `Contract violation: ${contractResult.violations.join('; ')}` });
          continue;
        }
      }

      // Activate
      try {
        const instance = await plugin.activate(orch);
        plugin._activated = true;
        plugin._instance = instance || null;
        activated.push(name);
        console.log(`[PluginRegistry] ✅ Activated: ${name} (priority: ${plugin.priority})`);
      } catch (err) {
        console.warn(`[PluginRegistry] ⚠️  Failed to activate "${name}": ${err.message}`);
        failed.push({ name, error: err.message });
      }
    }

    return { activated, failed };
  }

  /**
   * Deactivate all activated plugins for a given phase.
   * Plugins are deactivated in REVERSE priority order (highest priority value first).
   *
   * @param {string} phase - One of PluginPhase values
   * @param {object} orch  - Orchestrator instance (or context object)
   * @returns {{ deactivated: string[], failed: Array<{ name: string, error: string }> }}
   */
  async deactivateAll(phase, orch) {
    const deactivated = [];
    const failed = [];

    // Reverse order for teardown
    const reverseOrder = [...this._order].reverse();

    for (const name of reverseOrder) {
      const plugin = this._plugins.get(name);

      if (!plugin._activated) continue;
      if (!this._matchesPhase(plugin.phase, phase)) continue;
      if (!plugin.deactivate) continue;

      try {
        await plugin.deactivate(orch);
        plugin._activated = false;
        deactivated.push(name);
        console.log(`[PluginRegistry] ✅ Deactivated: ${name}`);
      } catch (err) {
        console.warn(`[PluginRegistry] ⚠️  Failed to deactivate "${name}": ${err.message}`);
        failed.push({ name, error: err.message });
      }
    }

    return { deactivated, failed };
  }

  /**
   * Notify all plugins with onStage handlers about a stage event.
   *
   * @param {string} stageName - Name of the stage event
   * @param {object} orch      - Orchestrator instance
   */
  async notifyStage(stageName, orch) {
    for (const name of this._order) {
      const plugin = this._plugins.get(name);
      if (!plugin._activated || !plugin.onStage) continue;

      try {
        await plugin.onStage(stageName, orch);
      } catch (err) {
        console.warn(`[PluginRegistry] ⚠️  "${name}" onStage(${stageName}) failed: ${err.message}`);
      }
    }
  }

  // ─── Hook System Integration ──────────────────────────────────────────

  /**
   * Subscribe all plugin hooks to a HookSystem instance.
   * Each plugin's hooks array maps to HookSystem.on() registrations.
   *
   * @param {object} hookSystem - HookSystem instance with on() method
   * @returns {number} Number of hook subscriptions created
   */
  subscribeAll(hookSystem) {
    if (!hookSystem || typeof hookSystem.on !== 'function') return 0;

    let count = 0;
    for (const name of this._order) {
      const plugin = this._plugins.get(name);
      if (!plugin.hooks || plugin.hooks.length === 0) continue;

      const subscriptions = [];
      for (const event of plugin.hooks) {
        const handler = (payload) => {
          // Delegate to onStage if available, otherwise to deactivate
          if (plugin.onStage) {
            return plugin.onStage(event, payload);
          }
        };
        hookSystem.on(event, handler);
        subscriptions.push({ event, handler });
        count++;
      }
      this._hookSubscriptions.set(name, subscriptions);
    }

    if (count > 0) {
      console.log(`[PluginRegistry] 🔗 Subscribed ${count} hook(s) across ${this._hookSubscriptions.size} plugin(s)`);
    }
    return count;
  }

  // ─── Bridge Integration ───────────────────────────────────────────────

  /**
   * Get all registered bridge subcommand handlers.
   *
   * @returns {Map<string, Function>} subcommand → handler
   */
  getBridgeHandlers() {
    return new Map(this._bridgeHandlers);
  }

  /**
   * Execute a bridge subcommand by name.
   *
   * @param {string} subcommand - Subcommand name
   * @param {object} args       - Arguments for the handler
   * @returns {object} Handler result
   */
  async executeBridgeCommand(subcommand, args) {
    const handler = this._bridgeHandlers.get(subcommand);
    if (!handler) {
      return { success: false, subcommand, error: `Unknown plugin subcommand: "${subcommand}"` };
    }

    try {
      return await handler(args);
    } catch (err) {
      return { success: false, subcommand, error: err.message };
    }
  }

  /**
   * Get list of available bridge subcommands.
   *
   * @returns {string[]}
   */
  getBridgeSubcommands() {
    return [...this._bridgeHandlers.keys()];
  }

  // ─── Query ────────────────────────────────────────────────────────────

  /**
   * Get a plugin by name.
   *
   * @param {string} name
   * @returns {LifecyclePlugin|undefined}
   */
  get(name) { return this._plugins.get(name); }

  /**
   * Get all registered plugins in priority order.
   *
   * @returns {LifecyclePlugin[]}
   */
  getAll() { return this._order.map(n => this._plugins.get(n)); }

  /**
   * Get all activated plugins.
   *
   * @returns {LifecyclePlugin[]}
   */
  getActivated() { return this.getAll().filter(p => p._activated); }

  /**
   * Get activation summary for logging.
   *
   * @returns {object}
   */
  getSummary() {
    const total = this._plugins.size;
    const activated = this.getActivated().length;
    const byPhase = {};
    for (const p of this.getAll()) {
      byPhase[p.phase] = (byPhase[p.phase] || 0) + 1;
    }
    return {
      total,
      activated,
      byPhase,
      bridgeSubcommands: [...this._bridgeHandlers.keys()],
      hookSubscriptions: this._hookSubscriptions.size,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Recompute execution order based on priority.
   * @private
   */
  _recomputeOrder() {
    const entries = [...this._plugins.entries()];
    entries.sort((a, b) => a[1].priority - b[1].priority);
    this._order = entries.map(([name]) => name);
  }

  /**
   * Check if a plugin's phase matches the requested phase.
   * @private
   */
  _matchesPhase(pluginPhase, requestedPhase) {
    if (pluginPhase === requestedPhase) return true;
    if (pluginPhase === PluginPhase.BOTH) return true;
    // 'both' matches init and teardown
    if (requestedPhase === PluginPhase.INIT || requestedPhase === PluginPhase.TEARDOWN) {
      return pluginPhase === PluginPhase.BOTH;
    }
    return false;
  }

  /**
   * Validate contracts for a plugin before activation.
   * @private
   */
  _validateContracts(plugin, orch) {
    try {
      const { validateContract } = require('./contracts');
      const allViolations = [];

      for (const contractName of plugin.contracts) {
        // Try to find the instance in the orch context
        const instanceKey = contractName.replace(/^I/, '').replace(/([A-Z])/g, (_, c, i) =>
          i === 0 ? c.toLowerCase() : c
        );
        // Common name mappings
        const nameMap = {
          'stateMachine':  ['stateMachine', 'sm'],
          'hookSystem':    ['hooks', 'hookSystem', 'hookEmitter'],
          'experienceStore': ['experienceStore', 'expStore'],
          'stageRunner':   ['stageRunner'],
          'codeGraph':     ['codeGraph', 'codeGraphManager'],
        };
        const candidateNames = nameMap[instanceKey] || [instanceKey];

        let instance = null;
        for (const name of candidateNames) {
          if (orch && orch[name]) {
            instance = orch[name];
            break;
          }
          if (orch && orch.services && orch.services.has && orch.services.has(name)) {
            instance = orch.services.resolve(name);
            break;
          }
        }

        if (!instance) {
          // Contract dependency not yet available — skip validation (will fail at actual use)
          continue;
        }

        const result = validateContract(contractName, instance);
        if (!result.valid) {
          allViolations.push(...result.violations);
        }
      }

      return { valid: allViolations.length === 0, violations: allViolations };
    } catch (err) {
      // contracts.js not available — skip validation
      return { valid: true, violations: [] };
    }
  }
}

// ─── Singleton Registry ─────────────────────────────────────────────────────

let _globalRegistry = null;

/**
 * Get or create the global plugin registry.
 *
 * @returns {LifecyclePluginRegistry}
 */
function getGlobalRegistry() {
  if (!_globalRegistry) {
    _globalRegistry = new LifecyclePluginRegistry();
  }
  return _globalRegistry;
}

/**
 * Reset the global registry (for testing).
 */
function resetGlobalRegistry() {
  if (_globalRegistry) {
    _globalRegistry = new LifecyclePluginRegistry();
  }
}

module.exports = {
  LifecyclePlugin,
  LifecyclePluginRegistry,
  PluginPhase,
  PluginPriority,
  getGlobalRegistry,
  resetGlobalRegistry,
};
