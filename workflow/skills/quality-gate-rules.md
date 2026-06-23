---
name: quality-gate-rules
version: 1.0.0
type: config
description: "门禁规则定义 — GateEngine 数值检查的阈值配置和 LLM 审查时的规则指南"
triggers:
  keywords: [quality, gate, lint, test, pass rate, threshold, CVE, syntax, file size]
  stages: [TEST]
max_tokens: 1200
dependencies: []
---

# Skill: quality-gate-rules

> **Type**: Config Skill
> **Version**: 1.0.0
> **Description**: 定义 WorkFlowAgent 的质量门禁规则。GateEngine 消费阈值配置，LLM 在审查时消费方法论规则。

---

## Rules

### R1: Lint Pass Rate (GateEngine 强制执行)
- **阈值**: ≥ 80%
- **检查方式**: `GateEngine.checkLintPassRate(0.80)` — 运行 `npm run lint` / `npx eslint`，计算通过率
- **阻断条件**: passRate < 0.80 → CRITICAL 阻断，返回 fixInstruction
- **不受 LLM 影响**: 此检查完全由代码执行，不依赖 LLM 推理

### R2: Test Pass Rate (GateEngine 强制执行)
- **阈值**: ≥ 70%
- **检查方式**: `GateEngine.checkTestPassRate(0.70)` — 运行 `npm test` / `npx jest`，计算通过率
- **阻断条件**: passRate < 0.70 → HIGH 阻断
- **不受 LLM 影响**: 此检查完全由代码执行

### R3: Critical CVEs (GateEngine 强制执行)
- **阈值**: 0 个
- **检查方式**: `GateEngine.checkCriticalCves(0)` — 运行 `npm audit` 或 OSV.dev API
- **阻断条件**: CRITICAL CVE count > 0 → CRITICAL 阻断
- **不受 LLM 影响**: 此检查完全由代码执行

### R4: Syntax Validity (GateEngine 强制执行)
- **检查方式**: `GateEngine.checkSyntaxValidity(files)` — `node -c <file>` 逐文件验证
- **阻断条件**: 任意文件有语法错误 → CRITICAL 阻断
- **不受 LLM 影响**: 此检查完全由代码执行

### R5: File Size Violation (GateEngine 强制执行)
- **阈值**: ≤ 900 行
- **检查方式**: `GateEngine.checkFileSizeViolation(900)` — 检查修改文件行数
- **阻断条件**: 文件 > 900 行 → HIGH 阻断（建议拆分）
- **不受 LLM 影响**: 此检查完全由代码执行

---

## Best Practices

### BP1: 门禁分层
- **Pre-stage gate**: 进入阶段前检查（依赖完整性、配置有效性）
- **Post-stage gate**: 阶段完成后检查（产物质量、lint/test 通过率）
- **Final gate**: 工作流结束前检查（所有门禁汇总）

### BP2: LLM 审查时参考规则
LLM 在执行代码审查时，除了依赖自身的判断力，还应主动检查：
1. 修改的代码是否可能触发 lint 问题？
2. 是否有明显的安全漏洞（SQL 注入、XSS、硬编码密钥）？
3. 是否有 N+1 查询或内存泄漏？
4. 错误处理是否完整？

---

## Anti-Patterns

### AP1: 不要绕过门禁
- 不要因为"这个错误不重要"就跳过 lint fix
- 不要因为"测试已经跑过了"就跳过 test pass rate 检查

### AP2: 不要把规则知识硬编码
- 门禁规则应在此 Skill 中定义，不应在 GateEngine 代码中硬编码
- 阈值变更时只需修改此文件，无需改代码

---

## SOP

### GateEngine 执行流程
```
1. parseConfig() → 读取 workflow.config.js 获取阈值
2. runAllChecks() → 并行执行 5 个检查
3. aggregateResults() → 汇总 GateReport
4. 决策:
   - blockedBy 非空 → 阻断，返回 fixInstruction
   - warnings 非空 → 不阻断，记录警告
   - 全部 PASS → 继续
```

### LLM 审查时使用流程
```
1. 加载本 Skill (quality-gate-rules.md)
2. 理解各门禁的阈值和检查项
3. 在代码审查中主动检查是否可能触发门禁
4. 在审查报告中标注预测的门禁结果
```
