## 代码图谱（517 个符号，13292 条调用边）

> 生成时间：2026-03-15
> 查询命令：`/graph search <关键词>` | `/graph file <路径>` | `/graph calls <符号名>`

### agents/analyst-agent.js
- `class` **AnalystAgent** → 6 次调用 // 职责：仅专注于澄清用户"想要什么"，不涉及实现方式
- `method` **constructor**(llmCall, hookEmitter) → 5 次调用
- `method` **buildPrompt**(inputContent, expContext = null) → 5 次调用
- `method` **parseResponse**(llmResponse) → 5 次调用

### agents/architect-agent.js
- `class` **ArchitectAgent** → 6 次调用 // 职责：专注于系统设计：组件、接口、数据流
- `method` **constructor**(llmCall, hookEmitter) → 5 次调用
- `method` **buildPrompt**(inputContent, expContext = null) → 5 次调用
- `method` **parseResponse**(llmResponse) → 5 次调用

### agents/base-agent.js
- `class` **BaseAgent** → 10 次调用
- `method` **run**(inputFilePath = null, rawInput = null, e) → 9 次调用
- `method` **buildPrompt**(inputContent, expContext = null) → 9 次调用
- `method` **parseResponse**(llmResponse) → 9 次调用
- `method` **assertAllowed**(action) → 9 次调用
- `method` **_readInput**(inputFilePath, rawInput) → 9 次调用
- `method` **_writeOutput**(content) → 9 次调用

### agents/developer-agent.js
- `class` **DeveloperAgent** → 6 次调用 // 职责：严格遵循架构文档进行开发
- `method` **constructor**(llmCall, hookEmitter) → 5 次调用
- `method` **buildPrompt**(inputContent, expContext = null) → 5 次调用
- `method` **parseResponse**(llmResponse) → 5 次调用

### agents/tester-agent.js
- `class` **TesterAgent** → 7 次调用
- `method` **constructor**(llmCall, hookEmitter) → 6 次调用
- `method` **buildPrompt**(inputContent, expContext = null) → 6 次调用
- `method` **parseResponse**(llmResponse) → 6 次调用
- `function` **missingSections**(requiredSections.filter(s)) → 6 次调用 // 校验报告是否包含所有必需章节

### commands/command-router.js
- `function` **registerCommand**(name, description, handler) → 31 次调用 // 注册命令处理器
- `function` **dispatch**(input, context = {}) → 31 次调用 // 解析并分发斜杠命令字符串
- `function` **loadGraph** → 31 次调用
- `function` **trendIcon**(t) → 31 次调用

### core/architecture-review-agent.js
- `function` **buildArchReviewPrompt**(checklist, archContent, requirementText) → 30 次调用 // 使用 evaluationGuide 为 LLM 提供每项精确的评审指令
- `function` **buildArchFixPrompt**(originalContent, failures) → 30 次调用 // 合并修复结果，避免 LLM 输出截断
- `function` **applyArchPatches**(originalContent, patchResponse) → 30 次调用 // 查找每个 "### PATCH: <标题>" 块并替换或追加内容
- `function` **extractJsonArray**(response) → 30 次调用
- `class` **ArchitectureReviewAgent** → 30 次调用
- `method` **review**(archPath, requirementPath = null) → 30 次调用
- `function` **failures**(reviewResults.filter(r)) → 30 次调用
- `function` **passes**(reviewResults.filter(r)) → 30 次调用
- `function` **nas**(reviewResults.filter(r)) → 30 次调用
- `function` **highFailures**(failures.filter(f)) → 30 次调用
- `function` **item**(this.checklist.find(c)) → 30 次调用
- `function` **finalFailures**(lastReviewResults.filter(r)) → 31 次调用
- `function` **finalMissing**(lastReviewResults.filter(r)) → 30 次调用
- `function` **riskNotes**(allFailed.map(f)) → 30 次调用
- `method` **_runReview**(archContent, requirementText) → 30 次调用
- `function` **resultMap**(new Map(parsed.map(r))) → 30 次调用
- `method` **formatReport**(result) → 30 次调用
- `method` **_emptyResult**(skipReason) → 30 次调用
- `method` **_log**(msg) → 30 次调用

### core/ci-integration.js
- `class` **CIIntegration** → 23 次调用
- `method` **_detectProvider** → 22 次调用
- `method` **_detectRepoSlug** → 22 次调用
- `method` **runLocalPipeline**({ skipLint = false, skipTest = false, sk}) → 22 次调用
- `function` **allPassed**(steps.every(s)) → 23 次调用
- `method` **_runStep**(name, command) → 22 次调用
- `method` **_buildResult**(status, steps, startedAt, message = null) → 22 次调用
- `method` **pollGitHub**({ branch = null, workflowName = null, wa}) → 22 次调用
- `function` **poll** → 22 次调用
- `method` **_mapGitHubStatus**(status, conclusion) → 22 次调用
- `method` **pollGitLab**({ branch = null, wait = false } = {}) → 22 次调用
- `method` **_mapGitLabStatus**(status) → 22 次调用
- `method` **_waitForCompletion**(pollFn) → 22 次调用
- `method` **_httpGet**(url, headers = {}) → 22 次调用
- `function` **req**(lib.request(options, (res))) → 22 次调用
- `method` **_getCurrentBranch** → 22 次调用
- `method` **getSummary**(result) → 22 次调用

### core/clarification-engine.js
- `function` **detectSignals**(text) → 20 次调用 // 快速检测，无需 LLM，作为语义模式的降级方案
- `function` **buildSemanticDetectionPrompt**(text, stageLabel) → 20 次调用 // 理解上下文：配置示例中的 "default" ≠ 未明确的需求
- `function` **parseSemanticSignals**(response) → 20 次调用 // 解析失败时降级为空数组
- `function` **buildRefinementPrompt**(originalContent, signals, stageLabel) → 20 次调用 // 构建精化提示词，指导 Agent 修复检测到的问题
- `class` **SelfCorrectionEngine** → 20 次调用
- `method` **constructor**(llmCall, { maxRounds = 3, verbose = true}) → 20 次调用
- `method` **correct**(content, stageLabel = 'Review') → 20 次调用
- `function` **highSeverityRemaining**(remainingSignals.filter(s)) → 20 次调用
- `method` **_deepInvestigate**(content, highSignals, stageLabel) → 20 次调用
- `method` **_detectSignals**(text, stageLabel) → 20 次调用
- `method` **_log**(msg) → 20 次调用
- `class` **ClarificationEngine** → 20 次调用 // 保留以兼容现有调用方，迁移期间不破坏接口
- `method` **analyse**(proposalText, stageLabel = 'Review') → 20 次调用
- `function` **formatClarificationReport**(result) → 20 次调用 // 将自我修正结果格式化为 Markdown 块，供注入使用

### core/code-graph.js
- `class` **CodeGraph** → 32 次调用
- `method` **build** → 31 次调用
- `method` **search**(query, { kind = null, file = null, limit}) → 31 次调用
- `method` **getFileSymbols**(filePath) → 31 次调用
- `method` **getCallGraph**(symbolName) → 31 次调用
- `method` **toMarkdown**({ maxSymbols = 100 } = {}) → 31 次调用
- `method` **_extractSymbols**(content, relPath, ext) → 31 次调用
- `method` **_addSymbol**(kind, name, file, line, signature = '') → 31 次调用
- `method` **_extractJsSymbols**(lines, file) → 31 次调用
- `method` **_extractCsSymbols**(lines, file) → 31 次调用
- `method` **_extractLuaSymbols**(lines, file) → 31 次调用
- `method` **_extractGoSymbols**(lines, file) → 31 次调用
- `method` **_extractPySymbols**(lines, file) → 31 次调用
- `method` **_extractDartSymbols**(lines, file) → 31 次调用
- `method` **_extractJsDocSummary**(lines, fnLine) → 31 次调用
- `method` **_extractXmlDocSummary**(lines, fnLine) → 31 次调用
- `method` **_extractLuaCommentSummary**(lines, fnLine) → 31 次调用
- `method` **_extractGoDocSummary**(lines, fnLine) → 31 次调用
- `method` **_extractPyDocSummary**(lines, fnLine) → 31 次调用
- `method` **_extractImports**(content, relPath, ext) → 31 次调用
- `method` **_extractCallEdges**(content, relPath, ext) → 31 次调用
- `method` **_findByName**(name) → 31 次调用
