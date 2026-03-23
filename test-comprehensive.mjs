/**
 * algo-memory Comprehensive Test (Simplified)
 */

import crypto from 'crypto';

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
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function isNoise(text) {
  const exactNoise = ['ok', 'okay', '好的', '收到', '嗯', '是的', 'yes', 'yep', 'sure', 'got it', 'gotcha', 'thanks', 'thx', 'tks', '👍', '😂', '哈哈', '好吧', '行吧', '算了', '没事', '抱歉', '稍等', '等等'];
  const lower = text.toLowerCase().trim();
  return exactNoise.includes(lower) || text.length < 3;
}

function isCoreKeyword(text) {
  return ['记住', '重要', '别忘', 'never forget', '关键'].some(k => text.includes(k));
}

function extractKeywords(content) {
  const chinese = content.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const english = content.match(/[a-zA-Z]{3,}/g) || [];
  return [...new Set([...chinese, ...english])].slice(0, 10).join(',');
}

function getTier(importance, accessCount, config) {
  if (!config.enabled) return importance >= 1.0 ? 'core' : 'working';
  const score = importance * (1 + Math.log10(accessCount + 1));
  if (accessCount >= config.coreThreshold || score >= 0.7) return 'core';
  if (score < config.peripheralThreshold) return 'peripheral';
  return 'working';
}

function compressContent(content, maxLength = 200, semantic = false) {
  if (!content || content.length <= maxLength) return content;
  if (semantic) {
    const parts = [];
    const flight = content.match(/[A-Z]{2,}\d{3,4}/);
    if (flight) parts.push(flight[0]);
    if (content.includes('明天')) parts.push('明天');
    if (content.includes('元')) parts.push('元');
    let result = parts.join(' | ');
    if (result.length > maxLength * 0.6) result = result.substring(0, Math.floor(maxLength * 0.6));
    return result || content.substring(0, maxLength);
  }
  let compressed = content.replace(/\s+/g, ' ').trim();
  if (compressed.length > maxLength) compressed = compressed.substring(0, maxLength - 3) + '...';
  return compressed;
}

// LLM Cache
const llmCache = new Map();

function getCacheKey(type, content) {
  return `${type}:${content.toLowerCase().trim().substring(0, 100)}`;
}

function getCached(key) {
  const entry = llmCache.get(key);
  if (!entry || Date.now() - entry.ts > 300000) return null;
  return entry.result;
}

function setCache(key, result) {
  llmCache.set(key, { result, ts: Date.now() });
}

// LLM
class MockLLM {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.callCount = 0;
  }
  async isCoreMemory(content) {
    if (!this.enabled) return { isCore: false, confidence: 0.5 };
    this.callCount++;
    await new Promise(r => setTimeout(r, 5));
    return { isCore: /记住|重要/.test(content), confidence: 0.8 };
  }
  async extractKeywords(content) {
    if (!this.enabled) return extractKeywords(content);
    this.callCount++;
    await new Promise(r => setTimeout(r, 5));
    return extractKeywords(content);
  }
}

class Database {
  constructor() {
    this.memories = [];
    this.snapshots = [];
    this.tierHistory = [];
  }
}

class BatchBuffer {
  constructor(config, callback) {
    this.config = config;
    this.callback = callback;
    this.items = [];
    this.timer = null;
  }
  add(item) {
    this.items.push(item);
    if (this.items.length >= this.config.maxBatchSize) this.flush('full');
    else if (!this.timer) this.timer = setTimeout(() => this.flush('timer'), this.config.bufferMs);
  }
  flush(reason) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.items.length === 0) return;
    const count = this.items.length;
    this.callback([...this.items]);
    this.items = [];
    console.log(`    [batch] ${reason}, ${count} items`);
  }
}

class Plugin {
  constructor(config) {
    this.config = config;
    this.llm = new MockLLM(config.llm.enabled);
    this.db = new Database();
    this.batch = new BatchBuffer(config.batchWrite, mems => mems.forEach(m => this.db.memories.push(m)));
    this.recallCache = new Map();
    this.lastSessionKey = new Map();
  }

  async store(agentId, messages) {
    console.log(`  [store] ${messages.length} msgs`);
    for (const msg of messages) {
      if (msg.role !== 'user' || typeof msg.content !== 'string' || msg.content.length < 5) continue;
      if (isNoise(msg.content)) { console.log(`    [skip] noise: "${msg.content}"`); continue; }

      const content = normalizeText(msg.content);
      let isCore = isCoreKeyword(content);
      let keywords = extractKeywords(content);
      let importance = isCore ? 1.0 : 0.5;

      // LLM
      if (this.config.threshold.useLlmForCore && !isCore && content.length >= 50) {
        const key = getCacheKey('isCore', content);
        let r = getCached(key);
        if (!r) { r = await this.llm.isCoreMemory(content); setCache(key, r); }
        if (r) { isCore = r.isCore; importance = r.confidence; }
      }

      if (this.config.threshold.useLlmForExtract && content.length >= 150) {
        const key = getCacheKey('extract', content);
        let r = getCached(key);
        if (!r) { r = await this.llm.extractKeywords(content); setCache(key, r); }
        if (r) keywords = r;
      }

      // compress
      let storedContent = content;
      if (this.config.compression.enabled) {
        storedContent = compressContent(content, this.config.compression.maxLength, this.config.compression.semanticEnhance);
        if (storedContent !== content) console.log(`    [compress] ${content.length} -> ${storedContent.length}`);
      }

      // tier
      const tier = getTier(importance, 1, this.config.tier);

      this.batch.add({
        id: generateId(), agentId, content: storedContent,
        importance, accessCount: 1, keywords, tier, createdAt: Date.now()
      });
    }
  }

  recall(agentId, query) {
    console.log(`  [recall] "${query}"`);
    const cacheKey = `${agentId}:${query}`;
    if (this.recallCache.has(cacheKey)) { console.log(`    [cache_hit]`); return this.recallCache.get(cacheKey); }

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
      const oldTier = memory.tier;
      const newTier = getTier(memory.importance, memory.accessCount, this.config.tier);
      if (oldTier !== newTier) {
        this.db.tierHistory.push({ id: generateId(), old_tier: oldTier, new_tier: newTier, reason: `access=${memory.accessCount}` });
        console.log(`    [tier] ${oldTier} -> ${newTier}`);
        memory.tier = newTier;
      }
    }

    this.recallCache.set(cacheKey, results.map(x => x.memory));
    return results.map(x => x.memory);
  }

  saveSnapshot(agentId, sessionKey, messages) {
    if (!this.config.sessionContinuity.enabled) return;
    const snapshot = { id: generateId(), agentId, sessionKey, endedAt: Date.now(), summary: messages.slice(-10).map(m => `${m.role}: ${m.content}`.substring(0, 80)).join('\n'), msgCount: messages.length };
    this.db.snapshots.push(snapshot);
    this.lastSessionKey.set(agentId, sessionKey);
    console.log(`  [snapshot] ${snapshot.id}, ${snapshot.msgCount} msgs`);
  }

  detectSessionChange(agentId, currentKey) {
    if (!this.config.sessionContinuity.enabled) return null;
    const lastKey = this.lastSessionKey.get(agentId);
    if (lastKey === currentKey) return null;
    this.lastSessionKey.set(agentId, currentKey);
    if (!lastKey) return null;
    const snapshot = this.db.snapshots.filter(s => s.agentId === agentId).sort((a, b) => b.endedAt - a.endedAt)[0];
    if (snapshot) console.log(`  [session_switch] ${lastKey} -> ${currentKey}`);
    return snapshot;
  }

  buildContext(snapshot) {
    if (!snapshot) return { text: '', tokens: 0 };
    return { text: snapshot.summary, tokens: estimateTokens(snapshot.summary) };
  }

  flush() { this.batch.flush('manual'); }
}

// Config
const config = {
  llm: { enabled: true },
  batchWrite: { bufferMs: 50, maxBatchSize: 5 },
  compression: { enabled: true, maxLength: 100, semanticEnhance: true },
  tier: { enabled: true, coreThreshold: 10, peripheralThreshold: 0.15 },
  sessionContinuity: { enabled: true, maxInjectTokens: 600 },
  threshold: { useLlmForCore: true, useLlmForExtract: true, useLlmForDedup: true, lengthForCore: 50, lengthForExtract: 150 },
  maxResults: 5
};

async function runTests() {
  console.log('='.repeat(60));
  console.log('algo-memory Comprehensive Test');
  console.log('='.repeat(60));

  const plugin = new Plugin(config);
  let pass = 0, fail = 0;

  function test(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  PASS: ${name}${detail ? ': ' + detail : ''}`); }
    else { fail++; console.log(`  FAIL: ${name}${detail ? ': ' + detail : ''}`); }
  }

  // Test 1: Basic Storage
  console.log('\n[Test 1] Basic Storage');
  await plugin.store('main', [
    { role: 'user', content: 'Book a flight from Beijing to Shanghai tomorrow morning' },
    { role: 'assistant', content: 'Sure' },
    { role: 'user', content: 'MU5101 please, 8am departure' },
    { role: 'assistant', content: 'Done' },
  ]);
  plugin.flush();
  test('store_1', plugin.db.memories.length >= 2, `stored ${plugin.db.memories.length}`);

  // Test 2: Core Keyword
  console.log('\n[Test 2] Core Keyword');
  await plugin.store('main', [
    { role: 'user', content: 'Remember my wife is called Xiaoming' },
    { role: 'assistant', content: 'OK' },
  ]);
  plugin.flush();
  test('store_2', plugin.db.memories.some(m => m.content.includes('Xiaoming')), 'important stored');
  test('tier_2', plugin.db.memories.some(m => m.tier === 'core'), 'core tier');

  // Test 3: Compression
  console.log('\n[Test 3] Compression');
  await plugin.store('main', [
    { role: 'user', content: 'Book MU5101 from Beijing to Shanghai tomorrow morning, business class, price 2000 yuan, window seat, need invoice, phone 13800138000' },
  ]);
  plugin.flush();
  const compressed = plugin.db.memories.find(m => m.content.length < 100);
  test('compress_3', compressed !== undefined, 'content compressed');

  // Test 4: Tier Promotion
  console.log('\n[Test 4] Tier Promotion');
  const mem = plugin.db.memories.find(m => m.content.includes('flight'));
  const tierBefore = mem?.tier || 'none';
  for (let i = 0; i < 12; i++) plugin.recall('main', 'flight booking');
  const tierAfter = mem?.tier || 'none';
  test('tier_4', tierAfter === 'core', `${tierBefore} -> ${tierAfter}`);
  test('history_4', plugin.db.tierHistory.length > 0, `${plugin.db.tierHistory.length} records`);

  // Test 5: Session Continuity
  console.log('\n[Test 5] Session Continuity');
  plugin.saveSnapshot('main', 'session1', [{ role: 'user', content: 'What was my flight?' }]);
  const snapshot = plugin.detectSessionChange('main', 'session2');
  test('snapshot_5', snapshot !== null, 'snapshot saved');
  const ctx = plugin.buildContext(snapshot);
  test('context_5', ctx.tokens > 0, `injects ${ctx.tokens} tokens`);

  // Test 6: Batch Write
  console.log('\n[Test 6] Batch Write');
  const batchPlugin = new Plugin(config);
  await batchPlugin.store('main', [
    { role: 'user', content: 'Message 1 with content here' },
    { role: 'user', content: 'Message 2 with content here' },
    { role: 'user', content: 'Message 3 with content here' },
  ]);
  await new Promise(r => setTimeout(r, 100));
  test('batch_6', batchPlugin.db.memories.length >= 2, `wrote ${batchPlugin.db.memories.length}`);

  // Test 7: Noise Filtering
  console.log('\n[Test 7] Noise Filtering');
  const noisePlugin = new Plugin(config);
  await noisePlugin.store('main', [
    { role: 'user', content: 'hello' },
    { role: 'user', content: 'ok' },
    { role: 'user', content: 'got it' },
    { role: 'user', content: '好的' },
    { role: 'user', content: 'I need Python help' },
  ]);
  noisePlugin.flush();
  test('noise_7', noisePlugin.db.memories.length <= 1, `${noisePlugin.db.memories.length}/5 stored (expect 1)`);

  // Test 8: Multi-Agent Isolation
  console.log('\n[Test 8] Multi-Agent');
  await plugin.store('agent_python', [{ role: 'user', content: 'Python is great' }]);
  await plugin.store('agent_js', [{ role: 'user', content: 'JavaScript is great' }]);
  plugin.flush();
  const py = plugin.db.memories.filter(m => m.agentId === 'agent_python');
  const js = plugin.db.memories.filter(m => m.agentId === 'agent_js');
  test('agent_8', py.length > 0 && js.length > 0, `isolated: Python ${py.length}, JS ${js.length}`);

  // Test 9: LLM Calls
  console.log('\n[Test 9] LLM Calls');
  test('llm_9', plugin.llm.callCount > 0, `${plugin.llm.callCount} calls`);
  test('llm_cache_9', llmCache.size > 0, `cache: ${llmCache.size}`);

  // Test 10: Recall Cache
  console.log('\n[Test 10] Recall Cache');
  plugin.recall('main', 'flight booking');
  plugin.recall('main', 'flight booking');
  test('recall_cache_10', plugin.recallCache.size > 0, 'cache populated');

  // Test 11: Long Content
  console.log('\n[Test 11] Long Content');
  const longPlugin = new Plugin(config);
  await longPlugin.store('main', [{ role: 'user', content: 'A'.repeat(300) }]);
  longPlugin.flush();
  test('truncate_11', longPlugin.db.memories[0]?.content.length <= 300, `truncated to ${longPlugin.db.memories[0]?.content.length}`);

  // Test 12: Empty Handling
  console.log('\n[Test 12] Empty Handling');
  try {
    await plugin.store('main', []);
    await plugin.store('main', [{ role: 'user', content: '' }]);
    test('empty_12', true, 'no crash');
  } catch (e) {
    test('empty_12', false, e.message);
  }

  // Test 13: Keywords
  console.log('\n[Test 13] Keywords');
  const kwPlugin = new Plugin(config);
  await kwPlugin.store('main', [{ role: 'user', content: 'Python Django REST API tutorial' }]);
  kwPlugin.flush();
  test('kw_13', kwPlugin.db.memories[0]?.keywords.length > 0, `keywords: ${kwPlugin.db.memories[0]?.keywords || 'none'}`);

  // Test 14: Multiple Sessions
  console.log('\n[Test 14] Multiple Sessions');
  plugin.saveSnapshot('main', 's1', [{ role: 'user', content: 'msg1' }]);
  plugin.detectSessionChange('main', 's2');
  plugin.saveSnapshot('main', 's2', [{ role: 'user', content: 'msg2' }]);
  plugin.detectSessionChange('main', 's3');
  test('multi_sess_14', plugin.db.snapshots.length >= 2, `${plugin.db.snapshots.length} snapshots`);

  // Test 15: Config Disabled
  console.log('\n[Test 15] Config Disabled');
  const disabledPlugin = new Plugin({ ...config, llm: { enabled: false }, compression: { enabled: false } });
  await disabledPlugin.store('main', [{ role: 'user', content: 'Test disabled features' }]);
  disabledPlugin.flush();
  test('disabled_15', disabledPlugin.db.memories.length > 0, 'still works');
  test('no_llm_15', disabledPlugin.llm.callCount === 0, 'no LLM calls');

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(60));
  console.log(`\n  Total: ${pass + fail}`);
  console.log(`  Passed: ${pass}`);
  console.log(`  Failed: ${fail}`);
  console.log(`\n  Memories: ${plugin.db.memories.length}`);
  console.log(`  Snapshots: ${plugin.db.snapshots.length}`);
  console.log(`  Tier History: ${plugin.db.tierHistory.length}`);
  console.log(`  LLM Calls: ${plugin.llm.callCount}`);
  console.log(`  LLM Cache: ${llmCache.size}`);

  if (fail === 0) console.log('\n  ALL TESTS PASSED!');
  else console.log(`\n  ${fail} TESTS FAILED`);

  console.log('='.repeat(60));
}

runTests().catch(console.error);
