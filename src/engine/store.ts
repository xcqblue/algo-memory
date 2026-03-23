/**
 * algo-memory v2.3.0 - Storage Engine
 */

import type { Config, Memory } from '../types.js';
import {
  normalizeText,
  isNoise,
  isCoreKeyword,
  extractKeywords,
  jaccardSimilarity,
  getTier,
  generateId,
  hashContent,
  compressContent,
  extractContentSummary,
  MAX_MESSAGE_LENGTH,
  MAX_SIMILAR_CHECK
} from '../utils.js';
import { queryAll, queryOne, run, runOrThrow } from '../db/queries.js';
import { LLMClient } from './llm.js';
import type { DbLike } from '../db/queries.js';

// ============= Batch Write Buffer =============
interface MemoryBuffer {
  memories: Memory[];
  timer: NodeJS.Timeout | null;
}

const memoryBuffers: Map<string, MemoryBuffer> = new Map();

function getBuffer(AgentId: string, config: Config): MemoryBuffer {
  if (!memoryBuffers.has(AgentId)) {
    memoryBuffers.set(AgentId, { memories: [], timer: null });
  }
  return memoryBuffers.get(AgentId)!;
}

/**
 * 将记忆批量写入数据库
 */
function flushMemoryBuffer(db: DbLike, AgentId: string, config: Config, log: any): number {
  const buffer = memoryBuffers.get(AgentId);
  if (!buffer || buffer.memories.length === 0) return 0;

  // 清除定时器
  if (buffer.timer) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }

  const memoriesToWrite = buffer.memories;
  buffer.memories = [];

  if (memoriesToWrite.length === 0) return 0;

  let inserted = 0;
  try {
    // 批量插入
    const placeholders = memoriesToWrite.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    const params = memoriesToWrite.flatMap(m => [
      m.id, m.agent_id, m.scope, m.content, m.type, m.tier, m.layer,
      m.keywords, m.importance, m.access_count, m.cited_count,
      m.created_at, m.last_accessed, m.content_hash, m.metadata
    ]);

    run(db,
      `INSERT INTO memories (id, agent_id, scope, content, type, tier, layer, keywords, importance, access_count, cited_count, created_at, last_accessed, content_hash, metadata)
       VALUES ${placeholders}`,
      params
    );

    inserted = memoriesToWrite.length;
    log.info(`[algo-memory] 批量写入完成: ${inserted} 条记忆`);
  } catch (err) {
    log.error('[algo-memory] 批量写入失败:', err);
  }

  return inserted;
}

/**
 * 计划批量写入（延迟执行）
 */
function scheduleBatchWrite(db: DbLike, AgentId: string, config: Config, log: any): void {
  const buffer = getBuffer(AgentId, config);

  // 如果已经有定时器在运行，不重复创建
  if (buffer.timer) return;

  // 计划在 bufferMs 后执行批量写入
  buffer.timer = setTimeout(() => {
    flushMemoryBuffer(db, AgentId, config, log);
  }, config.batchWrite?.bufferMs || 500);
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
type TierRow = { id: string; importance: number; access_count: number; created_at: number };

// Normalize content before storing: strip @mentions, compress whitespace, remove markdown noise
export function normalizeForStorage(content: string): string {
  let text = content
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

  // Boundary checks
  if (!AgentId) {
    log.warn('[algo-memory] store 失败: agentId 为空');
    AgentId = 'default';
  }
  if (!messages?.length || !db) {
    log.warn('[algo-memory] store 失败: 无消息或数据库未初始化');
    return 0;
  }

  // Truncate overly long messages
  messages = messages.map(msg => ({
    ...msg,
    content: msg.content?.length > MAX_MESSAGE_LENGTH
      ? msg.content.substring(0, MAX_MESSAGE_LENGTH) + '...[截断]'
      : msg.content
  }));

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

      // Smart dedup
      let isDuplicate = false; // reset each outer iteration — must not persist across messages
      if (config.smartDedup) {
        const similar = queryAll(db,
          'SELECT id, content FROM memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?',
          [AgentId, MAX_SIMILAR_CHECK]
        ) as IdContentRow[];

        for (const s of similar) {
          let score = jaccardSimilarity(safe, s.content);
          const { dedupUncertaintyMin, dedupUncertaintyMax } = config.threshold;
          const inUncertaintyZone = score >= dedupUncertaintyMin && score < dedupUncertaintyMax;

          if (config.threshold.useLlmForDedup && llmClient && inUncertaintyZone) {
            const r = await llmClient.isDuplicateLLM(safe, s.content as string);
            isDuplicate = r.isDuplicate;
          } else {
            isDuplicate = score >= config.dedupThreshold;
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
                             (!isCore || safe.length >= config.threshold.lengthForCore);
      if (needLLMForCore) {
        const r = await llmClient.isCoreMemory(safe);
        isCore = r.isCore;
        importance = r.confidence;
      }

      const needLLMForExtract = config.threshold.useLlmForExtract &&
                                 llmClient &&
                                 safe.length >= config.threshold.lengthForExtract;
      if (needLLMForExtract) {
        keywords = await llmClient.extractKeywordsFromLLM(safe);
      }

      // 启用压缩时，对内容进行压缩
      let storedContent = safe;
      if (config.compression?.enabled) {
        const maxLen = config.compression.maxLength || 200;
        storedContent = compressContent(safe, maxLen);

        // 如果启用了关键词提取，也添加到 keywords
        if (config.compression.extractKeywords && storedContent.length >= maxLen) {
          const extraKeywords = extractContentSummary(safe, 3);
          if (extraKeywords) {
            keywords = keywords ? `${keywords},${extraKeywords}` : extraKeywords;
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
        if (buffer.memories.length >= (config.batchWrite.maxBatchSize || 20)) {
          flushMemoryBuffer(db, AgentId, config, log);
        } else {
          // 否则计划延迟写入
          scheduleBatchWrite(db, AgentId, config, log);
        }
      } else {
        // 直接写入（原有逻辑）
        runOrThrow(db,
          `INSERT INTO memories (id, agent_id, scope, content, type, tier, layer, keywords, importance, access_count, cited_count, created_at, last_accessed, content_hash, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [memory.id, memory.agent_id, memory.scope, memory.content, memory.type, memory.tier, memory.layer, memory.keywords, memory.importance, memory.access_count, memory.cited_count, memory.created_at, memory.last_accessed, memory.content_hash, memory.metadata]
        );
      }

      captured++;
    }

    // Batch tier promotion — one SELECT + one UPDATE for all candidates
    if (tierCandidates.length > 0 && config.tier.enabled) {
      const uniqueIds = [...new Set(tierCandidates)];
      const rows = queryAll(db,
        `SELECT id, importance, access_count, created_at FROM memories WHERE id IN (${uniqueIds.map(() => '?').join(',')})`,
        uniqueIds
      ) as TierRow[];
      // Build one CASE WHEN statement for all tier updates in a single SQL round-trip
      if (rows.length > 0) {
        // Build parameterized CASE WHEN: 2 params per row (id, tier) + n params for WHERE IN
        const idParams: string[] = [];
        const tierParams: string[] = [];
        const whereParams: string[] = [];
        for (const row of rows) {
          const daysOld = (Date.now() - row.created_at) / (1000 * 60 * 60 * 24);
          const newTier = getTier(row.importance, row.access_count, daysOld, config.tier);
          idParams.push(row.id);
          tierParams.push(newTier);
          whereParams.push(row.id);
        }
        const whenClauses = rows.map(() => 'WHEN id = ? THEN ?').join(' ');
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
