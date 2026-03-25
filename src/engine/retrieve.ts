/**
 * Unified retrieval engine — shared by both recall (with MMR) and search (without MMR).
 *
 * Pipeline:
 *   FTS5 search (with Trie-optimized Query Expansion)  OR  LIKE fallback
 *   → Score (time decay / reinforcement / lengthNorm)
 *   → Tier-grouped MMR deduplication (v2.9.0: 每组内独立 MMR，防止 peripheral 挤出 core)
 *   → HardMinScore filter
 *   → return sorted memories
 *
 * v2.9.0 关键优化：
 * 1. Trie-based FTS5 query expansion（O(query_len) 替代 O(query_len × syn_count)）
 * 2. 多路召回缩减为 2 路（原始 + 前缀 3-token）
 * 3. Tier 分组内 MMR（core 记忆不会被 peripheral 意外挤出）
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { queryAll } from '../db/queries.js';
import type { Config, Memory } from '../types.js';
import {
  mmrDeduplicate,
  weibullDecay,
  reinforcementFactor,
  lengthNorm,
  generateMultiPathQueries,
} from '../utils.js';
// v2.9.0 Trie-based synonym expansion for FTS5
import { buildTrieFts5Query } from './synonym-trie.js';

export type DbLike = DatabaseType;

export interface RetrievalOptions {
  db: DbLike;
  config: Config;
  log: any;
  agentId: string;
  /** Visible agent IDs for scoping; null = no filter (all agents) */
  visibleAgentIds: string[] | null;
  query: string;
  /** Enable MMR (used by recall, not by search) */
  mmrEnabled: boolean;
  /** Max raw candidates to fetch from DB */
  limit: number;
  /** Whether FTS5 is available (passed from plugin, not from config) */
  ftsEnabled: boolean;
}

const FIELDS = `id, agent_id, scope, content, type, tier, layer, keywords,
  importance, access_count, cited_count, tier_confidence, last_tier_update,
  created_at, last_accessed, content_hash, metadata`;

/**
 * Main retrieval function — handles FTS5 → score → MMR → filter.
 */
export function retrieve(options: RetrievalOptions): Memory[] {
  const { db, config, log, agentId, visibleAgentIds, query, mmrEnabled, limit, ftsEnabled } = options;

  const safeLimit = Math.min(limit, 100);
  const agentFilter = visibleAgentIds !== null
    ? `agent_id IN (${visibleAgentIds.map(() => '?').join(',')})`
    : '1=1';

  let allCandidates: Memory[] = [];
  const seenIds = new Set<string>(); // 多路合并去重

  // ---- FTS5 path with Trie-optimized multi-path expansion ----
  if (ftsEnabled) {
    const ftsQuery = query.trim().replace(/'/g, "''");
    if (ftsQuery) {
      try {
        // v2.9.0: 使用 Trie 优化的同义词展开（FTS5 query expansion）
        const expandedQuery = buildTrieFts5Query(ftsQuery);

        // v2.9.0: 多路召回缩减为 2 路（原始 + 前缀 3-token）
        const multiQueries = generateMultiPathQueries(expandedQuery, 2);

        for (const q of multiQueries) {
          if (!q.trim()) continue;
          try {
            const baseSql = `SELECT ${FIELDS} FROM memories m JOIN memories_fts fts ON m.id = fts.id WHERE ${agentFilter} AND fts MATCH ? ORDER BY bm25(fts) DESC, m.importance DESC LIMIT ?`;
            const params = visibleAgentIds !== null ? [...visibleAgentIds, q, safeLimit] : [q, safeLimit];
            const rows = queryAll(db, baseSql, params) as unknown as Memory[];
            // 多路合并：按 id 去重，保留最高分
            for (const m of rows) {
              if (!seenIds.has(m.id)) {
                seenIds.add(m.id);
                allCandidates.push(m);
              }
            }
          } catch (err) {
            log.warn(`[algo-memory] FTS5 query "${q}" failed: ${err}`);
          }
        }
      } catch (err) {
        log.warn(`[algo-memory] Trie FTS5 expansion failed: ${err}`);
      }
    }
  }

  // ---- LIKE fallback (when FTS5 unavailable or returned nothing) ----
  if (allCandidates.length === 0) {
    const likeQuery = query.replace(/'/g, "''").trim();
    if (likeQuery) {
      const sql = `SELECT ${FIELDS} FROM memories WHERE ${agentFilter} AND (content LIKE ? OR keywords LIKE ?) ORDER BY importance DESC, created_at DESC LIMIT ?`;
      const params = visibleAgentIds !== null ? [...visibleAgentIds, `%${likeQuery}%`, `%${likeQuery}%`, safeLimit] : [`%${likeQuery}%`, `%${likeQuery}%`, safeLimit];
      allCandidates = queryAll(db, sql, params) as unknown as Memory[];
    }
  }

  if (allCandidates.length === 0) return [];

  // ---- Score ----
  const scored = allCandidates.map(m => {
    const daysOld = (Date.now() - m.last_accessed) / (1000 * 60 * 60 * 24);
    const w = config.tier.weights;
    const tierMultiplier = m.tier === 'core' ? w.core : m.tier === 'working' ? w.working : w.peripheral;
    let score = tierMultiplier * m.importance;

    if (config.recencyDecay) {
      const halfLife = config.recencyHalfLife || 180;
      if (config.weibullDecay.enabled) {
        score *= weibullDecay(daysOld, config.weibullDecay.shape, config.weibullDecay.scale);
      } else {
        score *= (0.5 + 0.5 * Math.pow(0.5, daysOld / halfLife));
      }
    }

    score *= reinforcementFactor(m.access_count, config.reinforcement);

    if (config.lengthNorm.enabled) {
      score *= lengthNorm(m.content, config.lengthNorm.anchor);
    }

    return { ...m, _score: score };
  }).sort((a, b) => b._score - a._score);

  // ---- Tier-grouped MMR deduplication (v2.9.0 关键优化) ----
  // 问题：全局 MMR 可能让 core 记忆被 peripheral 挤出（内容相似时，peripheral 先被选中）
  // 解决：按 tier 分组，每组内独立 MMR，再合并
  // 这样 core 组保留 core 代表，peripheral 组保留 peripheral 代表
  const mmrCandidates = mmrEnabled && config.mmr.enabled
    ? tierGroupedMMR(scored, config)
    : scored;

  // ---- HardMinScore filter ----
  const filtered = config.hardMinScore.enabled
    ? mmrCandidates.filter(m => (m._score ?? m.importance) >= config.hardMinScore.threshold)
    : mmrCandidates;

  return filtered;
}

/**
 * v2.9.0 新增：按 tier 分组内独立 MMR 去重
 *
 * 策略：
 * 1. 将候选按 tier 分组（core / working / peripheral）
 * 2. 每组内独立执行 MMR 去重（保留各组代表）
 * 3. 合并结果，按 _score 排序截断
 *
 * 优势：core 记忆不会因为和 peripheral "内容相似" 而被错误淘汰
 */
function tierGroupedMMR(
  items: Memory[],
  config: Config
): Memory[] {
  if (items.length === 0) return [];

  // 按 tier 分组
  const groups: Record<string, Memory[]> = {
    core: [],
    working: [],
    peripheral: [],
  };
  for (const m of items) {
    const tier = m.tier as string;
    if (groups[tier]) {
      groups[tier].push(m);
    } else {
      // 未知 tier，归入 working
      groups.working.push(m);
    }
  }

  const deduplicated: Memory[] = [];

  // 每组内独立 MMR（lambda 使用配置的默认值 0.7）
  const mmrLambda = config.mmr?.lambda ?? 0.7;

  for (const [tier, groupItems] of Object.entries(groups)) {
    if (groupItems.length === 0) continue;

    if (groupItems.length === 1) {
      deduplicated.push(groupItems[0]);
    } else {
      // 组内 MMR 去重
      const deduped = mmrDeduplicate(groupItems, { ...config.mmr, lambda: mmrLambda });
      deduplicated.push(...deduped);
    }
  }

  // 合并后按 _score 排序
  return deduplicated.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
}
