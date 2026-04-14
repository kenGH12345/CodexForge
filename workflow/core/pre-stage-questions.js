/**
 * Pre-Stage Questions — Shared Socratic question generator
 *
 * Extracted from ide-workflow-bridge.js _generatePreStageQuestions().
 * Provides identical behavior for both IDE Agent mode and Node Orchestrator mode.
 *
 * Design principles (from first principles, not templates):
 *   1. Self-Ask (Press et al. 2022): decompose task into sub-questions BEFORE acting
 *   2. ReAct (Yao et al. 2022): Reason → Act, never Act without prior Reason
 *   3. CoVe (Dhuliawala 2023): generate verification questions → self-answer → revise
 *   4. Anthropic Extended Thinking: <thinking> space for deep reasoning before output
 *
 * @module pre-stage-questions
 */

'use strict';

const VALID_STAGES = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];

function generatePreStageQuestions(stage, requirement) {
  const req = requirement ? requirement.slice(0, 150) : '';
  const reqCtx = req ? `（针对需求："${req}"）` : '';

  const questionsByStage = {
    ANALYSE: [
      `【根因 vs 症状】${reqCtx} 你识别的"根因"是真正的原因，还是症状的描述？请用"因为X导致Y，因为Y导致Z"的因果链验证：你找到的是X还是Z？`,
      `【代码证据】你是否已经用 grep_search/codebase_search 在代码库中找到了问题的实际位置？请列出：具体文件路径 + 行号/函数名。如果还没搜索，现在必须先搜索再写分析。`,
      `【影响范围】${reqCtx} 受影响的代码被哪些其他模块调用或依赖？这次变更是否会破坏上游或下游的现有行为？`,
      `【阶段边界】你的 analysis.md 是在描述"问题是什么"，还是已经在描述"怎么解决"？ANALYSE 阶段只诊断，不开处方。如果你写了解决方案，删掉它。`,
      `【第一性原则】${reqCtx} 你的根因结论是从你实际读到的代码推导出来的，还是从经验/模式匹配猜测的？什么证据可以证伪你的假设？`,
    ],
    ARCHITECT: [
      `【最小化原则】${reqCtx} 这个设计引入了哪些新的抽象层？每个抽象层消除了什么具体的复杂度？能否用更简单的改动达到同样目标？`,
      `【一致性检查】代码库中类似问题是如何解决的？你的设计是否遵循了相同的模式？如果不一致，理由是什么？`,
      `【故障模式】${reqCtx} 你提出的设计在以下情况下会发生什么：网络超时、空值输入、并发访问冲突？这些失败模式是否有处理？`,
      `【调用方验证】新接口/新模块的调用方是谁？你是否验证了调用点的存在，以及你的接口签名与调用方的期望匹配？`,
      `【第一性原则】${reqCtx} 解决 ANALYSE 阶段识别的根因，最小必要的改动是什么？你的架构方案是否与问题规模成比例，还是在解决一个比实际更大的问题？`,
    ],
    PLAN: [
      `【具体性检查】execution-plan.md 中每个任务是否都指定了精确的文件路径？（例如："workflow/core/foo.js 第42行"，而非"foo 模块"）没有文件路径的任务不可执行。`,
      `【依赖顺序】${reqCtx} 哪些任务必须在其他任务完成后才能开始？任务顺序是否正确？并行执行是否会产生冲突？`,
      `【完整性检查】计划是否包含：(1) 如何验证改动生效的步骤，(2) 如果失败如何回滚？这两项不是可选的。`,
      `【范围控制】${reqCtx} 计划中每个任务是否都直接对应 ANALYSE 阶段识别的根因？删除所有"顺便做"但不是修复根因所必需的任务。`,
      `【第一性原则】你现在能按照这个计划一步步执行吗？如果有任何任务描述模糊或需要未知信息，它需要被进一步拆解。`,
    ],
    DEVELOP: [
      `【计划追踪】${reqCtx} 检查 execution-plan.md：列出每个任务 ID 及其状态（已完成/跳过/阻塞）。跳过任务必须有明确理由，不能静默跳过。`,
      `【代码阅读证据】对于你修改的每个文件：你是否先读了现有代码再编辑？描述你修改的现有逻辑是什么，以及你的改动为什么是正确的。`,
      `【回归风险】${reqCtx} 你的改动影响了哪些现有行为？修改函数的调用方是否仍然与新的签名/行为兼容？`,
      `【完整性检查】你的实现是完整的，还是留有 TODO/placeholder 注释？artifact 必须反映代码的实际状态，而非预期状态。`,
      `【第一性原则】${reqCtx} 你的实现是否直接解决了 ANALYSE 阶段识别的根因？还是修复了症状？请从根因追溯到你的改动，验证因果链完整。`,
    ],
    TEST: [
      `【实际执行证据】${reqCtx} 你是否实际运行了测试套件？粘贴真实输出（通过/失败数量、错误信息）。不要描述测试应该做什么——展示它们实际做了什么。`,
      `【失败路径覆盖】你是否测试了失败场景？（无效输入、边界值、并发冲突、网络失败）列出你测试过的失败场景。`,
      `【根因覆盖验证】${reqCtx} 哪个具体的测试用例验证了 ANALYSE 阶段识别的根因已被修复？如果没有测试覆盖根因，你需要添加一个。`,
      `【失败分析】输出中是否有测试失败？如果有：它们是预先存在的（与本次改动无关）还是由本次改动引起的？必须明确记录。`,
      `【第一性原则】${reqCtx} 要对这个修复在生产环境中有效建立信心，最少需要什么证据？你的测试是否提供了这个证据，还是在测试错误的东西？`,
    ],
    REVIEW: [
      `【审查深度】${reqCtx} 列出你在实现中发现的至少 3 个具体问题或风险。如果你发现了零个问题，说明你没有认真审查。`,
      `【需求符合度】实现是否完全满足原始需求："${req || '（见上下文）'}"？列出请求内容与实现内容之间的所有差距。`,
      `【安全与性能】是否有安全影响？（输入验证、权限绕过、数据暴露）是否有性能影响？（N+1 查询、阻塞 I/O、内存泄漏）`,
      `【端到端链路】追踪修复链：根因（ANALYSE）→ 设计决策（ARCHITECT）→ 实现（DEVELOP）→ 测试覆盖（TEST）。链路是否完整且一致？`,
      `【第一性原则】如果你是第一次看这个 PR 的工程师，你会问什么问题？什么会让你拒绝它？现在回答这些问题。`,
    ],
    DEPLOY: [
      `【回滚计划】${reqCtx} 如果这次部署失败，回滚步骤是什么？是否已记录？能否在 5 分钟内执行？`,
      `【部署前检查】(1) 所有测试是否通过？(2) artifact 是否已审查并批准？(3) 是否需要配置变更？(4) 是否有数据库迁移？`,
      `【部署顺序】${reqCtx} 这次变更是否影响多个服务或组件？如果是，正确的部署顺序是什么，以避免破坏依赖关系？`,
      `【可观测性】部署后如何知道是否引发了生产回归？部署后应该监控哪些指标/日志/告警？`,
      `【第一性原则】${reqCtx} 这次部署是可逆的吗？如果不可逆，是什么使它不可逆，这是可接受的吗？如果出错，影响范围是什么？`,
    ],
  };

  const questions = questionsByStage[stage] || [
    `【目标确认】${reqCtx} 这个阶段的具体目标是什么？"完成"是什么样子的？`,
    `【失败模式】这个阶段最可能的失败模式是什么？你如何避免它们？`,
    `【证据要求】你将产出什么证据来证明这个阶段被正确完成了？`,
  ];

  const formattedQuestions = questions.map((q, i) => `Q${i + 1}: ${q}`);

  return {
    mandatory: true,
    enforcement: 'SOFT-STRUCTURED + VERIFIABLE — answer in <thinking>, then write ## 思考摘要 section in artifact',
    instruction: [
      `⚡ PRE-STAGE THINKING REQUIRED (Self-Ask + CoVe pattern):`,
      `在写 artifact 之前，必须在 <thinking> 中按 "Q1: [问题] → A1: [你的回答]" 格式逐条回答以下 ${formattedQuestions.length} 个问题。`,
      `然后在 artifact 末尾写一个 "## 思考摘要" section，格式为：`,
      `  Q1: [问题简述] → A1: [你的回答摘要（1-2句，必须具体引用代码/文件/数据）]`,
      `  Q2: [问题简述] → A2: [你的回答摘要]`,
      `  ...`,
      `stage-complete 会 HARD-REJECT 缺少 ## 思考摘要 section 的 artifact。`,
      `每个回答必须具体（引用实际代码/文件/数据），不接受"已考虑"或"将会处理"这类空洞回答。`,
    ].join(' '),
    questions: formattedQuestions,
    selfAnswerFormat: 'Q{n}: [question summary] → A{n}: [specific answer with evidence, 1-2 sentences]',
    rationale: `这些问题针对 ${stage} 阶段最常见的失误模式（基于 Self-Ask/ReAct/CoVe 方法论）。逐条回答迫使你在提交方案前验证假设。## 思考摘要 section 使思考过程可观测、可验证。`,
  };
}

module.exports = { generatePreStageQuestions, VALID_STAGES };
