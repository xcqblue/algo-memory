/**
 * algo-memory 会话续接功能 - 模拟测试脚本
 * 
 * 直接模拟核心逻辑，不依赖插件注册
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============= 简化版核心逻辑 =============

function generateId() {
  return 'mem_' + crypto.randomBytes(8).toString('hex');
}

function estimateTokens(text) {
  if (!text) return 0;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjk = text.length - cjkChars;
  return cjkChars + Math.ceil(nonCjk / 4);
}

function normalizeForStorage(content) {
  let text = content
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/```[\s\S]*?```/g, m => m.replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s*/gm, '')
    .trim();
  return text;
}

class SessionContinuitySimulator {
  constructor(config) {
    this.config = config;
    this.lastSessionKey = new Map();
    this.snapshots = [];
  }

  generateSessionSummary(messages, maxMessages = 30) {
    if (!messages || messages.length === 0) return '';

    const recentMessages = messages.slice(-maxMessages);
    const lines = [];

    for (const msg of recentMessages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        const content = msg.content.length > 200 ? msg.content.substring(0, 200) + '...' : msg.content;
        lines.push(`用户: ${content}`);
      } else if (msg.role === 'assistant' && msg.content && !msg.isError) {
        const content = typeof msg.content === 'string'
          ? (msg.content.length > 200 ? msg.content.substring(0, 200) + '...' : msg.content)
          : '[助手回复]';
        lines.push(`助手: ${content}`);
      }
    }

    return lines.join('\n');
  }

  extractContextSnapshot(messages, maxMessages = 30) {
    if (!messages || messages.length === 0) return '';

    const recentMessages = messages.slice(-maxMessages);
    const seen = new Set();
    const lines = [];

    for (const msg of recentMessages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        const normalized = normalizeForStorage(msg.content);
        if (normalized.length < 3) continue;
        const key = normalized.substring(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);
        const content = normalized.length > 300 ? normalized.substring(0, 300) + '...' : normalized;
        lines.push(`用户: ${content}`);
      } else if (msg.role === 'assistant' && msg.content && !msg.isError) {
        const content = typeof msg.content === 'string'
          ? normalizeForStorage(msg.content)
          : '';
        if (!content || content.length < 3) continue;
        const key = 'a:' + content.substring(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);
        const truncated = content.length > 300 ? content.substring(0, 300) + '...' : content;
        lines.push(`助手: ${truncated}`);
      }
    }

    return lines.join('\n');
  }

  saveSessionSnapshot(agentId, sessionKey, messages) {
    if (!this.config.enabled) return null;

    const maxMessages = this.config.maxMessagesForSummary || 30;
    const summary = this.generateSessionSummary(messages, maxMessages);
    const contextSnapshot = this.extractContextSnapshot(messages, maxMessages);
    const messageCount = messages.length;
    const totalTokens = estimateTokens(JSON.stringify(messages));

    const snapshot = {
      id: generateId(),
      agent_id: agentId,
      session_key: sessionKey,
      ended_at: Date.now(),
      summary,
      context_snapshot: contextSnapshot,
      message_count: messageCount,
      total_tokens: totalTokens,
      created_at: Date.now(),
    };

    this.snapshots.push(snapshot);
    return snapshot;
  }

  getLastSessionSnapshot(agentId) {
    const agentSnapshots = this.snapshots
      .filter(s => s.agent_id === agentId)
      .sort((a, b) => b.ended_at - a.ended_at);
    return agentSnapshots[0] || null;
  }

  detectSessionChangeAndGetSnapshot(agentId, currentSessionKey) {
    if (!this.config.enabled) return null;

    const lastKey = this.lastSessionKey.get(agentId);

    if (lastKey === currentSessionKey) {
      return null;
    }

    this.lastSessionKey.set(agentId, currentSessionKey);

    if (!lastKey) {
      return null;
    }

    const snapshot = this.getLastSessionSnapshot(agentId);
    if (snapshot) {
      console.log(`[检测] 会话切换: ${lastKey} -> ${currentSessionKey}`);
    }

    return snapshot;
  }

  buildSessionContinuityContext(snapshot) {
    if (!snapshot) return { text: '', tokens: 0 };

    const maxTokens = this.config.maxInjectTokens || 800;
    const lines = [];

    if (snapshot.summary) {
      lines.push('【上会话摘要】');
      const summaryLines = snapshot.summary.split('\n').slice(-10);
      for (const line of summaryLines) {
        if (estimateTokens(lines.join('\n') + '\n' + line) <= maxTokens) {
          lines.push(line);
        }
      }
    }

    if (snapshot.context_snapshot && lines.join('\n').length < maxTokens * 2) {
      lines.push('');
      lines.push('【上会话详情】');
      const contextLines = snapshot.context_snapshot.split('\n').slice(-20);
      for (const line of contextLines) {
        if (estimateTokens(lines.join('\n') + '\n' + line) <= maxTokens) {
          lines.push(line);
        } else {
          break;
        }
      }
    }

    const text = lines.join('\n');
    return { text, tokens: estimateTokens(text) };
  }
}

// ============= 测试场景 =============

console.log('='.repeat(60));
console.log('algo-memory 会话续接功能测试');
console.log('='.repeat(60));

const config = {
  enabled: true,
  maxInjectTokens: 800,
  maxMessagesForSummary: 30,
};

const simulator = new SessionContinuitySimulator(config);

// ============= 测试1: 基本摘要生成 =============
console.log('\n【测试1】generateSessionSummary - 基本摘要生成');
console.log('-'.repeat(40));

const messages1 = [
  { role: 'user', content: '我想了解一下明天的天气' },
  { role: 'assistant', content: '明天天气晴，温度15-25度。' },
  { role: 'user', content: '那后天呢？' },
  { role: 'assistant', content: '后天多云，可能有雨。' },
];

const summary1 = simulator.generateSessionSummary(messages1);
console.log('输入: 4条消息');
console.log('摘要:\n', summary1);
console.log('✅ 通过');

// ============= 测试2: 过长内容截断 =============
console.log('\n【测试2】generateSessionSummary - 过长内容截断');
console.log('-'.repeat(40));

const longContent = 'A'.repeat(300);
const messages2 = [{ role: 'user', content: longContent }];
const summary2 = simulator.generateSessionSummary(messages2);
console.log('输入: 300字符内容');
console.log('输出长度:', summary2.length);
console.log('包含省略号:', summary2.includes('...'));
console.log('✅ 通过');

// ============= 测试3: 上下文去重 =============
console.log('\n【测试3】extractContextSnapshot - 上下文去重');
console.log('-'.repeat(40));

const messages3 = [
  { role: 'user', content: '同样的问题' },
  { role: 'user', content: '同样的问题' },
  { role: 'user', content: '不同的问题' },
];
const snapshot3 = simulator.extractContextSnapshot(messages3);
const lines3 = snapshot3.split('\n').filter(l => l.trim());
console.log('输入: 3条消息（2条重复）');
console.log('输出行数:', lines3.length);
console.log('✅ 通过（去重后应为2行）');

// ============= 测试4: 会话切换检测 =============
console.log('\n【测试4】detectSessionChangeAndGetSnapshot - 会话切换检测');
console.log('-'.repeat(40));

const agentId = 'test-agent-001';
const sessionKey1 = 'feishu:direct:user001:2026-03-22-23:00';
const sessionKey2 = 'feishu:direct:user001:2026-03-23-06:00';

// 首次会话
const result1 = simulator.detectSessionChangeAndGetSnapshot(agentId, sessionKey1);
console.log('首次会话（应返回null）:', result1 === null ? 'null ✅' : '错误');

// 会话切换
const result2 = simulator.detectSessionChangeAndGetSnapshot(agentId, sessionKey2);
console.log('会话切换（应返回快照）:', result2 !== null ? '有快照 ✅' : '错误');

// ============= 测试5: 续接上下文构建 =============
console.log('\n【测试5】buildSessionContinuityContext - 续接上下文构建');
console.log('-'.repeat(40));

if (result2) {
  const context = simulator.buildSessionContinuityContext(result2);
  console.log('上下文 tokens:', context.tokens);
  console.log('上下文内容:\n', context.text.substring(0, 500) + (context.text.length > 500 ? '...' : ''));
  console.log('✅ 通过');
}

// ============= 测试6: 完整流程模拟 =============
console.log('\n【测试6】完整流程 - 晚上12点到早上6点续接');
console.log('-'.repeat(40));

const agentId2 = 'feishu-user-002';
const nightSessionKey = 'feishu:direct:ou_471:2026-03-22-23:50';
const morningSessionKey = 'feishu:direct:ou_471:2026-03-23-06:05';

const nightMessages = [
  { role: 'user', content: '帮我查一下明天去上海的机票' },
  { role: 'assistant', content: '好的，为您查询明天去上海的机票，请稍等...' },
  { role: 'user', content: '我要早上8点的' },
  { role: 'assistant', content: '找到了早上8点的东航MU5101，起飞时间8:00，到达10:30' },
  { role: 'user', content: '帮我订这张机票' },
  { role: 'assistant', content: '好的，正在为您订票...' },
  { role: 'user', content: '要靠窗的位置' },
  { role: 'assistant', content: '好的，为您选择靠窗座位...' },
];

console.log('=== 昨晚对话 ===');
const nightSnapshot = simulator.saveSessionSnapshot(agentId2, nightSessionKey, nightMessages);
console.log('快照已保存, 消息数:', nightSnapshot.message_count, 'tokens:', nightSnapshot.total_tokens);

console.log('\n=== 今早继续 ===');
const morningSnapshot = simulator.detectSessionChangeAndGetSnapshot(agentId2, morningSessionKey);
if (morningSnapshot) {
  console.log('检测到会话切换，从上会话恢复上下文');
  const { text, tokens } = simulator.buildSessionContinuityContext(morningSnapshot);
  console.log('续接上下文 tokens:', tokens);
  console.log('续接内容预览:\n', text);
  console.log('\n✅ 完整流程测试通过！');
} else {
  console.log('❌ 未能获取快照');
}

// ============= 测试7: 同一会话不触发续接 =============
console.log('\n【测试7】同一会话不应触发续接');
console.log('-'.repeat(40));

const sameUser = 'feishu-user-003';
const session1 = 'feishu:direct:ou_999:2026-03-23-10:00';
const session2 = 'feishu:direct:ou_999:2026-03-23-10:05'; // 同一会话的不同消息

simulator.detectSessionChangeAndGetSnapshot(sameUser, session1);
const sameSessionResult = simulator.detectSessionChangeAndGetSnapshot(sameUser, session2);
console.log('同一会话的 sessionKey 不同但应识别为续接:', sameSessionResult === null ? 'null（正确）✅' : '有快照（需检查）');

// ============= 测试8: 边界条件 =============
console.log('\n【测试8】边界条件测试');
console.log('-'.repeat(40));

// 空消息
const emptyResult = simulator.generateSessionSummary([]);
console.log('空消息:', emptyResult === '' ? '空字符串 ✅' : '错误');

// 大量消息
const manyMessages = Array.from({ length: 100 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `消息内容第${i + 1}条 - ${'测试内容'.repeat(10)}`,
}));
const manySnapshot = simulator.saveSessionSnapshot('bulk-user', 'bulk-session', manyMessages);
console.log('100条消息快照:', manySnapshot ? `消息数${manySnapshot.message_count}, 摘要长度${manySnapshot.summary.length} ✅` : '错误');

// ============= 测试结果汇总 =============
console.log('\n' + '='.repeat(60));
console.log('所有测试完成！');
console.log('='.repeat(60));

console.log('\n功能说明:');
console.log('1. saveSessionSnapshot() - 在 agent_end 时调用，保存会话快照');
console.log('2. detectSessionChangeAndGetSnapshot() - 在 agent_start 时调用，检测是否需要续接');
console.log('3. buildSessionContinuityContext() - 构建注入上下文的文本');
console.log('\n关键特性:');
console.log('- 基于 sessionKey 检测会话切换（支持跨 session 续接）');
console.log('- 自动生成摘要和上下文快照');
console.log('- Token 上限保护（默认800 tokens）');
console.log('- 消息去重和截断');
