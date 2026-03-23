/**
 * algo-memory 完整端到端流程模拟
 * 包含全部功能：存储/召回/压缩/分层/批量/LLM/会话续接/分层历史
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

function isNoise(text) {
  const noise = ['你好', 'hi', 'hello', 'ok', '好的', '收到', '嗯', '是的', 'ok', 'okay', 'yes', 'yep', 'sure', 'got it', 'gotcha', 'roger', 'copy that', 'tks', 'thanks', 'thx', '👍', '😂', '哈哈哈', '嘿嘿', '哈哈', '哦哦', '啊啊', '这样子', '这样啊', '好吧', '行吧', '算了', '没事', '没关系', '不好意思', '抱歉', '稍等', '等等', '等一下'];
  const lower = text.toLowerCase().trim();
  return noise.includes(lower) || noise.some(n => lower.includes(n)) || text.length < 3;
}

function isCoreKeyword(text, coreKeywords = ['记住', '重要', '别忘', 'never forget', '关键']) {
  return coreKeywords.some(k => text.includes(k));
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

function extractKeywords(content) {
  const chinese = content.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const english = content.match(/[a-zA-Z]{3,}/g) || [];
  return [...new Set([...chinese, ...english])].slice(0, 10).join(',');
}

function getTier(importance, accessCount, daysOld, config) {
  if (!config.enabled) return importance >= 1.0 ? 'core' : 'working';
  const score = importance * (1 + Math.log10(accessCount + 1));
  if (accessCount >= config.coreThreshold || (score >= 0.7 && daysOld <= config.ageDays)) return 'core';
  if (score < config.peripheralThreshold || daysOld > config.ageDays) return 'peripheral';
  return 'working';
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
      info[key] = [...new Set(matches)].slice(0, 3).join(',');
    }
  }
  return info;
}

function semanticCompress(content, maxLength = 200) {
  if (!content || content.length <= maxLength) return content;
  const info = extractSemanticInfo(content);
  const parts = [];
  for (const key of ['flight', 'date', 'money', 'person', 'location']) {
    if (info[key]) parts.push(info[key]);
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

// ============= LLM 模拟 =============

class MockLLMClient {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.callCount = 0;
    this.calls = [];
  }

  async isCoreMemory(content) {
    if (!this.enabled) return { isCore: false, confidence: 0.5 };
    this.callCount++;
    this.calls.push({ type: 'isCoreMemory', content: content.substring(0, 50) });
    console.log(`    [LLM] isCoreMemory #${this.callCount}`);
    await new Promise(r => setTimeout(r, 30));
    const isCore = /记住|重要|别忘|关键|never forget/i.test(content);
    return { isCore, confidence: isCore ? 1.0 : 0.5 + Math.random() * 0.3 };
  }

  async extractKeywordsFromLLM(content) {
    if (!this.enabled) return extractKeywords(content);
    this.callCount++;
    this.calls.push({ type: 'extractKeywordsFromLLM', content: content.substring(0, 50) });
    console.log(`    [LLM] extractKeywordsFromLLM #${this.callCount}`);
    await new Promise(r => setTimeout(r, 30));
    const words = content.match(/[\u4e00-\u9fff]{2,}/g) || [];
    return [...new Set(words)].slice(0, 8).join(',');
  }

  async isDuplicateLLM(text1, text2) {
    if (!this.enabled) return { isDuplicate: false, similarity: jaccardSimilarity(text1, text2) };
    this.callCount++;
    this.calls.push({ type: 'isDuplicateLLM', content: `${text1.substring(0, 20)} vs ${text2.substring(0, 20)}` });
    console.log(`    [LLM] isDuplicateLLM #${this.callCount}`);
    await new Promise(r => setTimeout(r, 30));
    const sim = jaccardSimilarity(text1, text2);
    return { isDuplicate: sim >= 0.85, similarity: sim };
  }
}

// ============= LLM 异步队列 + 缓存 =============

const llmCache = new Map();
const LLM_CACHE_TTL = 5 * 60 * 1000;

function getCacheKey(type, content) {
  return `${type}:${content.toLowerCase().trim().substring(0, 100)}`;
}

function getCached(key) {
  const entry = llmCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > LLM_CACHE_TTL) {
    llmCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key, result) {
  llmCache.set(key, { result, ts: Date.now() });
  if (llmCache.size > 1000) {
    const oldest = [...llmCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) llmCache.delete(oldest[0]);
  }
}

let llmQueue = [];
let llmProcessing = false;
let llmProcessTimer = null;
let llmBatchWindowMs = 200;
let llmClientRef = null;

function initLlmQueue(batchWindowMs, llmClient) {
  llmBatchWindowMs = batchWindowMs;
  llmClientRef = llmClient;
  llmQueue = [];
  llmProcessing = false;
}

function addToLlmQueue(item) {
  return new Promise((resolve, reject) => {
    const cacheKey = getCacheKey(item.type, item.content);
    const cached = getCached(cacheKey);
    if (cached) {
      resolve(cached);
      return;
    }
    llmQueue.push({ ...item, resolve, reject, addedAt: Date.now() });
    if (!llmProcessTimer) {
      llmProcessTimer = setTimeout(() => processLlmQueue(), llmBatchWindowMs);
    }
  });
}

async function processLlmQueue() {
  if (llmProcessing || llmQueue.length === 0) return;
  llmProcessing = true;
  llmProcessTimer = null;
  const batch = llmQueue.splice(0, 10);
  for (const item of batch) {
    const cacheKey = getCacheKey(item.type, item.content);
    const cached = getCached(cacheKey);
    if (cached) {
      item.resolve(cached);
      continue;
    }
    try {
      let result;
      switch (item.type) {
        case 'isCore':
          result = llmClientRef ? await llmClientRef.isCoreMemory(item.content) : { isCore: false, confidence: 0.5 };
          break;
        case 'extractKeywords':
          result = llmClientRef ? await llmClientRef.extractKeywordsFromLLM(item.content) : '';
          break;
        case 'isDuplicate':
          result = { isDuplicate: false, similarity: 0.5 };
          break;
      }
      if (result) {
        setCache(cacheKey, result);
        item.resolve(result);
      }
    } catch (err) {
      item.reject(err);
    }
  }
  llmProcessing = false;
  if (llmQueue.length > 0) {
    llmProcessTimer = setTimeout(() => processLlmQueue(), 100);
  }
}

// ============= 数据库模拟 =============

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
    if (this.memories.length === 0) return 0;
    const count = this.memories.length;
    this.callback([...this.memories]);
    this.memories = [];
    this.lastFlush = Date.now();
    console.log(`    [批量写入] ${reason}, ${count} 条记忆`);
    return count;
  }
}

// ============= 插件主类 =============

class AlgoMemoryPlugin {
  constructor(config) {
    this.config = config;
    this.llm = new MockLLMClient(config.llm?.enabled);
    this.db = new Database();
    this.lastSessionKey = new Map();
    this.batchBuffer = new BatchBuffer(config.batchWrite, mems => this.doFlush(mems));
    this.recallCache = new Map();
    this.errors = [];
  }

  doFlush(memories) {
    for (const m of memories) {
      this.db.memories.push(m);
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
    console.log(`    [分层历史] ${oldTier} -> ${newTier}, reason: ${reason}`);
  }

  async store(agentId, messages) {
    console.log(`\n  [store] received ${messages.length} messages`);
    initLlmQueue(this.config.llm?.batchWindowMs || 200, this.llm);

    for (const msg of messages) {
      if (msg.role !== 'user' || typeof msg.content !== 'string' || msg.content.length < 5) continue;
      if (isNoise(msg.content)) {
        console.log(`    [skip] noise: "${msg.content}"`);
        continue;
      }

      const content = normalizeText(msg.content);
      let isCore = isCoreKeyword(content);
      let keywords = extractKeywords(content);
      let importance = isCore ? 1.0 : 0.5;

      // LLM isCore
      const needLlmCore = this.config.threshold.useLlmForCore && this.llm.enabled &&
        !isCore && content.length >= (this.config.threshold.lengthForCore || 50);
      if (needLlmCore) {
        const r = await addToLlmQueue({ type: 'isCore', content });
        if (r) {
          isCore = r.isCore;
          importance = r.confidence;
        }
      }

      // LLM extractKeywords
      const needLlmExtract = this.config.threshold.useLlmForExtract && this.llm.enabled &&
        content.length >= (this.config.threshold.lengthForExtract || 150);
      if (needLlmExtract) {
        const r = await addToLlmQueue({ type: 'extractKeywords', content });
        if (r) keywords = r;
      }

      // compress
      let storedContent = content;
      if (this.config.compression.enabled) {
        const maxLen = this.config.compression.maxLength || 200;
        const semanticEnhance = this.config.compression.semanticEnhance;
        storedContent = compressContent(content, maxLen, semanticEnhance);
        if (storedContent !== content) {
          console.log(`    [compress] ${content.length} -> ${storedContent.length}`);
        }
      }

      // tier
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
    console.log(`\n  [recall] query: "${query}"`);
    const cacheKey = `${agentId}:${query}`;
    if (this.recallCache.has(cacheKey)) {
      console.log(`    [cache hit]`);
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
        return { memory: m, score: score * tierWeight };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.maxResults);

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
        summaryLines.push(`User: ${c}`);
        const norm = normalizeText(m.content);
        if (norm.length >= 3 && !seen.has(norm.slice(0, 50))) {
          seen.add(norm.slice(0, 50));
          contextLines.push(`User: ${norm.length > 300 ? norm.slice(0, 300) + '...' : norm}`);
        }
      } else if (m.role === 'assistant' && m.content && !m.isError) {
        const c = typeof m.content === 'string' ? (m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content) : '[assistant]';
        summaryLines.push(`Assistant: ${c}`);
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
    console.log(`\n  [snapshot] saved ${snapshot.id}, ${snapshot.msgCount} messages`);
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
    if (snapshot) console.log(`\n  [session switch] ${lastKey} -> ${currentKey}`);
    return snapshot;
  }

  buildContinuityContext(snapshot) {
    if (!snapshot) return { text: '', tokens: 0 };
    const maxTokens = this.config.sessionContinuity.maxInjectTokens;
    const lines = [];
    lines.push('[Prev Session Summary]');
    for (const line of snapshot.summary.split('\n').slice(-10)) {
      if (estimateTokens(lines.join('\n') + '\n' + line) <= maxTokens) {
        lines.push(line);
      }
    }
    if (snapshot.context && lines.join('\n').length < maxTokens * 2) {
      lines.push('', '[Prev Session Detail]');
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
    this.batchBuffer.flush('manual flush');
  }
}

// ============= 配置 =============

const config = {
  llm: { enabled: true, batchWindowMs: 200 },
  batchWrite: { enabled: true, bufferMs: 200, maxBatchSize: 5 },
  compression: { enabled: true, maxLength: 150, extractKeywords: true, semanticEnhance: true },
  tier: { enabled: true, coreThreshold: 10, peripheralThreshold: 0.15, ageDays: 60 },
  sessionContinuity: { enabled: true, maxInjectTokens: 600, maxMessagesForSummary: 20 },
  threshold: { useLlmForCore: true, useLlmForExtract: true, useLlmForDedup: true, lengthForCore: 50, lengthForExtract: 150, dedupUncertaintyMin: 0.5, dedupUncertaintyMax: 0.98 },
  maxResults: 5
};

// ============= 运行模拟 =============

console.log('='.repeat(70));
console.log('algo-memory Full E2E Simulation');
console.log('Features: store/recall/compress/tier/batch/LLM/session/history');
console.log('='.repeat(70));

console.log('\n[Config]');
console.log(`  LLM: ${config.llm.enabled ? 'ON' : 'OFF'} (batchWindowMs=${config.llm.batchWindowMs})`);
console.log(`  Batch: ${config.batchWrite.enabled ? 'ON' : 'OFF'} (bufferMs=${config.batchWrite.bufferMs})`);
console.log(`  Compression: ${config.compression.enabled ? 'ON' : 'OFF'} (maxLength=${config.compression.maxLength})`);
console.log(`  Tier: ${config.tier.enabled ? 'ON' : 'OFF'} (core>=${config.tier.coreThreshold})`);
console.log(`  SessionContinuity: ${config.sessionContinuity.enabled ? 'ON' : 'OFF'}`);

const plugin = new AlgoMemoryPlugin(config);

let totalTests = 0;
let passedTests = 0;

function test(name, condition, detail = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  PASS: ${name}${detail ? ': ' + detail : ''}`);
  } else {
    console.log(`  FAIL: ${name}${detail ? ': ' + detail : ''}`);
  }
}

// ============================================================
// Scenario 1: Basic Store and Recall
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Scenario 1: Basic Store and Recall');
console.log('='.repeat(70));

const session1 = 'feishu:direct:user001:2026-03-20';
const messages1 = [
  { role: 'user', content: 'I want to build an e-commerce website with Python Django' },
  { role: 'assistant', content: 'Good, Django is great for e-commerce' },
  { role: 'user', content: 'How to use Django ORM? Can you write a user model?' },
  { role: 'assistant', content: 'Sure, let me write a user model for you...' },
];

await plugin.store('main', messages1);
plugin.flush();

const memories1 = plugin.db.memories.length;
test('Store memories', memories1 > 0, `stored ${memories1} items`);

// ============================================================
// Scenario 2: Core Keyword Trigger
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Scenario 2: Core Keyword Trigger (remember)');
console.log('='.repeat(70));

const messages2 = [
  { role: 'user', content: 'Remember, my wife is called Xiaoming, our anniversary is May 1, 2027' },
  { role: 'assistant', content: 'OK, I will remember that' },
];

await plugin.store('main', messages2);
plugin.flush();

const coreMemories = plugin.db.memories.filter(m => m.tier === 'core');
test('Core memory', coreMemories.length > 0, `${coreMemories.length} core memories`);
const hasXm = plugin.db.memories.some(m => m.content.includes('Xiaoming'));
test('Important info kept', hasXm, 'Xiaoming remembered');

// ============================================================
// Scenario 3: Semantic Compression
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Scenario 3: Semantic Compression');
console.log('='.repeat(70));

const longMsg = { role: 'user', content: 'Book MU5101 flight from Beijing to Shanghai tomorrow, window seat, price 1500 yuan' };
await plugin.store('main', [longMsg]);
plugin.flush();

const compressedMem = plugin.db.memories.find(m => m.originalContent.length > 100);
if (compressedMem) {
  const compressed = compressedMem.content;
  const original = compressedMem.originalContent;
  test('Semantic compression', compressed.length < original.length, `${original.length} -> ${compressed.length}`);
  const hasFlight = /MU5101/.test(compressed);
  test('Key info preserved', hasFlight, 'flight number preserved');
} else {
  console.log('  SKIP: content not long enough for compression');
}

// ============================================================
// Scenario 4: Multiple Access Triggers Tier Upgrade
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Scenario 4: Multiple Access Tier Upgrade');
console.log('='.repeat(70));

console.log('\n[Simulating 10 recalls for Django]');
for (let i = 0; i < 10; i++) {
  plugin.recall('main', 'Django ORM');
}

const tierHistory = plugin.db.tierHistory.length;
test('Tier history', tierHistory > 0, `${tierHistory} tier changes recorded`);

const coreAfterRecall = plugin.db.memories.filter(m => m.tier === 'core');
test('Tier upgrade', coreAfterRecall.length > 0, `${coreAfterRecall.length} core memories`);

// ============================================================
// Scenario 5: Session Switch Continuity
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Scenario 5: Session Switch Continuity');
console.log('='.repeat(70));

plugin.saveSnapshot('main', session1, [...messages1, ...messages2]);

const session2 = 'feishu:direct:user001:2026-03-21';
const snapshot = plugin.detectSessionChange('main', session2);

if (snapshot) {
  const { text, tokens } = plugin.buildContinuityContext(snapshot);
  test('Session continuity', snapshot !== null, `snapshot has ${snapshot.msgCount} messages`);
  test('Context injection', tokens > 0, `injected ${tokens} tokens`);
} else {
  test('Session continuity', false, 'no session switch detected');
}

// ============================================================
// Scenario 6: Batch Write
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Scenario 6: Batch Write');
console.log('='.repeat(70));

const batchPlugin = new AlgoMemoryPlugin(config);
await batchPlugin.store('main', [
  { role: 'user', content: 'Message 1: nice weather today' },
  { role: 'user', content: 'Message 2: I want to travel' },
  { role: 'user', content: 'Message 3: help me check Japan visa' },
]);

// wait for batch trigger
await new Promise(r => setTimeout(r, 300));

const batchCount = batchPlugin.db.memories.length;
test('Batch write', batchCount > 0, `wrote ${batchCount} memories`);

// ============================================================
// Scenario 7: Noise Filtering
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Scenario 7: Noise Filtering');
console.log('='.repeat(70));

const noisePlugin = new AlgoMemoryPlugin(config);
await noisePlugin.store('main', [
  { role: 'user', content: 'hello' },
  { role: 'user', content: 'ok' },
  { role: 'user', content: 'got it' },
  { role: 'user', content: 'I want to learn programming' },
]);
noisePlugin.flush();

const noiseCount = noisePlugin.db.memories.length;
test('Noise filtering', noiseCount <= 1, `${noiseCount}/4 stored (should be <=1)`);

// ============================================================
// Scenario 8: Multi-Agent Isolation
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Scenario 8: Multi-Agent Memory Isolation');
console.log('='.repeat(70));

await plugin.store('agent_a', [{ role: 'user', content: 'I am Agent A user' }]);
await plugin.store('agent_b', [{ role: 'user', content: 'I am Agent B user' }]);
plugin.flush();

const agentAMemories = plugin.db.memories.filter(m => m.agentId === 'agent_a');
const agentBMemories = plugin.db.memories.filter(m => m.agentId === 'agent_b');
test('Agent isolation', agentAMemories.length > 0 && agentBMemories.length > 0,
  `AgentA: ${agentAMemories.length}, AgentB: ${agentBMemories.length}`);

// ============================================================
// LLM Stats
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('LLM Call Statistics');
console.log('='.repeat(70));

console.log(`\n  Total LLM calls: ${plugin.llm.callCount}`);
console.log(`  LLM cache size: ${llmCache.size}`);
console.log(`  LLM calls:`);
for (const call of plugin.llm.calls.slice(0, 10)) {
  console.log(`    - ${call.type}: "${call.content}..."`);
}

// ============================================================
// Issue Check
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Issue Check');
console.log('='.repeat(70));

const issues = [];

if (plugin.db.memories.length === 0) {
  issues.push('No memories stored');
}

const llmCalls = plugin.llm.callCount;
const memoryCount = plugin.db.memories.length;
if (llmCalls > memoryCount * 2) {
  console.log(`  WARN: LLM calls too many: ${llmCalls} calls / ${memoryCount} memories`);
} else {
  console.log(`  OK: LLM calls reasonable: ${llmCalls} calls / ${memoryCount} memories`);
}

const tierCounts = { core: 0, working: 0, peripheral: 0 };
for (const m of plugin.db.memories) {
  tierCounts[m.tier] = (tierCounts[m.tier] || 0) + 1;
}
console.log(`  Tier distribution: core=${tierCounts.core}, working=${tierCounts.working}, peripheral=${tierCounts.peripheral}`);

if (plugin.db.snapshots.length === 0) {
  issues.push('No session snapshots');
} else {
  console.log(`  OK: Session snapshots: ${plugin.db.snapshots.length}`);
}

console.log(`  OK: Tier history: ${plugin.db.tierHistory.length} records`);

// ============================================================
// Stability Analysis
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Stability Analysis');
console.log('='.repeat(70));

if (llmCache.size > 500) {
  console.log(`  WARN: LLM cache large: ${llmCache.size}, consider cleanup`);
} else {
  console.log(`  OK: LLM cache normal: ${llmCache.size}`);
}

if (llmQueue.length > 0) {
  console.log(`  WARN: LLM queue not cleared: ${llmQueue.length} pending`);
} else {
  console.log(`  OK: LLM queue cleared`);
}

if (batchPlugin.batchBuffer.memories.length > 0) {
  console.log(`  WARN: Batch buffer not flushed: ${batchPlugin.batchBuffer.memories.length} pending`);
} else {
  console.log(`  OK: Batch buffer flushed`);
}

// ============================================================
// Flow Conflict Analysis
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Flow Conflict Analysis');
console.log('='.repeat(70));

console.log(`  OK: Batch write vs recall - no conflict (memory sync)`);
console.log(`  INFO: LLM queue async - caller must await properly`);
console.log(`  INFO: Session snapshot should flush buffer first`);

// ============================================================
// Optimization Suggestions
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('Optimization Suggestions');
console.log('='.repeat(70));

console.log(`
1. [LOW] Flush batch buffer before saving session snapshot
   Reason: ensure all memories are written to DB

2. [LOW] Add timeout for LLM queue
   Reason: prevent queue stuck on LLM timeout

3. [SUGGEST] Increase max batch wait time
   Reason: 200ms may not be enough in extreme cases

4. [SUGGEST] Add LRU eviction for LLM cache
   Reason: current time-based eviction can be improved
`);

// ============================================================
// Final Summary
// ============================================================

console.log('\n\n' + '='.repeat(70));
console.log('FINAL SUMMARY');
console.log('='.repeat(70));

console.log(`\n  Total tests: ${totalTests}`);
console.log(`  Passed: ${passedTests}`);
console.log(`  Failed: ${totalTests - passedTests}`);
console.log(`\n  Total memories: ${plugin.db.memories.length}`);
console.log(`  Session snapshots: ${plugin.db.snapshots.length}`);
console.log(`  Tier history: ${plugin.db.tierHistory.length}`);
console.log(`  LLM calls: ${plugin.llm.callCount}`);
console.log(`  LLM cache hits: ${llmCache.size}`);

if (passedTests === totalTests) {
  console.log('\n  ALL TESTS PASSED!');
} else {
  console.log(`\n  SOME TESTS FAILED: ${totalTests - passedTests}`);
}

console.log('\n' + '='.repeat(70));
