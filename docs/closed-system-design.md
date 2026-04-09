# WorkFlowAgent 封闭系统设计方案

> **决策**：彻底走向封闭方案，用系统级强制替代 LLM 自觉。

---

## 1. 为什么需要封闭系统？

### 1.1 问题识别

| 问题 | 症状 | 根本原因 |
|------|------|---------|
| 触发不确定性 | 有时走工作流，有时直接回答 | 依赖 LLM 读取 AGENTS.md 后"自觉"执行 |
| 流程不可控 | 用户可直接让 LLM 改代码 | 没有系统级的修改入口控制 |
| 完成定义模糊 | LLM 觉得"做完了" vs 实际完成 | 缺乏客观的质量门禁 |

### 1.2 开放系统的幻觉

WorkFlowAgent 号称"开放式人机协作"，但实际：
- 用户无法干预工作流执行过程（黑盒）
- 用户只能触发，不能参与决策
- 结果：既无开放的灵活性，也无封闭的确定性

**结论**：承认现实，走向真正封闭。

---

## 2. 封闭系统架构

### 2.1 三层防线

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: IDE 层拦截 (Shell Hook)                           │
│  - Claude Code: wf-hook.sh (已存在)                         │
│  - 其他 IDE: 待实现                                           │
│  - 职责：在用户输入到达 LLM 前，强制记录并注入指令              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: 工作流引擎 (Node.js)                              │
│  - 7-stage 流水线（ANALYSE → DEPLOY）                       │
│  - mandatory stage transitions（不可跳过）                   │
│  - Socratic challenge 自动触发                              │
│  - 职责：定义和执行标准化流程                                 │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Git 门禁 (Hard Gate)                              │
│  - pre-commit hook（强制执行）                              │
│  - total-gate.js（门禁检查）                                │
│  - 职责：代码提交前的最终质量关卡                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 强制流程

```
用户输入 /wf <requirement>
         ↓
[Shell Hook 拦截] → 自动记录 input-received
         ↓
[IDE Agent 执行]  → 强制调用 workflow-stage (ANALYSE)
         ↓
[Stage 1] ANALYSE  → IDE 工具分析 → stage-complete
         ↓
[Stage 2] ARCHITECT → 设计方案 → stage-complete
         ↓
     ... (PLAN → DEVELOP → TEST → REVIEW) ...
         ↓
[Stage 7] DEPLOY   → 部署/交付 → session-summary
         ↓
[Git Commit]       → pre-commit hook → total-gate.js
         ↓
    门禁通过？是 → 提交成功
         ↓
    门禁失败？否 → 阻断提交，要求走工作流
```

---

## 3. 关键组件

### 3.1 total-gate.js（门禁脚本）

位置：`workflow/scripts/total-gate.js`

职责：
- 检查 `output/workflow-progress.log` 是否存在
- 验证最近 session 是否完整（7 stage 全完成）
- 检查 session 是否在有效期内（默认 24h）
- 不通过则返回非 0 退出码，阻断 git commit

使用：
```bash
# 手动检查
node workflow/scripts/total-gate.js

# Git hook 调用
node workflow/scripts/total-gate.js --mode pre-commit
```

### 3.2 install-git-hooks.js（Hook 安装器）

位置：`workflow/tools/install-git-hooks.js`

职责：
- 自动安装 pre-commit hook
- 提供 `--force` 覆盖已有 hook
- 提供 `--uninstall` 卸载

使用：
```bash
# 安装
node workflow/tools/install-git-hooks.js

# 强制覆盖
node workflow/tools/install-git-hooks.js --force

# 卸载
node workflow/tools/install-git-hooks.js --uninstall
```

### 3.3 config-schema.js（配置 Schema）

位置：`workflow/core/config-schema.js`

新增配置：
```javascript
{
  systemMode: 'closed',  // 默认封闭模式
  gitEnforcement: {
    enabled: true,
    preCommitHook: true,
    autoInstall: true
  },
  gateChecks: {
    sessionValidityHours: 24,
    requireCompleteArtifact: true,
    evidenceCheck: true
  }
}
```

---

## 4. 实施路径

### Phase 1: Git 门禁（已完成 ✅）

- [x] `total-gate.js` - 统一门禁检查脚本
- [x] `install-git-hooks.js` - Hook 安装器
- [x] `init-project.js` 集成 - 自动安装 hook

### Phase 2: IDE Hook 扩展（待实施）

- [ ] Cursor IDE Hook
- [ ] VS Code Extension Hook
- [ ] Windsurf Hook

### Phase 3: CI/CD 兜底（待实施）

- [ ] 服务端 pre-receive hook
- [ ] CI pipeline gate check

---

## 5. 使用方式

### 5.1 初始化项目（自动启用封闭系统）

```bash
node workflow/init-project.js
```

这会：
1. 安装 Git pre-commit hook
2. 生成 AGENTS.md
3. 安装 IDE Agent 定义

### 5.2 日常工作流

```bash
# 用户发送
/wf 实现用户登录功能

# 系统自动执行 7-stage，用户只需观察进度

# 最后 git commit
# → pre-commit hook 自动检查
# → 通过则提交成功
```

### 5.3 紧急情况（绕过门禁）

```bash
# 如果有紧急情况需要提交
# 1. 先走工作流完成修改
# 2. 或联系管理员临时禁用 hook

# 不推荐：
git commit --no-verify  # 会绕过所有 hooks
```

---

## 6. 与文章方案的对比

| 特性 | 文章方案 | WorkFlowAgent 封闭方案 |
|------|---------|----------------------|
| 控制入口 | PM Agent 路由 | Shell Hook + Node.js Bridge |
| 质量保证 | Scripts 阶段门禁 | 7-stage + total-gate.js |
| 完成定义 | Scripts 客观判定 | workflow-progress.log 完整性检查 |
| 用户交互 | 间接（通过 PM）| 极简（仅触发，不干预） |
| 适用场景 | 内部自动化工具 | 团队标准化开发流程 |

---

## 7. 一句话总结

> **封闭系统不是限制，而是确定性。** 通过三层防线（IDE Hook → 工作流引擎 → Git 门禁），把"希望 LLM 自觉"变成"系统强制执行"，确保每次代码提交都有完整的工作流记录和质量保障。
