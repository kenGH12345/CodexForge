/**
 * Introspection Report Generator
 *
 * Generates human-readable and machine-readable reports from
 * introspection data and validation results.
 *
 * Output Formats:
 *   - JSON: Complete data for programmatic processing
 *   - Markdown: Human-readable report with visualizations
 *
 * Usage:
 *   const generator = new IntrospectionReportGenerator(collector, validator);
 *   generator.generateBoth(outputDir);
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ModuleType } = require('./workflow-introspection-collector');

// ─── Report Generator ──────────────────────────────────────────────────────────

class IntrospectionReportGenerator {
  /**
   * @param {WorkflowIntrospectionCollector} collector
   * @param {ConsistencyValidator} validator
   */
  constructor(collector, validator) {
    this._collector = collector;
    this._validator = validator;
  }

  /**
   * Generate both JSON and Markdown reports.
   *
   * @param {string} outputDir - Output directory
   * @returns {{ jsonPath: string, markdownPath: string }} Paths to generated files
   */
  generateBoth(outputDir) {
    const jsonPath = this.generateJSON(outputDir);
    const markdownPath = this.generateMarkdown(outputDir);
    return { jsonPath, markdownPath };
  }

  /**
   * Generate JSON report.
   *
   * @param {string} outputDir
   * @returns {string} Path to written file
   */
  generateJSON(outputDir) {
    const validationReport = this._validator.validateAll();
    
    const report = {
      metadata: {
        generatedAt: new Date().toISOString(),
        sessionId: this._collector._sessionId,
        version: '1.0.0',
      },
      summary: validationReport.summary,
      validation: validationReport,
      introspection: {
        stats: this._collector.getStats(),
        entries: this._collector.getAll(),
      },
      dataFlow: this._buildDataFlowAnalysis(),
      entityLifecycles: this._buildEntityLifecycles(),
    };

    const filePath = path.join(outputDir, 'workflow-introspection-report.json');
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    return filePath;
  }

  /**
   * Generate Markdown report.
   *
   * @param {string} outputDir
   * @returns {string} Path to written file
   */
  generateMarkdown(outputDir) {
    const validationReport = this._validator.validateAll();
    const stats = this._collector.getStats();
    
    const sections = [
      this._generateHeader(validationReport, stats),
      this._generateSummary(validationReport, stats),
      this._generateValidationResults(validationReport),
      this._generateDataFlowVisualization(),
      this._generateModuleDetails(),
      this._generateEntityLifecycles(),
      this._generateRecommendations(validationReport),
    ];

    const content = sections.join('\n\n');
    const filePath = path.join(outputDir, 'workflow-introspection-report.md');
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  // ─── Section Generators ───────────────────────────────────────────────────────

  _generateHeader(validationReport, stats) {
    const total = validationReport.summary.totalIssues;
    const errors = validationReport.summary.errors;
    const warnings = validationReport.summary.warnings;
    const passRate = validationReport.summary.passRate;
    
    const statusIcon = errors > 0 ? '❌' : warnings > 0 ? '⚠️' : '✅';
    const statusText = errors > 0 ? 'Issues Found' : warnings > 0 ? 'Warnings Present' : 'All Clear';
    
    return [
      '# Workflow Introspection Report',
      '',
      `> **Session:** ${this._collector._sessionId || 'N/A'}`,
      `> **Generated:** ${new Date().toLocaleString()}`,
      `> **Status:** ${statusIcon} ${statusText} (Pass Rate: ${passRate}%)`,
      '',
      '## Executive Summary',
      '',
      '| Metric | Value |',
      '|--------|-------|',
      `| Total Introspection Entries | ${stats.totalEntries} |`,
      `| Unique Traces | ${stats.uniqueTraces} |`,
      `| Modules Covered | ${stats.moduleCoverage}/7 |`,
      `| Validation Issues | ${total} (${errors} errors, ${warnings} warnings) |`,
      `| Pass Rate | ${passRate}% |`,
    ].join('\n');
  }

  _generateSummary(validationReport, stats) {
    const byModule = stats.byModule || {};
    
    const lines = [
      '## Module Activity Summary',
      '',
      '| Module | Activity Count | Status |',
      '|--------|---------------|--------|',
    ];
    
    const moduleNames = Object.values(ModuleType).filter(m => m !== ModuleType.UNKNOWN);
    for (const module of moduleNames) {
      const count = byModule[module] || 0;
      const status = count > 0 ? '✅ Active' : '⚪ Inactive';
      lines.push(`| ${module} | ${count} | ${status} |`);
    }
    
    return lines.join('\n');
  }

  _generateValidationResults(validationReport) {
    const lines = [
      '## Validation Results',
      '',
    ];
    
    if (validationReport.issues.length === 0) {
      lines.push('✅ **All validation checks passed!** No inconsistencies detected between modules.');
      return lines.join('\n');
    }
    
    // Group by severity
    const bySeverity = {
      error: validationReport.issues.filter(i => i.severity === 'error'),
      warning: validationReport.issues.filter(i => i.severity === 'warning'),
      info: validationReport.issues.filter(i => i.severity === 'info'),
    };
    
    // Errors section
    if (bySeverity.error.length > 0) {
      lines.push('### ❌ Errors', '');
      for (const issue of bySeverity.error) {
        lines.push(this._formatIssue(issue));
      }
      lines.push('');
    }
    
    // Warnings section
    if (bySeverity.warning.length > 0) {
      lines.push('### ⚠️ Warnings', '');
      for (const issue of bySeverity.warning) {
        lines.push(this._formatIssue(issue));
      }
      lines.push('');
    }
    
    // Info section
    if (bySeverity.info.length > 0) {
      lines.push('### ℹ️ Informational', '');
      for (const issue of bySeverity.info) {
        lines.push(this._formatIssue(issue));
      }
    }
    
    return lines.join('\n');
  }

  _formatIssue(issue) {
    const lines = [
      `#### ${issue.id}: ${issue.description}`,
      '',
      `- **Category:** ${issue.category}`,
      `- **Severity:** ${issue.severity.toUpperCase()}`,
      `- **Affected Modules:** ${issue.affectedModules.join(', ')}`,
    ];
    
    if (issue.suggestion) {
      lines.push(`- **Suggestion:** ${issue.suggestion}`);
    }
    
    if (Object.keys(issue.details).length > 0) {
      lines.push('', '<details>', '<summary>Details</summary>', '');
      lines.push('```json');
      lines.push(JSON.stringify(issue.details, null, 2));
      lines.push('```');
      lines.push('</details>');
    }
    
    return lines.join('\n');
  }

  _generateDataFlowVisualization() {
    const flows = [];
    const modulePairs = [
      [ModuleType.SKILL, ModuleType.PROMPT],
      [ModuleType.EXPERIENCE, ModuleType.SKILL],
      [ModuleType.ARCHITECTURE, ModuleType.SCAN],
      [ModuleType.FRAMEWORK, ModuleType.EXPERIENCE],
    ];
    
    for (const [from, to] of modulePairs) {
      const moduleFlows = this._collector.findDataFlow(from, to);
      if (moduleFlows.length > 0) {
        flows.push({ from, to, count: moduleFlows.length });
      }
    }
    
    if (flows.length === 0) {
      return '';
    }
    
    const lines = [
      '## Cross-Module Data Flow',
      '',
      '```mermaid',
      'graph LR',
    ];
    
    for (const flow of flows) {
      lines.push(`    ${flow.from}[${flow.from}] -->|${flow.count} flows| ${flow.to}[${flow.to}]`);
    }
    
    lines.push('```', '');
    
    // Data flow table
    lines.push('### Flow Details', '');
    lines.push('| Source | Target | Flow Count | Status |');
    lines.push('|--------|--------|------------|--------|');
    
    for (const flow of flows) {
      const status = flow.count > 0 ? '✅ Active' : '⚪ Inactive';
      lines.push(`| ${flow.from} | ${flow.to} | ${flow.count} | ${status} |`);
    }
    
    return lines.join('\n');
  }

  _generateModuleDetails() {
    const lines = [
      '## Detailed Module Activity',
      '',
    ];
    
    const moduleNames = Object.values(ModuleType).filter(m => m !== ModuleType.UNKNOWN);
    
    for (const module of moduleNames) {
      const entries = this._collector.getByModule(module);
      if (entries.length === 0) continue;
      
      lines.push(`### ${module}`, '');
      
      // Activity by action
      const byAction = {};
      for (const entry of entries) {
        byAction[entry.action] = (byAction[entry.action] || 0) + 1;
      }
      
      lines.push('**Activity Distribution:**', '');
      lines.push('| Action | Count |');
      lines.push('|--------|-------|');
      
      const sortedActions = Object.entries(byAction).sort((a, b) => b[1] - a[1]);
      for (const [action, count] of sortedActions.slice(0, 10)) {
        lines.push(`| ${action} | ${count} |`);
      }
      
      lines.push('', '**Recent Events:**', '');
      const recentEntries = entries
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 5);
      
      for (const entry of recentEntries) {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        lines.push(`- \`${time}\` ${entry.action}: ${JSON.stringify(entry.context).slice(0, 100)}`);
      }
      
      lines.push('');
    }
    
    return lines.join('\n');
  }

  _generateEntityLifecycles() {
    const lines = [
      '## Notable Entity Lifecycles',
      '',
    ];
    
    // Find entities with interesting lifecycles (multiple events)
    const entityEvents = new Map(); // entityKey -> events[]
    
    for (const entry of this._collector.getAll()) {
      const entityId = entry.context.skillName || entry.context.experienceId || 
                       entry.context.findingId || entry.context.entityId;
      if (!entityId) continue;
      
      const key = `${entry.module}:${entityId}`;
      if (!entityEvents.has(key)) entityEvents.set(key, []);
      entityEvents.get(key).push(entry);
    }
    
    // Find entities with multiple events (interesting lifecycles)
    const interestingEntities = [];
    for (const [key, events] of entityEvents) {
      if (events.length >= 2) {
        const modules = new Set(events.map(e => e.module));
        if (modules.size > 1) {
          interestingEntities.push({ key, events, moduleCount: modules.size });
        }
      }
    }
    
    interestingEntities.sort((a, b) => b.moduleCount - a.moduleCount);
    
    if (interestingEntities.length === 0) {
      lines.push('*No cross-module entity lifecycles recorded in this session.*');
      return lines.join('\n');
    }
    
    lines.push('Entities that flowed through multiple modules:', '');
    
    for (const { key, events } of interestingEntities.slice(0, 10)) {
      const [module, entityId] = key.split(':');
      lines.push(`### ${entityId} (${module})`, '');
      lines.push('| Time | Module | Action | Context |');
      lines.push('|------|--------|--------|---------|');
      
      const sortedEvents = events
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      
      for (const event of sortedEvents) {
        const time = new Date(event.timestamp).toLocaleTimeString();
        const context = JSON.stringify(event.context).slice(0, 50) + '...';
        lines.push(`| ${time} | ${event.module} | ${event.action} | ${context} |`);
      }
      
      lines.push('');
    }
    
    return lines.join('\n');
  }

  _generateRecommendations(validationReport) {
    const lines = [
      '## Recommendations',
      '',
    ];
    
    // Generate recommendations based on issues
    const errors = validationReport.issues.filter(i => i.severity === 'error');
    const warnings = validationReport.issues.filter(i => i.severity === 'warning');
    
    if (errors.length === 0 && warnings.length === 0) {
      lines.push('✅ **No action required.** All modules are operating consistently.');
      return lines.join('\n');
    }
    
    lines.push('### Priority Actions', '');
    
    if (errors.length > 0) {
      lines.push('**Critical (Fix Immediately):**');
      lines.push('');
      for (const issue of errors.slice(0, 5)) {
        lines.push(`1. **${issue.category}:** ${issue.suggestion || issue.description}`);
      }
      lines.push('');
    }
    
    if (warnings.length > 0) {
      lines.push('**Warnings (Review Soon):**');
      lines.push('');
      for (const issue of warnings.slice(0, 5)) {
        lines.push(`- ${issue.category}: ${issue.suggestion || issue.description}`);
      }
      lines.push('');
    }
    
    // General recommendations based on stats
    const stats = this._collector.getStats();
    
    lines.push('### General Improvements', '');
    
    if (stats.moduleCoverage < 7) {
      const inactiveModules = Object.values(ModuleType)
        .filter(m => m !== ModuleType.UNKNOWN && !stats.byModule[m]);
      lines.push(`- Consider instrumenting inactive modules: ${inactiveModules.join(', ')}`);
    }
    
    if (stats.uniqueTraces < stats.totalEntries * 0.1) {
      lines.push('- Low correlation trace coverage. Consider adding more trace IDs for cross-module tracking.');
    }
    
    return lines.join('\n');
  }

  // ─── Data Building Helpers ────────────────────────────────────────────────────

  _buildDataFlowAnalysis() {
    const modulePairs = [
      [ModuleType.SKILL, ModuleType.PROMPT],
      [ModuleType.EXPERIENCE, ModuleType.SKILL],
      [ModuleType.ARCHITECTURE, ModuleType.SCAN],
      [ModuleType.FRAMEWORK, ModuleType.EXPERIENCE],
    ];
    
    const analysis = [];
    for (const [from, to] of modulePairs) {
      const flows = this._collector.findDataFlow(from, to);
      analysis.push({
        source: from,
        target: to,
        flowCount: flows.length,
        flows: flows.map(f => ({
          traceId: f.traceId,
          sourceEvents: f.fromEntries.map(e => ({ id: e.id, action: e.action })),
          targetEvents: f.toEntries.map(e => ({ id: e.id, action: e.action })),
        })),
      });
    }
    
    return analysis;
  }

  _buildEntityLifecycles() {
    const lifecycles = [];
    const entityKeys = ['skillName', 'experienceId', 'findingId'];
    
    for (const key of entityKeys) {
      const seen = new Set();
      for (const entry of this._collector.getAll()) {
        const value = entry.context[key];
        if (!value || seen.has(value)) continue;
        seen.add(value);
        
        const lifecycle = this._collector.getEntityLifecycle(key, value);
        if (lifecycle.length >= 2) {
          lifecycles.push({
            entityType: key,
            entityId: value,
            events: lifecycle.map(e => ({
              timestamp: e.timestamp,
              module: e.module,
              action: e.action,
            })),
          });
        }
      }
    }
    
    return lifecycles.slice(0, 50); // Limit to prevent huge reports
  }
}

module.exports = { IntrospectionReportGenerator };