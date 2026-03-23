/**
 * 集成测试：模拟真实场景
 * 场景：用户晚上12点对话，第二天早上6点继续
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============= 数据库模拟（内存版）=============

class MockDb {
  constructor() {
    this.snapshots = [];
  }
  
  saveSnapshot(snapshot) {
    this.snapshots.push(snapshot);
  }
  
  getLastSnapshot(agentId) {
    const filtered = this.snapshots.filter(s => s.agent_id === agentId);
    return filtered.sort((a, b) => b.ended_at - a.ended_at)[0] || null;
  }
}

function generateId() {
  return 'snap_' + crypto.randomBytes(8).toString('hex');
}

function estimateTokens(text) {
  if (!text) return 0;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjk = text.length - cjkChars;
  return cjkChars + Math.ceil(nonCjk / 4);
}

function normalizeForStorage(content) {
  return content
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class SessionContinuity {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.lastSessionKey = new Map();
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
        const content = typeof msg.content === 'string' ? normalizeForStorage(msg.content) : '';
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

    this.db.saveSnapshot(snapshot);
    // 重要：同时更新 lastSessionKey
    this.lastSessionKey.set(agentId, sessionKey);
    return snapshot;
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
    
    return this.db.getLastSnapshot(agentId);
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

// ============= 模拟 OpenClaw 钩子调用 =============

class MockApi {
  constructor() {
    this.injectedContext = [];
    this.hooks = {};
  }
  
  prependSystemContext(text) {
    this.injectedContext.push(text);
    console.log('[API] prependSystemContext 调用，注入长度:', text.length, '字符');
  }
  
  on(event, handler, options) {
    this.hooks[event] = { handler, options };
  }
  
  // 模拟触发钩子
  trigger(event, data) {
    if (this.hooks[event]) {
      return this.hooks[event].handler(data);
    }
  }
}

// ============= 测试场景 =============

console.log('='.repeat(70));
console.log('集成测试：模拟用户真实场景 - "晚上12点对话，早上6点续不上"');
console.log('='.repeat(70));

const db = new MockDb();
const config = {
  enabled: true,
  maxInjectTokens: 800,
  maxMessagesForSummary: 30,
};
const continuity = new SessionContinuity(config, db);
const api = new MockApi();

// 注册钩子（模拟 OpenClaw 的插件钩子注册）
api.on('before_agent_start', async (event) => {
  const agentId = event.agentId;
  const sessionKey = event.sessionKey;
  
  const snapshot = continuity.detectSessionChangeAndGetSnapshot(agentId, sessionKey);
  
  if (snapshot) {
    const { text, tokens } = continuity.buildSessionContinuityContext(snapshot);
    if (text && tokens > 0) {
      console.log(`[钩子] before_agent_start 检测到会话切换，注入 ${tokens} tokens`);
      api.prependSystemContext('\n\n' + text + '\n');
    }
  }
}, { priority: 10 });

api.on('agent_end', async (event) => {
  const agentId = event.agentId;
  const sessionKey = event.sessionKey;
  const messages = event.messages || [];
  
  if (messages.length > 0) {
    continuity.saveSessionSnapshot(agentId, sessionKey, messages);
    console.log(`[钩子] agent_end 保存会话快照，消息数: ${messages.length}`);
  }
});

// ============= 场景1：晚上12点的对话 =============

console.log('\n' + '-'.repeat(70));
console.log('📅 场景1：晚上12点开始对话');
console.log('-'.repeat(70));

const nightSessionKey = 'feishu:direct:ou_471c9d1240f8c33e8d632527d2af6759:2026-03-22-23:50';
const nightMessages = [
  { role: 'user', content: '帮我查一下明天北京到上海的机票' },
  { role: 'assistant', content: '好的，正在为您查询北京到上海的航班...' },
  { role: 'user', content: '我要早上8点左右的' },
  { role: 'assistant', content: '找到了几个8点左右的航班：\n1. 东航MU5101，8:00起飞，10:30到达\n2. 国航CA1519，8:05起飞，10:35到达' },
  { role: 'user', content: '帮我订东航MU5101，靠窗位置' },
  { role: 'assistant', content: '好的，正在为您预订东航MU5101经济舱靠窗座位...\n航班信息：\n- 日期：2026-03-23\n- 航班号：MU5101\n- 出发：北京首都机场T3\n- 到达：上海虹桥机场T2\n- 座位：靠窗' },
  { role: 'user', content: '好的，确认预订' },
  { role: 'assistant', content: '预订成功！您的机票已确认：\n- 航班号：MU5101\n- 日期：2026-03-23 08:00-10:30\n- 座位：靠窗\n祝您旅途愉快！' },
];

// 模拟 agent_end 钩子 - 保存晚上会话
api.trigger('agent_end', {
  agentId: 'main',
  sessionKey: nightSessionKey,
  messages: nightMessages
});

console.log('\n💾 晚上会话快照已保存');
console.log('   消息数:', nightMessages.length);
console.log('   摘要预览:', db.getLastSnapshot('main')?.summary?.substring(0, 100) + '...');

// ============= 场景2：第二天早上6点继续对话 =============

console.log('\n' + '-'.repeat(70));
console.log('📅 场景2：第二天早上6点继续对话（之前接不上的问题）');
console.log('-'.repeat(70));

const morningSessionKey = 'feishu:direct:ou_471c9d1240f8c33e8d632527d2af6759:2026-03-23-06:00';
const morningMessages = [
  { role: 'user', content: '继续' },  // 用户早上发来"继续"
];

console.log('\n用户发送: "继续"');
console.log('（在之前的系统中，这会导致上下文丢失，无法续接昨晚的订票对话）\n');

// 模拟 before_agent_start 钩子 - 检测会话切换并注入上下文
api.trigger('before_agent_start', {
  agentId: 'main',
  sessionKey: morningSessionKey,
});

// 检查注入的上下文
if (api.injectedContext.length > 0) {
  console.log('\n✅ 成功注入上会话上下文！');
  console.log('\n' + '='.repeat(70));
  console.log('注入的续接内容:');
  console.log('='.repeat(70));
  console.log(api.injectedContext[0]);
  console.log('='.repeat(70));
} else {
  console.log('\n❌ 未能注入上下文');
}

// ============= 验证结果 =============

console.log('\n' + '-'.repeat(70));
console.log('验证结果');
console.log('-'.repeat(70));

const injected = api.injectedContext[0] || '';
const checks = [
  { name: '包含上会话摘要', pass: injected.includes('【上会话摘要】') },
  { name: '包含机票相关上下文', pass: injected.includes('机票') || injected.includes('航班') },
  { name: '包含用户订票请求', pass: injected.includes('订') || injected.includes('东航') },
  { name: '包含助手确认回复', pass: injected.includes('预订成功') || injected.includes('已确认') },
  { name: '上下文在token限制内', pass: estimateTokens(injected) <= config.maxInjectTokens },
];

checks.forEach(check => {
  console.log(`  ${check.pass ? '✅' : '❌'} ${check.name}`);
});

const allPassed = checks.every(c => c.pass);
console.log('\n' + '='.repeat(70));
if (allPassed) {
  console.log('🎉 所有验证通过！会话续接功能正常工作');
} else {
  console.log('⚠️ 部分验证未通过，请检查');
}
console.log('='.repeat(70));

// ============= 问题分析 =============

console.log('\n' + '='.repeat(70));
console.log('问题分析：algo-memory 原插件 vs 修复后的插件');
console.log('='.repeat(70));

console.log(`
┌─────────────────────┬────────────────────────────────────────────────────┐
│ 问题                │ 原因                                                │
├─────────────────────┼────────────────────────────────────────────────────┤
│ 晚上12点对话早上    │ 1. 新会话开始时没有检测上会话状态                   │
│ 接不上              │ 2. 没有机制保存和恢复会话上下文                     │
│                     │ 3. before_prompt_build 只看当前 messages            │
└─────────────────────┴────────────────────────────────────────────────────┘

┌─────────────────────┬────────────────────────────────────────────────────┐
│ 解决方案            │ 实现方式                                            │
├─────────────────────┼────────────────────────────────────────────────────┤
│ session_end 钩子   │ 保存会话快照到数据库（含摘要和上下文）              │
│ before_agent_start  │ 检测 sessionKey 是否变化                            │
│ 钩子                │ 如果变了，从数据库读取上会话快照                    │
│                     │ 注入到当前上下文中                                  │
└─────────────────────┴────────────────────────────────────────────────────┘

┌─────────────────────┬────────────────────────────────────────────────────┐
│ 关键改动            │ 说明                                                │
├─────────────────────┼────────────────────────────────────────────────────┤
│ 新增表              │ session_snapshots - 存储会话快照                   │
│ 新增方法            │ saveSessionSnapshot() - 保存快照                    │
│                     │ detectSessionChange() - 检测会话切换                │
│                     │ buildContinuityContext() - 构建续接文本             │
│ 新增钩子            │ before_agent_start - 注入上会话上下文               │
│                     │ agent_end - 保存会话快照                            │
└─────────────────────┴────────────────────────────────────────────────────┘
`);
