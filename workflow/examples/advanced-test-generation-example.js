/**
 * Advanced Test Case Generation - Example Usage
 * 
 * 演示如何使用增强版 TestCaseGenerator 根据代码改动自动生成详细测试文档
 * 
 * Usage: node workflow/examples/advanced-test-generation-example.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { TestCaseGenerator } = require('../core/test-case-generator');

// 示例 LLM 调用函数（实际使用时替换为真实的 LLM 调用）
async function mockLlmCall(prompt) {
  console.log('\n[Mock LLM] Received prompt length:', prompt.length, 'chars');
  console.log('[Mock LLM] Analyzing code diff and generating test cases...\n');
  
  // 模拟 LLM 返回详细测试文档
  return generateExampleTestDocument();
}

// 生成示例测试文档（实际项目中，这是 LLM 的输出）
function generateExampleTestDocument() {
  return `# Section 1: Feature Scope Analysis

## 1.1 New Features Added
| Feature ID | Feature Description | Files Modified | Functions/Methods |
|------------|---------------------|----------------|-------------------|
| FEAT-001 | 添加用户购物车功能 | src/cart.js | addItem(), removeItem(), calculateTotal() |
| FEAT-002 | 实现库存检查 | src/cart.js, src/inventory.js | checkStock(), reserveItem() |

## 1.2 Existing Features Modified
| Feature ID | Original Behavior | New Behavior | Impact Level |
|------------|-------------------|--------------|--------------|
| MOD-001 | 直接添加到购物车 | 先检查库存再添加 | High |

---

# Section 2: Detailed Test Cases

## Feature: [FEAT-001] 购物车添加商品

### 2.1 Test Summary
- **Feature**: 购物车添加商品功能
- **Test Priority**: P0 (Critical)
- **Risk Level**: High
- **Automation Feasibility**: High

### 2.2 Test Cases

#### Test Case: TC_FEAT001_001
| Field | Value |
|-------|-------|
| **Test ID** | TC_FEAT001_001 |
| **Title** | 验证成功添加商品到购物车 |
| **Test Type** | Functional |
| **Preconditions** | 用户已登录，商品有库存 |
| **Test Steps** | 1. 调用 addItem({ productId: "PROD-001", quantity: 2 }) <br> 2. 检查返回值 <br> 3. 验证购物车状态更新 <br> 4. 检查库存扣减 |
| **Expected Result** | 返回 { success: true, cartItemId: "CI-123" }，购物车商品数量 +2，库存 -2 |
| **Actual Implementation Code Reference** | src/cart.js:45-67 |
| **Test Data** | \`\`\`json { "productId": "PROD-001", "name": "Test Product", "quantity": 2, "price": 99.99 } \`\`\` |
| **Automation Type** | auto |

#### Test Case: TC_FEAT001_002
| Field | Value |
|-------|-------|
| **Test ID** | TC_FEAT001_002 |
| **Title** | 验证添加商品时库存不足 |
| **Test Type** | Functional / Error |
| **Preconditions** | 商品库存为 1 |
| **Test Steps** | 1. 调用 addItem({ productId: "PROD-002", quantity: 5 }) <br> 2. 检查返回值 |
| **Expected Result** | 返回 { success: false, error: "Insufficient stock", available: 1 } |
| **Actual Implementation Code Reference** | src/cart.js:68-75 |
| **Test Data** | \`\`\`json { "productId": "PROD-002", "quantity": 5 } \`\`\` |
| **Automation Type** | auto |

---

# Section 3: Boundary & Edge Case Analysis

## 3.1 Input Boundary Values
| Feature | Input Field | Boundary Type | Test Value | Expected Behavior |
|---------|-------------|---------------|------------|-------------------|
| FEAT-001 | quantity | Min Boundary (1) | 1 | Accept |
| FEAT-001 | quantity | Max Boundary (99) | 99 | Accept |
| FEAT-001 | quantity | Max+1 Boundary (100) | 100 | Reject with "Quantity limit exceeded" |
| FEAT-001 | quantity | Zero | 0 | Reject with "Quantity must be at least 1" |
| FEAT-001 | quantity | Negative | -1 | Reject with "Invalid quantity" |

## 3.2 Error Scenarios
| Scenario ID | Error Condition | Expected Error Message | HTTP Status |
|-------------|-----------------|------------------------|-------------|
| ERR-001 | 商品不存在 | "Product not found" | 404 |
| ERR-002 | 库存不足 | "Insufficient stock" | 400 |
| ERR-003 | 数量超过限制 | "Quantity limit exceeded" | 400 |
| ERR-004 | 用户未登录 | "Authentication required" | 401 |

---

# Section 4: Test Data Sets

## 4.1 Valid Test Data
| Test Data ID | Description | Test Data Object |
|--------------|-------------|------------------|
| VALID-001 | 标准商品 | \`\`\`json { "productId": "PROD-001", "quantity": 2 } \`\`\` |
| VALID-002 | 最大数量 | \`\`\`json { "productId": "PROD-001", "quantity": 99 } \`\`\` |

## 4.2 Invalid Test Data
| Test Data ID | Description | Test Data Object | Expected Error |
|--------------|-------------|------------------|----------------|
| INVALID-001 | 零数量 | \`\`\`json { "productId": "PROD-001", "quantity": 0 } \`\`\` | "Quantity must be at least 1" |
| INVALID-002 | 负数 | \`\`\`json { "productId": "PROD-001", "quantity": -5 } \`\`\` | "Invalid quantity" |

---

# Section 5: Coverage Matrix

## 5.1 Code Coverage Targets
| File | Functions/Methods | Test Cases Covering | Estimated Coverage |
|------|-------------------|---------------------|-------------------|
| src/cart.js | addItem() | TC_FEAT001_001, TC_FEAT001_002 | 95% |
| src/inventory.js | checkStock() | TC_FEAT001_001 | 90% |

---

# Section 6: Execution Instructions

## 6.1 Recommended Execution Order
1. TC_FEAT001_001 - 验证正常功能
2. TC_FEAT001_002 - 验证错误处理
3. Section 3.1 边界测试
4. Section 3.2 错误场景

## 6.2 Environment Setup
\`\`\`bash
npm test -- src/cart.test.js
\`\`\`

---

# Section 7: Machine-Readable Test Cases (JSON)

\`\`\`json
[
  {
    "case_id": "TC_FEAT001_001",
    "feature_id": "FEAT-001",
    "title": "验证成功添加商品到购物车",
    "test_type": "Functional",
    "precondition": "用户已登录，商品有库存",
    "steps": [
      "调用 addItem({ productId: 'PROD-001', quantity: 2 })",
      "检查返回值",
      "验证购物车状态更新",
      "检查库存扣减"
    ],
    "expected": "返回 { success: true, cartItemId: 'CI-123' }",
    "test_data": { "productId": "PROD-001", "quantity": 2 },
    "automation_type": "auto",
    "priority": "P0",
    "code_reference": "src/cart.js:45-67"
  },
  {
    "case_id": "TC_FEAT001_002",
    "feature_id": "FEAT-001",
    "title": "验证添加商品时库存不足",
    "test_type": "Functional",
    "precondition": "商品库存为 1",
    "steps": [
      "调用 addItem({ productId: 'PROD-002', quantity: 5 })",
      "检查返回值"
    ],
    "expected": "返回 { success: false, error: 'Insufficient stock' }",
    "test_data": { "productId": "PROD-002", "quantity": 5 },
    "automation_type": "auto",
    "priority": "P0",
    "code_reference": "src/cart.js:68-75"
  }
]
\`\`\``;
}

// 创建模拟代码改动
function createMockCodeDiff() {
  return `diff --git a/src/cart.js b/src/cart.js
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/cart.js
@@ -0,0 +1,85 @@
+/**
+ * Shopping Cart Module
+ * 
+ * Features:
+ * - Add item to cart
+ * - Remove item from cart
+ * - Calculate total
+ * - Check and reserve inventory
+ */
+
+const { checkStock, reserveItem } = require('./inventory');
+
+class ShoppingCart {
+  constructor(userId) {
+    this.userId = userId;
+    this.items = [];
+  }
+
+  /**
+   * Add item to cart with stock validation
+   * @param {Object} item - { productId, quantity }
+   * @returns {Object} - { success, cartItemId, error }
+   */
+  async addItem(item) {
+    // Validate input
+    if (!item.productId || !item.quantity) {
+      return { success: false, error: 'Missing required fields' };
+    }
+
+    if (item.quantity < 1) {
+      return { success: false, error: 'Quantity must be at least 1' };
+    }
+
+    if (item.quantity > 99) {
+      return { success: false, error: 'Quantity limit exceeded' };
+    }
+
+    // Check stock availability
+    const stockResult = await checkStock(item.productId);
+    if (!stockResult.available) {
+      return { success: false, error: 'Product not found' };
+    }
+
+    if (stockResult.quantity < item.quantity) {
+      return { 
+        success: false, 
+        error: 'Insufficient stock',
+        available: stockResult.quantity
+      };
+    }
+
+    // Reserve inventory
+    const reserved = await reserveItem(item.productId, item.quantity);
+    if (!reserved) {
+      return { success: false, error: 'Failed to reserve item' };
+    }
+
+    // Add to cart
+    const cartItem = {
+      id: \`CI-\${Date.now()}\`,
+      productId: item.productId,
+      quantity: item.quantity,
+      addedAt: new Date().toISOString()
+    };
+
+    this.items.push(cartItem);
+
+    return { 
+      success: true, 
+      cartItemId: cartItem.id,
+      items: this.items.length
+    };
+  }
+
+  calculateTotal() {
+    return this.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
+  }
+}
+
+module.exports = { ShoppingCart };
\ No newline at end of file

diff --git a/src/inventory.js b/src/inventory.js
index def7890..ghi0123 100644
--- a/src/inventory.js
+++ b/src/inventory.js
@@ -15,6 +15,28 @@ async function getProduct(productId) {
   return db.query('SELECT * FROM products WHERE id = ?', [productId]);
 }
 
+/**
+ * Check stock availability
+ * @returns {Object} - { available, quantity }
+ */
+async function checkStock(productId) {
+  const product = await getProduct(productId);
+  if (!product) return { available: false };
+  return { available: true, quantity: product.stock_quantity };
+}
+
+/**
+ * Reserve inventory item
+ */
+async function reserveItem(productId, quantity) {
+  const result = await db.query(
+    'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
+    [quantity, productId, quantity]
+  );
+  return result.affectedRows > 0;
+}
+
 module.exports = {
   getInventory,
-  getProduct
+  getProduct,
+  checkStock,
+  reserveItem
 };`;
}

// 主函数
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║   Advanced Test Case Generation - Demo                        ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // 准备输出目录
  const outputDir = path.join(__dirname, '../../output/demo-test-generation');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 创建模拟的 code.diff
  const codeDiffPath = path.join(outputDir, 'code.diff');
  const codeDiff = createMockCodeDiff();
  fs.writeFileSync(codeDiffPath, codeDiff);
  console.log('✓ Created mock code.diff');
  console.log(`  Location: ${codeDiffPath}`);
  console.log(`  Size: ${codeDiff.length} bytes\n`);

  // 创建 TestCaseGenerator 实例
  const tcGen = new TestCaseGenerator(mockLlmCall, {
    verbose: true,
    outputDir: outputDir,
  });

  // 运行高级测试用例生成
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│  Running: generateAdvanced()                                │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  const result = await tcGen.generateAdvanced();

  // 输出结果
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  Generation Result                                          │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log(`  Skipped: ${result.skipped}`);
  console.log(`  Case Count: ${result.caseCount}`);
  console.log(`  Features Identified: ${result.features.length}`);
  console.log(`  Output Path: ${result.path || 'N/A'}`);
  
  if (result.features.length > 0) {
    console.log('\n  Features:');
    result.features.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
  }

  // 显示生成的内容预览
  if (result.path && fs.existsSync(result.path)) {
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│  Generated Document Preview                                 │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    
    const content = fs.readFileSync(result.path, 'utf-8');
    const lines = content.split('\n').slice(0, 50);
    console.log(lines.join('\n'));
    console.log('\n  ... (truncated for display)');
    console.log(`\n  Full document: ${result.path}`);

    // 解析测试用例
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│  Parsed Test Cases (JSON)                                   │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    
    const testCases = tcGen.parseDetailedTestCases(result.path);
    console.log(`  Found ${testCases.length} test cases:`);
    
    testCases.forEach((tc, i) => {
      console.log(`\n  ${i + 1}. ${tc.case_id}: ${tc.title}`);
      console.log(`     Priority: ${tc.priority}, Type: ${tc.test_type}`);
      console.log(`     Code Ref: ${tc.code_reference || 'N/A'}`);
    });
  }

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║   Demo Complete!                                              ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('\n  Generated files:');
  console.log(`  1. ${codeDiffPath}`);
  console.log(`  2. ${result.path || 'test-cases-detailed.md'}`);
  console.log('\n  Next step: TesterAgent will read this document and execute tests.');
}

// 运行
main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});