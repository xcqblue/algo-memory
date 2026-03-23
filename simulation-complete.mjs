/**
 * algo-memory 完整端到端流程模拟
 * 
 * 包含全部功能：
 * 1. 记忆存储
 * 2. 记忆召回
 * 3. 会话续接
 * 4. 记忆压缩 (普通 + 语义增强)
 * 5. 记忆分层 (core/working/peripheral)
 * 6. 批量写入 (idle检测)
 * 7. 分层历史
 * 8. LLM 集成 (isCoreMemory, extractKeywords, isDuplicateLLM)
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
  return text.replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// ============= 语义压缩 =============

const SEMANTIC_PATTERNS = {
  flight: /([A-Z]{2,}\d{3,4})|航班[号]?\s*([A-Z0-9]+)/gi,
  date: /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?)|(\d{1,2}[-/月]\d{1,2}[日]?)|(今天|明天|后天|昨天)/g,
  time: /(\d{1,2}[时点]\d{0,2}分?)|(\d{1,2}:\d{2})/g,
  money: /(\d+(?:[万千百])?\s*元)|(?:价格|价钱|花费|费用)[：:]?\s*(\d+(?:[万千百])?(?:\.\d+)?(?:元|块)?)/gi,
  location: /([\u4e00-\u9fff]{2,6}(?:省|市|区|县|路|街|道|机场|车站|酒店|医院|学校|商场))/g,
  person: /(?:叫|名叫|姓名|名字)[：:]?\s*([\u4e00-\u9fff]{2,4})/g,
};

function extractSemanticInfo(content) {
  const info = {};
  for (const [key, pattern] of Object.entries(SEMANTIC_PATTERNS)) {
    const matches = content.match(pattern);
    if (matches) {
      (info as any)[key] = [...new Set(matches)].slice(0, 3).join(',');
    }
  }
  return info;
}

function semanticCompress(content, maxLength = 200) {
  if (!content || content.length <= maxLength) return content;

  const info = extractSemanticInfo(content);
  const parts = [];
  const priorityKeys = ['flight', 'date', 'money', 'person', 'location'];

  for (const key of priorityKeys) {
    if ((info as any)[key]) parts.push((info as any)[key]);
  }

  let result = parts.join(' | ');
  if (result.length > maxLength * 0.6) {
    result = result.substring(0, Math.floor(maxLength * 0.6));
  }

  const remaining = maxLength - result.length - 3;
  if (remaining > 20) {
    const first = content.split(/[。！？；\n]/)[0].trim();
    result = result ? `${result} | ${first.length > remaining ? first.substring(0, remaining - 3) + '...' : first}` : first;
  }

  return result.replace(/\s+/g, ' ').trim() || content.substring(0, maxLength);
}

function compressContent(content, maxLength = 200, semanticEnhance = false) {
  if (!content || content.length <= maxLength) return content;
  if (semanticEnhance) return semanticCompress(content, maxLength);

  let compressed = content.replace(/\s+/g, ' ').trim();
  if (compressed.length > maxLength) {
    const sentences = compressed.split(/[。！？；\n]/);
    const result = [];
    let currentLength = 0;
    for (const s of sentences) {
      const t = s.trim();
      if (!t) continue;
      if (currentLength + t.length + 1 <= maxLength) {
        result.push(t);
        currentLength += t.length + 1;
      } else if (result.length === 0) {
        result.push(t.substring(0, maxLength - 3) + '...');
        break;
      } else break;
    }
    compressed = result.join('。');
    if (compressed.length > maxLength) compressed = compressed.substring(0, maxLength - 3) + '...';
  }
  return compressed;
}

function extractKeywords(content) {
  const chinese = content.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const english = content.match(/[a-zA-Z]{3,}/g) || [];
  return [...new Set([...chinese, ...english])].slice(0, 10).join(',');
}

// ============= 分层 =============

function getTier(importance, accessCount, daysOld, config) {
  if (!config.enabled) return importance >= 1.0 ? 'core' : 'working';
  const score = importance * (1 + Math.log10(accessCount + 1));
  if (accessCount >= config.coreThreshold || (score >= 0.7 && daysOld <= config.ageDays)) return 'core';
  if (score < config.peripheralThreshold || daysOld > config.ageDays) return 'peripheral';
  return 'working';
}

// ============= LLM 模拟 =============

class MockLLMClient {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.callCount = 0;
  }

  async isCoreMemory(content) {
    if (!this.config.enabled) return { isCore: false, confidence: 0.5 };
    this.callCount++;
    this.log(`  [LLM] isCoreMemory 调用 #${this.callCount}`);
    
    // 模拟判断
    const isCore = /重要|记住|别忘|never forget|关键/i.test(content);
    return { isCore, confidence: isCore ? 1.0 : 0.5 };
  }

  async extractKeywordsFromLLM(content) {
    if (!this.config.enabled) return extractKeywords(content);
    this.callCount++;
    this.log(`  [LLM] extractKeywords 调用 #${this.callCount}`);
    
    // 模拟关键词提取
    const words = content.match(/[\u4e00-\u9fff]{2,}/g) || [];
    return [...new Set(words)].slice(0, 8).join(',');
  }

  async isDuplicateLLM(text1, text2) {
    if (!this.config.enabled) return { isDuplicate: false, similarity: 0.5 };
    this.callCount++;
    this.log(`  [LLM] isDuplicateLLM 调用 #${this.callCount}`);
    
    const sim = jaccardSimilarity(text1, text2);
    return { isDuplicate: sim >= 0.85, similarity: sim };
  }
}

// ============= 数据库 =============

class Database {
  constructor() {
    this.memories = [];
    this.snapshots = [];
    this.metadata = [];
    this.tierHistory = [];
  }
}

// ============= 批量缓冲区 =============

class BatchBuffer {
  constructor(config, flushCallback) {
    this.config = config;
    this.callback = flushCallback;
    this.memories = [];
    this.timer = null;
    this.lastFlush = Date.now();
  }

  add(memory) {
    this.memories.push(memory);
    if (this.memories.length >= this.config.maxBatchSize) {
      this.flush('批量大小达到');
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.checkIdle(), this.config.bufferMs);
    }
  }

  checkIdle() {
    const idle = Date.now() - this.lastFlush;
    if (idle >= this.config.bufferMs * 0.5 && this.memories.length > 0) {
      this.flush('空闲提前');
    } else {
      this.timer = setTimeout(() => this.flush('定时刷新'), this.config.bufferMs - idle);
    }
  }

  flush(reason) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.memories.length === 0) return;
    const count = this.memories.length;
    this.callback([...this.memories]);
    this.memories = [];
    this.lastFlush = Date.now();
    return count;
  }
}

// ============= 插件主类 =============

class AlgoMemoryPlugin {
  constructor(config, llmClient) {
    this.config = config;
    this.llm = llmClient;
    this.db = new Database();
    this.lastSessionKey = new Map();
    this.batchBuffer = new BatchBuffer(config.batchWrite, mems => this.doFlush(mems));
    this.recallCache = new Map();
  }

  doFlush(memories) {
    for (const m of memories) {
      this.db.memories.push(m);
    }
    if (memories.length > 0) {
      console.log(`    [批量写入] ${memories.length} 条记忆`);
    }
  }

  recordTierChange(memoryId, oldTier, newTier, reason, accessCount) {
    if (oldTier === newTier) return;
    const record = {
      id: generateId(),
      memory_id: memoryId,
      old_tier: oldTier,
      new_tier: newTier,
      reason,
      access_count: accessCount,
      created_at: Date.now()
    };
    this.db.tierHistory.push(record);
    console.log(`    [分层历史] ${oldTier} → ${newTier}, 原因: ${reason}`);
  }

  async store(agentId, messages) {
    console.log(`\n  [store] 收到 ${messages.length} 条消息`);

    for (const msg of messages) {
      if (msg.role !== 'user' || typeof msg.content !== 'string' || msg.content.length < 5) continue;

      const content = normalizeText(msg.content);
      const isCoreKeyword = /记住|重要|别忘/i.test(content);
      let importance = isCoreKeyword ? 1.0 : 0.5;

      // LLM 判断 isCore
      if (this.config.threshold.useLlmForCore && this.llm && !isCoreKeyword) {
        const result = await this.llm.isCoreMemory(content);
        if (result.isCore) {
          importance = result.confidence;
          console.log(`    [LLM] 判定为 ${result.isCore ? 'core' : '普通'}, 置信度: ${result.confidence}`);
        }
      }

      // LLM 提取关键词
      let keywords = extractKeywords(content);
      if (this.config.threshold.useLlmForExtract && this.llm) {
        keywords = await this.llm.extractKeywordsFromLLM(content);
        console.log(`    [LLM] 关键词: ${keywords}`);
      }

      // 压缩存储
      let storedContent = content;
      const semanticEnhance = this.config.compression.semanticEnhance;
      if (this.config.compression.enabled) {
        const beforeLen = content.length;
        storedContent = compressContent(content, this.config.compression.maxLength, semanticEnhance);
        if (storedContent !== content) {
          console.log(`    [压缩] ${beforeLen}字符 → ${storedContent.length}字符`);
        }
      }

      // 分层
      const daysOld = 0;
      const tier = getTier(importance, 1, daysOld, this.config.tier);

      const memory = {
        id: generateId(),
        agentId,
        content: storedContent,
        originalContent: content,
        importance,
        accessCount: 1,
        keywords,
        tier,
        createdAt: Date.now(),
        lastAccessed: Date.now()
      };

      this.batchBuffer.add(memory);
    }
  }

  recall(agentId, query) {
    console.log(`\n  [recall] 查询: "${query}"`);
    
    // 检查 recall 缓存
    const cacheKey = `${agentId}:${query}`;
    if (this.recallCache.has(cacheKey)) {
      console.log(`    [recall] 使用缓存`);
      return this.recallCache.get(cacheKey);
    }

    const queryWords = normalizeText(query).toLowerCase().split(/\s+/);
    
    const results = this.db.memories
      .filter(m => m.agentId === agentId)
      .map(m => {
        const contentWords = m.content.toLowerCase();
        const matchCount = queryWords.filter(w => contentWords.includes(w)).length;
        const score = matchCount / queryWords.length;
        const tierWeight = { core: 1.5, working: 1.0, peripheral: 0.5 }[m.tier] || 1.0;
        
        // 模拟 LLM 去重（如果启用）
        if (this.config.threshold.useLlmForDedup && this.llm && score >= this.config.threshold.dedupUncertaintyMin && score < this.config.threshold.dedupUncertaintyMax) {
          // 简化：直接用 Jaccard
          const sim = jaccardSimilarity(queryWords.join(' '), contentWords);
          return { memory: m, score: score * tierWeight, isDuplicate: sim >= 0.85 };
        }
        
        return { memory: m, score: score * tierWeight, isDuplicate: false };
      })
      .filter(x => x.score > 0 && !x.isDuplicate)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.maxResults);

    // 更新访问统计和分层
    for (const { memory } of results) {
      memory.accessCount++;
      memory.lastAccessed = Date.now();

      const daysOld = (Date.now() - memory.createdAt) / (1000 * 60 * 60 * 24);
      const oldTier = memory.tier;
      const newTier = getTier(memory.importance, memory.accessCount, daysOld, this.config.tier);
      
      if (oldTier !== newTier) {
        this.recordTierChange(memory.id, oldTier, newTier, `accessCount=${memory.accessCount}`, memory.accessCount);
        memory.tier = newTier;
      }
    }

    const memories = results.map(x => x.memory);
    this.recallCache.set(cacheKey, memories);
    return memories;
  }

  saveSnapshot(agentId, sessionKey, messages) {
    if (!this.config.sessionContinuity.enabled || !messages?.length) return;

    const maxMsgs = this.config.sessionContinuity.maxMessagesForSummary;
    const recent = messages.slice(-maxMsgs);

    const summaryLines = [];
    const contextLines = [];
    const seen = new Set();

    for (const m of recent) {
      if (m.role === 'user' && typeof m.content === 'string') {
        const c = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
        summaryLines.push(`用户: ${c}`);
        
        const norm = normalizeText(m.content);
        if (norm.length >= 3 && !seen.has(norm.slice(0, 50))) {
          seen.add(norm.slice(0, 50));
          contextLines.push(`用户: ${norm.length > 300 ? norm.slice(0, 300) + '...' : norm}`);
        }
      } else if (m.role === 'assistant' && m.content && !m.isError) {
        const c = typeof m.content === 'string' ? (m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content) : '[助手]';
        summaryLines.push(`助手: ${c}`);
      }
    }

    const snapshot = {
      id: generateId(),
      agentId,
      sessionKey,
      endedAt: Date.now(),
      summary: summaryLines.join('\n'),
      context: contextLines.join('\n'),
      msgCount: messages.length
    };

    this.db.snapshots.push(snapshot);

    const idx = this.db.metadata.findIndex(m => m.agentId === agentId);
    const meta = { agentId, lastSessionKey: sessionKey, updatedAt: Date.now() };
    if (idx >= 0) this.db.metadata[idx] = meta;
    else this.db.metadata.push(meta);

    this.lastSessionKey.set(agentId, sessionKey);
    console.log(`\n  [快照] 保存会话快照 ${snapshot.id}，${snapshot.msgCount}条消息`);
  }

  detectSessionChange(agentId, currentKey) {
    if (!this.config.sessionContinuity.enabled) return null;

    const lastKey = this.lastSessionKey.get(agentId);
    if (lastKey === currentKey) return null;
    this.lastSessionKey.set(agentId, currentKey);
    if (!lastKey) return null;

    const snapshot = this.db.snapshots
      .filter(s => s.agentId === agentId)
      .sort((a, b) => b.endedAt - a.endedAt)[0];

    if (snapshot) console.log(`\n  [会话切换] ${lastKey} → ${currentKey}`);
    return snapshot;
  }

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

  restoreSession(agentId) {
    const meta = this.db.metadata.find(m => m.agentId === agentId);
    if (meta?.lastSessionKey) {
      this.lastSessionKey.set(agentId, meta.lastSessionKey);
      return meta.lastSessionKey;
    }
    return null;
  }

  flush() {
    this.batchBuffer.flush('手动刷新');
  }
}

// ============= 配置 =============

const config = {
  batchWrite: { enabled: true, bufferMs: 200, maxBatchSize: 5 },
  compression: { enabled: true, maxLength: 150, extractKeywords: true, semanticEnhance: true },
  tier: { enabled: true, coreThreshold: 10, peripheralThreshold: 0.15, ageDays: 60 },
  sessionContinuity: { enabled: true, maxInjectTokens: 600, maxMessagesForSummary: 20 },
  threshold: { useLlmForCore: true, useLlmForExtract: true, useLlmForDedup: true, dedupUncertaintyMin: 0.5, dedupUncertaintyMax: 0.98 },
  maxResults: 5
};

// ============= 运行模拟 =============

console.log('='.repeat(70));
console.log('algo-memory 完整端到端流程模拟');
console.log('包含全部功能：存储/召回/压缩/分层/批量/LLM/会话续接');
console.log('='.repeat(70));

console.log('\n【配置】');
console.log(`  批量写入: ${config.batchWrite.enabled ? '开启' : '关闭'} (bufferMs=${config.batchWrite.bufferMs}, maxBatchSize=${config.batchWrite.maxBatchSize})`);
console.log(`  压缩: ${config.compression.enabled ? '开启' : '关闭'} (maxLength=${config.compression.maxLength}, semantic=${config.compression.semanticEnhance})`);
console.log(`  分层: ${config.tier.enabled ? '开启' : '关闭'} (core≥${config.tier.coreThreshold}次, peripheral<${config.tier.peripheralThreshold})`);
console.log(`  LLM: ${config.threshold.useLlmForCore || config.threshold.useLlmForExtract ? '开启' : '关闭'}`);

// 创建插件（带 LLM 模拟）
const log = (msg) => console.log(msg);
const llm = new MockLLMClient({ enabled: true }, log);
const plugin = new AlgoMemoryPlugin(config, llm);

// 包装主逻辑为 async 函数
async function runSimulation() {

// ============================================================
// 场景1：用户讨论复杂技术问题
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 场景1：用户讨论技术问题（触发LLM和压缩）');
console.log('='.repeat(70));

const session1 = 'feishu:direct:user001:2026-03-20-15:00';
const messages1 = [
  { role: 'user', content: '我想开发一个电商网站，用Python Django框架' },
  { role: 'assistant', content: '好的，Django很适合快速开发电商网站' },
  { role: 'user', content: 'Django的ORM怎么用，能帮我写个用户表的模型吗？' },
  { role: 'assistant', content: '当然，我来帮你写一个用户模型...' },
];

await plugin.store('main', messages1);
plugin.flush();

// ============================================================
// 场景2：用户说"记住"（触发core分层）
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 场景2：用户说"记住"（触发core分层）');
console.log('='.repeat(70));

const messages2 = [
  { role: 'user', content: '记住，我老婆叫小明，我们的结婚纪念日是2027年5月1日' },
  { role: 'assistant', content: '好的，已经记住了' },
];

await plugin.store('main', messages2);
plugin.flush();

// ============================================================
// 场景3：用户多次查询同一话题（触发分层升级）
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 场景3：用户多次查询（触发分层升级）');
console.log('='.repeat(70));

console.log('\n[模拟 8 次 recall 查询 Django]');
for (let i = 0; i < 8; i++) {
  plugin.recall('main', 'Django ORM');
}

console.log('\n[检查分层状态]');
for (const m of plugin.db.memories) {
  if (m.originalContent.includes('Django')) {
    console.log(`  "${m.content.slice(0, 30)}..." → 分层: ${m.tier}, 访问: ${m.accessCount}次`);
  }
}

// ============================================================
// 场景4：会话切换（触发续接）
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 场景4：会话切换（触发续接）');
console.log('='.repeat(70));

plugin.saveSnapshot('main', session1, [...messages1, ...messages2]);

const session2 = 'feishu:direct:user001:2026-03-21-09:00';
const snapshot = plugin.detectSessionChange('main', session2);

if (snapshot) {
  const { text, tokens } = plugin.buildContinuityContext(snapshot);
  console.log(`\n[续接成功] 注入 ${tokens} tokens`);
  console.log('内容预览:');
  console.log(text.slice(0, 200) + '...');
}

// ============================================================
// 场景5：长内容压缩对比
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 场景5：长内容压缩对比（普通 vs 语义）');
console.log('='.repeat(70));

const longContent = '帮我预订明天北京到上海的东航MU5101航班，靠窗位置，价格是1500元，要记住这个偏好';
console.log(`原文: ${longContent} (${longContent.length}字符)`);

const normal = compressContent(longContent, 100, false);
const semantic = compressContent(longContent, 100, true);

console.log(`\n普通压缩(${normal.length}字符): ${normal}`);
console.log(`语义压缩(${semantic.length}字符): ${semantic}`);

// ============================================================
// 场景6：批量写入验证
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 场景6：批量写入验证（5条消息）');
console.log('='.repeat(70));

const batchPlugin = new AlgoMemoryPlugin(config, llm);
await batchPlugin.store('main', [
  { role: 'user', content: '消息1' },
  { role: 'user', content: '消息2' },
  { role: 'user', content: '消息3' },
]);
// 不手动flush，等待200ms看是否自动批量写入

setTimeout(async () => {
  await batchPlugin.store('main', [
    { role: 'user', content: '消息4' },
    { role: 'user', content: '消息5' },
  ]);
  // 此时应该触发批量写入
  
  setTimeout(() => {
    console.log(`\n批量写入后，记忆总数: ${batchPlugin.db.memories.length}`);
    console.log('✅ 批量写入测试完成');
  }, 300);
}, 300);

// ============================================================
// 场景7：分层历史验证
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 场景7：分层历史验证');
console.log('='.repeat(70));

console.log(`\n分层历史记录数: ${plugin.db.tierHistory.length}`);
if (plugin.db.tierHistory.length > 0) {
  console.log('\n历史记录:');
  for (const h of plugin.db.tierHistory) {
    console.log(`  ${h.old_tier} → ${h.new_tier}, 原因: ${h.reason}`);
  }
} else {
  console.log('\n(本次测试中未触发分层变化)');
}

// ============================================================
// 场景8：LLM调用统计
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('📅 场景8：LLM调用统计');
console.log('='.repeat(70));

console.log(`\nLLM 总调用次数: ${llm.callCount}`);
console.log('调用明细: isCoreMemory / extractKeywords / isDuplicateLLM');

// ============================================================
// 最终状态检查
// ============================================================

setTimeout(() => {
  console.log('\n\n' + '='.repeat(70));
  console.log('📊 最终状态检查');
  console.log('='.repeat(70));

  console.log(`\n记忆总数: ${plugin.db.memories.length}`);
  console.log('记忆列表:');
  for (const m of plugin.db.memories) {
    const preview = m.content.length > 35 ? m.content.slice(0, 35) + '...' : m.content;
    console.log(`  [${m.tier}] ${preview}`);
  }

  console.log(`\n会话快照: ${plugin.db.snapshots.length}`);
  console.log(`分层历史: ${plugin.db.tierHistory.length}`);
  console.log(`LLM调用: ${llm.callCount}次`);

  // 问题检查
  console.log('\n\n' + '='.repeat(70));
  console.log('🔍 问题检查');
  console.log('='.repeat(70));

  const issues = [];

  if (plugin.db.memories.length === 0) {
    issues.push('没有记忆被存储');
  }

  const hasCompressed = plugin.db.memories.some(m => m.content.length < m.originalContent.length);
  if (!hasCompressed) {
    console.log('🟡 压缩: 没有记忆被压缩（可能内容不够长）');
  } else {
    console.log('🟢 压缩: 有记忆被压缩');
  }

  const hasCore = plugin.db.memories.some(m => m.tier === 'core');
  if (hasCore) {
    console.log('🟢 分层: 有core层记忆');
  } else {
    console.log('🟡 分层: 没有core层记忆（可能访问次数不够）');
  }

  if (llm.callCount > 0) {
    console.log(`🟢 LLM: 被调用 ${llm.callCount} 次`);
  } else {
    console.log('🟡 LLM: 没有调用');
  }

  if (plugin.db.snapshots.length > 0) {
    console.log('🟢 会话续接: 快照已保存');
  } else {
    issues.push('没有会话快照');
  }

  if (issues.length === 0) {
    console.log('\n✅ 所有检查通过！');
  } else {
    console.log('\n⚠️ 发现问题:', issues.join(', '));
  }

  console.log('\n\n' + '='.repeat(70));
  console.log('✅ 完整端到端流程模拟完成');
  console.log('='.repeat(70));
}, 1000);

} // end runSimulation

// 执行
runSimulation().catch(console.error);
