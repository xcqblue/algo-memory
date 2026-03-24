/**
 * algo-memory v2.3.0 - Recall Engine
 */

import type { Config, Memory } from '../types.js';
import {
  shouldRetrieve,
  jaccardSimilarity,
  weibullDecay,
  reinforcementFactor,
  mmrDeduplicate,
  lengthNorm,
  cosineSimilarity,
} from '../utils.js';
import { queryAll, run, getEmbeddings } from '../db/queries.js';
import { embedText } from './embed.js';
import type { DbLike } from '../db/queries.js';

// ============= Query Embedding Cache =============
// 同一 query 在 5 分钟内不重复调用 embedding API
interface CacheEntry {
  embedding: number[];
  dimensions: number;
  ts: number;
}
const queryEmbeddingCache = new Map<string, CacheEntry>();
const EMBEDDING_CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟

function getCachedQueryEmbedding(query: string): number[] | null {
  const entry = queryEmbeddingCache.get(query);
  if (entry && Date.now() - entry.ts < EMBEDDING_CACHE_TTL_MS) {
    return entry.embedding;
  }
  return null;
}

function setCachedQueryEmbedding(query: string, embedding: number[], dimensions: number): void {
  // 最多缓存 100 个 query，防止内存无限增长
  if (queryEmbeddingCache.size >= 100) {
    const oldestKey = [...queryEmbeddingCache.entries()]
      .sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
    if (oldestKey) queryEmbeddingCache.delete(oldestKey);
  }
  queryEmbeddingCache.set(query, { embedding, dimensions, ts: Date.now() });
}

export function clearQueryEmbeddingCache(): void {
  queryEmbeddingCache.clear();
}

export { getCachedQueryEmbedding };

export interface RecallDeps {
  db: DbLike;
  config: Config;
  log: any;
  getVisibleAgentIds: (AgentId: string) => string[] | null;
  cache: Map<string, { hasMemory: boolean; memories: Memory[] }>;
  configHash: string;
  /** 会话去重：上次召回的查询 */
  lastRecallQuery?: string;
  /** 会话去重：上次召回的时间戳 */
  lastRecallTime?: number;
  /** FTS5 是否可用（由插件注入） */
  ftsEnabled?: boolean;
}

export interface RecallResult {
  hasMemory: boolean;
  memories: Memory[];
}

export interface RecallOptions {
  /** 跳过 session dedup 检查（用于 proactive recall） */
  skipDedup?: boolean;
  /** 限制返回条数（默认使用 config.maxResults） */
  limit?: number;
}

/**
 * Retrieve and rank relevant memories for a given query.
 */
export async function recall(
  deps: RecallDeps,
  AgentId: string,
  query: string,
  options?: RecallOptions
): Promise<RecallResult> {
  const { db, config, log, getVisibleAgentIds, cache, configHash, lastRecallQuery, lastRecallTime, ftsEnabled } = deps;

  if (!db) {
    log.warn('[algo-memory] recall 失败: 数据库未初始化');
    return { hasMemory: false, memories: [] };
  }

  const recallStartTime = Date.now();

  const shouldRetrieveResult = shouldRetrieve(query, config.adaptiveRetrieval, { lastQuery: lastRecallQuery ?? '', lastRecallTime: lastRecallTime ?? 0 });
  if (!shouldRetrieveResult && !options?.skipDedup) {
    return { hasMemory: false, memories: [] };
  }

  const visibleAgentIds = getVisibleAgentIds(AgentId);

  // Session dedup is active — do NOT use cache, because same query at different times
  // should produce different results (one eligible, one skipped). Cache would bypass dedup.
  const useCache = (!config.adaptiveRetrieval.sessionDedup?.enabled || !!options?.skipDedup) && !options?.skipDedup;

  const cacheKey = `recall:${AgentId}:${configHash}:${query}`;
  if (useCache && cache.has(cacheKey)) {
    log.info(`[algo-memory] 召回完成(缓存命中), agentId: ${AgentId}, 耗时: ${Date.now() - recallStartTime}ms`);
    const cached = cache.get(cacheKey)!;
    return cached;
  }

  const safeLimit = Math.min((options?.limit ?? config.maxResults) * 3, 100);

  let memories: Memory[];
  if (visibleAgentIds === null) {
    memories = queryAll(db,
      `SELECT * FROM memories ORDER BY CASE tier WHEN 'core' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, importance DESC, access_count DESC LIMIT ?`,
      [safeLimit]
    ) as unknown as Memory[];
  } else {
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    memories = queryAll(db,
      `SELECT * FROM memories WHERE agent_id IN (${placeholders}) ORDER BY CASE tier WHEN 'core' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, importance DESC, access_count DESC LIMIT ?`,
      [...visibleAgentIds, safeLimit]
    ) as unknown as Memory[];
  }

  // Apply recency decay and re-score
  if (config.recencyDecay) {
    const halfLife = config.recencyHalfLife || 180;
    memories = memories.map(m => {
      const daysOld = (Date.now() - m.last_accessed) / (1000 * 60 * 60 * 24);
      const w = config.tier.weights;
      const tierMultiplier = m.tier === 'core' ? w.core : m.tier === 'working' ? w.working : w.peripheral;
      let score = tierMultiplier * m.importance;

      if (config.weibullDecay.enabled) {
        score *= weibullDecay(daysOld, config.weibullDecay.shape, config.weibullDecay.scale);
      } else {
        // Floor at 0.5 — old memories stay relevant, never collapse to zero
        score *= (0.5 + 0.5 * Math.pow(0.5, daysOld / halfLife));
      }

      score *= reinforcementFactor(m.access_count, config.reinforcement);

      if (config.lengthNorm.enabled) {
        score *= lengthNorm(m.content, config.lengthNorm.anchor);
      }

      return { ...m, _score: score };
    }).sort((a, b) => (b._score || 0) - (a._score || 0));
  } else {
    // No recency decay: base score from importance only
    memories = memories.map(m => {
      return { ...m, _score: m.importance };
    }).sort((a, b) => (b._score || 0) - (a._score || 0));
  }

  // ---- Vector hybrid fusion (optional) ----
  if (config.vectorSearch?.enabled && config.vectorSearch.model) {
    try {
      // 优先从缓存读取，避免重复调用 embedding API
      let cached = getCachedQueryEmbedding(query);
      if (!cached) {
        const result = await embedText(query, config.vectorSearch);
        cached = result.embedding;
        setCachedQueryEmbedding(query, cached, result.dimensions);
      }
      const memoryIds = memories.map(m => m.id);
      const embMap = getEmbeddings(db, memoryIds);
      if (embMap.size > 0) {
        const ftsWeight = config.vectorSearch.ftsWeight ?? 0.5;
        const vectorWeight = 1 - ftsWeight;
        const maxFtsScore = memories[0]?._score || 1;
        let maxSim = 0;
        const sims = new Map<string, number>();
        for (const m of memories) {
          const emb = embMap.get(m.id);
          if (emb) {
            const sim = cosineSimilarity(cached, emb);
            sims.set(m.id, sim);
            if (sim > maxSim) maxSim = sim;
          }
        }
        if (maxSim > 0) {
          memories = memories.map(m => {
            const vecScore = sims.get(m.id) || 0;
            const normFts = maxFtsScore > 0 ? m._score / maxFtsScore : 0;
            const normVec = maxSim > 0 ? vecScore / maxSim : 0;
            const fusedScore = normFts * ftsWeight + normVec * vectorWeight;
            return { ...m, _score: fusedScore };
          }).sort((a, b) => b._score - a._score);
        }
      }
    } catch (err) {
      log.warn('[algo-memory] 向量搜索失败，静默降级:', err);
    }
  }

  // Build the final returned set: MMR → hardMinScore → truncate
  if (config.mmr.enabled) {
    memories = mmrDeduplicate(memories, config.mmr);
  }

  // HardMinScore filter BEFORE cited_count update
  // Only items that actually passed to the user count as "cited"
  if (config.hardMinScore.enabled) {
    memories = memories.filter(m => (m._score || m.importance) >= config.hardMinScore.threshold);
  }
  const limited = memories.slice(0, config.maxResults);

  // cited_count: only update items that were actually returned to the user
  const candidateIds = limited.map((m: Memory) => m.id);
  if (candidateIds.length > 0) {
    const placeholders = candidateIds.map(() => '?').join(',');
    run(db,
      `UPDATE memories SET cited_count = cited_count + 1 WHERE id IN (${placeholders})`,
      candidateIds
    );
  }

  const result: RecallResult = { hasMemory: limited.length > 0, memories: limited };

  const recallDuration = Date.now() - recallStartTime;
  log.info(`[algo-memory] 召回完成, agentId: ${AgentId}, 命中: ${limited.length}, 耗时: ${recallDuration}ms`);

  return result;
}
