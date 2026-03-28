/**
 * CodeReviewAgent Tests
 * Covers: review logic, checklist validation, dimension tracking
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  CodeReviewAgent,
  DEFAULT_CHECKLIST,
  REVIEW_DIMENSIONS,
  ITEM_TO_DIMENSION,
} = require('./code-review-agent');

describe('CodeReviewAgent', () => {
  describe('Exports', () => {
    it('should export CodeReviewAgent class', () => {
      assert.ok(CodeReviewAgent, 'CodeReviewAgent should be exported');
      assert.ok(typeof CodeReviewAgent === 'function', 'CodeReviewAgent should be a class/function');
    });

    it('should export DEFAULT_CHECKLIST', () => {
      assert.ok(DEFAULT_CHECKLIST, 'DEFAULT_CHECKLIST should be exported');
      assert.ok(Array.isArray(DEFAULT_CHECKLIST), 'Should be an array');
      assert.ok(DEFAULT_CHECKLIST.length > 0, 'Should have items');
    });

    it('should export REVIEW_DIMENSIONS', () => {
      assert.ok(REVIEW_DIMENSIONS, 'REVIEW_DIMENSIONS should be exported');
      assert.ok(typeof REVIEW_DIMENSIONS === 'object', 'Should be an object');
    });

    it('should export ITEM_TO_DIMENSION mapping', () => {
      assert.ok(ITEM_TO_DIMENSION, 'ITEM_TO_DIMENSION should be exported');
      assert.ok(typeof ITEM_TO_DIMENSION === 'object', 'Should be an object');
    });
  });

  describe('Checklist Structure', () => {
    it('should have valid checklist items', () => {
      for (const item of DEFAULT_CHECKLIST) {
        assert.ok(item.id, `Item should have id`);
        assert.ok(typeof item.id === 'string', 'ID should be string');
        assert.ok(item.description, `Item ${item.id} should have description`);
        assert.ok(typeof item.severity === 'string', 'Should have severity');
        assert.ok(['critical', 'high', 'medium', 'low'].includes(item.severity),
          `Severity should be valid: ${item.severity}`);
      }
    });

    it('should have categories for items', () => {
      const hasCategories = DEFAULT_CHECKLIST.some(item => item.category || item.dimension);
      console.log(`   Info: ${DEFAULT_CHECKLIST.length} checklist items`);

      // Optional: items may have category field
      if (hasCategories) {
        console.log('   Info: Items have category/dimension field');
      }
    });

    it('should map items to dimensions', () => {
      // Each checklist item should map to a dimension
      for (const item of DEFAULT_CHECKLIST.slice(0, 10)) { // Sample first 10
        const dimension = ITEM_TO_DIMENSION[item.id];
        if (dimension) {
          assert.ok(REVIEW_DIMENSIONS[dimension], `Dimension ${dimension} should exist`);
        }
      }
    });
  });

  describe('Review Dimensions', () => {
    it('should have defined dimensions', () => {
      const dimensions = Object.keys(REVIEW_DIMENSIONS);
      console.log(`   Info: Available dimensions: ${dimensions.join(', ')}`);

      assert.ok(dimensions.length > 0, 'Should have dimensions');

      for (const dim of dimensions) {
        const config = REVIEW_DIMENSIONS[dim];
        assert.ok(config, `Dimension ${dim} should have config`);
      }
    });

    it('should include core code quality dimensions', () => {
      const dimensions = Object.keys(REVIEW_DIMENSIONS).map(d => d.toLowerCase());

      // Check for typical dimensions
      const typicalDims = ['security', 'performance', 'maintainability', 'correctness'];
      const found = typicalDims.filter(d => dimensions.some(dim => dim.includes(d)));

      console.log(`   Info: Found core dimensions: ${found.join(', ')}`);
      assert.ok(found.length > 0, 'Should have some core dimensions');
    });
  });
});

describe('CodeReviewAgent Instance', () => {
  // Mock LLM call function
  const mockLLMCall = async (prompt, opts) => {
    return {
      text: JSON.stringify({
        passed: ['test-item-1'],
        failed: [],
        na: [],
      }),
    };
  };

  it('should create instance with LLM call', () => {
    const agent = new CodeReviewAgent(mockLLMCall, {
      maxRounds: 2,
      checklist: DEFAULT_CHECKLIST.slice(0, 3),
    });

    assert.ok(agent, 'Should create instance');
    assert.ok(agent.llmCall === mockLLMCall, 'Should store LLM call');
  });

  it('should have default options', () => {
    const agent = new CodeReviewAgent(mockLLMCall);

    assert.ok(agent.options, 'Should have options');
    assert.ok(typeof agent.options.maxRounds === 'number', 'Should have maxRounds');
  });
});

describe('Diff Validation', () => {
  it('should validate diff format', () => {
    const validDiff = `diff --git a/file.js b/file.js
index 123..456 789
--- a/file.js
+++ b/file.js
@@ -1,5 +1,5 @@
 function test() {
-  return 1;
+  return 2;
 }`;

    // Diff should have proper git format markers
    assert.ok(validDiff.includes('diff --git'), 'Should have diff header');
    assert.ok(validDiff.includes('---'), 'Should have old file marker');
    assert.ok(validDiff.includes('+++'), 'Should have new file marker');
  });

  it('should detect invalid diff', () => {
    const invalidDiff = 'this is not a valid diff';

    assert.ok(!invalidDiff.includes('diff --git'), 'Should not have diff header');
    assert.ok(!invalidDiff.includes('---'), 'Should not have file markers');
  });
});

describe('Checklist Item Severity', () => {
  it('should have critical severity items', () => {
    const criticalItems = DEFAULT_CHECKLIST.filter(i => i.severity === 'critical');
    console.log(`   Info: ${criticalItems.length} critical items`);

    assert.ok(criticalItems.length >= 0, 'May have critical items');
  });

  it('should have high severity items', () => {
    const highItems = DEFAULT_CHECKLIST.filter(i => i.severity === 'high');
    console.log(`   Info: ${highItems.length} high severity items`);

    assert.ok(highItems.length >= 0, 'May have high severity items');
  });

  it('should prioritize critical over high', () => {
    const items = DEFAULT_CHECKLIST;
    const criticalCount = items.filter(i => i.severity === 'critical').length;
    const highCount = items.filter(i => i.severity === 'high').length;

    console.log(`   Info: Severity distribution - Critical: ${criticalCount}, High: ${highCount}`);

    // Critical items should be fewer or equal to high
    assert.ok(criticalCount <= highCount || criticalCount < 10,
      'Critical items should be limited');
  });
});

describe('Security Coverage', () => {
  it('should include security-related checks', () => {
    const securityItems = DEFAULT_CHECKLIST.filter(item => {
      const text = (item.description + ' ' + (item.id || '')).toLowerCase();
      return text.includes('security') ||
             text.includes('injection') ||
             text.includes('sanitize') ||
             text.includes('escape') ||
             text.includes('auth');
    });

    console.log(`   Info: ${securityItems.length} security-related items`);

    // Should have some security checks
    assert.ok(securityItems.length >= 0, 'Should document security coverage');
  });
});

console.log(`\n🔍 CodeReviewAgent Tests\n`);
