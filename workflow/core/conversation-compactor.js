'use strict';

const fs = require('fs');
const path = require('path');
const { COMPACTION } = require('./constants');
const { CONVERSATION_PRIORITY } = require('./token-budget');

// ConversationCompactor (C1) compresses long message histories via LLM summary
// with a deterministic truncation fallback. Triggers by message count OR total
// chars, whichever first. Per-session rate limited to prevent runaway LLM calls.
class ConversationCompactor {
  constructor(opts = {}) {
    this._cheapLlmCall = opts.cheapLlmCall || null;
    this._logPath = opts.logPath || COMPACTION.AUDIT_PATH || null;
    this._sessions = new Map();
    this._triggerMessages = opts.triggerMessages || COMPACTION.TRIGGER_MESSAGES;
    this._triggerChars = opts.triggerChars || COMPACTION.TRIGGER_CHARS;
    this._cooldownMessages = opts.cooldownMessages || COMPACTION.COOLDOWN_MESSAGES;
    this._maxPerSession = opts.maxPerSession || COMPACTION.MAX_PER_SESSION;
    this._targetRatio = opts.targetRatio || COMPACTION.TARGET_RATIO;
    this._preserveLastN = opts.preserveLastN || COMPACTION.PRESERVE_LAST_N;
    // Runtime env toggle — allows ops to disable without redeploy.
    const flag = process.env[COMPACTION.ENV_FLAG];
    this._enabled = flag === undefined ? true : flag !== 'false';
  }

  setCheapLlmCall(fn) {
    this._cheapLlmCall = fn;
  }

  shouldTrigger(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { trigger: false, reason: 'empty' };
    }
    if (messages.length >= this._triggerMessages) {
      return { trigger: true, reason: 'message count' };
    }
    const totalChars = messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
    if (totalChars >= this._triggerChars) {
      return { trigger: true, reason: 'char threshold' };
    }
    return { trigger: false, reason: 'below threshold' };
  }

  resetSession(sessionId) {
    if (sessionId) this._sessions.delete(sessionId);
  }

  _getSessionState(sessionId) {
    const key = sessionId || '_default';
    if (!this._sessions.has(key)) {
      this._sessions.set(key, { compactCount: 0, lastCompactAt: -Infinity, totalMessagesProcessed: 0 });
    }
    return this._sessions.get(key);
  }

  async compact(messages, opts = {}) {
    const sessionId = opts.sessionId || '_default';
    const state = this._getSessionState(sessionId);

    // R2 guard: structural circuit-breaker. When Compactor's own LLM call
    // re-enters _rawLlmCall, the caller sets _skipCompaction=true so we
    // short-circuit before touching any LLM again.
    if (opts._skipCompaction === true) {
      return { strategy: 'skip', reason: 'guard', savedChars: 0, messages, overuseWarning: false };
    }

    if (!this._enabled && !opts.force) {
      return { strategy: 'skip', reason: 'disabled', savedChars: 0, messages, overuseWarning: false };
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return { strategy: 'skip', reason: 'empty', savedChars: 0, messages: messages || [], overuseWarning: false };
    }

    const trigger = this.shouldTrigger(messages);
    if (!trigger.trigger && !opts.force) {
      return { strategy: 'skip', reason: trigger.reason, savedChars: 0, messages, overuseWarning: false };
    }

    const messagesSinceLast = messages.length - state.lastCompactAt;
    if (state.compactCount > 0 && messagesSinceLast < this._cooldownMessages) {
      return { strategy: 'skip', reason: 'cooldown', savedChars: 0, messages, overuseWarning: false };
    }

    const originalChars = this._totalChars(messages);
    const preserve = messages.slice(-this._preserveLastN);
    const toCompact = messages.slice(0, messages.length - this._preserveLastN);

    let summaryContent = null;
    let strategy = 'truncate';
    let llmFailed = false;

    // Prefer caller-supplied llmCall (typically _originalLlmCall bypass),
    // fall back to the constructor-registered one.
    const llmCall = opts.llmCall || this._cheapLlmCall;
    if (llmCall && toCompact.length > 0) {
      try {
        summaryContent = await this._llmSummarize(toCompact, llmCall);
        strategy = 'llm';
      } catch (err) {
        llmFailed = true;
        summaryContent = null;
      }
    }

    if (!summaryContent) {
      summaryContent = this._fallbackTruncate(toCompact);
      strategy = 'truncate';
    }

    const summaryMessage = {
      role: 'system',
      content: `[COMPACTED SUMMARY] ${summaryContent}`,
    };
    const compactedMessages = [summaryMessage, ...preserve];
    const compactedChars = this._totalChars(compactedMessages);
    const savedChars = Math.max(0, originalChars - compactedChars);

    // LLM failures do NOT consume compactCount budget — we want genuine LLM
    // compactions to be the limiter, not fallback noise.
    if (!llmFailed) {
      state.compactCount += 1;
      state.lastCompactAt = messages.length;
    }
    const overuseWarning = state.compactCount > this._maxPerSession;
    const warningMessage = overuseWarning
      ? `History compaction invoked ${state.compactCount} times this session (limit: ${this._maxPerSession}). Consider using /clear to start fresh.`
      : null;

    const result = {
      strategy,
      reason: trigger.reason,
      originalChars,
      compactedChars,
      savedChars,
      originalMessageCount: messages.length,
      compactedMessageCount: compactedMessages.length,
      messages: compactedMessages,
      sessionCompactCount: state.compactCount,
      overuseWarning,
      warningMessage,
    };

    this._auditLog(sessionId, result).catch(() => { /* audit is best-effort */ });
    return result;
  }

  async _llmSummarize(messages, llmCallOverride = null) {
    const bucketed = { USER_INSTRUCTION: [], FINAL_RESPONSE: [], TOOL_RESULT: [], OTHER: [] };
    for (const msg of messages) {
      const p = this._classify(msg);
      if (p === 0) bucketed.USER_INSTRUCTION.push(msg);
      else if (p === 1) bucketed.FINAL_RESPONSE.push(msg);
      else if (p === 4) bucketed.TOOL_RESULT.push(msg);
      else bucketed.OTHER.push(msg);
    }

    const userInstructions = bucketed.USER_INSTRUCTION.map((m, i) => `${i + 1}. ${this._truncate(m.content, 200)}`).join('\n');
    const recentResponses = bucketed.FINAL_RESPONSE.slice(-3).map((m, i) => `${i + 1}. ${this._truncate(m.content, 300)}`).join('\n');

    const prompt = [
      'Summarize the following conversation for continuation. Preserve:',
      '1. ALL user instructions (goals, constraints, preferences)',
      '2. Key decisions made and their rationale',
      '3. Open questions or unresolved issues',
      '4. Important file paths, identifiers, and data referenced',
      '',
      'USER INSTRUCTIONS:',
      userInstructions || '(none)',
      '',
      'RECENT AGENT RESPONSES:',
      recentResponses || '(none)',
      '',
      'TOOL RESULTS: ' + bucketed.TOOL_RESULT.length + ' calls (details omitted)',
      '',
      'Write the summary in <=400 words. Focus on WHAT was decided and WHY.',
    ].join('\n');

    const llmCall = llmCallOverride || this._cheapLlmCall;
    const response = await llmCall(prompt, { maxTokens: 600, temperature: 0.2 });
    const text = typeof response === 'string' ? response : (response && response.content ? response.content : '');
    if (!text || text.trim().length === 0) {
      throw new Error('LLM returned empty summary');
    }
    return text.trim();
  }

  _fallbackTruncate(messages) {
    const totalChars = this._totalChars(messages);
    const targetChars = Math.floor(totalChars * this._targetRatio);
    const userMsgs = messages.filter(m => this._classify(m) === 0).map(m => this._truncate(m.content, 150));
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const head = `Conversation truncated (fallback mode — LLM unavailable). ${messages.length} messages, ${totalChars} chars.`;
    const body = [
      'User instructions seen:',
      ...userMsgs.slice(0, 10).map((t, i) => `- ${t}`),
      '',
      lastAssistant ? `Last agent response: ${this._truncate(lastAssistant.content, 400)}` : '',
    ].join('\n');
    const combined = `${head}\n${body}`;
    return combined.length > targetChars ? combined.slice(0, targetChars) + '\n...[truncated]' : combined;
  }

  _classify(msg) {
    if (!msg || !msg.role) return 3;
    if (msg.role === 'user') return CONVERSATION_PRIORITY ? CONVERSATION_PRIORITY.USER_INSTRUCTION : 0;
    if (msg.role === 'assistant') return CONVERSATION_PRIORITY ? CONVERSATION_PRIORITY.FINAL_RESPONSE : 1;
    if (msg.role === 'tool') return CONVERSATION_PRIORITY ? CONVERSATION_PRIORITY.TOOL_SUCCESS : 4;
    return 3;
  }

  _totalChars(messages) {
    return messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
  }

  _truncate(text, maxLen) {
    if (!text) return '';
    return text.length <= maxLen ? text : text.slice(0, maxLen) + '...';
  }

  async _auditLog(sessionId, result) {
    if (!this._logPath) return;
    try {
      const dir = path.dirname(this._logPath);
      await fs.promises.mkdir(dir, { recursive: true });
      const entry = {
        timestamp: new Date().toISOString(),
        sessionId,
        strategy: result.strategy,
        reason: result.reason,
        originalChars: result.originalChars,
        compactedChars: result.compactedChars,
        savedChars: result.savedChars,
        originalMessageCount: result.originalMessageCount,
        compactedMessageCount: result.compactedMessageCount,
        sessionCompactCount: result.sessionCompactCount,
        overuseWarning: result.overuseWarning,
      };
      await fs.promises.appendFile(this._logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (_) { /* best-effort audit */ }
  }
}

module.exports = { ConversationCompactor };
