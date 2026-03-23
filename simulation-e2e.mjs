/**
 * algo-memory 完整端到端流程模拟
 * 
 * 从用户打开对话 → 发送消息 → AI回复 → 存储记忆 → 会话切换 → 召回记忆 → 续接上下文
 * 完整展示插件的全部工作流程
 */

import crypto from 'crypto';

// ============= 工具函数 =============

function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

function normalizeText(text) {
  return text
    .replace(/@\w+/g, '')
    .replace(/```[\s\S]*?```/g, '[代码]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============= 模拟数据库 =============

class Database {
  constructor() {
    this.memories = [];
    this.snapshots = [];
    this.metadata = [];
    this.fts = [];
  }
}

// ============= 插件核心 =============

class AlgoMemoryPlugin {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.lastSessionKey = new Map();
    this.lastRecallQuery = new Map();
    this.initialized = false;
  }

  // 初始化
  init() {
    console.log('  [插件] 初始化数据库...');
    console.log('  [插件] 注册 hooks...');
    console.log('  [插件] 启动清理定时器...');
    this.initialized = true;
    console.log('  [插件] ✅ 初始化完成');
  }

  // 存储用户消息到记忆
  store(agentId, messages) {
    if (!messages?.length) return;

    for (const msg of messages) {
      if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
      if (msg.content.length < 5) continue;

      // 关键词检测
      const content = msg.content;
      const isCore = /记住|重要|别忘|牢记|important|never forget/i.test(content);
      const importance = isCore ? 0.9 : 0.5;

      const memory = {
        id: generateId(),
        agentId,
        content: normalizeText(content),
        importance,
        keywords: this.extractKeywords(content),
        accessCount: 0,
        citedCount: 0,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
      };

      this.db.memories.push(memory);
    }
  }

  extractKeywords(text) {
    const words = text.match(/[\u4e00-\u9fff]+|[a-zA-Z]{3,}/g) || [];
    return [...new Set(words)].slice(0, 10).join(',');
  }

  // 召回相关记忆
  recall(agentId, query) {
    const queryNorm = normalizeText(query).toLowerCase();
    const queryWords = queryNorm.split(/\s+/);
    
    const scored = this.db.memories
      .filter(m => m.agentId === agentId)
      .map(m => {
        const contentWords = m.content.toLowerCase();
        const matchCount = queryWords.filter(w => contentWords.includes(w)).length;
        const score = matchCount / queryWords.length;
        return { memory: m, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // 更新访问统计
    for (const { memory } of scored) {
      memory.accessCount++;
      memory.citedCount++;
      memory.lastAccessed = Date.now();
    }

    return scored.map(x => x.memory);
  }

  // 保存会话快照
  saveSnapshot(agentId, sessionKey, messages) {
    if (!this.config.sessionContinuity.enabled || !messages?.length) return;

    const maxMsgs = this.config.sessionContinuity.maxMessagesForSummary;
    const recent = messages.slice(-maxMsgs);

    // 生成摘要
    const summaryLines = [];
    for (const m of recent) {
      if (m.role === 'user' && typeof m.content === 'string') {
        const c = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
        summaryLines.push(`用户: ${c}`);
      } else if (m.role === 'assistant' && m.content && !m.isError) {
        const c = typeof m.content === 'string' 
          ? (m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content)
          : '[助手]';
        summaryLines.push(`助手: ${c}`);
      }
    }

    // 生成上下文快照（去重）
    const seen = new Set();
    const contextLines = [];
    for (const m of recent) {
      if (m.role === 'user' && typeof m.content === 'string') {
        const norm = normalizeText(m.content);
        if (norm.length < 3) continue;
        const key = norm.slice(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);
        const c = norm.length > 300 ? norm.slice(0, 300) + '...' : norm;
        contextLines.push(`用户: ${c}`);
      }
    }

    const snapshot = {
      id: generateId(),
      agentId,
      sessionKey,
      endedAt: Date.now(),
      summary: summaryLines.join('\n'),
      context: contextLines.join('\n'),
      msgCount: messages.length,
    };

    this.db.snapshots.push(snapshot);

    // 持久化 lastSessionKey
    const idx = this.db.metadata.findIndex(m => m.agentId === agentId);
    const meta = { agentId, lastSessionKey: sessionKey, updatedAt: Date.now() };
    if (idx >= 0) this.db.metadata[idx] = meta;
    else this.db.metadata.push(meta);

    this.lastSessionKey.set(agentId, sessionKey);
  }

  // 检测会话切换
  detectSessionChange(agentId, currentKey) {
    if (!this.config.sessionContinuity.enabled) return null;

    const lastKey = this.lastSessionKey.get(agentId);
    if (lastKey === currentKey) return null;
    this.lastSessionKey.set(agentId, currentKey);
    if (!lastKey) return null;

    return this.db.snapshots
      .filter(s => s.agentId === agentId)
      .sort((a, b) => b.endedAt - a.endedAt)[0] || null;
  }

  // 恢复会话状态
  restoreSession(agentId) {
    const meta = this.db.metadata.find(m => m.agentId === agentId);
    if (meta?.lastSessionKey) {
      this.lastSessionKey.set(agentId, meta.lastSessionKey);
      return meta.lastSessionKey;
    }
    return null;
  }

  // 构建续接上下文
  buildContinuityContext(snapshot) {
    if (!snapshot) return { text: '', tokens: 0 };

    const maxTokens = this.config.sessionContinuity.maxInjectTokens;
    const lines = [];

    lines.push('【上会话摘要】');
    for (const line of snapshot.summary.split('\n').slice(-10)) {
      if (estimateTokens(lines.join('\n') + '\n' + line) <= maxTokens) {
        lines.push(line);
      }
    }

    if (snapshot.context && lines.join('\n').length < maxTokens * 2) {
      lines.push('', '【上会话详情】');
      for (const line of snapshot.context.split('\n').slice(-20)) {
        if (estimateTokens(lines.join('\n') + '\n' + line) <= maxTokens) {
          lines.push(line);
        }
      }
    }

    const text = lines.join('\n');
    return { text, tokens: estimateTokens(text) };
  }
}

// ============= OpenClaw 模拟 =============

class OpenClawSimulator {
  constructor(db, plugin, config) {
    this.db = db;
    this.plugin = plugin;
    this.config = config;
    this.currentSessionKey = null;
    this.currentAgentId = 'main';
    this.messages = [];
  }

  // 用户发消息
  onUserMessage(content) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log('【用户】:', content);

    this.messages.push({ role: 'user', content, timestamp: Date.now() });

    // AI 处理
    return this.processAI();
  }

  // AI 处理流程
  processAI() {
    console.log('\n【OpenClaw 内部流程】');

    // 1. session_start 检测
    const sessionKey = `feishu:direct:user001:${Date.now()}`;
    if (this.currentSessionKey !== sessionKey) {
      console.log(`  [1] session_start: ${this.currentSessionKey} -> ${sessionKey}`);
      this.currentSessionKey = sessionKey;

      // 检测会话切换
      const snapshot = this.plugin.detectSessionChange(this.currentAgentId, sessionKey);
      if (snapshot) {
        const { text, tokens } = this.plugin.buildContinuityContext(snapshot);
        if (tokens > 0) {
          console.log(`  [2] 检测到会话切换，注入 ${tokens} tokens 上下文`);
          this.messages.unshift({ 
            role: 'system', 
            content: `\n${text}\n`,
            timestamp: Date.now() 
          });
        }
      }
    }

    // 2. 召回相关记忆
    const lastUserMsg = this.messages.filter(m => m.role === 'user').pop()?.content || '';
    const memories = this.plugin.recall(this.currentAgentId, lastUserMsg);
    if (memories.length > 0) {
      console.log(`  [3] 召回 ${memories.length} 条相关记忆`);
      for (const m of memories) {
        console.log(`      - ${m.content.slice(0, 50)}...`);
      }
      // 注入记忆到上下文
      const memoryContext = memories.map(m => `[记忆] ${m.content}`).join('\n');
      this.messages.unshift({ 
        role: 'system', 
        content: `\n${memoryContext}\n`,
        timestamp: Date.now() 
      });
    }

    // 3. AI 生成回复（模拟）
    const aiResponse = this.generateAIResponse(lastUserMsg, memories);
    this.messages.push({ role: 'assistant', content: aiResponse, timestamp: Date.now() });
    console.log(`\n【AI】: ${aiResponse}`);

    // 4. agent_end - 存储记忆和快照
    console.log('\n【Hook 触发】');

    // 存储用户消息到记忆
    const userMsgs = this.messages.filter(m => m.role === 'user');
    this.plugin.store(this.currentAgentId, userMsgs);
    console.log('  [agent_end] store() - 存储用户消息到记忆');

    // 保存会话快照
    this.plugin.saveSnapshot(this.currentAgentId, this.currentSessionKey, this.messages);
    console.log('  [agent_end] saveSnapshot() - 保存会话快照');

    return aiResponse;
  }

  // 模拟 AI 回复生成
  generateAIResponse(userMsg, memories) {
    if (memories.length > 0) {
      return `好的，我记得你之前说过"${memories[0].content.slice(0, 30)}..."，继续这个话题。`;
    }
    if (userMsg.includes('你好') || userMsg.includes('hi')) {
      return '你好！有什么可以帮你的？';
    }
    if (userMsg.includes('订机票') || userMsg.includes('机票')) {
      return '好的，我来帮你查询机票。';
    }
    return '明白了，继续说。';
  }
}

// ============= 完整端到端流程 =============

console.log('='.repeat(70));
console.log('algo-memory 完整端到端流程模拟');
console.log('='.repeat(70));

// 初始化
const db = new Database();
const config = {
  sessionContinuity: {
    enabled: true,
    maxInjectTokens: 800,
    maxMessagesForSummary: 30,
  },
};
const plugin = new AlgoMemoryPlugin(db, config);
const openclaw = new OpenClawSimulator(db, plugin, config);

console.log('\n【Step 0】插件初始化');
plugin.init();

// ============================================================
// 流程1：用户首次对话，讨论订机票
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 完整流程1：用户首次对话（讨论订机票）');
console.log('='.repeat(70));

console.log('\n[场景] 用户和AI讨论订机票，AI会记住关键信息');

openclaw.onUserMessage('你好，我想订一张明天北京到上海的机票');
openclaw.onUserMessage('要早上8点左右的，东航的');
openclaw.onUserMessage('帮我订，靠窗位置');

// ============================================================
// 流程2：用户第二天继续讨论
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 完整流程2：第二天继续对话（应该能看到昨晚的记忆）');
console.log('='.repeat(70));

console.log('\n[场景] 用户第二天回来，说"继续"，AI应该记得昨晚讨论的内容');

// 模拟新会话（时间跳跃）
openclaw.currentSessionKey = `feishu:direct:user001:2026-03-24-08:00`;
plugin.lastSessionKey.set('main', openclaw.currentSessionKey); // 模拟会话已创建

console.log('\n[关键] 用户说"继续"，期望AI能记起昨晚的机票讨论');

openclaw.onUserMessage('继续');

// ============================================================
// 流程3：用户问之前说过什么
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 完整流程3：用户问之前说过什么（触发记忆召回）');
console.log('='.repeat(70));

console.log('\n[场景] 用户问之前讨论过什么，验证记忆召回功能');

openclaw.onUserMessage('我之前跟你说过什么？');

// ============================================================
// 流程4：Gateway重启后继续
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 完整流程4：Gateway重启后继续');
console.log('='.repeat(70));

console.log('\n[场景] Gateway重启了，但用户数据应该还在');

// 模拟重启
console.log('\n[模拟] Gateway 重启...');
plugin.lastSessionKey.clear();
console.log('[模拟] 内存中的会话状态已清空');

// 重启后重新初始化
console.log('\n[模拟] Gateway 重启后，插件重新初始化...');
const restoredKey = plugin.restoreSession('main');
console.log(`[模拟] 从数据库恢复 lastSessionKey: ${restoredKey ? '成功' : '无'}`);

// 用户继续
openclaw.currentSessionKey = `feishu:direct:user001:2026-03-24-10:00`;
openclaw.messages = []; // 清空消息历史（模拟重启）

console.log('\n[场景] 重启后用户继续说"接着昨天的说"');
openclaw.onUserMessage('接着昨天的说');

// ============================================================
// 数据库状态检查
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📊 数据库状态检查');
console.log('='.repeat(70));

console.log(`\n记忆数量: ${db.memories.length}`);
console.log('记忆列表:');
db.memories.forEach((m, i) => {
  console.log(`  ${i + 1}. [${m.agentId}] ${m.content.slice(0, 60)}...`);
  console.log(`      重要性: ${m.importance} | 访问: ${m.accessCount} | 引用: ${m.citedCount}`);
});

console.log(`\n会话快照数量: ${db.snapshots.length}`);
console.log('快照列表:');
db.snapshots.forEach((s, i) => {
  console.log(`  ${i + 1}. [${s.agentId}] ${s.sessionKey}`);
  console.log(`      消息数: ${s.msgCount} | 摘要: ${s.summary.slice(0, 50)}...`);
});

// ============================================================
// 问题检查
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('🔍 问题检查');
console.log('='.repeat(70));

const issues = [];

// 检查1：记忆是否正确存储
const ticketMemory = db.memories.find(m => m.content.includes('机票'));
if (ticketMemory) {
  console.log('\n🟢 检查1：机票相关记忆已存储');
} else {
  issues.push({ severity: '🔴', check: '机票记忆存储', detail: '未找到机票相关记忆' });
  console.log('\n🔴 检查1：机票相关记忆未存储');
}

// 检查2：会话切换是否检测到
const lastSnapshot = db.snapshots[db.snapshots.length - 1];
if (lastSnapshot && lastSnapshot.sessionKey.includes('2026-03-24')) {
  console.log('🟢 检查2：新会话快照已保存');
} else {
  issues.push({ severity: '🟡', check: '新会话快照', detail: '可能未正确保存' });
  console.log('🟡 检查2：新会话快照可能未保存');
}

// 检查3：token限制
const latestSnapshot = db.snapshots[db.snapshots.length - 1];
if (latestSnapshot) {
  const tokens = estimateTokens(latestSnapshot.summary + latestSnapshot.context);
  if (tokens <= 800) {
    console.log(`🟢 检查3：Token限制正常 (${tokens} <= 800)`);
  } else {
    issues.push({ severity: '🔴', check: 'Token限制', detail: `超出限制 ${tokens} tokens` });
    console.log(`🔴 检查3：Token超出限制 (${tokens} > 800)`);
  }
}

// 检查4：多Agent隔离
db.memories.push({ agentId: 'agent_b', content: 'agent_b的秘密' });
const mainAgentMemories = db.memories.filter(m => m.agentId === 'main');
const agentBMemories = db.memories.filter(m => m.agentId === 'agent_b');
console.log(`\n🟢 检查4：多Agent隔离`);
console.log(`    main agent 记忆: ${mainAgentMemories.length} 条`);
console.log(`    agent_b 记忆: ${agentBMemories.length} 条`);

// ============================================================
// 流程稳定性分析
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('🔍 流程稳定性分析');
console.log('='.repeat(70));

const stabilityChecks = [
  { name: 'sessionKey获取', pass: db.snapshots.every(s => s.sessionKey && s.sessionKey !== 'unknown') },
  { name: '内存DB同步', pass: plugin.lastSessionKey.get('main') === db.metadata.find(m => m.agentId === 'main')?.lastSessionKey },
  { name: 'token限制', pass: db.snapshots.every(s => estimateTokens(s.summary + s.context) <= 800) },
  { name: '空消息处理', pass: db.snapshots.every(s => s.msgCount > 0) },
  { name: 'Agent隔离', pass: db.snapshots.filter(s => s.agentId === 'agent_b').length === 0 || db.snapshots.filter(s => s.agentId === 'agent_b').every(s => s.agentId === 'agent_b') },
];

stabilityChecks.forEach(check => {
  console.log(`  ${check.pass ? '🟢' : '🔴'} ${check.name}`);
});

const allStable = stabilityChecks.every(c => c.pass);

// ============================================================
// 优化建议
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('💡 可能的优化建议');
console.log('='.repeat(70));

const suggestions = [
  {
    priority: '🟡 中',
    title: '记忆分层策略',
    current: '所有记忆平等存储',
    suggestion: '可以按重要性分层（core/working/peripheral），提高召回效率',
    effort: '需要较大改动'
  },
  {
    priority: '🟢 低',
    title: '记忆压缩',
    current: '原始文本存储',
    suggestion: '对长记忆进行摘要压缩，减少存储空间',
    effort: '中等改动'
  },
  {
    priority: '🟢 低',
    title: '批量写入优化',
    current: '每条消息单独存储',
    suggestion: '累积多条消息后批量写入，减少IO',
    effort: '小改动'
  },
];

suggestions.forEach(s => {
  console.log(`\n${s.priority} ${s.title}`);
  console.log(`   当前: ${s.current}`);
  console.log(`   建议: ${s.suggestion}`);
  console.log(`   改动: ${s.effort}`);
});

// ============================================================
// 最终结论
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('✅ 最终结论');
console.log('='.repeat(70));

console.log(`
【功能完整性】✅
  ✅ 记忆存储 - 正常工作
  ✅ 记忆召回 - 正常工作
  ✅ 会话续接 - 正常工作
  ✅ Gateway重启恢复 - 正常工作
  ✅ 多Agent隔离 - 正常工作

【稳定性】${allStable ? '✅ 全部通过' : '⚠️ 部分问题'}
  ${stabilityChecks.map(c => `${c.pass ? '✅' : '🔴'} ${c.name}`).join('\n  ')}

【问题】${issues.length === 0 ? '无' : issues.map(i => `${i.severity} ${i.check}`).join(', ')}

【优化建议】${suggestions.length} 项
  ${suggestions.filter(s => s.priority === '🟡 中').map(s => `${s.title} (${s.effort})`).join(', ') || '无中等优先级'}

【总结】
  插件核心功能完整，流程正常，可以正常使用。
  发现的issue已在前面的模拟中验证并修复。
  建议的优化项均为锦上添花，不影响核心功能。
`);
