'use strict';

const { ConversationCompactor } = require('../../workflow/core/conversation-compactor');

async function runTests() {
  let pass = 0;
  let fail = 0;
  const log = (name, ok, info) => {
    if (ok) { console.log('PASS', name, info || ''); pass++; }
    else { console.log('FAIL', name, info || ''); fail++; }
  };

  // T3.AC1: under threshold
  {
    const c = new ConversationCompactor();
    const msgs = Array.from({ length: 9 }, (_, i) => ({ role: 'user', content: 'msg' + i }));
    const r = c.shouldTrigger(msgs);
    log('T3.AC1 shouldTrigger 9 msgs below', r.trigger === false && r.reason === 'below threshold', JSON.stringify(r));
  }

  // T3.AC2: message count trigger
  {
    const c = new ConversationCompactor();
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: 'msg' + i }));
    const r = c.shouldTrigger(msgs);
    log('T3.AC2 shouldTrigger 10 msgs', r.trigger === true && r.reason === 'message count', JSON.stringify(r));
  }

  // T3.AC3: char threshold trigger
  {
    const c = new ConversationCompactor();
    const bigMsg = { role: 'user', content: 'x'.repeat(85000) };
    const r = c.shouldTrigger([bigMsg, { role: 'assistant', content: 'y' }]);
    log('T3.AC3 shouldTrigger char threshold', r.trigger === true && r.reason === 'char threshold', JSON.stringify(r));
  }

  // T3.AC4: LLM-based compact
  {
    const mockLlm = async (prompt) => 'Mocked summary of the conversation.';
    const c = new ConversationCompactor({ cheapLlmCall: mockLlm });
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'msg content ' + i + ' '.repeat(50) }));
    const r = await c.compact(msgs, { sessionId: 's1' });
    log('T3.AC4 LLM strategy + savedChars>0', r.strategy === 'llm' && r.savedChars > 0, 'strategy=' + r.strategy + ' saved=' + r.savedChars);
  }

  // T3.AC5: LLM failure => fallback truncation, compactCount NOT incremented
  {
    const mockLlm = async () => { throw new Error('LLM timeout'); };
    const c = new ConversationCompactor({ cheapLlmCall: mockLlm });
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: 'msg ' + i }));
    const r = await c.compact(msgs, { sessionId: 's2' });
    const stateOk = r.sessionCompactCount === 0;
    log('T3.AC5 LLM fail => truncate + no count', r.strategy === 'truncate' && stateOk, 'strategy=' + r.strategy + ' count=' + r.sessionCompactCount);
  }

  // T3.AC6: overuse warning after 4th call
  {
    const mockLlm = async () => 'Summary';
    const c = new ConversationCompactor({ cheapLlmCall: mockLlm, maxPerSession: 3 });
    const msgs = Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: 'x' + i }));
    let lastResult;
    for (let i = 0; i < 4; i++) {
      // Give unique message arrays to bypass cooldown — simulate fresh conversation each time.
      const newMsgs = Array.from({ length: 15 + i * 5 }, (_, idx) => ({ role: 'user', content: 'x' + idx }));
      lastResult = await c.compact(newMsgs, { sessionId: 's3', force: true });
    }
    log('T3.AC6 overuseWarning after 4 calls', lastResult.overuseWarning === true && /\/clear/.test(lastResult.warningMessage || ''), 'count=' + lastResult.sessionCompactCount + ' warning=' + lastResult.overuseWarning);
  }

  // T3.AC7: user instructions preserved, last 3 preserved
  {
    const mockLlm = async () => 'Summary';
    const c = new ConversationCompactor({ cheapLlmCall: mockLlm });
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: 'u' + i }));
    const r = await c.compact(msgs, { sessionId: 's7' });
    const last3Preserved = r.messages.slice(-3).every((m, i) => m.content === 'u' + (9 + i));
    const hasSummary = r.messages[0].content.startsWith('[COMPACTED SUMMARY]');
    log('T3.AC7 last3 preserved + summary head', last3Preserved && hasSummary, 'last3Preserved=' + last3Preserved + ' summary=' + hasSummary);
  }

  // T3.AC8: compacted size <= original * 0.3 (allow slack for small messages)
  {
    const mockLlm = async () => 'A short summary.';
    const c = new ConversationCompactor({ cheapLlmCall: mockLlm });
    const msgs = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'Long verbose message content '.repeat(30) + i }));
    const r = await c.compact(msgs, { sessionId: 's8' });
    const ratio = r.compactedChars / r.originalChars;
    log('T3.AC8 ratio <= 0.3', ratio <= 0.3, 'ratio=' + ratio.toFixed(3));
  }

  // T3.AC9: cooldown on 2nd immediate call
  {
    const mockLlm = async () => 'Summary';
    const c = new ConversationCompactor({ cheapLlmCall: mockLlm, cooldownMessages: 3 });
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: 'x' + i }));
    const r1 = await c.compact(msgs, { sessionId: 's9' });
    const msgs2 = msgs.concat([{ role: 'user', content: 'new1' }, { role: 'user', content: 'new2' }]);
    const r2 = await c.compact(msgs2, { sessionId: 's9' });
    log('T3.AC9 cooldown skip', r2.strategy === 'skip' && r2.reason === 'cooldown', 'r1.strategy=' + r1.strategy + ' r2.strategy=' + r2.strategy + ' r2.reason=' + r2.reason);
  }

  // T3.AC10: resetSession restores ability
  {
    const mockLlm = async () => 'Summary';
    const c = new ConversationCompactor({ cheapLlmCall: mockLlm });
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: 'x' + i }));
    await c.compact(msgs, { sessionId: 's10' });
    c.resetSession('s10');
    const r2 = await c.compact(msgs, { sessionId: 's10' });
    log('T3.AC10 resetSession', r2.strategy === 'llm' && r2.sessionCompactCount === 1, 'strategy=' + r2.strategy + ' count=' + r2.sessionCompactCount);
  }

  // T3.AC11: empty messages
  {
    const c = new ConversationCompactor();
    const r = await c.compact([], { sessionId: 's11' });
    log('T3.AC11 empty', r.strategy === 'skip' && r.savedChars === 0, 'strategy=' + r.strategy + ' saved=' + r.savedChars);
  }

  // T3.AC12: jsonl audit writes valid JSON
  {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.join(process.cwd(), 'output', 'compaction-log-smoke.jsonl');
    try { fs.unlinkSync(logPath); } catch (_) {}
    const mockLlm = async () => 'Summary';
    const c = new ConversationCompactor({ cheapLlmCall: mockLlm, logPath });
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: 'x' + i }));
    await c.compact(msgs, { sessionId: 's12' });
    await new Promise(r => setTimeout(r, 100));
    const content = fs.readFileSync(logPath, 'utf8').trim();
    let ok = false;
    try {
      const lines = content.split('\n').filter(Boolean);
      const parsed = JSON.parse(lines[0]);
      ok = parsed.sessionId === 's12' && parsed.strategy === 'llm' && typeof parsed.savedChars === 'number';
    } catch (e) { /* parse failed */ }
    log('T3.AC12 jsonl audit valid', ok, 'content=' + (content || '').slice(0, 100));
  }

  console.log('\nResult: ' + pass + '/' + (pass + fail));
  if (fail > 0) process.exit(1);
}

runTests().catch(e => { console.error('ERROR:', e); process.exit(1); });
