/**
 * Task Board — 增强版任务看板
 * 
 * 职责：
 * - 从阶段历史升级为任务看板（类似 Jira/Trello）
 * - 支持子任务、优先级、状态流转
 * - 与 PM Agent 和 Gate Controller 集成
 * 
 * 文章对应：Task Board 支持多任务并发跟踪和进度可视化
 * 
 * @module workflow/tools/task-board
 */

'use strict';

const fs = require('fs');
const path = require('path');

class TaskBoard {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.boardPath = path.join(projectRoot, '.workflow', 'task-board.json');
    this.historyPath = path.join(projectRoot, '.workflow', 'task-history.jsonl');
  }

  /**
   * 初始化看板
   * @param {string} sessionId - Session ID
   * @param {string} requirement - 需求描述
   */
  init(sessionId, requirement) {
    const board = {
      version: '2.0',
      sessionId,
      requirement: requirement.slice(0, 200), // 截断
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      columns: [
        { id: 'backlog', name: '待办', tasks: [] },
        { id: 'in_progress', name: '进行中', tasks: [] },
        { id: 'review', name: '待评审', tasks: [] },
        { id: 'done', name: '已完成', tasks: [] }
      ],
      // 7-stage 映射为任务
      stages: [
        { 
          id: 'ANALYSE', 
          name: '需求分析', 
          status: 'backlog',
          priority: 'high',
          assignee: 'analyst-agent',
          subtasks: []
        },
        { 
          id: 'ARCHITECT', 
          name: '架构设计', 
          status: 'backlog',
          priority: 'high', 
          assignee: 'architect-agent',
          subtasks: []
        },
        { 
          id: 'PLAN', 
          name: '执行规划', 
          status: 'backlog',
          priority: 'medium',
          assignee: 'planner-agent',
          subtasks: []
        },
        { 
          id: 'DEVELOP', 
          name: '开发实现', 
          status: 'backlog',
          priority: 'high',
          assignee: 'developer-agent',
          subtasks: [],
          blockedBy: ['PRE-DEVELOP-GATE'] // Gate 检查
        },
        { 
          id: 'TEST', 
          name: '测试验证', 
          status: 'backlog',
          priority: 'high',
          assignee: 'tester-agent',
          subtasks: []
        },
        { 
          id: 'REVIEW', 
          name: '代码评审', 
          status: 'backlog',
          priority: 'medium',
          assignee: 'reviewer-agent',
          subtasks: []
        },
        { 
          id: 'DEPLOY', 
          name: '部署交付', 
          status: 'backlog',
          priority: 'medium',
          assignee: 'deploy-agent',
          subtasks: [],
          blockedBy: ['PRE-DEPLOY-GATE']
        }
      ],
      gates: [
        { id: 'PRE-DEVELOP-GATE', name: '开发前检查', status: 'pending' },
        { id: 'PRE-DEPLOY-GATE', name: '部署前检查', status: 'pending' }
      ],
      metrics: {
        totalTasks: 7,
        completedTasks: 0,
        completionRate: 0
      }
    };

    this._saveBoard(board);
    this._logEvent('board_init', { sessionId, requirement });

    return board;
  }

  /**
   * 更新 Stage 状态
   * @param {string} stageId - Stage ID (e.g., 'ANALYSE')
   * @param {string} status - 新状态 (backlog|in_progress|review|done)
   * @param {Object} metadata - 额外信息
   */
  updateStage(stageId, status, metadata = {}) {
    const board = this._loadBoard();
    if (!board) return null;

    const stage = board.stages.find(s => s.id === stageId);
    if (!stage) return null;

    const oldStatus = stage.status;
    stage.status = status;
    stage.updatedAt = new Date().toISOString();
    
    // 更新子任务
    if (metadata.subtasks) {
      stage.subtasks = metadata.subtasks;
    }

    // 更新产出物链接
    if (metadata.artifact) {
      stage.artifact = metadata.artifact;
    }

    // 检查 Gate 阻塞
    if (status === 'in_progress' && stage.blockedBy) {
      const blocked = stage.blockedBy.some(gateId => {
        const gate = board.gates.find(g => g.id === gateId);
        return gate && gate.status !== 'passed';
      });
      if (blocked) {
        stage.blocked = true;
        stage.blockedReason = '等待 Gate 检查通过';
      }
    }

    board.updatedAt = new Date().toISOString();
    this._saveBoard(board);
    this._logEvent('stage_update', { stageId, oldStatus, newStatus: status });

    // 更新指标
    this._updateMetrics(board);

    return stage;
  }

  /**
   * 更新 Gate 状态
   * @param {string} gateId - Gate ID
   * @param {string} status - pending|passed|failed
   * @param {Object} result - 检查结果
   */
  updateGate(gateId, status, result = {}) {
    const board = this._loadBoard();
    if (!board) return null;

    const gate = board.gates.find(g => g.id === gateId);
    if (!gate) return null;

    gate.status = status;
    gate.result = result;
    gate.updatedAt = new Date().toISOString();

    // 如果 Gate 通过，解除阻塞
    if (status === 'passed') {
      board.stages.forEach(stage => {
        if (stage.blockedBy && stage.blockedBy.includes(gateId)) {
          stage.blocked = false;
          stage.blockedReason = null;
        }
      });
    }

    board.updatedAt = new Date().toISOString();
    this._saveBoard(board);
    this._logEvent('gate_update', { gateId, status });

    return gate;
  }

  /**
   * 添加子任务
   * @param {string} stageId - Stage ID
   * @param {string} title - 子任务标题
   * @param {Object} options - 选项
   */
  addSubtask(stageId, title, options = {}) {
    const board = this._loadBoard();
    if (!board) return null;

    const stage = board.stages.find(s => s.id === stageId);
    if (!stage) return null;

    const subtask = {
      id: `${stageId}-${Date.now()}`,
      title,
      status: options.status || 'backlog',
      priority: options.priority || 'medium',
      createdAt: new Date().toISOString()
    };

    stage.subtasks.push(subtask);
    board.updatedAt = new Date().toISOString();
    this._saveBoard(board);

    return subtask;
  }

  /**
   * 获取看板状态（用于 /status 命令）
   */
  getStatus() {
    const board = this._loadBoard();
    if (!board) {
      return { initialized: false };
    }

    return {
      initialized: true,
      sessionId: board.sessionId,
      requirement: board.requirement,
      stages: board.stages.map(s => ({
        id: s.id,
        name: s.name,
        status: s.status,
        blocked: s.blocked || false,
        blockedReason: s.blockedReason || null,
        subtaskCount: s.subtasks ? s.subtasks.length : 0,
        completedSubtasks: s.subtasks ? s.subtasks.filter(st => st.status === 'done').length : 0
      })),
      gates: board.gates.map(g => ({
        id: g.id,
        name: g.name,
        status: g.status
      })),
      metrics: board.metrics
    };
  }

  /**
   * 生成看板报告（Markdown）
   */
  generateReport() {
    const board = this._loadBoard();
    if (!board) return '看板尚未初始化';

    const lines = [
      '# 📊 Task Board 报告',
      '',
      `**Session**: ${board.sessionId}`,
      `**需求**: ${board.requirement}`,
      `**更新时间**: ${board.updatedAt}`,
      '',
      '## 📈 进度概览',
      ''
    ];

    // 进度条
    const completed = board.stages.filter(s => s.status === 'done').length;
    const total = board.stages.length;
    const progress = Math.round((completed / total) * 100);
    
    lines.push(`\`\`\``);
    lines.push(`[${'█'.repeat(progress / 10)}${'░'.repeat(10 - progress / 10)}] ${progress}%`);
    lines.push(`已完成: ${completed}/${total} 个阶段`);
    lines.push(`\`\`\``);
    lines.push('');

    // 各阶段状态
    lines.push('## 🎯 阶段详情', '');
    for (const stage of board.stages) {
      const statusIcon = this._getStatusIcon(stage.status);
      const blockedIcon = stage.blocked ? '🔒' : '';
      lines.push(`### ${statusIcon} ${blockedIcon} ${stage.name} (${stage.id})`);
      lines.push(`- **状态**: ${stage.status}`);
      lines.push(`- **负责人**: ${stage.assignee}`);
      if (stage.blocked) {
        lines.push(`- **阻塞原因**: ${stage.blockedReason}`);
      }
      if (stage.subtasks && stage.subtasks.length > 0) {
        lines.push(`- **子任务**: ${stage.subtasks.filter(st => st.status === 'done').length}/${stage.subtasks.length} 完成`);
      }
      if (stage.artifact) {
        lines.push(`- **产出物**: ${stage.artifact}`);
      }
      lines.push('');
    }

    // Gate 状态
    lines.push('## 🚪 Gate 状态', '');
    for (const gate of board.gates) {
      const icon = gate.status === 'passed' ? '✅' : gate.status === 'failed' ? '❌' : '⏳';
      lines.push(`- ${icon} ${gate.name} (${gate.id}): ${gate.status}`);
    }
    lines.push('');

    return lines.join('\n');
  }

  /**
   * 列出历史任务（跨 session）
   */
  listHistory(limit = 10) {
    if (!fs.existsSync(this.historyPath)) {
      return [];
    }

    const lines = fs.readFileSync(this.historyPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(l => l)
      .map(l => JSON.parse(l));

    return lines.slice(-limit);
  }

  // ============== Private Methods ==============

  _loadBoard() {
    if (!fs.existsSync(this.boardPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(this.boardPath, 'utf-8'));
  }

  _saveBoard(board) {
    const dir = path.dirname(this.boardPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.boardPath, JSON.stringify(board, null, 2));
  }

  _logEvent(event, data) {
    const dir = path.dirname(this.historyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...data
    };
    
    fs.appendFileSync(this.historyPath, JSON.stringify(entry) + '\n');
  }

  _updateMetrics(board) {
    const completed = board.stages.filter(s => s.status === 'done').length;
    board.metrics.completedTasks = completed;
    board.metrics.completionRate = Math.round((completed / board.stages.length) * 100);
  }

  _getStatusIcon(status) {
    const icons = {
      backlog: '⏸️',
      in_progress: '🔄',
      review: '👀',
      done: '✅'
    };
    return icons[status] || '⏸️';
  }
}

// CLI 入口
function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const projectRoot = process.cwd();
  const board = new TaskBoard(projectRoot);

  switch (command) {
    case 'init':
      const sessionId = args[1] || `wf-${Date.now()}`;
      const requirement = args[2] || '未指定需求';
      const result = board.init(sessionId, requirement);
      console.log(`✅ Task Board 初始化成功`);
      console.log(`   Session: ${result.sessionId}`);
      console.log(`   阶段: ${result.stages.length} 个`);
      break;

    case 'status':
      const status = board.getStatus();
      console.log(JSON.stringify(status, null, 2));
      break;

    case 'report':
      const report = board.generateReport();
      const reportPath = path.join(projectRoot, 'output', 'task-board-report.md');
      fs.writeFileSync(reportPath, report);
      console.log(`✅ 报告已生成: ${reportPath}`);
      break;

    case 'history':
      const history = board.listHistory(parseInt(args[1]) || 10);
      console.log(JSON.stringify(history, null, 2));
      break;

    default:
      console.log('Usage: node task-board.js <command> [options]');
      console.log('Commands:');
      console.log('  init <sessionId> <requirement>  - 初始化看板');
      console.log('  status                          - 获取当前状态');
      console.log('  report                          - 生成 Markdown 报告');
      console.log('  history [limit]                 - 查看历史记录');
  }
}

// 如果直接运行
if (require.main === module) {
  main();
}

module.exports = { TaskBoard };
