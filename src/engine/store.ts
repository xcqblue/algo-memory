/**
 * algo-memory v2.3.0 - Storage Engine
 */

import { DEFAULT_VALUES } from '../types.js';
import type { Config, Memory } from '../types.js';
import {
  isNoise,
  isCoreKeyword,
  extractKeywords,
  jaccardSimilarity,
  getTier,
  generateId,
  hashContent,
  compressContent,
  extractContentSummary,
  extractMessageText,
  normalizeText,
  stripInboundMetadata,
  isMetadataLike,
  MAX_MESSAGE_LENGTH,
  MAX_SIMILAR_CHECK
} from '../utils.js';
import { queryAll, queryOne, run, runOrThrow } from '../db/queries.js';
import { LLMClient } from './llm.js';
import type { DbLike } from '../db/queries.js';

// ============= Batch Write Buffer（动态调整优化）=============
interface MemoryBuffer {
  memories: Memory[];
  timer: NodeJS.Timeout | null;
  lastFlush: number; // 上次刷新时间
  baseBufferMs: number; // 基础buffer时间
  messageCount: number; // 消息计数（用于动态调整）
  flushing: boolean; // 互斥标志，防止 flush 期间 schedule 冲突
}

const memoryBuffers: Map<string, MemoryBuffer> = new Map();

// 用户活动跟踪（用于idle检测）
const userActivity: Map<string, number> = new Map();

function getBuffer(AgentId: string, config: Config): MemoryBuffer {
  if (!memoryBuffers.has(AgentId)) {
    memoryBuffers.set(AgentId, {
      memories: [],
      timer: null,
      lastFlush: Date.now(),
      baseBufferMs: config.batchWrite?.bufferMs || DEFAULT_VALUES.BATCH_BUFFER_MS,
      messageCount: 0,
      flushing: false
    });
  }
  return memoryBuffers.get(AgentId)!;
}

// 动态计算bufferMs（根据消息频率调整）
function getDynamicBufferMs(buffer: MemoryBuffer): number {
  const base = buffer.baseBufferMs;
  const count = buffer.messageCount;

  // 快速消息流（高频率）：减少等待时间
  if (count > 20) return Math.max(100, base * 0.3);
  if (count > 10) return Math.max(200, base * 0.5);
  if (count > 5) return Math.max(300, base * 0.7);

  // 慢速消息流：使用正常等待时间
  return base;
}

// 增加消息计数并重置（用于动态调整）
function incrementMessageCount(AgentId: string): void {
  const buffer = memoryBuffers.get(AgentId);
  if (buffer) {
    buffer.messageCount++;
    // 每分钟重置计数
    setTimeout(() => {
      if (buffer) buffer.messageCount = 0;
    }, 60000);
  }
}

// ============= LLM 异步队列 =============
interface LlmQueueItem {
  type: 'isCore' | 'extractKeywords' | 'isDuplicate';
  content: string;
  resolve: (result: any) => void;
  reject: (err: any) => void;
  addedAt: number;
}

interface LlmRequest {
  type: 'isCore' | 'extractKeywords' | 'isDuplicate';
  content: string;
}

// ============= LLM 队列单例（优化2）=============
interface LlmQueueSingleton {
  queue: LlmQueueItem[];
  processing: boolean;
  processTimer: NodeJS.Timeout | null;
  batchWindowMs: number;
  llmClient: LLMClient | null;
}

const llmSingleton: LlmQueueSingleton = {
  queue: [],
  processing: false,
  processTimer: null,
  batchWindowMs: 200,
  llmClient: null,
};

// LLM 结果缓存（带LRU优化）
const llmCache = new Map<string, { result: any; ts: number; accessCount: number }>();
const LLM_CACHE_TTL = DEFAULT_VALUES.LLM_CACHE_TTL_MS; // 5分钟
const LLM_CACHE_MAX_SIZE = DEFAULT_VALUES.LLM_CACHE_MAX_SIZE;
const CACHE_KEY_PREFIX = 'llm'; // 缓存key前缀

// ============= 缓存辅助函数（合并缓存检查）=============
/**
 * 生成缓存key
 */
function getLlmCacheKey(type: string, content: string): string {
  return `${CACHE_KEY_PREFIX}:${type}:${content.toLowerCase().trim().substring(0, 100)}`;
}

// ============= SQL构建辅助函数（统一SQL构建）=============
// Memory表字段顺序
const MEMORY_COLUMNS = [
  'id', 'agent_id', 'scope', 'content', 'type', 'tier', 'layer',
  'keywords', 'importance', 'access_count', 'cited_count',
  'tier_confidence', 'last_tier_update',
  'created_at', 'last_accessed', 'content_hash', 'metadata'
] as const;

/**
 * 构建批量INSERT的占位符和参数
 * @param memories 记忆数组
 * @returns { placeholders: string, params: any[] }
 */
function buildMemoryBatchInsert(memories: Memory[]): { placeholders: string; params: any[] } {
  const placeholders = memories.map(() =>
    `(${MEMORY_COLUMNS.map(() => '?').join(', ')})`
  ).join(', ');

  const params = memories.flatMap(m =>
    MEMORY_COLUMNS.map(col => {
      const key = col as string;
      return (m as any)[key];
    })
  );

  return { placeholders, params };
}

/**
 * 构建单个INSERT的占位符和参数
 * @param memory 单个记忆
 * @returns { placeholders: string, params: any[] }
 */
function buildMemoryInsert(memory: Memory): { placeholders: string; params: any[] } {
  const { placeholders, params } = buildMemoryBatchInsert([memory]);
  // 去掉外层括号
  return {
    placeholders: placeholders.replace(/^\(|\)$/g, ''),
    params
  };
}

// ============= LLM 重试机制（优化3）=============
const LLM_MAX_RETRIES = 2;
const LLM_RETRY_BASE_DELAY_MS = 500;

/**
 * 带重试的 LLM 调用
 * 临时失败时自动重试，最多 LLM_MAX_RETRIES 次
 */
async function llmWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = LLM_MAX_RETRIES
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      
      // 如果还有重试次数，等待后重试（指数退避）
      if (attempt < maxRetries - 1) {
        const delay = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // 所有重试都失败，抛出最后一个错误
  throw lastError;
}

function getCachedResult(key: string): any | null {
  const entry = llmCache.get(key);
  if (!entry) return null;
  // LRU: 更新访问时间
  entry.accessCount++;
  entry.ts = Date.now();
  if (Date.now() - entry.ts > LLM_CACHE_TTL) {
    llmCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCachedResult(key: string, result: any): void {
  // LRU淘汰：超过最大容量时删除最少使用的
  if (llmCache.size >= LLM_CACHE_MAX_SIZE) {
    let oldest: string | null = null;
    let minAccess = Infinity;
    for (const [k, v] of llmCache.entries()) {
      if (v.accessCount < minAccess) {
        minAccess = v.accessCount;
        oldest = k;
      }
    }
    if (oldest) llmCache.delete(oldest);
  }
  llmCache.set(key, { result, ts: Date.now(), accessCount: 0 });
}

function initLlmQueue(batchWindowMs: number, llmClient: LLMClient | null): void {
  // 单例模式：只更新配置，不重新初始化队列
  llmSingleton.batchWindowMs = batchWindowMs || 200;
  llmSingleton.llmClient = llmClient;
}

function addToLlmQueue(item: LlmRequest): Promise<any> {
  return new Promise((resolve, reject) => {
    const cacheKey = getLlmCacheKey(item.type, item.content);

    // 统一缓存检查
    const cached = getCachedResult(cacheKey);
    if (cached !== null) {
      resolve(cached);
      return;
    }

    llmSingleton.queue.push({ ...item, addedAt: Date.now(), resolve, reject });

    if (!llmSingleton.processTimer) {
      llmSingleton.processTimer = setTimeout(() => processLlmQueue(), llmSingleton.batchWindowMs);
    }
  });
}

async function processLlmQueue(): Promise<void> {
  if (llmSingleton.processing || llmSingleton.queue.length === 0) return;
  llmSingleton.processing = true;
  llmSingleton.processTimer = null;

  const batch = llmSingleton.queue.splice(0, 10);

  for (const item of batch) {
    const cacheKey = getLlmCacheKey(item.type, item.content);

    // 统一缓存检查
    const cached = getCachedResult(cacheKey);
    if (cached !== null) {
      item.resolve(cached);
      continue;
    }

    try {
      let result: any;
      // 带超时和重试的LLM调用
      const timeoutPromise = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('LLM timeout')), DEFAULT_VALUES.LLM_TIMEOUT_MS)
      );

      switch (item.type) {
        case 'isCore':
          if (llmSingleton.llmClient) {
            const llmPromise = llmSingleton.llmClient.isCoreMemory(item.content);
            const racePromise = Promise.race([llmPromise, timeoutPromise]);
            result = await llmWithRetry(() => racePromise).catch(() => ({ isCore: false, confidence: 0.5 }));
          } else {
            result = { isCore: false, confidence: 0.5 };
          }
          break;
        case 'extractKeywords':
          if (llmSingleton.llmClient) {
            const llmPromise = llmSingleton.llmClient.extractKeywordsFromLLM(item.content);
            const racePromise = Promise.race([llmPromise, timeoutPromise]);
            result = await llmWithRetry(() => racePromise).catch(() => '');
          } else {
            result = '';
          }
          break;
        case 'isDuplicate':
          result = { isDuplicate: false, similarity: 0.5 };
          break;
      }
      if (result) {
        setCachedResult(cacheKey, result);
        item.resolve(result);
      }
    } catch (err) {
      // 错误边界：失败时返回默认值，不阻塞流程
      console.warn(`[algo-memory] LLM调用失败: ${err}`);
      item.resolve(item.type === 'isCore' ? { isCore: false, confidence: 0.5 } : '');
    }
  }

  llmSingleton.processing = false;

  if (llmSingleton.queue.length > 0) {
    llmSingleton.processTimer = setTimeout(() => processLlmQueue(), 100);
  }
}

/**
 * 检测用户是否空闲
 * 如果用户在 bufferMs 内没有新活动，可以提前刷新
 */
function checkIdleAndFlush(db: DbLike, AgentId: string, config: Config, log: any): void {
  const buffer = getBuffer(AgentId, config);
  if (buffer.memories.length === 0 || buffer.flushing) return;

  const idleTime = Date.now() - buffer.lastFlush;
  const dynamicBufferMs = getDynamicBufferMs(buffer);

  // 如果空闲时间超过动态bufferMs的50%，就提前刷新
  if (idleTime >= dynamicBufferMs * 0.5) {
    log.info(`[algo-memory] 检测到用户空闲 ${idleTime}ms，提前刷新批量缓冲区（动态bufferMs: ${dynamicBufferMs}）`);
    flushMemoryBuffer(db, AgentId, config, log);
  }
}

/**
 * 将记忆批量写入数据库
 */
function flushMemoryBuffer(db: DbLike, AgentId: string, config: Config, log: any): number {
  const buffer = memoryBuffers.get(AgentId);
  if (!buffer || buffer.memories.length === 0) return 0;

  // 互斥锁：防止 flush 期间 scheduleBatchWrite 写入旧数据
  if (buffer.flushing) return 0;
  buffer.flushing = true;

  try {
    // 清除定时器
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    const memoriesToWrite = buffer.memories;
    buffer.memories = [];
    buffer.lastFlush = Date.now();

    if (memoriesToWrite.length === 0) return 0;

    let inserted = 0;
    try {
      // 统一SQL构建
      const { placeholders, params } = buildMemoryBatchInsert(memoriesToWrite);

      run(db,
        `INSERT INTO memories (${MEMORY_COLUMNS.join(', ')}) VALUES ${placeholders}`,
        params
      );

      inserted = memoriesToWrite.length;
      log.info(`[algo-memory] 批量写入完成: ${inserted} 条记忆`);
    } catch (err) {
      log.error('[algo-memory] 批量写入失败:', err);
    }

    return inserted;
  } finally {
    buffer.flushing = false;
  }
}

/**
 * 记录分层变化历史
 */
function recordTierChange(db: DbLike, memoryId: string, oldTier: string, newTier: string, reason: string, accessCount: number, log: any): void {
  if (oldTier === newTier) return;

  try {
    const id = 'th_' + generateId();
    run(db,
      `INSERT INTO tier_history (id, memory_id, old_tier, new_tier, reason, access_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, memoryId, oldTier, newTier, reason, accessCount, Date.now()]
    );
    log.info(`[algo-memory] 分层变化: ${memoryId} ${oldTier} -> ${newTier} (${reason})`);
  } catch (err) {
    log.error('[algo-memory] 记录分层变化失败:', err);
  }
}

/**
 * 计划批量写入（延迟执行）
 */
function scheduleBatchWrite(db: DbLike, AgentId: string, config: Config, log: any): void {
  const buffer = getBuffer(AgentId, config);

  // 如果正在 flush 或已有定时器，不重复创建
  if (buffer.flushing || buffer.timer) return;

  // 增加消息计数（用于动态调整）
  incrementMessageCount(AgentId);

  // 计划在动态bufferMs后执行批量写入
  const dynamicBufferMs = getDynamicBufferMs(buffer);
  buffer.timer = setTimeout(() => {
    buffer.timer = null;
    flushMemoryBuffer(db, AgentId, config, log);
  }, dynamicBufferMs);
}

/**
 * 强制立即写入所有待处理的记忆
 */
export function flushAllBuffers(db: DbLike, config: Config, log: any): number {
  let total = 0;
  for (const AgentId of memoryBuffers.keys()) {
    total += flushMemoryBuffer(db, AgentId, config, log);
  }
  return total;
}

/**
 * 用户活动通知（用于idle检测）
 * 当检测到用户空闲时，触发提前刷新
 */
export function notifyUserActivity(AgentId: string): void {
  userActivity.set(AgentId, Date.now());
}

// ============= 内存缓冲区清理（优化2）=============
const BUFFER_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时清理一次
let bufferCleanupTimer: NodeJS.Timeout | null = null;
let isCleanupRunning = false;

/**
 * 清理无用的内存缓冲区
 * 删除空的、没有活跃定时器的缓冲区，防止内存无限增长
 */
export function cleanupEmptyBuffers(log: any): number {
  if (isCleanupRunning) return 0;
  isCleanupRunning = true;
  
  let cleanedCount = 0;
  const now = Date.now();
  
  for (const [AgentId, buffer] of memoryBuffers.entries()) {
    // 只有当缓冲区为空且没有活跃定时器时才清理
    if (buffer.memories.length === 0 && buffer.timer === null) {
      // 检查是否长时间未使用（超过1小时）
      const idleTime = now - buffer.lastFlush;
      if (idleTime > BUFFER_CLEANUP_INTERVAL_MS) {
        memoryBuffers.delete(AgentId);
        cleanedCount++;
      }
    }
  }
  
  isCleanupRunning = false;
  
  if (cleanedCount > 0) {
    log.info(`[algo-memory] 清理了 ${cleanedCount} 个无用内存缓冲区`);
  }
  
  return cleanedCount;
}

/**
 * 启动定期清理定时器
 * 应该在插件初始化时调用一次
 */
export function startBufferCleanup(log: any): void {
  if (bufferCleanupTimer !== null) return; // 防止重复启动
  
  bufferCleanupTimer = setInterval(() => {
    cleanupEmptyBuffers(log);
  }, BUFFER_CLEANUP_INTERVAL_MS);
  
  // 标记为不阻止进程退出
  bufferCleanupTimer.unref();
}

/**
 * 停止定期清理定时器
 * 应该在插件销毁时调用
 */
export function stopBufferCleanup(): void {
  if (bufferCleanupTimer !== null) {
    clearInterval(bufferCleanupTimer);
    bufferCleanupTimer = null;
  }
}

/**
 * Score a message by how many core keywords it contains.
 * Higher score = more likely to be worth storing.
 */
function messagePriority(content: string, coreKeywords: string[]): number {
  if (!coreKeywords.length) return 0;
  const lower = content.toLowerCase();
  return coreKeywords.filter(kw => lower.includes(kw.toLowerCase())).length;
}

// Raw row types returned by queryAll
type IdRow = { id: string };
type IdContentRow = { id: string; content: string };
type TierRow = { id: string; tier: string; importance: number; access_count: number; created_at: number };

// Normalize content before storing: strip @mentions, compress whitespace, remove markdown noise
export function normalizeForStorage(content: string): string {
  let text = typeof content === 'string' ? content : String(content ?? '');
  // Strip Conversation info metadata injected by OpenClaw
  text = stripInboundMetadata(text);
  text = text
    // Strip @mentions
    .replace(/@\w+/g, '')
    // Compress multiple whitespace to single space
    .replace(/\s+/g, ' ')
    // Remove common markdown noise (keep the text, not the markup)
    .replace(/```[\s\S]*?```/g, m => m.replace(/```/g, '')) // strip code blocks, keep inner text
    .replace(/`([^`]+)`/g, '$1')  // strip inline code markers, keep text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // strip bold
    .replace(/\*([^*]+)\*/g, '$1')   // strip italic
    .replace(/^#+\s*/gm, '')        // strip heading markers
    .replace(/^[-*+]\s+/gm, '')     // strip list bullets
    .replace(/^\d+\.\s*/gm, '')     // strip numbered list
    .trim();
  return text;
}

// Helper to compute content_hash for storage
export function safeContent(content: string): string {
  return normalizeForStorage(content);
}

export interface StoreDeps {
  db: DbLike;
  config: Config;
  llmClient: LLMClient | null;
  log: any;
  clearRecallCache: (agentId: string) => void;
  metrics: {
    llmErrors: { core: number; extract: number; dedup: number };
    dbErrors: number;
    lastErrorAt: number | null;
  };
}

/**
 * Store new memories from a batch of messages.
 * Returns the number of newly captured memories.
 */
export async function store(
  deps: StoreDeps,
  AgentId: string,
  messages: any[]
): Promise<number> {
  const { db, config, llmClient, log, clearRecallCache, metrics } = deps;

  // 初始化 LLM 异步队列
  initLlmQueue(config.llm?.batchWindowMs || 200, llmClient);

  // Boundary checks
  if (!AgentId) {
    log.warn('[algo-memory] store 失败: agentId 为空');
    AgentId = 'default';
  }
  if (!messages?.length || !db) {
    log.warn('[algo-memory] store 失败: 无消息或数据库未初始化');
    return 0;
  }

  // Normalize + strip metadata, then truncate overly long messages
  messages = messages.map(msg => {
    const raw = extractMessageText(msg.content);
    return {
      ...msg,
      content: raw.length > MAX_MESSAGE_LENGTH
        ? raw.substring(0, MAX_MESSAGE_LENGTH) + '...[截断]'
        : raw
    };
  });

  let captured = 0;
  const maxCapture = config.capturePerTurn || 3;
  const storeStartTime = Date.now();

  // Score and sort messages by priority before processing
  const scoredMessages = messages
    .map((msg, i) => ({ msg, score: messagePriority(msg.content, config.coreKeywords), index: i }))
    .filter(({ msg, score }) => msg.role === 'user' && score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index) // highest score first, stable tie-break
    .slice(0, maxCapture); // already limited here, no need to count in loop

  try {
    // Collect tier-update candidates to batch them (avoids N+1 queries)
    const tierCandidates: string[] = [];
    // 收集需要批量写入的记忆
    const memoriesToBatch: Memory[] = [];

    for (const { msg } of scoredMessages) {
      const content = normalizeText(msg.content);
      if (!content || isNoise(content, config.noiseFilter)) continue;

      const safe = safeContent(content);

      // ===== 来源标签过滤：系统/元数据来源直接跳过 =====
      // 来源标签过滤（msg.source === 'system'）在消息入口预先过滤
      // 这里做兜底：内容本身像元数据包裹层的，也直接跳过
      if (isMetadataLike(safe)) continue;

      const contentHash = hashContent(safe);

      // Exact dedup check
      const existing = queryOne(db,
        'SELECT id FROM memories WHERE agent_id = ? AND content_hash = ?',
        [AgentId, contentHash]
      ) as IdRow | null;
      if (existing) {
        // Dedup hit: bump importance (max 1.0) to reflect repeated relevance, then re-tier
        run(db,
          `UPDATE memories SET access_count = access_count + 1, last_accessed = ?, importance = MIN(1.0, importance * 1.05) WHERE id = ?`,
          [Date.now(), existing.id]
        );
        tierCandidates.push(existing.id);
        continue;
      }

      // Smart dedup（语义去重增强版）
      let isDuplicate = false; // reset each outer iteration — must not persist across messages
      if (config.smartDedup) {
        const similar = queryAll(db,
          'SELECT id, content FROM memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?',
          [AgentId, MAX_SIMILAR_CHECK]
        ) as IdContentRow[];

        for (const s of similar) {
          const existingContent = s.content as string;

          // ===== 语义去重增强：元数据结构相似性检测 =====
          // 如果现有记忆的内容是元数据类的，且当前内容与它结构相似（都是元数据包裹），降级处理
          const existingIsMetadata = isMetadataLike(existingContent);
          const currentIsMetadata = isMetadataLike(safe);

          // 两者都是元数据：强相似度降级（更激进地认为是重复）
          // 两者之一是元数据：弱相似度降级
          let effectiveThreshold = config.dedupThreshold;
          if (existingIsMetadata || currentIsMetadata) {
            // 元数据类内容更严格：降低阈值，更容易触发去重
            effectiveThreshold = existingIsMetadata && currentIsMetadata
              ? config.dedupThreshold * 0.5   // 双方都是元数据：阈值减半
              : config.dedupThreshold * 0.75; // 一方是元数据：阈值降25%
          }

          let score = jaccardSimilarity(safe, existingContent);
          const { dedupUncertaintyMin, dedupUncertaintyMax } = config.threshold;
          const inUncertaintyZone = score >= dedupUncertaintyMin && score < dedupUncertaintyMax;

          if (config.threshold.useLlmForDedup && llmClient && inUncertaintyZone) {
            const r = await llmClient.isDuplicateLLM(safe, existingContent);
            isDuplicate = r.isDuplicate;
          } else {
            isDuplicate = score >= effectiveThreshold;
          }

          if (isDuplicate) {
            run(db,
              `UPDATE memories SET access_count = access_count + 1, last_accessed = ?, importance = MIN(1.0, importance * 1.05) WHERE id = ?`,
              [Date.now(), s.id as string]
            );
            tierCandidates.push(s.id as string);
            break;
          }
        }
        if (isDuplicate) continue;
      }

      // Core determination
      let isCore = isCoreKeyword(safe, config.coreKeywords);
      let keywords = extractKeywords(safe);
      let importance = isCore ? 1.0 : 0.5;

      const needLLMForCore = config.threshold.useLlmForCore &&
                             llmClient &&
                             (!isCore && safe.length >= (config.threshold.lengthForCore || DEFAULT_VALUES.THRESHOLD_LENGTH_FOR_CORE));
      if (needLLMForCore) {
        const r = await addToLlmQueue({ type: 'isCore', content: safe });
        if (r) {
          isCore = r.isCore;
          importance = r.confidence;
        }
      }

      const needLLMForExtract = config.threshold.useLlmForExtract &&
                                 llmClient &&
                                 safe.length >= (config.threshold.lengthForExtract || DEFAULT_VALUES.THRESHOLD_LENGTH_FOR_EXTRACT);
      if (needLLMForExtract) {
        const r = await addToLlmQueue({ type: 'extractKeywords', content: safe });
        if (r) keywords = r;
      }

      // 压缩策略优化：仅在必要时压缩，避免短内容和元数据被过度处理
      let storedContent = safe;
      let wasCompressed = false;
      if (config.compression?.enabled) {
        const minLen = config.compression.minLengthForCompression || DEFAULT_VALUES.COMPRESSION_MIN_LENGTH;
        const maxLen = config.compression.maxLength || DEFAULT_VALUES.COMPRESSION_MAX_LENGTH;

        // 元数据类内容：直接存储原文，不压缩
        if (config.compression.skipMetadataCompression && isMetadataLike(safe)) {
          storedContent = safe;
          wasCompressed = false;
        }
        // 短内容：跳过压缩，直接存储
        else if (safe.length <= minLen) {
          storedContent = safe;
          wasCompressed = false;
        }
        // 正常长度内容：执行压缩
        else {
          storedContent = compressContent(safe, maxLen);
          wasCompressed = storedContent !== safe;

          // 如果启用了关键词提取，也添加到 keywords
          if (config.compression.extractKeywords && storedContent.length >= maxLen) {
            const extraKeywords = extractContentSummary(safe, 3);
            if (extraKeywords) {
              keywords = keywords ? `${keywords},${extraKeywords}` : extraKeywords;
            }
          }
        }
      }

      const scope = config.scopes.enabled
        ? `${config.scopes.defaultScope}:${AgentId}`
        : 'global';
      const tier = getTier(importance, 1, 0, config.tier);

      // 生成元数据，包含原始内容摘要（用于压缩后的完整信息恢复）
      const originalSummary = safe.length > storedContent.length
        ? `[原文摘要]${safe.substring(0, 200)}`
        : '';

      const metadata = JSON.stringify({
        memory_category: isCore ? 'fact' : 'other',
        confidence: importance,
        source_session: AgentId,
        l0_abstract: originalSummary || storedContent.substring(0, 100),
        compressed: storedContent !== safe,
        original_length: safe.length
      });

      const memory: Memory = {
        id: generateId(),
        agent_id: AgentId,
        scope,
        content: storedContent,
        type: 'other',
        tier,
        layer: isCore ? 'core' : 'general',
        keywords,
        importance,
        access_count: 1,
        cited_count: 0,
        tier_confidence: 1.0,
        last_tier_update: Date.now(),
        created_at: Date.now(),
        last_accessed: Date.now(),
        content_hash: contentHash,
        metadata,
        _score: 0
      };

      // 判断是否使用批量写入
      if (config.batchWrite?.enabled) {
        const buffer = getBuffer(AgentId, config);
        buffer.memories.push(memory);

        // 如果缓冲区满了，立即写入
        if (buffer.memories.length >= (config.batchWrite.maxBatchSize || DEFAULT_VALUES.BATCH_MAX_SIZE)) {
          flushMemoryBuffer(db, AgentId, config, log);
        } else {
          // 否则计划延迟写入
          scheduleBatchWrite(db, AgentId, config, log);
        }
      } else {
        // 直接写入（原有逻辑）- 使用统一SQL构建
        const { placeholders, params } = buildMemoryInsert(memory);
        runOrThrow(db,
          `INSERT INTO memories (${MEMORY_COLUMNS.join(', ')}) VALUES (${placeholders})`,
          params
        );
      }

      captured++;
    }

    // Batch tier promotion — one SELECT + one UPDATE for all candidates
    if (tierCandidates.length > 0 && config.tier.enabled) {
      const uniqueIds = [...new Set(tierCandidates)];

      // 先查询当前的 tier（用于记录历史）
      const currentRows = queryAll(db,
        `SELECT id, tier, importance, access_count, created_at FROM memories WHERE id IN (${uniqueIds.map(() => '?').join(',')})`,
        uniqueIds
      ) as TierRow[];

      // 计算新的 tier
      const updates: { id: string; oldTier: string; newTier: string }[] = [];
      for (const row of currentRows) {
        const daysOld = (Date.now() - row.created_at) / (1000 * 60 * 60 * 24);
        const newTier = getTier(row.importance, row.access_count, daysOld, config.tier);
        if (row.tier !== newTier) {
          updates.push({ id: row.id, oldTier: row.tier, newTier });
        }
      }

      // 如果有 tier 变化，执行更新
      if (updates.length > 0) {
        const idParams: string[] = [];
        const tierParams: string[] = [];
        const whereParams: string[] = [];

        for (const update of updates) {
          idParams.push(update.id);
          tierParams.push(update.newTier);
          whereParams.push(update.id);

          // 记录分层变化历史
          const accessCount = currentRows.find(r => r.id === update.id)?.access_count || 0;
          const reason = accessCount >= config.tier.coreThreshold ? `access_count达到${accessCount}` : 'compositeScore变化';
          recordTierChange(db, update.id, update.oldTier, update.newTier, reason, accessCount, log);
        }

        const whenClauses = updates.map(() => 'WHEN id = ? THEN ?').join(' ');
        run(db,
          `UPDATE memories SET tier = CASE ${whenClauses} ELSE tier END WHERE id IN (${whereParams.map(() => '?').join(',')})`,
          [...idParams, ...tierParams, ...whereParams]
        );
      }
    }

    if (tierCandidates.length > 0) clearRecallCache(AgentId);
    const storeDuration = Date.now() - storeStartTime;
    if (captured > 0) {
      const writeMode = config.batchWrite?.enabled ? '批量' : '直接';
      log.info(`[algo-memory] 存储完成, 新增: ${captured}, agentId: ${AgentId}, 耗时: ${storeDuration}ms, 模式: ${writeMode}`);
    }
  } catch (err) {
    log.error('[algo-memory] store 操作失败:', err);
    metrics.dbErrors++;
    metrics.lastErrorAt = Date.now();
  }

  return captured;
}

// 导出 buffer 统计（供 health check 使用）
export function getBufferStats(): Record<string, { pending: number; flushing: boolean; lastFlush: number | null }> {
  const result: Record<string, { pending: number; flushing: boolean; lastFlush: number | null }> = {};
  for (const [id, buf] of memoryBuffers) {
    result[id] = {
      pending: buf.memories.length,
      flushing: buf.flushing,
      lastFlush: buf.lastFlush || null
    };
  }
  return result;
}
