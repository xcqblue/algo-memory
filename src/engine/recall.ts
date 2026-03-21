/**
 * algo-memory v2.2.3 - Recall Engine
 */

import type { Config, Memory } from '../types.js';
import {
  shouldRetrieve,
  jaccardSimilarity,
  weibullDecay,
  reinforcementFactor,
  mmrDeduplicate,
  lexicalOverlapSuppress,
  lengthNorm
} from '../utils.js';
import { queryAll, run } from '../db/queries.js';
import type { DbLike } from '../db/queries.js';

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
}

export interface RecallResult {
  hasMemory: boolean;
  memories: Memory[];
}

/**
 * Retrieve and rank relevant memories for a given query.
 */
export async function recall(
  deps: RecallDeps,
  AgentId: string,
  query: string
): Promise<RecallResult> {
  const { db, config, log, getVisibleAgentIds, cache, configHash, lastRecallQuery, lastRecallTime } = deps;

  if (!db) {
    log.warn('[algo-memory] recall 失败: 数据库未初始化');
    return { hasMemory: false, memories: [] };
  }

  const recallStartTime = Date.now();

  if (!shouldRetrieve(query, config.adaptiveRetrieval, { lastQuery: lastRecallQuery ?? '', lastRecallTime: lastRecallTime ?? 0 })) {
    return { hasMemory: false, memories: [] };
  }

  // Session dedup is active — do NOT use cache, because same query at different times
  // should produce different results (one eligible, one skipped). Cache would bypass dedup.
  const useCache = !config.adaptiveRetrieval.sessionDedup?.enabled;

  const cacheKey = `recall:${AgentId}:${configHash}:${query}`;
  if (useCache && cache.has(cacheKey)) {
    log.info(`[algo-memory] 召回完成(缓存命中), agentId: ${AgentId}, 耗时: ${Date.now() - recallStartTime}ms`);
    const cached = cache.get(cacheKey)!;
    return cached;
  }

  const visibleAgentIds = getVisibleAgentIds(AgentId);
  const safeLimit = Math.min(config.maxResults * 3, 100);

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
      const hoursOld = daysOld * 24;
      const w = config.tier.weights;
      const tierMultiplier = m.tier === 'core' ? w.core : m.tier === 'working' ? w.working : w.peripheral;
      let score = tierMultiplier * m.importance;

      // Urgency decay: urgency starts at 1.0, decays rapidly (default half-life 7 days)
      if (config.urgencyDecay.enabled) {
        const urgency = m.urgency ?? 1.0;
        const urgencyDecay = Math.pow(0.5, hoursOld / config.urgencyDecay.halfLifeHours);
        score *= urgency * urgencyDecay;
      }

      if (config.weibullDecay.enabled) {
        score *= weibullDecay(daysOld, config.weibullDecay.shape, config.weibullDecay.scale);
      } else {
        // Floor at 0.5 — old memories stay relevant, never collapse to zero
        score *= (0.5 + 0.5 * Math.pow(0.5, daysOld / halfLife));
      }

      score *= reinforcementFactor(m.access_count, config.reinforcement);

      // cited_count boost: more cited memories rank higher
      if (config.citedBoost?.enabled && m.cited_count > 0) {
        score *= (1 + config.citedBoost.factor * m.cited_count);
      }

      if (config.lengthNorm.enabled) {
        score *= lengthNorm(m.content, config.lengthNorm.anchor);
      }

      return { ...m, _score: score };
    }).sort((a, b) => (b._score || 0) - (a._score || 0));
  }

  if (config.mmr.enabled) {
    memories = mmrDeduplicate(memories, config.mmr);
  }

  // Lexical overlap suppression — post-MMR secondary pass
  if (config.lexicalOverlap?.enabled) {
    memories = lexicalOverlapSuppress(memories, config.lexicalOverlap);
  }

  if (config.hardMinScore.enabled) {
    memories = memories.filter(m => (m._score || m.importance) >= config.hardMinScore.threshold);
  }

  const limited = memories.slice(0, config.maxResults);

  // Auto-increment cited_count for each recalled memory
  if (limited.length > 0) {
    const ids = limited.map(m => m.id);
    const placeholders = ids.map(() => '?').join(',');
    run(db,
      `UPDATE memories SET cited_count = cited_count + 1, last_accessed = ? WHERE id IN (${placeholders})`,
      [Date.now(), ...ids]
    );
  }

  const result: RecallResult = { hasMemory: limited.length > 0, memories: limited };

  if (useCache) cache.set(cacheKey, result);

  const recallDuration = Date.now() - recallStartTime;
  log.info(`[algo-memory] 召回完成, agentId: ${AgentId}, 命中: ${limited.length}, 耗时: ${recallDuration}ms`);

  return result;
}
