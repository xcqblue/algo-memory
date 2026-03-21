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
  lengthNorm
} from '../utils.js';
import { queryAll } from '../db/queries.js';
import type { DbLike } from '../db/queries.js';

export interface RecallDeps {
  db: DbLike;
  config: Config;
  log: any;
  getVisibleAgentIds: (AgentId: string) => string[] | null;
  cache: Map<string, { hasMemory: boolean; memories: Memory[] }>;
  configHash: string;
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
  const { db, config, log, getVisibleAgentIds, cache, configHash } = deps;

  if (!db) {
    log.warn('[algo-memory] recall 失败: 数据库未初始化');
    return { hasMemory: false, memories: [] };
  }

  const recallStartTime = Date.now();

  if (!shouldRetrieve(query, config.adaptiveRetrieval)) {
    return { hasMemory: false, memories: [] };
  }

  // Check cache
  const cacheKey = `recall:${AgentId}:${configHash}:${query}`;
  if (cache.has(cacheKey)) {
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
      const w = config.tier.weights;
      const tierMultiplier = m.tier === 'core' ? w.core : m.tier === 'working' ? w.working : w.peripheral;
      let score = tierMultiplier * m.importance;

      if (config.weibullDecay.enabled) {
        score *= weibullDecay(daysOld, config.weibullDecay.shape, config.weibullDecay.scale);
      } else {
        score *= (0.3 + 0.7 * Math.pow(0.5, daysOld / halfLife));
      }

      score *= reinforcementFactor(m.access_count, config.reinforcement);

      if (config.lengthNorm.enabled) {
        score *= lengthNorm(m.content, config.lengthNorm.anchor);
      }

      return { ...m, _score: score };
    }).sort((a, b) => (b._score || 0) - (a._score || 0));
  }

  if (config.mmr.enabled) {
    memories = mmrDeduplicate(memories, config.mmr);
  }

  if (config.hardMinScore.enabled) {
    memories = memories.filter(m => (m._score || m.importance) >= config.hardMinScore.threshold);
  }

  const limited = memories.slice(0, config.maxResults);
  const result: RecallResult = { hasMemory: limited.length > 0, memories: limited };

  cache.set(cacheKey, result);

  const recallDuration = Date.now() - recallStartTime;
  log.info(`[algo-memory] 召回完成, agentId: ${AgentId}, 命中: ${limited.length}, 耗时: ${recallDuration}ms`);

  return result;
}
