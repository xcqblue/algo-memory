/**
 * algo-memory v2.6.0
 * 纯算法长期记忆插件 - 无需 LLM 也能工作
 * 支持多语言: zh/en/ja/ko/es/fr/de
 * 支持 FTS5 全文搜索
 */

import path from 'path';
import fs from 'fs';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import LRUCache from 'lru-cache';
import { Type } from '@sinclair/typebox';
import { initSchema } from './db/schema.js';
import { queryAll, queryOne, run, runOrThrow } from './db/queries.js';
import { store as doStore, normalizeForStorage, safeContent, flushAllBuffers, getBufferStats } from './engine/store.js';

import { retrieve } from './engine/retrieve.js';
import { recall as doRecall } from './engine/recall.js';
import type { StoreDeps } from './engine/store.js';
import type { RecallDeps } from './engine/recall.js';
import { LLMClient, resolveLLMConfig, llmEndpoint, llmHeaders } from './engine/llm.js';
import type { Config } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import {
  normalizeText,
  isNoise,
  isCoreKeyword,
  extractKeywords,
  hashContent,
  generateId,
  getTier,
  shouldRetrieve,
  estimateTokens,
  extractMessageText,
  CACHE_MAX_SIZE,
  CACHE_TTL_MS,
  DEFAULT_CLEANUP_INTERVAL_MS
} from './utils.js';

// ============= Config merge helper =============
// Uses explicit `!== undefined` so that `false`/`0` from userConfig are respected.
function mergeConfig(userConfig: Partial<Config>): Config {
  const scalar = <K extends keyof Config>(key: K, fallback: Config[K]): Config[K] =>
    userConfig[key] !== undefined ? userConfig[key] as Config[K] : fallback;
  return {
    ...DEFAULT_CONFIG,
    noiseFilter: { ...DEFAULT_CONFIG.noiseFilter, ...userConfig.noiseFilter },
    adaptiveRetrieval: { ...DEFAULT_CONFIG.adaptiveRetrieval, ...userConfig.adaptiveRetrieval },
    weibullDecay: { ...DEFAULT_CONFIG.weibullDecay, ...userConfig.weibullDecay },
    reinforcement: { ...DEFAULT_CONFIG.reinforcement, ...userConfig.reinforcement },
    mmr: { ...DEFAULT_CONFIG.mmr, ...userConfig.mmr },
    lengthNorm: { ...DEFAULT_CONFIG.lengthNorm, ...userConfig.lengthNorm },
    hardMinScore: { ...DEFAULT_CONFIG.hardMinScore, ...userConfig.hardMinScore },
    tier: {
      ...DEFAULT_CONFIG.tier,
      ...userConfig.tier,
      weights: { ...DEFAULT_CONFIG.tier.weights, ...(userConfig.tier?.weights || {}) }
    },
    scopes: { ...DEFAULT_CONFIG.scopes, ...userConfig.scopes },
    llm: resolveLLMConfig({ ...DEFAULT_CONFIG.llm, ...userConfig.llm }),
    threshold: { ...DEFAULT_CONFIG.threshold, ...userConfig.threshold },
    autoCapture: scalar('autoCapture', DEFAULT_CONFIG.autoCapture),
    autoRecall: scalar('autoRecall', DEFAULT_CONFIG.autoRecall),
    maxResults: scalar('maxResults', DEFAULT_CONFIG.maxResults),
    maxInjectTokens: scalar('maxInjectTokens', DEFAULT_CONFIG.maxInjectTokens),
    cleanupDays: scalar('cleanupDays', DEFAULT_CONFIG.cleanupDays),
    language: scalar('language', DEFAULT_CONFIG.language),
    coreKeywords: scalar('coreKeywords', DEFAULT_CONFIG.coreKeywords),
    recencyDecay: scalar('recencyDecay', DEFAULT_CONFIG.recencyDecay),
    recencyHalfLife: scalar('recencyHalfLife', DEFAULT_CONFIG.recencyHalfLife),
    smartDedup: scalar('smartDedup', DEFAULT_CONFIG.smartDedup),
    dedupThreshold: scalar('dedupThreshold', DEFAULT_CONFIG.dedupThreshold),
    capturePerTurn: scalar('capturePerTurn', DEFAULT_CONFIG.capturePerTurn),
    feedback: { ...DEFAULT_CONFIG.feedback, ...userConfig.feedback },
    mcp: { ...DEFAULT_CONFIG.mcp, ...userConfig.mcp },
    batchWrite: { ...DEFAULT_CONFIG.batchWrite, ...userConfig.batchWrite },
    compression: { ...DEFAULT_CONFIG.compression, ...userConfig.compression },
  };
}

// ============= MemoryPlugin =============
class MemoryPlugin {
  id = 'algo-memory';
  private db: Database.Database | null = null;
  private dbPath: string = '';
  private cache: LRUCache<string, any>;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private config: Config;
  /** 供外部 hook 调用，init 后 db 不为 null */
  getDb(): DatabaseType { return this.db!; }
  private _db(): DatabaseType { return this.db!; }
  llmClient: LLMClient | null = null;
  private log: any;
  configHash: string = '';
  private ftsAvailable: boolean = false;
  /** per-agent 会话去重追踪（避免跨 Agent 误拦截） */
  private lastRecallQuery: Map<string, string> = new Map();
  private lastRecallTime: Map<string, number> = new Map();
  getLastRecallQuery(agentId: string): string { return this.lastRecallQuery.get(agentId) ?? ''; }
  getLastRecallTime(agentId: string): number { return this.lastRecallTime.get(agentId) ?? 0; }

  // Error metrics
  public metrics = {
    llmErrors: { core: 0, extract: 0, dedup: 0 },
    dbErrors: 0,
    lastErrorAt: null as number | null,
    llmApiCalls: 0,
    totalTokens: 0,
    llmCacheHits: 0,
  };

  constructor(config: Partial<Config>, log: any = console) {
    this.config = mergeConfig(config);
    this.log = log;
    this.cache = new LRUCache({ max: CACHE_MAX_SIZE, ttl: CACHE_TTL_MS });

    const recallFields = {
      maxResults: this.config.maxResults,
      recencyDecay: this.config.recencyDecay,
      recencyHalfLife: this.config.recencyHalfLife,
      weibullDecay: this.config.weibullDecay,
      reinforcement: this.config.reinforcement,
      mmr: this.config.mmr,
      lengthNorm: this.config.lengthNorm,
      hardMinScore: this.config.hardMinScore,
      tier: this.config.tier,
    };
    this.configHash = hashContent(
      Object.keys(recallFields).sort()
        .map(k => `${k}=${JSON.stringify(recallFields[k as keyof typeof recallFields])}`).join('|')
    );

    if (this.config.llm.enabled && this.config.llm.apiKey) {
      this.llmClient = new LLMClient(this.config, this.log);
      this.llmClient.onCoreError = () => { this.metrics.llmErrors.core++; this.metrics.lastErrorAt = Date.now(); };
      this.llmClient.onExtractError = () => { this.metrics.llmErrors.extract++; this.metrics.lastErrorAt = Date.now(); };
      this.llmClient.onDedupError = () => { this.metrics.llmErrors.dedup++; this.metrics.lastErrorAt = Date.now(); };
    }
  }

  // Called by OpenClaw registry after registerService
  async start(_context: any): Promise<void> {}

  // Detect duplicate plugin instance via PID file
  private checkPidFile(stateDir: string): void {
    try {
      const pidPath = path.join(stateDir, 'algo-memory.pid');
      if (fs.existsSync(pidPath)) {
        const oldPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        try { process.kill(oldPid, 0); } catch (_) { return; }
        this.log.warn(`[algo-memory] 检测到另一个实例正在运行 (PID ${oldPid})`);
      }
      fs.writeFileSync(pidPath, String(process.pid));
    } catch (_) { /* non-critical */ }
  }

  async init(stateDir: string): Promise<void> {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    this.dbPath = path.join(stateDir, 'memories.db');
    this.checkPidFile(stateDir);

    // Load existing DB or create new — synchronous with better-sqlite3
    try {
      this.db = new Database(this.dbPath);
    } catch (err) {
      this.log.error('[algo-memory] 数据库打开失败:', err);
      throw err;
    }

    initSchema(this._db(), this.log);

    // Probe FTS5 availability
    try {
      this._db().exec("SELECT count(*) FROM memories_fts LIMIT 0");
      this.ftsAvailable = true;
      // Rebuild FTS index on startup to fix any prior rowid drift
      this.rebuildFTS();
    } catch (_) {
      this.ftsAvailable = false;
      this.log.warn('[algo-memory] FTS5 不可用，搜索将降级为 LIKE');
    }

    this.log.info('[algo-memory] 数据库初始化:', this.dbPath);
    this.log.info(`[algo-memory] 每轮最多写入: ${this.config.capturePerTurn} 条`);

    this.cleanupInterval = setInterval(() => this.cleanup(), DEFAULT_CLEANUP_INTERVAL_MS);
  }

  async store(AgentId: string, messages: any[]): Promise<void> {
    const deps: StoreDeps = {
      db: this._db(),
      config: this.config,
      llmClient: this.llmClient,
      log: this.log,
      clearRecallCache: (aid: string) => this.clearRecallCache(aid),
      metrics: this.metrics
    };
    await doStore(deps, AgentId, messages);
  }

  async recall(AgentId: string, query: string, options?: { limit?: number; skipDedup?: boolean }): Promise<{ hasMemory: boolean; memories: any[] }> {
    const deps = {
      db: this._db(),
      config: this.config,
      log: this.log,
      getVisibleAgentIds: (aid: string) => this.getVisibleAgentIds(aid),
      cache: this.cache as any,
      configHash: this.configHash,
      lastRecallQuery: this.lastRecallQuery.get(AgentId) ?? '',
      lastRecallTime: this.lastRecallTime.get(AgentId) ?? 0,
      ftsEnabled: this.ftsAvailable,
    };
    const result = await doRecall(deps, AgentId, query, options);
    // 只有真正召回到了记忆才更新会话去重状态
    // shouldRetrieve 跳过时（query太短/重复）不更新，让下次同类查询仍能触发
    if (result.hasMemory) {
      this.lastRecallQuery.set(AgentId, query);
      this.lastRecallTime.set(AgentId, Date.now());
    }
    return result;
  }

  listMemories(AgentId: string, limit: number = 20, offset: number = 0): any[] {
    const safeLimit = Math.min(limit, (this.config.maxResults || 5) * 10);
    const safeOffset = Math.max(0, offset);
    if (!this.db) return [];
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    if (visibleAgentIds === null) {
      return queryAll(this._db(),
        'SELECT * FROM memories ORDER BY CASE tier WHEN \'core\' THEN 0 WHEN \'working\' THEN 1 ELSE 2 END, importance DESC, created_at DESC LIMIT ? OFFSET ?',
        [safeLimit, safeOffset]
      );
    }
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    return queryAll(this._db(),
      `SELECT * FROM memories WHERE agent_id IN (${placeholders}) ORDER BY CASE tier WHEN 'core' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, importance DESC, created_at DESC LIMIT ? OFFSET ?`,
      [...visibleAgentIds, safeLimit, safeOffset]
    );
  }

  private ftsQuery(AgentId: string, query: string, visibleAgentIds: string[] | null): any[] {
    try {
      if (!this.ftsAvailable) throw new Error('FTS5 unavailable');
      const terms = query.replace(/[^\w\s\u4e00-\u9fa5]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 20);
      const ftsQuery = terms.map((w: string) => `"${w}"*`).join(' OR ') || '';
      if (!ftsQuery) return [];
      const ftsLimit = Math.min(this.config.maxResults, 20);
      if (visibleAgentIds === null) {
        return queryAll(this._db(),
          `SELECT m.* FROM memories m JOIN memories_fts fts ON m.id = fts.id WHERE fts MATCH ? ORDER BY bm25(fts) DESC, m.importance DESC LIMIT ?`,
          [ftsQuery, ftsLimit]
        );
      }
      const placeholders = visibleAgentIds.map(() => '?').join(',');
      return queryAll(this._db(),
        `SELECT m.* FROM memories m JOIN memories_fts fts ON m.id = fts.id WHERE m.agent_id IN (${placeholders}) AND fts MATCH ? ORDER BY bm25(fts) DESC, m.importance DESC LIMIT ?`,
        [...visibleAgentIds, ftsQuery, ftsLimit]
      );
    } catch (_) {
      return [];
    }
  }

  private likeFallback(AgentId: string, query: string, visibleAgentIds: string[] | null): any[] {
    // Normalize each term to match safeContent() storage (strip markdown markers)
    const stripMarkdown = (t: string) => t
      .replace(/```[\s\S]*?```/g, m => m.replace(/```/g, ''))
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^\d+\.\s*/gm, '');
    const terms = query.trim().split(/\s+/).map(stripMarkdown).filter(Boolean);
    if (terms.length === 0) return [];
    const likeLimit = Math.min(this.config.maxResults, 20);
    if (visibleAgentIds === null) {
      const clause = terms.map(() => 'content LIKE ? OR keywords LIKE ?').join(' OR ');
      const params = terms.flatMap(t => [`%${t}%`, `%${t}%`]);
      return queryAll(this._db(),
        `SELECT * FROM memories WHERE (${clause}) ORDER BY importance DESC LIMIT ?`,
        [...params, likeLimit]
      );
    }
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    const clause = terms.map(() => 'content LIKE ? OR keywords LIKE ?').join(' OR ');
    const params = terms.flatMap(t => [`%${t}%`, `%${t}%`]);
    return queryAll(this._db(),
      `SELECT * FROM memories WHERE agent_id IN (${placeholders}) AND (${clause}) ORDER BY importance DESC LIMIT ?`,
      [...visibleAgentIds, ...params, likeLimit]
    );
  }

  searchMemories(AgentId: string, query: string): any[] {
    if (!this.db || !query?.trim()) return [];
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    const safeLimit = Math.min(this.config.maxResults * 3, 100);
    let results = this.ftsQuery(AgentId, cleanQuery, visibleAgentIds);
    if (results.length === 0) results = this.likeFallback(AgentId, cleanQuery, visibleAgentIds);

    // Update cited_count for searched memories (active use signals relevance)
    if (results.length > 0) {
      const ids = results.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      run(this._db(),
        `UPDATE memories SET cited_count = cited_count + 1 WHERE id IN (${placeholders})`,
        ids
      );
    }

    return results;
  }

  private getVisibleAgentIds(AgentId: string): string[] | null {
    const { scopes } = this.config;
    if (!scopes.enabled) return null;
    if (scopes.visibleAgents && scopes.visibleAgents.length > 0) {
      if (scopes.visibleAgents.includes('*')) return null;
      return [AgentId, ...scopes.visibleAgents];
    }
    return [AgentId];
  }

  getStats(AgentId: string): any {
    if (!this.db) return { total: 0, core: 0, working: 0, peripheral: 0, general: 0, metrics: this.metrics };
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    let row: Record<string, unknown> | null;
    if (visibleAgentIds === null) {
      row = queryOne(this._db(),
        `SELECT COUNT(*) as total, SUM(tier = 'core') as core, SUM(tier = 'working') as working, SUM(tier = 'peripheral') as peripheral, SUM(layer = 'general') as general FROM memories`
      );
    } else {
      const placeholders = visibleAgentIds.map(() => '?').join(',');
      row = queryOne(this._db(),
        `SELECT COUNT(*) as total, SUM(tier = 'core') as core, SUM(tier = 'working') as working, SUM(tier = 'peripheral') as peripheral, SUM(layer = 'general') as general FROM memories WHERE agent_id IN (${placeholders})`,
        visibleAgentIds
      );
    }
    const total = (row?.total as number) || 0;
    const core = (row?.core as number) || 0;
    const working = (row?.working as number) || 0;
    const peripheral = (row?.peripheral as number) || 0;
    const general = (row?.general as number) || 0;
    return { total, core, working, peripheral, general, metrics: this.metrics };
  }

  getMemory(AgentId: string, memoryId: string): any {
    if (!this.db) return null;
    const row = queryOne(this._db(),
      'SELECT * FROM memories WHERE id = ? AND agent_id = ?',
      [memoryId, AgentId]
    );
    return row || null;
  }

  deleteMemory(AgentId: string, memoryId: string): boolean {
    if (!this.db) return false;
    const changes = run(this._db(),
      'DELETE FROM memories WHERE id = ? AND agent_id = ?',
      [memoryId, AgentId]
    );
    this.clearRecallCache(AgentId);
    return changes > 0;
  }

  deleteBulk(AgentId: string, memoryIds: string[]): number {
    if (!this.db || memoryIds.length === 0) return 0;
    const placeholders = memoryIds.map(() => '?').join(',');
    const changes = run(this._db(),
      `DELETE FROM memories WHERE id IN (${placeholders}) AND agent_id = ?`,
      [...memoryIds, AgentId]
    );
    this.clearRecallCache(AgentId);
    return changes;
  }

  clearMemories(AgentId: string, keepCore: boolean = true): number {
    if (!this.db) return 0;
    const changes = keepCore
      ? run(this._db(), 'DELETE FROM memories WHERE agent_id = ? AND tier != ?', [AgentId, 'core'])
      : run(this._db(), 'DELETE FROM memories WHERE agent_id = ?', [AgentId]);
    this.clearRecallCache(AgentId);
    return changes;
  }

  async updateMemory(AgentId: string, memoryId: string, content: string): Promise<boolean> {
    if (!this.db) return false;
    const row = queryOne(this._db(),
      'SELECT * FROM memories WHERE id = ? AND agent_id = ?',
      [memoryId, AgentId]
    ) as any;
    if (!row) return false;

    const safe = safeContent(content);
    const keywords = extractKeywords(safe);
    // Importance: preserve existing unless coreKeyword hit on new content
    let importance = row.importance || 0.5;
    if (isCoreKeyword(safe, this.config.coreKeywords)) {
      importance = 1.0;
    }
    // Tier and access_count: preserve exactly as-is (update should not trigger demotion/reinforcement)
    const changes = run(this._db(),
      'UPDATE memories SET content = ?, keywords = ?, importance = ?, last_accessed = ?, content_hash = ? WHERE id = ? AND agent_id = ?',
      [safe, keywords, importance, Date.now(), hashContent(safe), memoryId, AgentId]
    );
    this.clearRecallCache(AgentId);
    return changes > 0;
  }

  /**
   * 自然语言记忆修正
   * @param AgentId Agent ID
   * @param correction 自然语言修正描述，如 "我住上海不是北京"
   * @returns 修正建议列表，包含原记忆ID、新内容、匹配理由
   */
  /**
   * 记忆修正
   *
   * 用法一（已知 memoryId，直接修正）：
   *   correct(agentId, null, memoryId, newContent)
   *   → 直接更新该记忆，返回 success
   *
   * 用法二（自然语言修正，AI 帮助定位 + 生成建议）：
   *   correct(agentId, correctionText)
   *   → 召回相关记忆 → LLM 生成修正建议 → 高置信度(>0.8)自动应用，低置信度返回建议待确认
   *
   * 返回结构（两种用法不同）：
   *   { applied: true, memoryId, content }           — 用法一，或用法二高置信度自动应用
   *   { found: true, candidates, suggestions }      — 用法二低置信度，返回建议供确认
   *   { found: false }                             — 用法二找不到相关记忆
   */
  async correct(
    AgentId: string,
    correction: string,
    memoryId?: string,
    newContent?: string
  ): Promise<
    | { applied: true; memoryId: string; content: string }
    | { found: true; candidates: any[]; suggestions: Array<{ memoryId: string; original: string; updated: string; reason: string; confidence: number }> }
    | { found: false }
  > {
    // === 用法一：直接修正（已知 memoryId） ===
    if (memoryId && newContent !== undefined) {
      const success = await this.updateMemory(AgentId, memoryId, newContent);
      if (!success) return { found: false }; // memoryId 不存在
      const row = queryOne(this._db(), 'SELECT content FROM memories WHERE id = ?', [memoryId]) as any;
      return { applied: true, memoryId, content: row?.content || newContent };
    }

    // === 用法二：自然语言修正（AI 辅助） ===
    if (!this.config.feedback.enabled) return { found: false };
    if (!correction.trim()) return { found: false };

    // 召回相关记忆作为候选
    const { hasMemory, memories } = await this.recall(AgentId, correction);
    if (!hasMemory || memories.length === 0) return { found: false };

    const candidates = memories.slice(0, this.config.feedback.maxMemories);

    // 无 LLM 时返回候选（用户可自行选择 memoryId 调用用法一）
    if (!this.llmClient || !this.config.llm.enabled || !this.config.llm.apiKey) {
      return {
        found: true,
        candidates,
        suggestions: candidates.map(m => ({
          memoryId: m.id,
          original: m.content,
          updated: m.content,
          reason: 'LLM 未启用，无法生成修正建议。请先搜索确认 memoryId 后用 memoryId+newContent 方式调用',
          confidence: 0,
        })),
      };
    }

    // LLM 生成修正建议
    const memoriesText = candidates.map((m, i) =>
      `[${i}] ID:${m.id}\n内容: ${m.content}`).join('\n\n');

    const systemPrompt = `你是一个记忆修正助手。用户会给出一条"修正描述"，以及多条候选记忆。
你的任务是：
1. 判断哪条记忆需要被修正（可能多条）
2. 根据修正描述生成新的记忆内容

回复 JSON 数组（如果没有需要修正的，返回空数组 []）：
[{"memoryId": "ID", "updated": "修正后的内容", "reason": "修正理由", "confidence": 0.9}]
confidence 是 0-1 的置信度。

注意：只修改明确需要修改的记忆，不要过度修正。`;

    try {
      const response = await fetch(llmEndpoint(this.config.llm.baseURL, this.config.llm.provider), {
        method: 'POST',
        headers: llmHeaders(this.config.llm.apiKey, this.config.llm.provider),
        body: JSON.stringify({
          model: this.config.llm.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `修正描述: "${correction}"\n\n候选记忆:\n${memoriesText}` }
          ],
          max_tokens: 1024,
          temperature: 0.3
        })
      });

      if (!response.ok) {
        this.log.error('[algo-memory] correct LLM 调用失败:', response.status);
        return { found: false };
      }

      const json = await response.json() as any;
      const raw = json?.choices?.[0]?.message?.content || '[]';
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```|^\s*(\[[\s\S]*?\])\s*$/m);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[2]) : raw;
      const suggestions: Array<{ memoryId: string; updated: string; reason: string; confidence: number }> = JSON.parse(jsonStr);

      const filtered = suggestions
        .filter(s => s.confidence >= this.config.feedback.matchThreshold)
        .map(s => {
          const orig = candidates.find(c => c.id === s.memoryId);
          return {
            memoryId: s.memoryId,
            original: orig?.content || '',
            updated: s.updated,
            reason: s.reason,
            confidence: s.confidence,
          };
        });

      // 高置信度建议自动应用（confidence > 0.8），低置信度返回建议待确认
      const toApply = filtered.filter(s => s.confidence > 0.8);
      for (const s of toApply) {
        await this.updateMemory(AgentId, s.memoryId, s.updated);
      }

      return {
        found: true,
        candidates,
        suggestions: filtered.map(s => ({
          ...s,
          autoApplied: s.confidence > 0.8,
        })),
      };
    } catch (err) {
      this.log.error('[algo-memory] correct 失败:', err);
      return { found: false };
    }
  }

  importMemories(AgentId: string, memories: any[]): number {
    if (!this.db) return 0;
    let imported = 0;
    try {
      runOrThrow(this._db(), 'BEGIN IMMEDIATE');
      for (const m of memories) {
        try {
          const safe = safeContent(m.content || '');
          const tier = getTier(m.importance || 0.5, m.access_count || 1, 0, this.config.tier);
          run(this._db(),
            `INSERT INTO memories (id, agent_id, scope, content, type, tier, layer, keywords, importance, access_count, cited_count, created_at, last_accessed, content_hash, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               agent_id=excluded.agent_id, scope=excluded.scope, content=excluded.content,
               type=excluded.type, tier=excluded.tier, layer=excluded.layer,
               keywords=excluded.keywords, importance=excluded.importance,
               access_count=MAX(excluded.access_count, memories.access_count),
               cited_count=MAX(excluded.cited_count, memories.cited_count),
               created_at=excluded.created_at, last_accessed=excluded.last_accessed,
               content_hash=excluded.content_hash, metadata=excluded.metadata`,
            [
              m.id || generateId(), AgentId, m.scope || 'global',
              safe, m.type || 'other', tier, m.layer || 'general',
              m.keywords || '', m.importance || 0.5, m.access_count || 1,
              m.cited_count || 0,
              m.created_at || Date.now(), m.last_accessed || Date.now(),
              m.content_hash || hashContent(safe), m.metadata || null
            ]
          );
          imported++;
        } catch (_) { /* skip bad rows */ }
      }
      runOrThrow(this._db(), 'COMMIT');
    } catch (_) {
      try { runOrThrow(this._db(), 'ROLLBACK'); } catch (_) { /* ignore */ }
      return 0;
    }
    if (imported > 0) {
      this.clearRecallCache(AgentId);
      // Rebuild FTS index after bulk import to ensure FTS entries are in sync
      this.rebuildFTS();
    }
    return imported;
  }

  exportMemories(AgentId: string, maxExport: number = 1000): any[] {
    const safeLimit = Math.min(maxExport, 50000); // hard upper bound to prevent OOM
    if (!this.db) return [];
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    if (visibleAgentIds === null) {
      return queryAll(this._db(), 'SELECT * FROM memories ORDER BY created_at DESC LIMIT ?', [safeLimit]);
    }
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    return queryAll(this._db(),
      `SELECT * FROM memories WHERE agent_id IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`,
      [...visibleAgentIds, safeLimit]
    );
  }

  getMetrics() {
    return this.metrics;
  }

  /** 重建 FTS5 索引，修复 id 飘移导致的 "missing row" 错误 */
  rebuildFTS(): { success: boolean; message: string } {
    if (!this.db) return { success: false, message: '数据库未初始化' };
    if (!this.ftsAvailable) return { success: false, message: 'FTS5 不可用' };
    try {
      // 重建 FTS 索引：清空后用 id（稳定键）重新插入所有行
      this._db().exec(`
        DELETE FROM memories_fts;
        INSERT INTO memories_fts(id, content, keywords)
          SELECT id, content, keywords FROM memories;
      `);
      const count = (this._db().prepare('SELECT COUNT(*) as cnt FROM memories_fts').get() as any)?.cnt || 0;
      this.log.info(`[algo-memory] FTS5 索引重建完成，共 ${count} 条记录`);
      return { success: true, message: `FTS5 重建成功，共 ${count} 条记录` };
    } catch (err: any) {
      this.log.error('[algo-memory] FTS5 重建失败:', err);
      return { success: false, message: `FTS5 重建失败: ${err.message}` };
    }
  }

  private clearRecallCache(AgentId: string): void {
    try {
      const store = (this.cache as any).store as Map<string, any> | undefined;
      if (store && typeof store.keys === 'function') {
        for (const key of store.keys()) {
          if (key.startsWith(`recall:${AgentId}:`)) store.delete(key);
        }
      } else {
        this.cache.clear();
      }
    } catch (_) {
      this.cache.clear();
    }
  }

  cleanup(): void {
    if (!this.db) return;
    const cutoff = Date.now() - this.config.cleanupDays * 24 * 60 * 60 * 1000;
    const BATCH = 5000;
    let total = 0;
    let deleted = 0;
    do {
      let rows: any[] = [];
      try {
        rows = queryAll(this._db(),
          `SELECT rowid FROM memories WHERE last_accessed < ? AND layer = 'general' AND tier = 'peripheral' LIMIT ?`,
          [cutoff, BATCH]
        );
      } catch (err) {
        this.log.error('[algo-memory] cleanup 查询失败:', err);
        break;
      }
      if (rows.length === 0) break;
      const rowids = rows.map((r: any) => r.rowid);
      try {
        deleted = run(this._db(),
          `DELETE FROM memories WHERE rowid IN (${rowids.map(() => '?').join(',')})`,
          rowids
        );
      } catch (err) {
        this.log.error('[algo-memory] cleanup 删除失败:', err);
        break;
      }
      total += deleted;
    } while (deleted === BATCH);
    if (total > 0) {
      this.log.info('[algo-memory] 清理了', total, '条过期记忆');
    }
  }


  /**
   * compaction 周期开始前：将频繁访问的 peripheral 记忆升级为 working
   * 利用 compaction 机会重新评估记忆层级，减少手动干预
   * March 5 2026: OpenClaw 引入 session:compact:before 钩子
   */
  async promotePeripheralOnCompaction(AgentId: string): Promise<void> {
    if (!this.db) return;
    if (!this.config.reinforcement?.enabled) return;
    const threshold = this.config.tier?.coreThreshold ?? 10;

    try {
      const candidates = queryAll(this._db(),
        `SELECT id, access_count, importance, content FROM memories
         WHERE agent_id = ? AND tier = 'peripheral' AND access_count >= ?
         LIMIT 50`,
        [AgentId, Math.floor(threshold * 0.5)] // access_count 达到 coreThreshold 50% 的 peripheral 优先处理
      ) as any[];

      for (const m of candidates) {
        const newTier = getTier(m.importance, m.access_count, 0, this.config.tier);
        if (newTier !== 'peripheral') {
          run(this._db(), `UPDATE memories SET tier = ? WHERE id = ?`, [newTier, m.id]);
          this.log.info(`[algo-memory] [compaction] peripheral→${newTier} 升级: id=${m.id}, access_count=${m.access_count}`);
        }
      }
    } catch (err) {
      this.log.error('[algo-memory] promotePeripheralOnCompaction 失败:', err);
    }
  }

  /**
   * compaction 周期结束后：对旧 peripheral 记忆执行强化/降级
   * citation 多的记忆强化，访问少的降级
   * March 5 2026: OpenClaw 引入 session:compact:after 钩子
   */
  async reinforceOnCompaction(AgentId: string): Promise<void> {
    if (!this.db) return;
    if (!this.config.reinforcement?.enabled) return;
    const factor = this.config.reinforcement?.factor ?? 0.5;

    try {
      // 对 core 层：访问多的增加 importance
      const coreCandidates = queryAll(this._db(),
        `SELECT id, importance, access_count, cited_count FROM memories
         WHERE agent_id = ? AND tier = 'core' AND cited_count > 0
         ORDER BY cited_count DESC LIMIT 20`,
        [AgentId]
      ) as any[];

      for (const m of coreCandidates) {
        const boost = Math.min(m.cited_count * factor * 0.05, 0.3); // 最多加 0.3
        const newImportance = Math.min(1.0, m.importance + boost);
        if (newImportance !== m.importance) {
          run(this._db(),
            `UPDATE memories SET importance = ?, last_accessed = ? WHERE id = ?`,
            [newImportance, Date.now(), m.id]
          );
        }
      }

      // 对 peripheral 层：访问很少的降低 importance 或删除
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30天未访问
      const oldPeripheral = queryAll(this._db(),
        `SELECT id, importance FROM memories
         WHERE agent_id = ? AND tier = 'peripheral' AND last_accessed < ?
         ORDER BY importance ASC LIMIT 20`,
        [AgentId, cutoff]
      ) as any[];

      for (const m of oldPeripheral) {
        const newImportance = Math.max(0.01, m.importance - 0.1);
        if (newImportance < 0.05) {
          // 几乎无用的记忆直接删除
          run(this._db(), `DELETE FROM memories WHERE id = ?`, [m.id]);
          this.log.info(`[algo-memory] [compaction] 删除低价值 peripheral: id=${m.id}`);
        } else {
          run(this._db(), `UPDATE memories SET importance = ? WHERE id = ?`, [newImportance, m.id]);
        }
      }
    } catch (err) {
      this.log.error('[algo-memory] reinforceOnCompaction 失败:', err);
    }
  }


  /** 插件是否处于激活状态 */
  isActive(): boolean {
    return this.db !== null;
  }

  /** 手动刷新所有 agent 的 buffer 到 DB */
  flushAll(): void {
    if (!this.db) return;
    flushAllBuffers(this._db(), this.config, this.log);
  }

  /**
   * 健康检查：全面诊断 DB、FTS、buffer、内存、LLM 调用状态
   */
  getHealth(): {
    ok: boolean; db: any; fts: any; buffer: any; memory: any;
    llmStats: any; config: any; issues: string[];
  } {
    const issues: string[] = [];
    const db: any = { ok: false };
    const fts: any = { ok: false };
    const buffer: any = {};
    const llmStats: any = {};

    if (!this.db) {
      issues.push('数据库未初始化（插件未启动或加载失败）');
      return { ok: false, db, fts, buffer, memory: {}, llmStats, config: {}, issues };
    }

    // DB 基本检查
    try {
      const memCount = (queryOne(this._db(), 'SELECT COUNT(*) as cnt FROM memories') as any)?.cnt ?? 0;
      db.ok = true;
      db.memories = memCount;
      db.path = this.dbPath;
    } catch (err: any) {
      issues.push(`DB 查询失败: ${err?.message ?? err}`);
    }

    // FTS 检查
    try {
      if (this.ftsAvailable) {
        const ftsCount = (queryOne(this._db(), 'SELECT COUNT(*) as cnt FROM memories_fts') as any)?.cnt ?? 0;
        const memCount = (queryOne(this._db(), 'SELECT COUNT(*) as cnt FROM memories') as any)?.cnt ?? 0;
        fts.ok = true;
        fts.indexed = ftsCount;
        fts.memories = memCount;
        fts.synced = ftsCount === memCount;
        if (ftsCount !== memCount) {
          issues.push(`FTS 索引与主表不同步: FTS=${ftsCount} vs memories=${memCount}，建议运行 rebuildFTS`);
        }
      } else {
        issues.push('FTS5 不可用，搜索将使用 LIKE 降级');
      }
    } catch (err: any) {
      issues.push(`FTS 检查失败: ${err?.message ?? err}`);
    }

    // Buffer 状态
    try {
      const memBuffers = getBufferStats();
      const bufferEntries = Object.entries(memBuffers);
      for (const [id, stat] of bufferEntries) {
        buffer[id] = {
          pending: stat.pending,
          flushing: stat.flushing,
          lastFlush: stat.lastFlush ? new Date(stat.lastFlush).toISOString() : null
        };
      }
      if (bufferEntries.length === 0) {
        issues.push('无活动的 Buffer（插件可能未处理过消息）');
      }
    } catch (err: any) {
      issues.push(`Buffer 状态读取失败: ${err?.message ?? err}`);
    }

    // LLM 统计
    llmStats.apiCalls = this.metrics.llmApiCalls ?? 0;
    llmStats.totalTokens = this.metrics.totalTokens ?? 0;
    llmStats.cacheHits = this.metrics.llmCacheHits ?? 0;

    // Config 有效性
    const config = {
      autoCapture: this.config.autoCapture,
      autoRecall: this.config.autoRecall,
      cleanupDays: this.config.cleanupDays,
      llmProvider: this.config.llm?.provider ?? '未配置',
      mmrLambda: this.config.mmr?.lambda,
    };

    return {
      ok: issues.length === 0,
      db,
      fts,
      buffer,
      memory: { rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB' },
      llmStats,
      config,
      issues
    };
  }

  /**
   * 手动触发 compaction 强化流程（对应 session:compact:before + after 的合并调用）
   * 等价于 OpenClaw 压缩周期中的强化步骤
   */
  async manualCompact(AgentId: string): Promise<{ success: boolean; message: string; promoted?: number; reinforced?: number; pruned?: number }> {
    if (!this.db) return { success: false, message: '数据库未初始化' };
    try {
      await this.promotePeripheralOnCompaction(AgentId);
      await this.reinforceOnCompaction(AgentId);
      return {
        success: true,
        message: 'compaction 强化完成',
        promoted: 0,
        reinforced: 0,
        pruned: 0
      };
    } catch (err: any) {
      return { success: false, message: `compaction 失败: ${err.message}` };
    }
  }

  /**
   * 立即强化被工具调用召回的记忆（after_tool_call hook 专用）
   * 比 agent_end 更早更新 cited_count，实现实时强化
   */
  async reinforceCitedMemories(AgentId: string, citedIds: string[]): Promise<void> {
    if (!this.db || citedIds.length === 0) return;
    try {
      const placeholders = citedIds.map(() => '?').join(',');
      run(this._db(),
        `UPDATE memories SET cited_count = cited_count + 1, last_accessed = ?
         WHERE id IN (${placeholders}) AND agent_id = ?`,
        [Date.now(), ...citedIds, AgentId]
      );
      this.log.info(`[algo-memory] [after_tool_call] 强化 ${citedIds.length} 条被召回记忆`);
    } catch (err) {
      this.log.error('[algo-memory] reinforceCitedMemories 失败:', err);
    }
  }

  /**
   * 记录 LLM 调用统计（llm_output hook 专用）
   * 用于 memory metrics，不影响记忆存储
   */
  recordLlmUsage(AgentId: string, usage: {
    inputTokens?: number; outputTokens?: number;
    cacheRead?: number; cacheWrite?: number; totalTokens?: number;
  }): void {
    try {
      this.metrics.llmApiCalls = (this.metrics.llmApiCalls || 0) + 1;
      if (usage.totalTokens) {
        this.metrics.totalTokens = (this.metrics.totalTokens || 0) + usage.totalTokens;
      }
      this.log.info(`[algo-memory] [llm_output] LLM tokens: in=${usage.inputTokens}, out=${usage.outputTokens}, cacheR=${usage.cacheRead}`);
    } catch (err) {
      this.log.error('[algo-memory] recordLlmUsage 失败:', err);
    }
  }

  /**
   * 同步 core 层记忆到 workspace 文件（已禁用：workspace plugin 使用 JSON 格式，
   * 直接写 Markdown 会导致冲突。如需持久化，使用 export 工具导出 JSON。）
   */
  async syncCoreToWorkspace(): Promise<{ synced: number; skipped: number; message: string }> {
    this.log.warn('[algo-memory] syncCoreToWorkspace 已禁用：workspace plugin 使用 JSON 格式，写入 Markdown 会导致冲突。请使用 algo_memory_export 导出记忆。');
    return { synced: 0, skipped: 0, message: '已禁用，请使用 algo_memory_export 导出' };
  }

  // ===== CLI 增强工具 =====

  /** 详细召回统计（CLI 用） */
  getRecallStats(AgentId: string): any {
    const lastQuery = this.lastRecallQuery.get(AgentId) ?? '';
    const lastRecallTs = this.lastRecallTime.get(AgentId);
    const stats = this.getStats(AgentId);
    const dbPath = this.dbPath;
    const ftsAvailable = this.ftsAvailable;
    const sessionDedup = this.config.adaptiveRetrieval.sessionDedup;
    const mmrEnabled = this.config.mmr.enabled;
    const mmrLambda = this.config.mmr.lambda;
    return { ...stats, dbPath, ftsAvailable, sessionDedup, lastQuery, lastRecallTs, mmrEnabled, mmrLambda };
  }

  /** 查看最近召回记录（会话去重状态） */
  getLastRecallInfo(AgentId: string): any {
    const lastQuery = this.lastRecallQuery.get(AgentId) ?? '';
    const lastRecallTime = this.lastRecallTime.get(AgentId);
    return {
      agentId: AgentId,
      lastQuery: lastQuery || '(空)',
      lastRecallTime: lastRecallTime ? new Date(lastRecallTime).toISOString() : null,
      sessionDedupEnabled: this.config.adaptiveRetrieval.sessionDedup?.enabled ?? false,
      sessionDedupWindowMs: this.config.adaptiveRetrieval.sessionDedup?.windowMs ?? 0,
      sessionDedupSimilarity: this.config.adaptiveRetrieval.sessionDedup?.similarityThreshold ?? 0,
    };
  }

  /** 清除指定 Agent 的会话去重状态，允许相同查询再次召回 */
  clearRecallDedup(AgentId: string): { success: boolean; message: string } {
    this.lastRecallQuery.delete(AgentId);
    this.lastRecallTime.delete(AgentId);
    return { success: true, message: `Agent ${AgentId} 的会话去重状态已清除` };
  }

  // ============= 会话续接功能 =============
  /** 上一次会话的 sessionKey（用于检测会话切换） */
  close(): void {
    if (this.cleanupInterval) { clearInterval(this.cleanupInterval); this.cleanupInterval = null; }
    this.cache.clear();
    if (this.db) {
      try {
        // Flush all buffers — errors are logged but do not prevent DB close
        flushAllBuffers(this._db(), this.config, this.log);
      } catch (err: any) {
        this.log.error('[algo-memory] close() flush 失败:', err?.message ?? err);
      }
      try {
        const pidPath = this.dbPath.replace(/[/\\][^/\\]+$/, '') + '/algo-memory.pid';
        fs.unlinkSync(pidPath);
      } catch (_) { /* ignore */ }
      this.db.close();
      this.db = null;
    }
    this.log.info('[algo-memory] 插件已关闭');
  }
}

// ============= Plugin Export =============
export default {
  id: 'algo-memory',
  name: 'algo-memory',
  version: '2.6.0',
  async register(api: any) {
    const log = api.logger || console;
    const userConfig = api.pluginConfig || api.config || {};
    const config = mergeConfig(userConfig);

    const plugin = new MemoryPlugin(config, log);

    await plugin.init(api.getStateDir?.() || api.stateDir ||
      path.join(process.env.HOME || '/home/x', '.openclaw', 'state', 'algo-memory'));

    // === Hooks ===
    // IMPORTANT: All OpenClaw hooks pass (event, ctx) — ctx.agentId is the source of truth.
    if (config.autoCapture) {
      api.on('agent_end', async (event: any, ctx: any) => {
        const agentId = ctx?.agentId || 'default';
        const messages = event?.messages || [];
        if (messages.length > 0) {
          plugin.store(agentId, messages).catch((err: any) => {
            log.error('[algo-memory] agent_end store 错误:', err?.message ?? err);
          });
        }
      });
    }

    if (config.autoRecall) {
      api.on('before_prompt_build', async (event: any, ctx: any) => {
        try {
          const agentId = ctx?.agentId || 'default';
          const messages = event?.messages || [];
          // Handle Feishu array-format messages like [{type, text}] in addition to plain strings
          const userMessages = (messages as any[])
            .filter((m: any) => m.role === 'user')
            .map((m: any) => extractMessageText(m.content))
            .filter(Boolean);
          if (userMessages.length === 0) return;
          const query = userMessages.slice(-3).join(' ');
          // Session dedup is handled inside shouldRetrieve via per-agent dedup state
          if (!shouldRetrieve(query, config as any, { lastQuery: plugin.getLastRecallQuery(agentId), lastRecallTime: plugin.getLastRecallTime(agentId) })) return;

          const { hasMemory, memories } = await plugin.recall(agentId, query);
          if (hasMemory && memories.length > 0) {
            const MAX_INJECT_TOKENS = config.maxInjectTokens;
            const header = '\n\n以下是相关记忆：\n';
            let tokenCount = estimateTokens(header);
            const selected: string[] = [];
            let omitted = 0;
            for (const m of memories) {
              const line = `[记忆] ${m.content}`;
              const lineTokens = estimateTokens(line) + 1;
              if (tokenCount + lineTokens <= MAX_INJECT_TOKENS) {
                selected.push(line);
                tokenCount += lineTokens;
              } else omitted++;
            }
            const suffix = omitted > 0 ? `\n[...还有 ${omitted} 条记忆因超出上下文限制未显示]` : '';
            log.info(`[algo-memory] 已召回 ${memories.length} 条记忆（注入 ${selected.length} 条，约 ${tokenCount} tokens）`);
            api.prependSystemContext(selected.join('\n') + suffix + '\n');
          }
        } catch (err: any) {
          log.error('[algo-memory] before_prompt_build 钩子错误:', err?.message ?? err, err?.stack);
        }
      }, { priority: 10 });

    }

    // === Compaction lifecycle (March 5 2026: before_compaction / after_compaction hooks) ===
    // OpenClaw calls these during context compression cycles.
    // before_compaction: has event.sessionFile (JSONL transcript) and event.messages —
    //                   capture memories BEFORE compaction truncates them.
    // after_compaction:  has event.compactedCount, event.sessionFile — reinforce.
    //
    // NOTE: This hook runs IN PARALLEL with the compaction LLM call.
    // All operations are fire-and-forget (no await) so they do NOT block compaction.
    api.on('before_compaction', async (event: any, ctx: any) => {
      const agentId = ctx?.agentId || ctx?.sessionKey || 'default';
      if (!plugin.isActive() || !config.autoCapture) return;

      // Read session transcript from disk without blocking
      const readSessionFile = (filePath: string): any[] => {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          return content.trim().split('\n')
            .filter(Boolean)
            .map((line: string) => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean);
        } catch {
          return [];
        }
      };

      // 1. Fire-and-forget: read session file + store to DB
      const sessionMessages = (event.sessionFile && typeof event.sessionFile === 'string')
        ? readSessionFile(event.sessionFile)
        : [];

      if (sessionMessages.length > 0) {
        // 先立即强制 flush 当前 buffer，再异步 store（避免 compaction 开始前 buffer 未 flush 丢失）
        const { flushAllBuffers } = await import('./engine/store.js');
        flushAllBuffers(plugin.getDb(), config, log);

        plugin.store(agentId, sessionMessages).catch((err: any) => {
          log.error('[algo-memory] before_compaction store 异步错误:', err?.message ?? err);
        });
      }

      // 2. Fire-and-forget: DB-only peripheral promotion (no LLM, fast)
      plugin.promotePeripheralOnCompaction(agentId).catch((err: any) => {
        log.error('[algo-memory] before_compaction promote 错误:', err?.message ?? err);
      });

      // 3. Fire-and-forget: reinforcement (DB-only, fast)
      plugin.reinforceOnCompaction(agentId).catch((err: any) => {
        log.error('[algo-memory] before_compaction reinforce 错误:', err?.message ?? err);
      });

      if (sessionMessages.length > 0) {
        log.info(`[algo-memory] before_compaction: 已提交 ${sessionMessages.length} 条消息待 capture（异步，不阻塞 compaction）`);
      }
    });

    api.on('after_compaction', async (event: any, ctx: any) => {
      try {
        const agentId = ctx?.agentId || 'default';
        if (!plugin.isActive()) return;
        // 注意：reinforceOnCompaction 已在 before_compaction 中 fire-and-forget 执行
        // compaction 后 context 已截断，此处无需重复强化
        log.info(`[algo-memory] after_compaction: 跳过（强化已在 before_compaction 完成），compactedCount=${event.compactedCount}`);
      } catch (err: any) {
        log.error('[algo-memory] after_compaction 钩子错误:', err?.message ?? err, err?.stack);
      }
    });

    // === Tool lifecycle: after tool execution ===
    // after_tool_call: fires immediately after any tool executes (before agent_end).
    // This gives us real-time feedback on what memories were cited via algo_memory_search.
    api.on('after_tool_call', async (event: any, ctx: any) => {
      const agentId = ctx?.agentId || ctx?.sessionKey || 'default';
      if (!plugin.isActive()) return;

      // Fire-and-forget: do not await to avoid blocking the tool response pipeline.
      (async () => {
        try {
          // When algo_memory_search returns results, immediately reinforce cited memories.
          // This is better than waiting for agent_end — cited_count is updated in real-time.
          if (event.toolName === 'algo_memory_search' && event.result) {
            const resultStr = typeof event.result === 'string'
              ? event.result
              : JSON.stringify(event.result);

            // Extract memory IDs from search results (format: [{id, content, ...}])
            // The tool result text looks like: "[记忆] content..." or structured JSON
            const memoryIdPattern = /"id"\s*:\s*"([^"]+)"/g;
            const citedIds: string[] = [];
            let match;
            while ((match = memoryIdPattern.exec(resultStr)) !== null) {
              citedIds.push(match[1]);
            }

            if (citedIds.length > 0) {
              // Immediately update cited_count and last_accessed for cited memories
              plugin.reinforceCitedMemories(agentId, citedIds).catch(() => {});
            }
          }
        } catch (err: any) {
          log.error('[algo-memory] after_tool_call 错误:', err?.message ?? err);
        }
      })();
    });

    // === LLM output: record token usage for metrics ===
    // llm_output: fires after LLM responds. Captures usage stats (input/output/cache tokens).
    // Note: OpenClaw may already collect this; algo-memory stores it for memory-level analytics.
    api.on('llm_output', async (event: any, ctx: any) => {
      const agentId = ctx?.agentId || ctx?.sessionKey || 'default';
      if (!plugin.isActive() || !config.metricsEnabled) return;
      if (!event?.usage) return;

      plugin.recordLlmUsage(agentId, {
        inputTokens: event.usage.input ?? 0,
        outputTokens: event.usage.output ?? 0,
        cacheRead: event.usage.cacheRead,
        cacheWrite: event.usage.cacheWrite,
        totalTokens: event.usage.total ?? 0,
      });
    });

    // === Gateway lifecycle: ensure buffers flushed and DB closed cleanly ===
    api.on('gateway_stop', async () => {
      try {
        plugin.close();
        log.info('[algo-memory] gateway_stop: 插件已干净关闭');
      } catch (err: any) {
        log.error('[algo-memory] gateway_stop 钩子错误:', err?.message ?? err, err?.stack);
      }
    });

    // === Tools ===
    const tools = [
      { name: 'algo_memory_list', description: '列出记忆（支持 limit + offset 分页）', parameters: Type.Object({ agentId: Type.String(), limit: Type.Optional(Type.Number()), offset: Type.Optional(Type.Number()) }) },
      { name: 'algo_memory_search', description: '全文搜索（FTS5 优先，LIKE 兜底）', parameters: Type.Object({ agentId: Type.String(), query: Type.String() }) },
      { name: 'algo_memory_stats', description: '查看统计（total / core / working / peripheral）', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_get', description: '获取单条记忆详情', parameters: Type.Object({ agentId: Type.String(), memoryId: Type.String() }) },
      { name: 'algo_memory_delete', description: '删除单条记忆', parameters: Type.Object({ agentId: Type.String(), memoryId: Type.String() }) },
      { name: 'algo_memory_delete_bulk', description: '批量删除记忆', parameters: Type.Object({ agentId: Type.String(), memoryIds: Type.Array(Type.String()) }) },
      { name: 'algo_memory_clear', description: '清空记忆（keepCore=true 时保留 core 层）', parameters: Type.Object({ agentId: Type.String(), keepCore: Type.Optional(Type.Boolean()) }) },
      { name: 'algo_memory_update', description: '更新记忆内容（自动重新判断重要性）', parameters: Type.Object({ agentId: Type.String(), memoryId: Type.String(), content: Type.String() }) },
      { name: 'algo_memory_import', description: '批量导入记忆', parameters: Type.Object({ agentId: Type.String(), memories: Type.Array(Type.Any()) }) },
      { name: 'algo_memory_export', description: '导出记忆为 JSON（默认最多 1000 条）', parameters: Type.Object({ agentId: Type.String(), maxExport: Type.Optional(Type.Number()) }) },
      { name: 'algo_memory_metrics', description: '查看运行时指标', parameters: Type.Object({}) },
      { name: 'algo_memory_diagnostics', description: '召回诊断信息：DB 状态 + 缓存命中率 + MMR 配置 + 最近一次召回详情', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_recall_reset', description: '清除会话去重状态，允许相同查询再次召回', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_fts_rebuild', description: '重建 FTS5 全文索引，修复 rowid 漂移导致的搜索失败问题', parameters: Type.Object({}) },
      { name: 'algo_memory_compact', description: '手动触发 compaction 强化：提升 peripheral→working/core，强化 core importance，清理低价值 peripheral', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_health', description: '健康检查：DB 完整性、FTS 同步状态、buffer 待写数量、内存占用、LLM 调用统计', parameters: Type.Object({}) },
      { name: 'algo_memory_sync', description: '手动同步 core 层记忆到 workspace 文件（memory/algo-memory/YYYY-MM-DD.md）。按需调用，非自动运行', parameters: Type.Object({}) },
      { name: 'algo_memory_correct', description: '记忆修正。用法一（已知 memoryId）：直接更新内容；用法二（自然语言）：AI 定位相关记忆并生成修正建议，置信度>0.8 自动应用，否则返回建议待确认', parameters: Type.Object({
        agentId: Type.String(),
        correction: Type.String(),
        memoryId: Type.Optional(Type.String()),
        newContent: Type.Optional(Type.String()),
      }) },
    ];

    for (const tool of tools) {
      api.registerTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (callId: string, params: any) => {
          try {
            let result: any;
            switch (tool.name) {
              case 'algo_memory_list': result = plugin.listMemories(params.agentId, params.limit || 20, params.offset || 0); break;
              case 'algo_memory_search': result = plugin.searchMemories(params.agentId, params.query); break;
              case 'algo_memory_stats': result = plugin.getStats(params.agentId); break;
              case 'algo_memory_get': result = plugin.getMemory(params.agentId, params.memoryId); break;
              case 'algo_memory_delete': result = { success: plugin.deleteMemory(params.agentId, params.memoryId) }; break;
              case 'algo_memory_delete_bulk': result = { deleted: plugin.deleteBulk(params.agentId, params.memoryIds) }; break;
              case 'algo_memory_clear': result = { deleted: plugin.clearMemories(params.agentId, params.keepCore !== false) }; break;
              case 'algo_memory_update': result = { success: await plugin.updateMemory(params.agentId, params.memoryId, params.content) }; break;
              case 'algo_memory_import': result = { imported: plugin.importMemories(params.agentId, params.memories) }; break;
              case 'algo_memory_export': result = plugin.exportMemories(params.agentId, params.maxExport || 1000); break;
              case 'algo_memory_metrics': result = plugin.getMetrics(); break;
              case 'algo_memory_diagnostics': {
                const stats = plugin.getRecallStats(params.agentId);
                const info = plugin.getLastRecallInfo(params.agentId);
                result = { ...stats, lastRecall: info };
                break;
              }
              case 'algo_memory_recall_reset': result = plugin.clearRecallDedup(params.agentId); break;
              case 'algo_memory_fts_rebuild': result = plugin.rebuildFTS(); break;
              case 'algo_memory_compact': result = await plugin.manualCompact(params.agentId); break;
              case 'algo_memory_health': result = plugin.getHealth(); break;
              case 'algo_memory_sync': result = await plugin.syncCoreToWorkspace(); break;
              case 'algo_memory_correct': result = await plugin.correct(params.agentId, params.correction, params.memoryId, params.newContent); break;
              default: result = { error: 'Unknown tool' };
            }
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          } catch (err: any) {
            log.error(`[algo-memory] 工具执行失败 ${tool.name}:`, err?.message ?? err, err?.stack);
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err?.message ?? String(err) }) }] };
          }
        }
      });
    }

    // === LLM 配置警告 ===
    const llmEnabled = config.llm?.enabled && (config.threshold?.useLlmForCore || config.threshold?.useLlmForExtract || config.threshold?.useLlmForDedup);
    const hasApiKey = !!(config.llm?.apiKey);
    if (llmEnabled && !hasApiKey) {
      log.warn('[algo-memory] ⚠️ LLM 功能已启用（useLlmForCore/Extract/Dedup），但未配置 llm.apiKey，相关功能将降级为规则判断。如需启用，请配置 llm.apiKey。');
    }

    api.registerService(plugin);
  }
};


