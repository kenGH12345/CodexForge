# Skill 创建最佳实践

## 自检清单

### 核心质量
- [ ] description 具体，包含关键词和触发场景
- [ ] description 使用第三人称（"Processes…" 不是 "I can help…"）
- [ ] SKILL.md 正文 < 200 行（可接受上限 500 行）
- [ ] 详细内容拆分到 references/（如需要）
- [ ] 无时效性信息（日期、版本号等）
- [ ] 全文术语一致
- [ ] 示例具体（非抽象）
- [ ] references/ 引用深度 = 1（不嵌套）
- [ ] 渐进式披露合理

### 脚本和代码
- [ ] 脚本解决确定性问题（不丢给 Agent 猜）
- [ ] 错误处理明确且有用
- [ ] 无"魔法常量"（所有值有据可查）
- [ ] 依赖包已列出（requirements.txt / package.json）
- [ ] 路径使用正斜杠（`scripts/helper.py` 非 `scripts\helper.py`）
- [ ] 关键操作有验证/反馈循环

### 测试
- [ ] 至少 3 个 Eval 场景
- [ ] 在目标模型上测试过
- [ ] 真实使用场景验证

---

## 渐进式披露模式

### 模式 1：高层指南 + 引用

```markdown
# PDF Processing

## Quick start
Extract text with pdfplumber:
[代码示例]

## Advanced features
**Form filling**: See [FORMS.md](references/FORMS.md)
**API reference**: See [REFERENCE.md](references/REFERENCE.md)
```

### 模式 2：按领域组织

```
bigquery-skill/
├── SKILL.md (概览 + 导航)
└── references/
    ├── finance.md
    ├── sales.md
    └── product.md
```

### 模式 3：条件详情

```markdown
# DOCX Processing

## Creating documents
Use docx-js. See [DOCX-JS.md](references/DOCX-JS.md).

## Editing documents
For simple edits, modify XML directly.
**For tracked changes**: See [REDLINING.md](references/REDLINING.md)
```

---

## 反模式

| 反模式 | 问题 | 修复 |
|--------|------|------|
| 过于冗长的背景说明 | Agent 已经知道 | 删掉，只写它不知道的 |
| 提供太多选项 | Agent 不知道选哪个 | 给一个默认方案 |
| Windows 风格路径 | 跨平台兼容差 | 统一用正斜杠 |
| 嵌套引用 | Agent 加载链过长 | 所有引用从 SKILL.md 直接链接 |
| 模糊命名 | 难以发现 | 用动名词 + 领域词 |
| 时效性内容 | 过期后误导 | 用 `<details>` 标签折叠旧版说明 |

---

## description 示例库

| 场景 | description |
|------|------------|
| PDF 处理 | Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction. |
| 代码审查 | Review code for bugs, security issues, and best practices. Use when reviewing pull requests, checking code quality, or performing security audits on code changes. |
| Azure 部署 | Build and deploy Azure infrastructure using Bicep templates. Use when creating Azure resources, managing environments, or writing infrastructure-as-code. |
| 数据分析 | Analyze Excel spreadsheets, create pivot tables, generate charts. Use when analyzing tabular data, .xlsx files, or generating data reports. |

---

## Skill 类型与自由度对照

| Skill 类型 | 自由度 | SKILL.md 侧重 | scripts/ 侧重 |
|-----------|--------|--------------|--------------|
| 执行型（pdf-editor） | 低 | 极简，指向脚本 | 核心逻辑全在此 |
| 流程型（deploy-tool） | 中 | 分支判断、异常处理 | 确定性步骤 |
| 规范型（code-style） | 高 | 标准和约束（核心价值） | 验证脚本 |
| 认知型（architecture-guide） | 高 | 设计哲学（核心价值） | 几乎不需要 |
