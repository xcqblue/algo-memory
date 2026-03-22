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
  MAX_MESSAGE_LENGTH,
  MAX_SIMILAR_CHECK
} from '../utils.js';
import { queryAll, queryOne, run, runOrThrow } from '../db/queries.js';
import { LLMClient } from './llm.js';
import type { DbLike } from '../db/queries.js';

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

      const scope = config.scopes.enabled
        ? `${config.scopes.defaultScope}:${AgentId}`
        : 'global';
      const tier = getTier(importance, 1, 0, config.tier);

      const metadata = JSON.stringify({
        memory_category: isCore ? 'fact' : 'other',
        confidence: importance,
        source_session: AgentId,
        l0_abstract: safe.substring(0, 100)
      });

      const memory: Memory = {
        id: generateId(),
        agent_id: AgentId,
        scope,
        content: safe,
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

      runOrThrow(db,
        `INSERT INTO memories (id, agent_id, scope, content, type, tier, layer, keywords, importance, access_count, cited_count, created_at, last_accessed, content_hash, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [memory.id, memory.agent_id, memory.scope, memory.content, memory.type, memory.tier, memory.layer, memory.keywords, memory.importance, memory.access_count, memory.cited_count, memory.created_at, memory.last_accessed, memory.content_hash, memory.metadata]
      );

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
      log.info(`[algo-memory] 存储完成, 新增: ${captured}, agentId: ${AgentId}, 耗时: ${storeDuration}ms`);
    }
  } catch (err) {
    log.error('[algo-memory] store 操作失败:', err);
    metrics.dbErrors++;
    metrics.lastErrorAt = Date.now();
  }

  return captured;
}
