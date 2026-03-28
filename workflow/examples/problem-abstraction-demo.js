/**
 * Problem Abstraction Engine Demo
 *
 * This script demonstrates how the Problem Abstraction Engine detects
 * recurring fix patterns and recommends architecture evolution.
 *
 * Scenario: Simulating multiple "added IDE support" fixes that indicate
 * the need for a Provider Pattern.
 */

'use strict';

const path = require('path');
const { ExperienceStore } = require('../core/experience-store');
const { ExperienceType, ExperienceCategory } = require('../core/experience-types');

// ─── Demo Configuration ─────────────────────────────────────────────────────

const DEMO_OUTPUT_DIR = path.join(__dirname, '../../output/demo-abstraction');

// ─── Helper Functions ───────────────────────────────────────────────────────

function createHardcodedIDEFixExperience(ideName, timestamp) {
  return {
    type: ExperienceType.NEGATIVE,
    category: ExperienceCategory.CONFIG_SYSTEM,
    title: `Added ${ideName} to IDE_SIGNATURES`,
    content: `Added support for ${ideName} IDE by adding new entry to the hardcoded IDE_SIGNATURES object in ide-detection.js. ` +
             `The list is growing and becoming hard to maintain. Each new IDE requires editing the core file.`,
    codeExample: `// ide-detection.js
const IDE_SIGNATURES = {
  // ... existing entries
  ${ideName.toLowerCase()}: {
    name: '${ideName}',
    envVars: ['${ideName.toUpperCase()}_SESSION'],
    processNames: ['${ideName.toLowerCase()}'],
    capabilities: { /* ... */ },
  },
};`,
    tags: ['ide', 'hardcoded', 'config', 'maintenance'],
  };
}

// ─── Demo Scenarios ─────────────────────────────────────────────────────────

async function runDemo() {
  console.log('\n' + '='.repeat(70));
  console.log('  Problem Abstraction Engine Demo');
  console.log('  Phase 1: HARDCODED_CONFIG_ENTRY Pattern Detection');
  console.log('='.repeat(70) + '\n');

  // Initialize experience store
  const store = new ExperienceStore(path.join(DEMO_OUTPUT_DIR, 'experiences.json'));

  console.log('[Demo] Experience Store initialized\n');
  console.log('-'.repeat(70));
  console.log('Scenario: Team keeps adding new IDE support to hardcoded list');
  console.log('-'.repeat(70) + '\n');

  // Simulate 3 hardcoded IDE fixes over time
  const ideFixes = [
    { name: 'Trae', daysAgo: 21 },
    { name: 'Zed', daysAgo: 14 },
    { name: 'KimiCode', daysAgo: 7 },
  ];

  console.log('Simulating experience recordings...\n');

  for (const fix of ideFixes) {
    const timestamp = Date.now() - fix.daysAgo * 24 * 60 * 60 * 1000;
    const exp = createHardcodedIDEFixExperience(fix.name, timestamp);
    exp.createdAt = new Date(timestamp).toISOString();

    // Record with pattern detection
    const recorded = store.recordWithAbstraction(exp);

    console.log(`📋 Recorded: ${exp.title}`);
    console.log(`   Date: ${new Date(timestamp).toLocaleDateString()}`);
    console.log(`   Patterns matched: ${recorded.patternCheck.patternsMatched}`);

    if (recorded.patternCheck.triggeredPatterns.length > 0) {
      console.log(`   🚨 TRIGGERED PATTERNS:`);
      for (const triggered of recorded.patternCheck.triggeredPatterns) {
        console.log(`      - ${triggered.patternName}`);
        console.log(`        Occurrences: ${triggered.occurrenceCount}/${triggered.threshold}`);
        console.log(`        Recommendation: ${triggered.recommendation}`);
      }
    }
    console.log();
  }

  console.log('-'.repeat(70));
  console.log('Running full abstraction analysis...');
  console.log('-'.repeat(70) + '\n');

  // Run full analysis
  const analysis = store.analyzeAbstractions();

  console.log('📊 Analysis Results:\n');
  console.log(`   Total experiences analyzed: ${analysis.summary.totalExperiencesAnalyzed}`);
  console.log(`   Unique patterns detected: ${analysis.summary.patternsDetected}`);
  console.log(`   Patterns triggered: ${analysis.summary.patternsTriggered}`);
  console.log(`   Health status: ${analysis.summary.healthStatus}`);
  console.log();

  if (analysis.detection.triggeredPatterns.length > 0) {
    console.log('🔴 Triggered Patterns (require architecture evolution):\n');

    for (const triggered of analysis.detection.triggeredPatterns) {
      console.log(`   📌 ${triggered.patternName}`);
      console.log(`      Severity: ${triggered.severity.toUpperCase()}`);
      console.log(`      Occurrences: ${triggered.occurrenceCount} (threshold: ${triggered.threshold})`);
      console.log(`      Confidence: ${(triggered.confidence * 100).toFixed(1)}%`);
      console.log(`      Recommendation: ${triggered.recommendation}`);
      console.log();

      if (triggered.evidence) {
        console.log(`      Evidence (${triggered.evidence.length} occurrences):`);
        triggered.evidence.slice(0, 3).forEach((ev, idx) => {
          console.log(`        ${idx + 1}. ${ev.title} (${new Date(ev.timestamp).toLocaleDateString()})`);
        });
        if (triggered.evidence.length > 3) {
          console.log(`        ... and ${triggered.evidence.length - 3} more`);
        }
        console.log();
      }
    }
  }

  if (analysis.recommendations.length > 0) {
    console.log('-'.repeat(70));
    console.log('💡 Evolution Recommendations:\n');

    for (const rec of analysis.recommendations) {
      const icon = rec.priority === 'P0' ? '🔴' : rec.priority === 'P1' ? '🟡' : '🟢';
      console.log(`   ${icon} [${rec.priority}] ${rec.type}`);
      console.log(`      ${rec.message}`);
      if (rec.recommendation) {
        console.log(`      Action: ${rec.recommendation}`);
      }
      console.log();
    }
  }

  // Health report
  console.log('-'.repeat(70));
  console.log('🏥 Architecture Health Report:\n');

  const health = analysis.health;
  const healthIcon = health.health === 'healthy' ? '✅' : health.health === 'at-risk' ? '⚠️' : '🚨';
  console.log(`   ${healthIcon} Overall Health: ${health.health.toUpperCase()}`);
  console.log(`   Risk Level: ${health.riskLevel}`);
  console.log();
  console.log('   Metrics:');
  console.log(`     - Total patterns: ${health.metrics.totalPatterns}`);
  console.log(`     - Active patterns: ${health.metrics.activePatterns}`);
  console.log(`     - Accelerating patterns: ${health.metrics.acceleratingPatterns}`);
  console.log(`     - Current entropy: ${health.metrics.currentEntropy.toFixed(2)}`);
  console.log(`     - Entropy trend: ${health.metrics.entropyTrend}`);
  console.log();

  if (health.categoryDistribution && Object.keys(health.categoryDistribution).length > 0) {
    console.log('   Category Distribution:');
    for (const [cat, count] of Object.entries(health.categoryDistribution)) {
      console.log(`     - ${cat}: ${count}`);
    }
    console.log();
  }

  // Run health check
  console.log('-'.repeat(70));
  console.log('Running automated health check...\n');

  const check = store.runHealthCheck();
  console.log(`   Health check completed at ${new Date(check.timestamp).toLocaleString()}`);
  console.log(`   Requires action: ${check.requiresAction ? 'YES' : 'No'}`);

  if (check.requiresAction) {
    console.log('\n   Action items:');
    for (const rec of check.recommendations) {
      console.log(`     - [${rec.priority}] ${rec.type}: ${rec.message}`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('Demo Complete');
  console.log('='.repeat(70) + '\n');

  // Summary
  console.log('Key Takeaways:');
  console.log('  1. System automatically detected recurring HARDCODED_CONFIG_ENTRY pattern');
  console.log('  2. Threshold (3 occurrences) triggered evolution recommendation');
  console.log('  3. Health report shows at-risk status with specific action items');
  console.log('  4. Zero LLM calls were made - all detection is rule-based');
  console.log();

  return analysis;
}

// ─── Run Demo ───────────────────────────────────────────────────────────────

runDemo().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
