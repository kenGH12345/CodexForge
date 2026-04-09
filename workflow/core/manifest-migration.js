/**
 * Manifest Migration Module
 * 
 * Handles versioned migration of workflow state manifests.
 * Ensures backward compatibility when manifest schema evolves.
 */

'use strict';

// Current manifest schema version
const CURRENT_VERSION = 1;

/**
 * Migrates a manifest to the current version.
 * 
 * @param {Object} manifest - The loaded manifest (may be from an older version)
 * @returns {Object} - Migrated manifest at current version
 */
function migrateManifest(manifest) {
  if (!manifest) {
    return { version: CURRENT_VERSION, states: {} };
  }

  // If no version, assume version 0 (legacy format)
  let version = manifest.version ?? 0;

  // Apply migrations sequentially
  let migrated = { ...manifest };

  // v0 → v1: Add version field and normalize state structure
  if (version < 1) {
    migrated = {
      version: 1,
      states: migrated.states || {},
      projectId: migrated.projectId || 'unknown',
      createdAt: migrated.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    version = 1;
  }

  // Future migrations go here:
  // if (version < 2) { ... }

  return migrated;
}

module.exports = {
  migrateManifest,
  CURRENT_VERSION,
};
