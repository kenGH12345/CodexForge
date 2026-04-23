'use strict';

/**
 * ProjectionContractValidator — Validates projected outputs against legacy schema contracts.
 * Ensures backward compatibility when RuntimeProjector emits manifest/workflow-status shaped objects.
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid — Whether the projection satisfies the contract
 * @property {string[]} errors — Human-readable error messages
 * @property {string[]} missing — List of missing required fields (if any)
 */

const MANIFEST_REQUIRED_FIELDS = Object.freeze([
  'version',
  'projectId',
  'currentState',
  'createdAt',
  'updatedAt',
  'history',
  'artifacts',
  'risks',
  'meta',
]);

const MANIFEST_META_REQUIRED_FIELDS = Object.freeze([
  'sessionId',
]);

const WORKFLOW_STATUS_REQUIRED_FIELDS = Object.freeze([
  'activeWorkflow',
]);

const WORKFLOW_STATUS_ACTIVE_WORKFLOW_FIELDS = Object.freeze([
  'session',
  'startedAt',
  'currentStage',
  'completedStages',
]);

function getProjectionContractSummary() {
  return {
    manifest: {
      requiredFields: [...MANIFEST_REQUIRED_FIELDS],
      metaRequiredFields: [...MANIFEST_META_REQUIRED_FIELDS],
    },
    workflowStatus: {
      requiredFields: [...WORKFLOW_STATUS_REQUIRED_FIELDS],
      activeWorkflowRequiredFields: [...WORKFLOW_STATUS_ACTIVE_WORKFLOW_FIELDS],
    },
  };
}

class ProjectionContractValidator {
  /**
   * @param {Object} [options]
   * @param {string[]} [options.manifestRequiredFields] — Override default manifest required fields
   * @param {string[]} [options.workflowStatusRequiredFields] — Override default workflow-status required fields
   */
  constructor(options = {}) {
    this._manifestRequired = options.manifestRequiredFields || MANIFEST_REQUIRED_FIELDS;
    this._workflowStatusRequired = options.workflowStatusRequiredFields || WORKFLOW_STATUS_REQUIRED_FIELDS;
  }

  getContractSummary() {
    return getProjectionContractSummary();
  }

  /**
   * Validate a manifest-shaped projection.
   * @param {Object|null|undefined} projection — The projected manifest-like object
   * @returns {ValidationResult}
   */
  validateManifest(projection) {
    if (!projection || typeof projection !== 'object') {
      return {
        valid: false,
        errors: ['Projection must be a non-null object'],
        missing: this._manifestRequired,
      };
    }

    const missing = [];
    const errors = [];

    for (const field of this._manifestRequired) {
      if (!(field in projection)) {
        missing.push(field);
      }
    }

    if (missing.length > 0) {
      errors.push(`Missing required fields: [${missing.join(', ')}]`);
    }

    if (projection.meta && typeof projection.meta === 'object') {
      for (const field of MANIFEST_META_REQUIRED_FIELDS) {
        if (!(field in projection.meta)) {
          missing.push(`meta.${field}`);
          errors.push(`Missing required meta field: meta.${field}`);
        }
      }
    } else {
      missing.push('meta');
      errors.push('Missing required field: meta (must be an object)');
    }

    if (projection.history && !Array.isArray(projection.history)) {
      errors.push('Field "history" must be an array');
    }

    if (projection.artifacts && typeof projection.artifacts !== 'object') {
      errors.push('Field "artifacts" must be an object');
    }

    return {
      valid: errors.length === 0,
      errors,
      missing: missing.length > 0 ? missing : undefined,
    };
  }

  /**
   * Validate a workflow-status-shaped projection.
   * @param {Object|null|undefined} projection — The projected workflow-status-like object
   * @returns {ValidationResult}
   */
  validateWorkflowStatus(projection) {
    if (!projection || typeof projection !== 'object') {
      return {
        valid: false,
        errors: ['Projection must be a non-null object'],
        missing: this._workflowStatusRequired,
      };
    }

    const missing = [];
    const errors = [];

    for (const field of this._workflowStatusRequired) {
      if (!(field in projection)) {
        missing.push(field);
      }
    }

    if (missing.length > 0) {
      errors.push(`Missing required fields: [${missing.join(', ')}]`);
    }

    const { activeWorkflow } = projection;
    if (activeWorkflow && typeof activeWorkflow === 'object') {
      for (const field of WORKFLOW_STATUS_ACTIVE_WORKFLOW_FIELDS) {
        if (!(field in activeWorkflow)) {
          missing.push(`activeWorkflow.${field}`);
          errors.push(`Missing required activeWorkflow field: ${field}`);
        }
      }
    } else {
      missing.push('activeWorkflow');
      errors.push('Missing or invalid field: activeWorkflow (must be an object)');
    }

    return {
      valid: errors.length === 0,
      errors,
      missing: missing.length > 0 ? missing : undefined,
    };
  }

  /**
   * Batch validate both projections at once.
   * @param {Object} projections — Object containing both projections
   * @param {Object} [projections.manifest] — Manifest-shaped projection
   * @param {Object} [projections.workflowStatus] — Workflow-status-shaped projection
   * @returns {{manifest: ValidationResult, workflowStatus: ValidationResult, overallValid: boolean}}
   */
  validateBoth(projections = {}) {
    const manifestResult = projections.manifest !== undefined
      ? this.validateManifest(projections.manifest)
      : { valid: true, errors: [], missing: undefined };

    const workflowStatusResult = projections.workflowStatus !== undefined
      ? this.validateWorkflowStatus(projections.workflowStatus)
      : { valid: true, errors: [], missing: undefined };

    return {
      manifest: manifestResult,
      workflowStatus: workflowStatusResult,
      overallValid: manifestResult.valid && workflowStatusResult.valid,
    };
  }
}

module.exports = {
  ProjectionContractValidator,
  MANIFEST_REQUIRED_FIELDS,
  MANIFEST_META_REQUIRED_FIELDS,
  WORKFLOW_STATUS_REQUIRED_FIELDS,
  WORKFLOW_STATUS_ACTIVE_WORKFLOW_FIELDS,
  getProjectionContractSummary,
};
