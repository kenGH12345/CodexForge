/**
 * PM Agent — 项目经理 Agent
 * 
 * 职责范围（明确边界）：
 * ✅ 任务路由：将需求分发到正确的 Stage
 * ✅ 进度管理：跟踪 7-stage 执行进度，识别阻塞
 * ✅ 资源协调：在 Agents 之间传递上下文
 * ❌ 不做专业判断：不分析技术可行性、不评审代码质量
 * 
 * 文章对应：PM Agent 负责任务分发和进度跟踪（不做技术决策）
 * 
 * @module workflow/agents/pm-agent
 */

'use strict';

const path = require('path');
const fs = require('fs');

class PMAgent {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.progressLogPath = path.join(projectRoot, 'output', 'workflow-progress.log');
    this.devMapPath = path.join(projectRoot, '.workflow', 'dev-map.md');
    this.taskBoardPath = path.join(projectRoot, '.workflow', 'task-board.json');
    
    // 7-stage 定义
    this.stages = [
      { id: 'ANALYSE', name: '需求分析', next: 'ARCHITECT' },
      { id: 'ARCHITECT', name: '架构设计', next: 'PLAN' },
      { id: 'PLAN', name: '执行规划', next: 'DEVELOP' },
      { id: 'DEVELOP', name: '开发实现', next: 'TEST' },
      { id: 'TEST', name: '测试验证', next: 'REVIEW' },
      { id: 'REVIEW', name: '代码评审', next: 'DEPLOY' },
      { id: 'DEPLOY', name: '部署交付', next: null }
    ];
  }

  /**
   * 路由决策：根据当前状态和输入，决定下一步动作
   * @param {Object} context - 当前上下文
   * @returns {Object} 路由决策结果
   */
  route(context) {
    const { currentStage, requirement, sessionId } = context;
    
    // 读取当前 session 进度
    const progress = this._readSessionProgress(sessionId);
    
    // 确定下一个 stage
    const nextStage = this._determineNextStage(currentStage, progress);
    
    // 检查是否需要 Gate 检查
    const needsGate = nextStage && nextStage.id === 'DEVELOP';
    
    return {
      decision: 'PROCEED',
      nextStage: nextStage ? nextStage.id : null,
      nextStageName: nextStage ? nextStage.name : null,
      needsGateCheck: needsGate,
      estimatedProgress: this._calculateProgress(progress),
      routingReason: `Current ${currentStage || 'INIT'} → Next ${nextStage ? nextStage.id : 'COMPLETE'}`
    };
  }

  /**
   * 初始化新 Session
   * @param {string} requirement - 用户需求
   * @returns {Object} Session 初始化结果
   */
  initSession(requirement) {
    const sessionId = `wf-${Date.now()}`;
    const timestamp = new Date().toISOString();
    
    // 创建 session 记录
    const sessionRecord = {
      type: 'session_start',
      session: sessionId,
      timestamp,
      requirement,
      pmAgent: {
        initiated: true,
        routingPlan: this.stages.map(s => s.id)
      }
    };
    
    // 写入日志
    this._appendLog(sessionRecord);
    
    // 初始化 Task Board
    this._initTaskBoard(sessionId, requirement);
    
    return {
      sessionId,
      routingPlan: this.stages.map(s => s.id),
      firstStage: 'ANALYSE'
    };
  }

  /**
   * 推进到下一个 Stage
   * @param {string} sessionId - Session ID
   * @param {string} stage - 当前完成的 Stage
   * @param {Object} summary - Stage 执行摘要
   */
  advanceStage(sessionId, stage, summary) {
    const timestamp = new Date().toISOString();
    
    // 记录 stage 完成
    const stageRecord = {
      type: 'stage_end',
      session: sessionId,
      stage,
      timestamp,
      pmAgent: {
        approved: true,
        completionTime: timestamp
      }
    };
    this._appendLog(stageRecord);
    
    // 更新 Task Board
    this._updateTaskBoard(sessionId, stage, 'completed', summary);
    
    // 确定下一个 stage
    const currentStageIdx = this.stages.findIndex(s => s.id === stage);
    const nextStage = this.stages[currentStageIdx + 1];
    
    if (nextStage) {
      // 记录下一个 stage 开始
      this._appendLog({
        type: 'stage_start',
        session: sessionId,
        stage: nextStage.id,
        timestamp
      });
      
      this._updateTaskBoard(sessionId, nextStage.id, 'in_progress');
    } else {
      // Session 完成
      this._appendLog({
        type: 'session_summary',
        session: sessionId,
        timestamp,
        completed: true
      });
    }
    
    return {
      completed: !nextStage,
      nextStage: nextStage ? nextStage.id : null
    };
  }

  /**
   * 获取当前项目状态摘要（用于 /status 命令）
   */
  getStatus() {
    const sessions = this._readAllSessions();
    const taskBoard = this._readTaskBoard();
    
    return {
      activeSessions: sessions.filter(s => !s.completed).length,
      completedSessions: sessions.filter(s => s.completed).length,
      currentStage: this._getCurrentStage(sessions),
      taskBoard: {
        total: taskBoard.tasks ? taskBoard.tasks.length : 0,
        completed: taskBoard.tasks ? taskBoard.tasks.filter(t => t.status === 'completed').length : 0,
        inProgress: taskBoard.tasks ? taskBoard.tasks.filter(t => t.status === 'in_progress').length : 0
      }
    };
  }

  // ============== Private Methods ==============

  _readSessionProgress(sessionId) {
    if (!fs.existsSync(this.progressLogPath)) {
      return { stages: [] };
    }
    
    const content = fs.readFileSync(this.progressLogPath, 'utf-8');
    const entries = content.trim().split('\n').filter(l => l).map(JSON.parse);
    
    return {
      stages: entries
        .filter(e => e.session === sessionId && e.type === 'stage_end')
        .map(e => e.stage)
    };
  }

  _readAllSessions() {
    if (!fs.existsSync(this.progressLogPath)) {
      return [];
    }
    
    const content = fs.readFileSync(this.progressLogPath, 'utf-8');
    const entries = content.trim().split('\n').filter(l => l).map(JSON.parse);
    
    const sessions = [];
    entries.forEach(e => {
      if (e.type === 'session_start') {
        sessions.push({ id: e.session, completed: false });
      } else if (e.type === 'session_summary') {
        const session = sessions.find(s => s.id === e.session);
        if (session) session.completed = true;
      }
    });
    
    return sessions;
  }

  _determineNextStage(currentStage, progress) {
    if (!currentStage) {
      return this.stages[0];
    }
    
    const currentIdx = this.stages.findIndex(s => s.id === currentStage);
    if (currentIdx >= 0 && currentIdx < this.stages.length - 1) {
      return this.stages[currentIdx + 1];
    }
    
    return null;
  }

  _calculateProgress(progress) {
    return Math.round((progress.stages.length / this.stages.length) * 100);
  }

  _getCurrentStage(sessions) {
    const active = sessions.find(s => !s.completed);
    return active ? active.id : 'IDLE';
  }

  _appendLog(record) {
    const dir = path.dirname(this.progressLogPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Check if record is a ModuleLogEntry (ARCHITECTURE.md D-1)
    // ModuleLogEntry has: module, action, level, summary fields
    if (record.module && record.action && record.level) {
      try {
        const ModuleLogFormatter = require('../core/module-log-formatter');
        // Use human-readable format for workflow-progress.log
        const formatted = ModuleLogFormatter.format(record);
        fs.appendFileSync(this.progressLogPath, formatted + '\n');
        return;
      } catch (err) {
        // Fallback to JSON format if ModuleLogFormatter fails
        console.error(`[PMAgent] ModuleLogFormatter failed: ${err.message}`);
      }
    }
    
    // Default: write as JSON (existing behavior)
    fs.appendFileSync(this.progressLogPath, JSON.stringify(record) + '\n');
  }

  _initTaskBoard(sessionId, requirement) {
    const taskBoard = {
      sessionId,
      requirement,
      createdAt: new Date().toISOString(),
      tasks: this.stages.map(s => ({
        id: s.id,
        name: s.name,
        status: s.id === 'ANALYSE' ? 'in_progress' : 'pending',
        startedAt: s.id === 'ANALYSE' ? new Date().toISOString() : null,
        completedAt: null
      }))
    };
    
    const dir = path.dirname(this.taskBoardPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.taskBoardPath, JSON.stringify(taskBoard, null, 2));
  }

  _updateTaskBoard(sessionId, stageId, status, summary = null) {
    if (!fs.existsSync(this.taskBoardPath)) return;
    
    const taskBoard = JSON.parse(fs.readFileSync(this.taskBoardPath, 'utf-8'));
    if (taskBoard.sessionId !== sessionId) return;
    
    const task = taskBoard.tasks.find(t => t.id === stageId);
    if (task) {
      task.status = status;
      if (status === 'in_progress' && !task.startedAt) {
        task.startedAt = new Date().toISOString();
      }
      if (status === 'completed') {
        task.completedAt = new Date().toISOString();
        if (summary) {
          task.summary = summary;
        }
      }
    }
    
    fs.writeFileSync(this.taskBoardPath, JSON.stringify(taskBoard, null, 2));
  }

  _readTaskBoard() {
    if (!fs.existsSync(this.taskBoardPath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(this.taskBoardPath, 'utf-8'));
  }
}

module.exports = { PMAgent };
