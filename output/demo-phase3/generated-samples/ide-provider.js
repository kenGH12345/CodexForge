/**
 * IDE Provider – Auto-generated from ADR-ADR-004
 *
 * IDE detection provider with dynamic registration.
 * Replaces hardcoded IDE_SIGNATURES object.
 */

'use strict';

const { ProviderRegistry } = require('./provider-registry');
const path = require('path');
const fs = require('fs');

// Global IDE provider instance
const ideProvider = new ProviderRegistry({
  name: 'IDEProvider',
  strictMode: false,
});

/**
 * Default IDE configurations.
 * These are pre-registered for backward compatibility.
 */
const DEFAULT_IDE_CONFIGS = {
  vscode: {
    name: 'VS Code',
    envVars: ['VSCODE_PID', 'VSCODE_CWD'],
    identifiers: [
      { type: 'env', key: 'VSCODE_PID' },
    ],
  },
  cursor: {
    name: 'Cursor',
    envVars: ['CURSOR_TRACE_ID'],
    identifiers: [
      { type: 'env', key: 'CURSOR_TRACE_ID' },
    ],
  },
  windsurf: {
    name: 'Windsurf',
    envVars: ['WINDSURF_SESSION'],
    identifiers: [
      { type: 'env', key: 'WINDSURF_SESSION' },
    ],
  },
};

/**
 * Load IDE configurations from external file.
 *
 * @param {string} [configPath] – Path to config file (default: ./config/ides.json)
 * @returns {boolean} – Whether config was loaded
 */
function loadFromConfig(configPath) {
  const defaultPath = path.join(process.cwd(), 'config', 'ides.json');
  const targetPath = configPath || defaultPath;

  if (!fs.existsSync(targetPath)) {
    console.warn(`[IDEProvider] Config not found: ${targetPath}`);
    return false;
  }

  try {
    const configs = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
    Object.entries(configs).forEach(([key, config]) => {
      ideProvider.register(key, config);
    });
    console.log(`[IDEProvider] Loaded ${Object.keys(configs).length} IDE configs from ${targetPath}`);
    return true;
  } catch (err) {
    console.error(`[IDEProvider] Failed to load config: ${err.message}`);
    return false;
  }
}

/**
 * Auto-detect current IDE from environment.
 *
 * @returns {object|null} – Detected IDE config or null
 */
function detectCurrentIDE() {
  for (const [key, config] of ideProvider.getAll()) {
    if (config.envVars && config.envVars.some(env => process.env[env])) {
      return { key, ...config };
    }
  }
  return null;
}

/**
 * Check if running in specific IDE.
 *
 * @param {string} ideKey
 * @returns {boolean}
 */
function isIDE(ideKey) {
  const config = ideProvider.get(ideKey);
  if (!config || !config.envVars) return false;
  return config.envVars.some(env => process.env[env]);
}

/**
 * Get all supported IDE names.
 *
 * @returns {string[]}
 */
function getSupportedIDEs() {
  return Array.from(ideProvider.getAll()).map(([, config]) => config.name);
}

// Initialize with defaults
Object.entries(DEFAULT_IDE_CONFIGS).forEach(([key, config]) => {
  ideProvider.register(key, config);
});

// Try to load from config file
loadFromConfig();

module.exports = {
  ideProvider,
  loadFromConfig,
  detectCurrentIDE,
  isIDE,
  getSupportedIDEs,
  DEFAULT_IDE_CONFIGS,
};
