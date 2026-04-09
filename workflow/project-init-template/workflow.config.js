/**
 * workflow.config.js – Project Workflow Configuration Template
 *
 * Copy this file to your project root and customise as needed.
 * Most fields are auto-detected at runtime — only override when needed.
 *
 * Auto-detected fields (no config needed):
 *   - projectName        → from directory name
 *   - techStack          → from project files (package.json, pubspec.yaml, go.mod, etc.)
 *   - sourceExtensions   → from detected tech stack
 *   - ignoreDirs         → from detected tech stack
 *
 * CodeGraph auto-scans ALL supported languages (.js, .ts, .cs, .lua, .go, .py, .dart).
 * No manual extension configuration is required.
 */

'use strict';

module.exports = {
  // ─── Runtime-Detected (uncomment only to override auto-detection) ─────
  // projectName: '{PROJECT_NAME}',
  // techStack: '{TECH_STACK}',
  // sourceExtensions: ['{EXT1}', '{EXT2}'],
  // ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output'],

  // ─── Code Graph ──────────────────────────────────────────────────────────
  codeGraph: {
    scopeDirs: [],             // Large monorepo only: ['packages/core']. Empty = full scan
  },

  // ─── IDE-First Architecture (ADR-37) ────────────────────────────────────
  //
  // Foundational principle: IDE capabilities first, self-built as fallback.
  // Auto-detects IDE environment (Cursor, VS Code, Claude Code, Windsurf, CodeBuddy).
  // No config needed — override only to force standalone mode in CI/CD.
  //
  ide: {
    forceStandalone: false,    // Set to true to disable IDE-first mode entirely
  },

  // ─── Remote Workflow Reference ──────────────────────────────────────────────
  //
  // Point to an external WorkFlowAgent installation instead of copying workflow/
  // into this project. All IDE Agent Bridge commands will use this path.
  //
  // Examples:
  //   workflowSource: 'C:\\workspace\\WorkFlowAgent\\workflow',  // Windows
  //   workflowSource: '/home/user/WorkFlowAgent/workflow',       // Linux/macOS
  //   workflowSource: '../WorkFlowAgent/workflow',               // Relative path
  //
  // Benefits: single source of truth, no version fragmentation, no disk waste.
  // Leave as null to use the local workflow/ directory inside this project.
  //
  workflowSource: null,

  // ─── Automated Verification Loop ─────────────────────────────────────────
  //
  // Set testCommand to enable the automated verification loop.
  // Examples:
  //   'npm test'           – Node.js / Jest / Mocha
  //   'flutter test'       – Flutter / Dart
  //   'pytest'             – Python
  //   'go test ./...'      – Go
  //   'dotnet test'        – .NET / C#
  //
  testCommand: null,  // TODO: replace with your actual test command
  testProfile: 'fast', // P0: fast=smoke+unit, full=smoke+unit+integration

  testFramework: 'auto',

  autoFixLoop: {
    enabled: true,
    maxFixRounds: 2,
    failOnUnfixed: false,
  },

  // ─── Built-in Skills ─────────────────────────────────────────────────────
  builtinSkills: [],

  // ─── Default Skills ───────────────────────────────────────────────────────
  defaultSkills: {},

  // ─── Skill Auto-injection ────────────────────────────────────────────────
  globalSkills: ['standards', 'troubleshooting'],
  projectSkills: [],
  alwaysLoadSkills: [],
  skillKeywords: {},

  // ─── Classification Rules ─────────────────────────────────────────────────
  classificationRules: [],

  // ─── Git PR Workflow ──────────────────────────────────────────────────────
  git: {
    enabled:    false,
    baseBranch: 'main',
    branchType: 'feat',
    autoPush:   false,
    draft:      false,
    labels:     [],
    reviewers:  [],
  },

  // ─── Dry-Run / Sandbox Mode ───────────────────────────────────────────────
  sandbox: {
    dryRun: false,
  },

  // ─── Health Monitoring (B + D) ─────────────────────────────────────────────
  // B: Rolling-window trend alerts
  // D: Externalized unified scoring parameters
  healthMonitoring: {
    scoring: {
      model: 'unified-v1',
      weights: {
        completeness: 0.35,
        process: 0.20,
        delivery: 0.30,
        detection: 0.15,
      },
      penalties: {
        missingStage: 20,
        socraticMax: 20,
        metricsGatePerFailedStage: 5,
        metricsGateMax: 25,
      },
      gradeThresholds: {
        A: 90,
        B: 80,
        C: 70,
        D: 60,
      },
    },
    trend: {
      enabled: true,
      windowSize: 5,
      minSessions: 3,
      degradationThreshold: 8,
      lowScoreThreshold: 75,
      maxHistoryEntries: 200,
    },
  },
};
