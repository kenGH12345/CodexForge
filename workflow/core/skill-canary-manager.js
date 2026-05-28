'use strict';

const fs = require('fs');
const path = require('path');
const { getDefaultOutputDir } = require('./constants');

const CANARY_STATES = {
  DRAFT: 'draft',
  CANARY: 'canary',
  PROMOTED: 'promoted',
  ROLLED_BACK: 'rolled_back',
};

class SkillCanaryManager {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.statePath = options.statePath || path.join(getDefaultOutputDir(), 'skill-canary-state.json');
    this.config = {
      enabled: false,
      canaryRatio: 0.2,
      minSampleSize: 3,
      successThreshold: 0.7,
      failureThreshold: 0.3,
      maxCanaryHours: 48,
      ...options.config,
    };
    this._state = this._loadState();
  }

  startCanary(skillName, version, options = {}) {
    if (!this.config.enabled) return { success: true, skipped: true, reason: 'canary_disabled' };

    const existing = this._state[skillName];
    if (existing && existing.status === CANARY_STATES.CANARY) {
      return { success: true, skillName, status: CANARY_STATES.CANARY, message: 'Canary already in progress' };
    }

    // Track previousVersion so rollback can restore the correct snapshot.
    // (Bug fix EXP-1779927872675-7GDLO18: rollbackCanary used new version,
    //  but snapshots are keyed by old version → restore failed silently.)
    const previousVersion = options.previousVersion
      || (existing && existing.version)
      || null;

    this._state[skillName] = {
      skillName,
      version,
      previousVersion,
      status: CANARY_STATES.CANARY,
      startedAt: new Date().toISOString(),
      outcomes: [],
      passCount: 0,
      failCount: 0,
    };
    this._saveState();

    return { success: true, skillName, version, previousVersion, status: CANARY_STATES.CANARY };
  }

  trackOutcome(skillName, version, passed) {
    if (!this.config.enabled) return { success: true, skipped: true };

    const entry = this._state[skillName];
    if (!entry || entry.status !== CANARY_STATES.CANARY) {
      return { success: true, skipped: true, reason: 'not_in_canary' };
    }

    entry.outcomes.push({ passed, timestamp: new Date().toISOString() });
    if (passed) entry.passCount = (entry.passCount || 0) + 1;
    else entry.failCount = (entry.failCount || 0) + 1;

    const result = this._checkAutoDecision(entry);
    this._saveState();

    return {
      success: true,
      skillName,
      passCount: entry.passCount,
      failCount: entry.failCount,
      totalOutcomes: entry.outcomes.length,
      ...result,
    };
  }

  checkCanaryStatus(skillName) {
    const entry = this._state[skillName];
    if (!entry) return { status: 'none', skillName };

    const totalOutcomes = entry.outcomes.length;
    const successRate = totalOutcomes > 0 ? entry.passCount / totalOutcomes : null;
    const elapsed = entry.startedAt ? (Date.now() - new Date(entry.startedAt).getTime()) / (1000 * 60 * 60) : null;

    return {
      skillName,
      version: entry.version,
      status: entry.status,
      startedAt: entry.startedAt,
      passCount: entry.passCount,
      failCount: entry.failCount,
      totalOutcomes,
      successRate: successRate !== null ? +successRate.toFixed(3) : null,
      elapsedHours: elapsed !== null ? +elapsed.toFixed(1) : null,
    };
  }

  promoteCanary(skillName) {
    const entry = this._state[skillName];
    if (!entry || entry.status !== CANARY_STATES.CANARY) {
      return { success: false, reason: 'not_in_canary', skillName };
    }

    entry.status = CANARY_STATES.PROMOTED;
    entry.promotedAt = new Date().toISOString();
    this._saveState();

    return { success: true, skillName, version: entry.version, status: CANARY_STATES.PROMOTED };
  }

  rollbackCanary(skillName) {
    const entry = this._state[skillName];
    if (!entry || entry.status !== CANARY_STATES.CANARY) {
      return { success: false, reason: 'not_in_canary', skillName };
    }

    entry.status = CANARY_STATES.ROLLED_BACK;
    entry.rolledBackAt = new Date().toISOString();
    this._saveState();

    const { SkillSnapshotStore } = require('./skill-snapshot-store');
    const snapshotStore = new SkillSnapshotStore({ projectRoot: this.projectRoot });

    // Restore the PREVIOUS version's snapshot, not the current canary version.
    // (The canary version was just promoted in; its snapshot may not exist.
    //  The pre-canary stable version is what we actually want to restore.)
    let restoreVersion = entry.previousVersion;
    let restoreResult;
    if (restoreVersion) {
      restoreResult = snapshotStore.restoreSnapshot(skillName, restoreVersion);
    }
    // Fallback: if previousVersion missing or its snapshot not found, use latest snapshot.
    if (!restoreVersion || (restoreResult && !restoreResult.success)) {
      const latest = snapshotStore.getLatestSnapshot(skillName);
      if (latest && latest.version) {
        restoreVersion = latest.version;
        restoreResult = snapshotStore.restoreSnapshot(skillName, latest.version);
      }
    }

    return {
      success: true,
      skillName,
      version: entry.version,
      restoredVersion: restoreVersion,
      status: CANARY_STATES.ROLLED_BACK,
      restoreResult: restoreResult || { success: false, reason: 'no_snapshot_available' },
    };
  }

  filterCanarySkills(skills) {
    if (!this.config.enabled) return skills;

    return skills.filter(skill => {
      const entry = this._state[skill.name || skill];
      if (!entry) return true;
      if (entry.status === CANARY_STATES.CANARY) {
        return Math.random() < this.config.canaryRatio;
      }
      if (entry.status === CANARY_STATES.ROLLED_BACK) return false;
      return true;
    });
  }

  getAllCanaryStatus() {
    const result = {};
    for (const [name, entry] of Object.entries(this._state)) {
      result[name] = this.checkCanaryStatus(name);
    }
    return result;
  }

  _checkAutoDecision(entry) {
    const total = entry.outcomes.length;
    if (total < this.config.minSampleSize) return { autoDecision: null };

    const rate = entry.passCount / total;

    if (rate >= this.config.successThreshold) {
      entry.status = CANARY_STATES.PROMOTED;
      entry.promotedAt = new Date().toISOString();
      return { autoDecision: 'promoted', successRate: +rate.toFixed(3) };
    }

    if (rate <= this.config.failureThreshold) {
      entry.status = CANARY_STATES.ROLLED_BACK;
      entry.rolledBackAt = new Date().toISOString();
      return { autoDecision: 'rolled_back', successRate: +rate.toFixed(3) };
    }

    if (entry.startedAt) {
      const elapsed = (Date.now() - new Date(entry.startedAt).getTime()) / (1000 * 60 * 60);
      if (elapsed >= this.config.maxCanaryHours) {
        entry.status = rate > 0.5 ? CANARY_STATES.PROMOTED : CANARY_STATES.ROLLED_BACK;
        return { autoDecision: entry.status, reason: 'max_hours_exceeded', successRate: +rate.toFixed(3) };
      }
    }

    return { autoDecision: null };
  }

  _loadState() {
    if (!fs.existsSync(this.statePath)) return {};
    try { return JSON.parse(fs.readFileSync(this.statePath, 'utf-8')); }
    catch { return {}; }
  }

  _saveState() {
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = this.statePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(this._state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.statePath);
  }
}

module.exports = { SkillCanaryManager, CANARY_STATES };
