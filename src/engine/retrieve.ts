/**
 * Unified retrieval engine — shared by both recall (with MMR) and search (without MMR).
 *
 * Pipeline:
 *   FTS5 search (with Query Expansion)  OR  LIKE fallback
 *   → Score (time decay / reinforcement / lengthNorm)
 *   → MMR (optional)
 *   → HardMinScore filter
 *   → return sorted memories
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { queryAll } from '../db/queries.js';
import type { Config, Memory } from '../types.js';
import {
  mmrDeduplicate,
  weibullDecay,
  reinforcementFactor,
  lengthNorm,
} from '../utils.js';

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
  importance, access_count, cited_count, urgency, created_at, last_accessed,
  content_hash, metadata`;

/**
 * Main retrieval function — handles FTS5 → score → MMR → filter.
 */
export function retrieve(options: RetrievalOptions): Memory[] {
  const { db, config, log, agentId, visibleAgentIds, query, mmrEnabled, limit, ftsEnabled } = options;

  const safeLimit = Math.min(limit, 100);
  const agentFilter = visibleAgentIds !== null
    ? `agent_id IN (${visibleAgentIds.map(() => '?').join(',')})`
    : '1=1';

  let candidates: Memory[] = [];

  // ---- FTS5 path ----
  if (ftsEnabled) {
    const ftsQuery = query.trim().replace(/'/g, "''");
    if (ftsQuery) {
      try {
        const runFts = (q: string): Memory[] => {
          const baseSql = `SELECT ${FIELDS} FROM memories m JOIN memories_fts fts ON m.id = fts.id WHERE ${agentFilter} AND fts MATCH ? ORDER BY bm25(fts, 1.0, 2.0) DESC, m.importance DESC LIMIT ?`;
          const params = visibleAgentIds !== null ? [...visibleAgentIds, q, safeLimit] : [q, safeLimit];
          return queryAll(db, baseSql, params) as unknown as Memory[];
        };

        candidates = runFts(ftsQuery);

        // Query Expansion: if empty, retry after dropping shortest term (once)
        if (candidates.length === 0) {
          const terms = ftsQuery.split(/\s+/).filter(t => t.length > 1);
          if (terms.length > 1) {
            const expanded = terms.sort((a, b) => a.length - b.length).slice(1).join(' ');
            candidates = runFts(expanded);
          }
        }
      } catch (err) {
        log.warn(`[algo-memory] FTS5 search failed: ${err}`);
      }
    }
  }

  // ---- LIKE fallback (when FTS5 unavailable or returned nothing) ----
  if (candidates.length === 0) {
    const likeQuery = query.replace(/'/g, "''").trim();
    if (likeQuery) {
      const sql = `SELECT ${FIELDS} FROM memories WHERE ${agentFilter} AND (content LIKE ? OR keywords LIKE ?) ORDER BY importance DESC, created_at DESC LIMIT ?`;
      const params = visibleAgentIds !== null ? [...visibleAgentIds, `%${likeQuery}%`, `%${likeQuery}%`, safeLimit] : [`%${likeQuery}%`, `%${likeQuery}%`, safeLimit];
      candidates = queryAll(db, sql, params) as unknown as Memory[];
    }
  }

  if (candidates.length === 0) return [];

  // ---- Score ----
  const scored = candidates.map(m => {
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

  // ---- MMR (optional) ----
  const mmrCandidates = mmrEnabled && config.mmr.enabled
    ? mmrDeduplicate(scored, config.mmr)
    : scored;

  // ---- HardMinScore filter ----
  const filtered = config.hardMinScore.enabled
    ? mmrCandidates.filter(m => (m._score ?? m.importance) >= config.hardMinScore.threshold)
    : mmrCandidates;

  return filtered;
}
