/**
 * algo-memory v2.2.3
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
import { store as doStore, normalizeForStorage, safeContent } from './engine/store.js';
import { retrieve } from './engine/retrieve.js';
import { recall as doRecall } from './engine/recall.js';
import type { StoreDeps } from './engine/store.js';
import type { RecallDeps } from './engine/recall.js';
import { LLMClient, resolveLLMConfig } from './engine/llm.js';
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
    cleanupDays: scalar('cleanupDays', DEFAULT_CONFIG.cleanupDays),
    language: scalar('language', DEFAULT_CONFIG.language),
    coreKeywords: scalar('coreKeywords', DEFAULT_CONFIG.coreKeywords),
    recencyDecay: scalar('recencyDecay', DEFAULT_CONFIG.recencyDecay),
    recencyHalfLife: scalar('recencyHalfLife', DEFAULT_CONFIG.recencyHalfLife),
    smartDedup: scalar('smartDedup', DEFAULT_CONFIG.smartDedup),
    dedupThreshold: scalar('dedupThreshold', DEFAULT_CONFIG.dedupThreshold),
    capturePerTurn: scalar('capturePerTurn', DEFAULT_CONFIG.capturePerTurn),
    sessionSummary: { ...DEFAULT_CONFIG.sessionSummary, ...userConfig.sessionSummary },
    feedback: { ...DEFAULT_CONFIG.feedback, ...userConfig.feedback },
    mcp: { ...DEFAULT_CONFIG.mcp, ...userConfig.mcp },
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
  // Internal non-null db accessor (caller must guard against null)
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
    lastErrorAt: null as number | null
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

  async recall(AgentId: string, query: string): Promise<{ hasMemory: boolean; memories: any[] }> {
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
    const result = await doRecall(deps, AgentId, query);
    // 只有真正召回到了记忆才更新会话去重状态
    // shouldRetrieve 跳过时（query太短/重复）不更新，让下次同类查询仍能触发
    if (result.hasMemory) {
      this.lastRecallQuery.set(AgentId, query);
      this.lastRecallTime.set(AgentId, Date.now());
    }
    return result;
  }

  /**
   * 补充存储：存储不重要/新发现的信息，不触发 tier 更新，不走 LLM 判断。
   * 用于 before_prompt_build 召回成功后，发现用户最新消息有未存储的新内容时补充。
   */
  async supplementStore(AgentId: string, rawContent: string): Promise<void> {
    if (!this.db || !rawContent?.trim()) return;
    const content = normalizeText(rawContent);
    if (isNoise(content, this.config.noiseFilter)) return;

    const safe = safeContent(content);
    const contentHash = hashContent(safe);
    const now = Date.now();

    // 检查是否已存在（精确去重）
    const existing = queryOne(this._db(),
      'SELECT id FROM memories WHERE agent_id = ? AND content_hash = ?',
      [AgentId, contentHash]
    );
    if (existing) return; // 精确命中则不存

    const scope = this.config.scopes.enabled
      ? `${this.config.scopes.defaultScope}:${AgentId}`
      : 'global';

    // 补充存储：importance = 0.4（低于普通记忆的 0.5），access_count = 0（不触发 tier 变化）
    run(this._db(),
      `INSERT INTO memories (id, agent_id, scope, content, type, tier, layer, keywords, importance, access_count, cited_count, urgency, created_at, last_accessed, content_hash, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(), AgentId, scope, safe, 'other', 'peripheral', 'general',
        extractKeywords(safe), 0.4, 0, 0, 1.0,
        now, now, contentHash,
        JSON.stringify({ memory_category: 'other', confidence: 0.4, source_session: AgentId, supplementary: true })
      ]
    );
    this.clearRecallCache(AgentId);
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

  private ftsQuery(AgentId: string, query: string, visibleAgentIds: string[] | null, safeLimit: number): any[] {
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
    let results = this.ftsQuery(AgentId, cleanQuery, visibleAgentIds, safeLimit);
    if (results.length === 0) results = this.likeFallback(AgentId, cleanQuery, visibleAgentIds);

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

  updateMemory(AgentId: string, memoryId: string, content: string): boolean {
    const safe = safeContent(content);
    const isCore = isCoreKeyword(safe, this.config.coreKeywords);
    const tier = getTier(isCore ? 1.0 : 0.5, 1, 0, this.config.tier);
    const changes = run(this._db(),
      'UPDATE memories SET content = ?, tier = ?, layer = ?, keywords = ?, importance = ?, last_accessed = ?, content_hash = ? WHERE id = ? AND agent_id = ?',
      [safe, tier, isCore ? 'core' : 'general', extractKeywords(safe), isCore ? 1.0 : 0.5, Date.now(), hashContent(safe), memoryId, AgentId]
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
  async feedback(AgentId: string, correction: string): Promise<{
    found: boolean;
    candidates: any[];
    suggestions: Array<{
      memoryId: string;
      original: string;
      updated: string;
      reason: string;
      confidence: number;
    }>;
  }> {
    if (!this.config.feedback.enabled) return { found: false, candidates: [], suggestions: [] };
    if (!correction.trim()) return { found: false, candidates: [], suggestions: [] };

    // 1. 召回相关记忆
    const { hasMemory, memories } = await this.recall(AgentId, correction);
    if (!hasMemory || memories.length === 0) return { found: false, candidates: [], suggestions: [] };

    const candidates = memories.slice(0, this.config.feedback.maxMemories);

    // 2. 如果没有 LLM，返回候选但无建议（AI 可以看到有哪些候选记忆）
    if (!this.llmClient || !this.config.llm.enabled || !this.config.llm.apiKey) {
      return {
        found: true,
        candidates,
        suggestions: candidates.map(m => ({
          memoryId: m.id,
          original: m.content,
          updated: m.content,
          reason: 'LLM 未启用，无法生成修正建议',
          confidence: 0,
        })),
      };
    }

    // 3. 用 LLM 判断哪条需要修正，并生成修正内容
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
      const response = await fetch(`${this.config.llm.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.llm.apiKey}`
        },
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
        this.log.error('[algo-memory] feedback LLM 调用失败:', response.status);
        return { found: false, candidates: [], suggestions: [] };
      }

      const json = await response.json() as any;
      const raw = json?.choices?.[0]?.message?.content || '[]';

      // 提取 JSON（可能带有 markdown 代码块）
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```|^\s*(\[[\s\S]*?\])\s*$/m);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[2]) : raw;
      const suggestions: Array<{ memoryId: string; updated: string; reason: string; confidence: number }> = JSON.parse(jsonStr);

      // 过滤低于阈值的建议
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
      return { found: true, candidates, suggestions: filtered };
    } catch (err) {
      this.log.error('[algo-memory] feedback 失败:', err);
      return { found: false, candidates: [], suggestions: [] };
    }
  }

  /**
   * 应用确认后的修正
   */
  applyFeedback(AgentId: string, memoryId: string, updatedContent: string): boolean {
    return this.updateMemory(AgentId, memoryId, updatedContent);
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
            `INSERT INTO memories (id, agent_id, scope, content, type, tier, layer, keywords, importance, access_count, cited_count, urgency, created_at, last_accessed, content_hash, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              m.id || generateId(), AgentId, m.scope || 'global',
              safe, m.type || 'other', tier, m.layer || 'general',
              m.keywords || '', m.importance || 0.5, m.access_count || 1,
              m.cited_count || 0, m.urgency ?? 1.0,
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

  /** 将会话期间新增的记忆写入 Markdown 摘要文件（跨 session 延续） */
  writeSessionSummary(): void {
    if (!this.config.sessionSummary.enabled) return;
    try {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const stateDir = this.dbPath.replace(/[/\\][^/\\]+$/, '');
      const summaryDir = path.join(stateDir, this.config.sessionSummary.dir);
      if (!fs.existsSync(summaryDir)) fs.mkdirSync(summaryDir, { recursive: true });
      const filePath = path.join(summaryDir, `${today}.md`);
      const markerPath = path.join(summaryDir, `.${today}.lastids`); // tracks last written IDs

      // 读取最近 N 条记忆的 content_hash 作为指纹（内容变了就重写）
      const recentMemories = queryAll(this._db(),
        `SELECT content_hash FROM memories ORDER BY created_at DESC LIMIT ?`,
        [this.config.sessionSummary.maxItems]
      ) as unknown as Array<{ content_hash: string }>;
      if (recentMemories.length === 0) return;

      const currentHashes = recentMemories.map(m => m.content_hash).join(',');

      // 读取上次写入的指纹，避免无变化重复写入
      let lastHashes = '';
      if (fs.existsSync(markerPath)) lastHashes = fs.readFileSync(markerPath, 'utf-8').trim();
      if (lastHashes === currentHashes) return; // 无新内容，跳过

      // 读取现有 Markdown 内容
      let existing = '';
      if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf-8');

      const header = existing.includes('# Algo-Memory 日记')
        ? ''
        : `# Algo-Memory 日记\n\n`;

      // 收集记忆详情
      const memoryDetails = queryAll(this._db(),
        `SELECT id, content, tier, importance, created_at FROM memories
         ORDER BY created_at DESC LIMIT ?`,
        [this.config.sessionSummary.maxItems]
      ) as unknown as Array<{ id: string; content: string; tier: string; importance: number; created_at: number }>;

      const lines: string[] = [];
      const dateStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      lines.push(`\n## ${dateStr}  Session 摘要\n`);
      for (const m of memoryDetails) {
        const time = new Date(m.created_at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
        lines.push(`- [${m.tier.toUpperCase()}] ${m.content.slice(0, 200)}${m.content.length > 200 ? '…' : ''} *(重要性: ${m.importance.toFixed(2)}, ${time})*`);
      }

      let output = existing || header;
      if (!output.includes('# Algo-Memory 日记')) output = header + output;
      output = output.replace(/\n+$/, '\n') + lines.join('\n') + '\n';

      fs.writeFileSync(filePath, output, 'utf-8');
      fs.writeFileSync(markerPath, currentHashes, 'utf-8'); // 保存本次 hash 指纹
      this.log.info(`[algo-memory] Session 摘要已写入: ${filePath}`);
    } catch (err) {
      this.log.error('[algo-memory] Session 摘要写入失败:', err);
    }
  }

  close(): void {
    if (this.cleanupInterval) { clearInterval(this.cleanupInterval); this.cleanupInterval = null; }
    this.cache.clear();
    if (this.db) {
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
  version: '2.3.0',
  async register(api: any) {
    const log = api.logger || console;
    const userConfig = api.pluginConfig || api.config || {};
    const config = mergeConfig(userConfig);

    const plugin = new MemoryPlugin(config, log);

    await plugin.init(api.getStateDir?.() || api.stateDir ||
      path.join(process.env.HOME || '/home/x', '.openclaw', 'state', 'algo-memory'));

    // === Hooks ===
    if (config.autoCapture) {
      api.on('agent_end', async (event: any) => {
        try {
          const agentId = event?.agentId || 'default';
          const messages = event?.messages || [];
          await plugin.store(agentId, messages);
        } catch (err) {
          log.error('[algo-memory] agent_end 钩子错误:', err);
        }
      });
    }

    if (config.autoRecall) {
      api.on('before_prompt_build', async (event: any) => {
        try {
          const agentId = event?.agentId || 'default';
          const messages = event?.messages || [];
          const userMessages = (messages as any[])
            .filter((m: any) => m.role === 'user' && typeof m.content === 'string')
            .map((m: any) => normalizeText(m.content)).filter(Boolean);
          if (userMessages.length === 0) return;
          const query = userMessages.slice(-3).join(' ');
          // Session dedup is handled inside shouldRetrieve via per-agent dedup state
          if (!shouldRetrieve(query, config.adaptiveRetrieval, { lastQuery: plugin.getLastRecallQuery(agentId), lastRecallTime: plugin.getLastRecallTime(agentId) })) return;

          const { hasMemory, memories } = await plugin.recall(agentId, query);
          if (hasMemory && memories.length > 0) {
            const MAX_INJECT_TOKENS = 1500;
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
        } catch (err) {
          log.error('[algo-memory] before_prompt_build 钩子错误:', err);
        }
      }, { priority: 10 });

    // === 补充存储：每次 before_prompt_build 都检查，不管有没有召回成功 ===
    // 目的：解决"冷启动"——没有任何历史记忆时，补充存储仍然能沉淀信息
    api.on('before_prompt_build', async (event: any) => {
      try {
        const latestRaw = (event?.messages as any[] || [])
          .filter((m: any) => m.role === 'user' && typeof m.content === 'string')
          .map((m: any) => m.content.trim())
          .filter(Boolean)
          .at(-1);
        if (!latestRaw) return;
        const latestNorm = normalizeText(latestRaw);
        if (isNoise(latestNorm, config.noiseFilter)) return;
        await plugin.supplementStore(event?.agentId || 'default', latestRaw);
      } catch (err) {
        log.error('[algo-memory] supplement store 错误:', err);
      }
    }, { priority: 5 });
    }

    // === Session Summary ===
    api.on('session_end', async () => {
      try {
        plugin.writeSessionSummary();
      } catch (err) {
        log.error('[algo-memory] session_end 钩子错误:', err);
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
      { name: 'algo_memory_recall_stats', description: '召回统计（含 MMR、会话去重状态、DB 信息）', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_recall_info', description: '查看最近召回记录（上一个查询和时间）', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_recall_reset', description: '清除会话去重状态，允许相同查询再次召回', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_feedback', description: '自然语言修正记忆：输入修正描述，自动找到相关记忆并生成修正建议（需确认后 apply）', parameters: Type.Object({ agentId: Type.String(), correction: Type.String() }) },
      { name: 'algo_memory_apply_feedback', description: '应用确认后的记忆修正', parameters: Type.Object({ agentId: Type.String(), memoryId: Type.String(), updatedContent: Type.String() }) },
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
              case 'algo_memory_update': result = { success: plugin.updateMemory(params.agentId, params.memoryId, params.content) }; break;
              case 'algo_memory_import': result = { imported: plugin.importMemories(params.agentId, params.memories) }; break;
              case 'algo_memory_export': result = plugin.exportMemories(params.agentId, params.maxExport || 1000); break;
              case 'algo_memory_metrics': result = plugin.getMetrics(); break;
              case 'algo_memory_recall_stats': result = plugin.getRecallStats(params.agentId); break;
              case 'algo_memory_recall_info': result = plugin.getLastRecallInfo(params.agentId); break;
              case 'algo_memory_recall_reset': result = plugin.clearRecallDedup(params.agentId); break;
              case 'algo_memory_feedback': result = await plugin.feedback(params.agentId, params.correction); break;
              case 'algo_memory_apply_feedback': result = { success: plugin.applyFeedback(params.agentId, params.memoryId, params.updatedContent) }; break;
              default: result = { error: 'Unknown tool' };
            }
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          } catch (err: any) {
            log.error(`[algo-memory] 工具执行失败 ${tool.name}:`, err);
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
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

    // === MCP Tool Exposure ===
    if (config.mcp.enabled) {
      setupMCPServer(plugin, config, log).catch(err => {
        log.error('[algo-memory] MCP 启动失败:', err);
      });
    }
  }
};

async function setupMCPServer(plugin: MemoryPlugin, config: any, log: any) {
  try {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

      const server = new Server({
        name: 'algo-memory',
        version: '2.3.0',
      }, {
        capabilities: { tools: {} },
      });

      // 注册所有工具到 MCP
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'algo_memory_list',
            description: '列出记忆',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } },
          },
          {
            name: 'algo_memory_search',
            description: '全文搜索记忆',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, query: { type: 'string' } } },
          },
          {
            name: 'algo_memory_stats',
            description: '查看统计',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' } } },
          },
          {
            name: 'algo_memory_get',
            description: '获取单条记忆',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, memoryId: { type: 'string' } } },
          },
          {
            name: 'algo_memory_delete',
            description: '删除记忆',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, memoryId: { type: 'string' } } },
          },
          {
            name: 'algo_memory_update',
            description: '更新记忆',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, memoryId: { type: 'string' }, content: { type: 'string' } } },
          },
          {
            name: 'algo_memory_feedback',
            description: '自然语言修正记忆',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, correction: { type: 'string' } } },
          },
          {
            name: 'algo_memory_apply_feedback',
            description: '应用确认后的修正',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, memoryId: { type: 'string' }, updatedContent: { type: 'string' } } },
          },
          {
            name: 'algo_memory_export',
            description: '导出记忆',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, maxExport: { type: 'number' } } },
          },
          {
            name: 'algo_memory_import',
            description: '导入记忆',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, memories: { type: 'array' } } },
          },
          {
            name: 'algo_memory_metrics',
            description: '运行时指标',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'algo_memory_recall_stats',
            description: '召回统计',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' } } },
          },
          {
            name: 'algo_memory_recall_info',
            description: '查看最近召回记录',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' } } },
          },
          {
            name: 'algo_memory_recall_reset',
            description: '清除会话去重状态',
            inputSchema: { type: 'object', properties: { agentId: { type: 'string' } } },
          },
        ],
      }));

      server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
        const { name, arguments: args } = request.params;
        try {
          let result: any;
          switch (name) {
            case 'algo_memory_list': result = plugin.listMemories(args.agentId, args.limit || 20, args.offset || 0); break;
            case 'algo_memory_search': result = plugin.searchMemories(args.agentId, args.query); break;
            case 'algo_memory_stats': result = plugin.getStats(args.agentId); break;
            case 'algo_memory_get': result = plugin.getMemory(args.agentId, args.memoryId); break;
            case 'algo_memory_delete': result = { success: plugin.deleteMemory(args.agentId, args.memoryId) }; break;
            case 'algo_memory_update': result = { success: plugin.updateMemory(args.agentId, args.memoryId, args.content) }; break;
            case 'algo_memory_feedback': result = await plugin.feedback(args.agentId, args.correction); break;
            case 'algo_memory_apply_feedback': result = { success: plugin.applyFeedback(args.agentId, args.memoryId, args.updatedContent) }; break;
            case 'algo_memory_export': result = plugin.exportMemories(args.agentId, args.maxExport || 1000); break;
            case 'algo_memory_import': result = { imported: plugin.importMemories(args.agentId, args.memories) }; break;
            case 'algo_memory_metrics': result = plugin.getMetrics(); break;
            case 'algo_memory_recall_stats': result = plugin.getRecallStats(args.agentId); break;
            case 'algo_memory_recall_info': result = plugin.getLastRecallInfo(args.agentId); break;
            case 'algo_memory_recall_reset': result = plugin.clearRecallDedup(args.agentId); break;
            default: result = { error: 'Unknown tool' };
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
        }
      });

      const transport = new StdioServerTransport();
      await server.connect(transport);
      log.info('[algo-memory] MCP stdio server 已启动（stdio 模式）');
    } catch (err) {
      log.error('[algo-memory] MCP 初始化失败:', err);
    }
  }


