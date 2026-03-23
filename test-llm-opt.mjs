/**
 * LLM 异步队列 + 缓存复用 + 批量处理 测试
 */

import crypto from 'crypto';

// ============= LLM 缓存 =============
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

// ============= LLM 异步队列 =============
let llmQueue = [];
let llmProcessing = false;
let llmProcessTimer = null;
let llmBatchWindowMs = 200;

function addToQueue(type, content) {
  return new Promise((resolve, reject) => {
    const cacheKey = getCacheKey(type, content);
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`  [缓存命中] ${type} - "${content.substring(0, 30)}..."`);
      resolve(cached);
      return;
    }

    llmQueue.push({ type, content, resolve, reject, addedAt: Date.now() });
    console.log(`  [加入队列] ${type} - "${content.substring(0, 30)}..."`);

    if (!llmProcessTimer) {
      llmProcessTimer = setTimeout(() => processQueue(), llmBatchWindowMs);
    }
  });
}

async function processQueue() {
  if (llmProcessing || llmQueue.length === 0) return;
  llmProcessing = true;
  llmProcessTimer = null;

  const batch = llmQueue.splice(0, 10);
  console.log(`\n  [批量处理] 一次处理 ${batch.length} 个请求`);

  for (const item of batch) {
    const cacheKey = getCacheKey(item.type, item.content);
    const cached = getCached(cacheKey);
    if (cached) {
      item.resolve(cached);
      continue;
    }

    // 模拟 LLM 调用
    await new Promise(r => setTimeout(r, 50));
    const result = item.type === 'isCore' 
      ? { isCore: Math.random() > 0.5, confidence: 0.7 + Math.random() * 0.3 }
      : `关键词1,关键词2,${item.content.substring(0, 10)}`;

    setCache(cacheKey, result);
    item.resolve(result);
    console.log(`  [LLM调用] ${item.type} 完成`);
  }

  llmProcessing = false;
  if (llmQueue.length > 0) {
    llmProcessTimer = setTimeout(() => processQueue(), 100);
  }
}

// ============= 测试 =============
console.log('='.repeat(60));
console.log('LLM 异步队列 + 缓存复用 + 批量处理 测试');
console.log('='.repeat(60));

async function test() {
  console.log('\n【测试1】快速连续发送3条相似消息');
  await addToQueue('isCore', '帮我订明天北京到上海的机票');
  await addToQueue('isCore', '帮我订明天北京到上海的机票'); // 重复
  await addToQueue('extractKeywords', '帮我订明天北京到上海的机票'); // 重复但不同类型

  // 等待队列处理
  await new Promise(r => setTimeout(r, 500));

  console.log('\n【测试2】发送不同内容');
  await addToQueue('isCore', 'Python Django 如何处理用户认证');
  await addToQueue('extractKeywords', 'JavaScript 闭包函数的使用场景');

  await new Promise(r => setTimeout(r, 500));

  console.log('\n【测试3】缓存检查');
  const cached1 = getCached(getCacheKey('isCore', '帮我订明天北京到上海的机票'));
  const cached2 = getCached(getCacheKey('isCore', '完全不相关的内容'));
  console.log(`  缓存命中1 (应该存在): ${cached1 ? '✅' : '❌'}`);
  console.log(`  缓存命中2 (不应该存在): ${cached2 ? '❌' : '✅'}`);

  console.log('\n【测试4】队列状态');
  console.log(`  队列剩余: ${llmQueue.length}`);
  console.log(`  缓存大小: ${llmCache.size}`);

  console.log('\n✅ 测试完成!');
}

test();
