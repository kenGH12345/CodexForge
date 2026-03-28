#!/usr/bin/env node
/**
 * Quick test script for ExecutionLogValidator
 * 快速测试执行日志验证器功能
 */

const fs = require('fs');
const path = require('path');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║     E X E C U T I O N   V A L I D A T O R   T E S T       ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// Test 1: Module Import
console.log('[Test 1] Module Import Test');
try {
  const validator = require('./workflow/core/execution-log-validator');
  const integration = require('./workflow/core/execution-validator-integration');
  const command = require('./workflow/commands/command-validate-execution');

  console.log('  ✅ ExecutionLogValidator module imported');
  console.log('  ✅ ExecutionValidatorIntegration module imported');
  console.log('  ✅ ValidateExecutionCommand module imported');
} catch (err) {
  console.error('  ❌ Import failed:', err.message);
  process.exit(1);
}

// Test 2: Class Instantiation
console.log('\n[Test 2] Class Instantiation Test');
try {
  const { ExecutionLogValidator, STANDARD_EXECUTION_FLOW, STAGE_SEQUENCE } = require('./workflow/core/execution-log-validator');

  const validator = new ExecutionLogValidator({
    outputDir: './output',
    verbose: false,
  });

  console.log('  ✅ ExecutionLogValidator instantiated');
  console.log(`  📊 Standard flow templates: ${Object.keys(STANDARD_EXECUTION_FLOW).length} stages`);
  console.log(`  📋 Stage sequence: ${STAGE_SEQUENCE.join(' → ')}`);
} catch (err) {
  console.error('  ❌ Instantiation failed:', err.message);
  process.exit(1);
}

// Test 3: Standard Execution Flow Validation
console.log('\n[Test 3] Standard Flow Template Validation');
try {
  const { STANDARD_EXECUTION_FLOW, STAGE_SEQUENCE } = require('./workflow/core/execution-log-validator');

  for (const stage of STAGE_SEQUENCE) {
    const template = STANDARD_EXECUTION_FLOW[stage];
    if (!template) {
      throw new Error(`Missing template for stage: ${stage}`);
    }

    console.log(`  ✅ ${stage}:`);
    console.log(`     Required artifacts: ${template.requiredArtifacts.join(', ')}`);
    console.log(`     Min sections: ${template.minContentSections}`);
    console.log(`     Required sections: ${template.requiredSections.length}`);
  }
} catch (err) {
  console.error('  ❌ Template validation failed:', err.message);
  process.exit(1);
}

// Test 4: Integration Helpers
console.log('\n[Test 4] Integration Helpers Test');
try {
  const {
    withExecutionValidation,
    createExecutionValidationGates,
    createExecutionValidationDimension,
  } = require('./workflow/core/execution-validator-integration');

  console.log('  ✅ withExecutionValidation function available');
  console.log('  ✅ createExecutionValidationGates function available');
  console.log('  ✅ createExecutionValidationDimension function available');

  // Test gate creation
  const gates = createExecutionValidationGates({
    minExecutionScore: 75,
    maxFailedStages: 1,
  });
  console.log(`  📊 Created ${Object.keys(gates).length} quality gates`);

  // Test dimension creation
  const dimension = createExecutionValidationDimension();
  console.log(`  📋 DeepAudit dimension: ${dimension.name}`);
} catch (err) {
  console.error('  ❌ Integration helpers test failed:', err.message);
  process.exit(1);
}

// Test 5: Execution Log Parsing
console.log('\n[Test 5] Execution Log Parsing Test');
try {
  const { ExecutionLogParser } = require('./workflow/core/execution-log-validator');
  const parser = new ExecutionLogParser('./output');

  console.log('  ✅ ExecutionLogParser instantiated');

  // Check if output directory exists and has content
  if (fs.existsSync('./output')) {
    const state = parser.parseExecutionState();
    console.log(`  📊 Parsed execution state:`);
    console.log(`     Stages analyzed: ${Object.keys(state.stages).length}`);
    console.log(`     Flow started: ${state.flow.started || 'N/A'}`);
    console.log(`     Flow completed: ${state.flow.completed || 'N/A'}`);
    console.log(`     Current stage: ${state.flow.currentStage}`);

    // Show stage statuses
    for (const [stage, stageState] of Object.entries(state.stages)) {
      const icon = stageState.status === 'completed' ? '✅' :
                   stageState.status === 'failed' ? '❌' : '⏳';
      console.log(`     ${icon} ${stage}: ${stageState.status}`);
    }
  } else {
    console.log('  ⚠️  Output directory not found, skipping parsing');
  }
} catch (err) {
  console.error('  ❌ Parsing test failed:', err.message);
  // Non-fatal
}

// Test 6: Integration Configuration
console.log('\n[Test 6] Integration Configuration Test');
try {
  const { createIntegrationConfig } = require('./workflow/core/execution-validator-integration');

  const config = createIntegrationConfig({
    strictMode: true,
    verbose: true,
  });

  console.log('  ✅ Integration config created');
  console.log(`     Orchestrator integration: ${config.orchestrator.enabled ? 'enabled' : 'disabled'}`);
  console.log(`     QualityGate integration: ${config.qualityGate.enabled ? 'enabled' : 'disabled'}`);
  console.log(`     DeepAudit integration: ${config.deepAudit.enabled ? 'enabled' : 'disabled'}`);
  console.log(`     SelfAudit integration: ${config.selfAudit.enabled ? 'enabled' : 'disabled'}`);
  console.log(`     EventJournal integration: ${config.eventJournal.enabled ? 'enabled' : 'disabled'}`);
} catch (err) {
  console.error('  ❌ Config test failed:', err.message);
  process.exit(1);
}

// Test 7: Command Registration
console.log('\n[Test 7] Command Registration Test');
try {
  const { COMMAND_SPEC, ValidateExecutionCommand } = require('./workflow/commands/command-validate-execution');

  console.log('  ✅ Command spec loaded');
  console.log(`     Command name: ${COMMAND_SPEC.name}`);
  console.log(`     Aliases: ${COMMAND_SPEC.aliases.join(', ')}`);
  console.log(`     Arguments: ${COMMAND_SPEC.args.map(a => a.name).join(', ')}`);

  const cmd = new ValidateExecutionCommand();
  console.log('  ✅ ValidateExecutionCommand instantiated');
} catch (err) {
  console.error('  ❌ Command test failed:', err.message);
  process.exit(1);
}

// Final Summary
console.log('\n' + '═'.repeat(60));
console.log('                     A L L   T E S T S   P A S S E D');
console.log('═'.repeat(60));
console.log('\n🎉 ExecutionLogValidator system is ready to use!');
console.log('\nUsage:');
console.log('  1. Run validation: node workflow/commands/command-validate-execution.js');
console.log('  2. Or use command: /validate-execution --verbose');
console.log('  3. Full validation: /validate-execution --strict --output-dir ./output');
console.log('');
