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
import { store as doStore, normalizeForStorage } from './engine/store.js';
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
  SESSION_CACHE_MAX_SIZE,
  SESSION_CACHE_TTL_MS,
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
    sessionMemory: { ...DEFAULT_CONFIG.sessionMemory, ...userConfig.sessionMemory },
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
    urgencyDecay: { ...DEFAULT_CONFIG.urgencyDecay, ...userConfig.urgencyDecay },
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
  };
}

// ============= MemoryPlugin =============
class MemoryPlugin {
  private db: Database.Database | null = null;
  private dbPath: string = '';
  private cache: LRUCache<string, any>;
  private sessionCache: LRUCache<string, any>;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private config: Config;
  // Internal non-null db accessor (caller must guard against null)
  private _db(): DatabaseType { return this.db!; }
  llmClient: LLMClient | null = null;
  private log: any;
  configHash: string = '';
  private ftsAvailable: boolean = false;
  /** 会话去重追踪（公开给 hook 访问） */
  lastRecallQuery: string = '';
  lastRecallTime: number = 0;

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
    this.sessionCache = new LRUCache({ max: SESSION_CACHE_MAX_SIZE, ttl: SESSION_CACHE_TTL_MS });

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
      citedBoost: this.config.citedBoost,
      lexicalOverlap: this.config.lexicalOverlap,
      urgencyDecay: this.config.urgencyDecay,
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

    this.cleanup();
    this.cleanupInterval = setInterval(() => this.cleanup(), DEFAULT_CLEANUP_INTERVAL_MS);
  }

  // better-sqlite3 auto-persists to disk, saveDatabase() is now a no-op
  private saveDatabase(): void {
    // No-op: better-sqlite3 writes synchronously on every statement.
    // WAL mode (DELETE journal) ensures durability without blocking.
  }

  async store(AgentId: string, messages: any[]): Promise<void> {
    const deps: StoreDeps = {
      db: this._db(),
      config: this.config,
      llmClient: this.llmClient,
      log: this.log,
      saveDatabase: () => this.saveDatabase(),
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
      lastRecallQuery: this.lastRecallQuery,
      lastRecallTime: this.lastRecallTime,
    };
    const result = await doRecall(deps, AgentId, query);
    // 召回执行后更新会话去重状态（skip 的情况不更新，让下次同类查询仍能触发）
    this.lastRecallQuery = query;
    this.lastRecallTime = Date.now();
    return result;
  }

  listMemories(AgentId: string, limit: number = 20, offset: number = 0): any[] {
    if (!this.db) return [];
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    if (visibleAgentIds === null) {
      return queryAll(this._db(),
        'SELECT * FROM memories ORDER BY CASE tier WHEN \'core\' THEN 0 WHEN \'working\' THEN 1 ELSE 2 END, importance DESC, created_at DESC LIMIT ? OFFSET ?',
        [limit, offset]
      );
    }
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    return queryAll(this._db(),
      `SELECT * FROM memories WHERE agent_id IN (${placeholders}) ORDER BY CASE tier WHEN 'core' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, importance DESC, created_at DESC LIMIT ? OFFSET ?`,
      [...visibleAgentIds, limit, offset]
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
          `SELECT m.* FROM memories m JOIN memories_fts fts ON m.id = fts.id WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) DESC, m.importance DESC LIMIT ?`,
          [ftsQuery, ftsLimit]
        );
      }
      const placeholders = visibleAgentIds.map(() => '?').join(',');
      return queryAll(this._db(),
        `SELECT m.* FROM memories m JOIN memories_fts fts ON m.id = fts.id WHERE m.agent_id IN (${placeholders}) AND memories_fts MATCH ? ORDER BY bm25(memories_fts) DESC, m.importance DESC LIMIT ?`,
        [...visibleAgentIds, ftsQuery, ftsLimit]
      );
    } catch (_) {
      return [];
    }
  }

  private likeFallback(AgentId: string, query: string, visibleAgentIds: string[] | null): any[] {
    const terms = query.trim().split(/\s+/);
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
    // Extract tag:xxx filters
    const tagMatch = query.matchAll(/(?:^|\s)tag:(\S+)/g);
    const tags = [...tagMatch].map(m => m[1]);
    const cleanQuery = query.replace(/(?:^|\s)tag:\S+/g, '').trim();
    if (!cleanQuery) return [];

    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    const safeLimit = Math.min(this.config.maxResults * 3, 100);
    let results = this.ftsQuery(AgentId, cleanQuery, visibleAgentIds, safeLimit);
    if (results.length === 0) results = this.likeFallback(AgentId, cleanQuery, visibleAgentIds);

    // Apply tag filters
    if (tags.length > 0) {
      results = results.filter(m => {
        const meta = m.metadata || '';
        return tags.some(tag => meta.includes(`"${tag}"`));
      });
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
        `SELECT COUNT(*) as total, SUM(tier = 'core') as core, SUM(tier = 'peripheral') as peripheral, SUM(layer = 'general') as general FROM memories`
      );
    } else {
      const placeholders = visibleAgentIds.map(() => '?').join(',');
      row = queryOne(this._db(),
        `SELECT COUNT(*) as total, SUM(tier = 'core') as core, SUM(tier = 'peripheral') as peripheral, SUM(layer = 'general') as general FROM memories WHERE agent_id IN (${placeholders})`,
        visibleAgentIds
      );
    }
    const total = (row?.total as number) || 0;
    const core = (row?.core as number) || 0;
    const peripheral = (row?.peripheral as number) || 0;
    const general = (row?.general as number) || 0;
    return { total, core, working: total - core - peripheral, peripheral, general, metrics: this.metrics };
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
    if (changes > 0) this.saveDatabase();
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
    if (changes > 0) this.saveDatabase();
    return changes;
  }

  clearMemories(AgentId: string, keepCore: boolean = true): number {
    if (!this.db) return 0;
    const changes = keepCore
      ? run(this._db(), 'DELETE FROM memories WHERE agent_id = ? AND tier != ?', [AgentId, 'core'])
      : run(this._db(), 'DELETE FROM memories WHERE agent_id = ?', [AgentId]);
    this.clearRecallCache(AgentId);
    if (changes > 0) this.saveDatabase();
    return changes;
  }

  updateMemory(AgentId: string, memoryId: string, content: string): boolean {
    const normalized = normalizeText(content);
    const safe = normalizeForStorage(content).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const isCore = isCoreKeyword(normalized, this.config.coreKeywords);
    const tier = getTier(isCore ? 1.0 : 0.5, 1, 0, this.config.tier);
    const changes = run(this._db(),
      'UPDATE memories SET content = ?, tier = ?, layer = ?, keywords = ?, importance = ?, last_accessed = ?, content_hash = ? WHERE id = ? AND agent_id = ?',
      [safe, tier, isCore ? 'core' : 'general', extractKeywords(normalized), isCore ? 1.0 : 0.5, Date.now(), hashContent(safe), memoryId, AgentId]
    );
    this.clearRecallCache(AgentId);
    if (changes > 0) this.saveDatabase();
    return changes > 0;
  }

  importMemories(AgentId: string, memories: any[]): number {
    if (!this.db) return 0;
    let imported = 0;
    try {
      runOrThrow(this._db(), 'BEGIN IMMEDIATE');
      for (const m of memories) {
        try {
          const tier = getTier(m.importance || 0.5, m.access_count || 1, 0, this.config.tier);
          run(this._db(),
            `INSERT INTO memories (id, agent_id, scope, content, type, tier, layer, keywords, importance, access_count, cited_count, urgency, created_at, last_accessed, content_hash, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              m.id || generateId(), AgentId, m.scope || 'global',
              m.content, m.type || 'other', tier, m.layer || 'general',
              m.keywords || '', m.importance || 0.5, m.access_count || 1,
              m.cited_count || 0, m.urgency ?? 1.0,
              m.created_at || Date.now(), m.last_accessed || Date.now(),
              m.content_hash || hashContent(m.content), m.metadata || null
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
      this.saveDatabase();
      this.clearRecallCache(AgentId);
    }
    return imported;
  }

  exportMemories(AgentId: string, maxExport: number = 1000): any[] {
    if (!this.db) return [];
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    if (visibleAgentIds === null) {
      return queryAll(this._db(), 'SELECT * FROM memories ORDER BY created_at DESC LIMIT ?', [maxExport]);
    }
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    return queryAll(this._db(),
      `SELECT * FROM memories WHERE agent_id IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`,
      [...visibleAgentIds, maxExport]
    );
  }

  getSessionMemory(AgentId: string): any[] {
    return this.sessionCache.get(`session:${AgentId}`) || [];
  }

  addSessionMemory(AgentId: string, content: string): boolean {
    if (!this.config.sessionMemory.enabled) return false;
    const key = `session:${AgentId}`;
    const session = this.sessionCache.get(key) || [];
    if (session.some((s: any) => s.content === content) || false) return false;
    session.unshift({ content, time: Date.now() });
    if (session.length > this.config.sessionMemory.maxSessionItems) session.pop();
    this.sessionCache.set(key, session);
    return true;
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
    const BATCH = 500;
    // better-sqlite3 supports DELETE...LIMIT natively
    let total = 0;
    let deleted = 0;
    do {
      const rows = queryAll(this._db(),
        `SELECT rowid FROM memories WHERE last_accessed < ? AND layer = 'general' AND tier = 'peripheral' LIMIT ?`,
        [cutoff, BATCH]
      );
      if (rows.length === 0) break;
      const rowids = rows.map((r: any) => r.rowid);
      deleted = run(this._db(),
        `DELETE FROM memories WHERE rowid IN (${rowids.map(() => '?').join(',')})`,
        rowids
      );
      total += deleted;
    } while (deleted === BATCH);
    if (total > 0) this.saveDatabase();
    this.log.info('[algo-memory] 清理了', total, '条过期记忆');
  }

  // ===== CLI 增强工具 =====

  /** 详细召回统计（CLI 用） */
  getRecallStats(AgentId: string): any {
    const stats = this.getStats(AgentId);
    const dbPath = this.dbPath;
    const ftsAvailable = this.ftsAvailable;
    const sessionDedup = this.config.adaptiveRetrieval.sessionDedup;
    const lastQuery = this.lastRecallQuery;
    const lastRecallTs = this.lastRecallTime ? new Date(this.lastRecallTime).toISOString() : null;
    const mmrEnabled = this.config.mmr.enabled;
    const mmrLambda = this.config.mmr.lambda;
    return { ...stats, dbPath, ftsAvailable, sessionDedup, lastQuery, lastRecallTs, mmrEnabled, mmrLambda };
  }

  /** 查看最近召回记录（会话去重状态） */
  getLastRecallInfo(AgentId: string): any {
    return {
      agentId: AgentId,
      lastQuery: this.lastRecallQuery || '(空)',
      lastRecallTime: this.lastRecallTime ? new Date(this.lastRecallTime).toISOString() : null,
      sessionDedupEnabled: this.config.adaptiveRetrieval.sessionDedup?.enabled ?? false,
      sessionDedupWindowMs: this.config.adaptiveRetrieval.sessionDedup?.windowMs ?? 0,
      sessionDedupSimilarity: this.config.adaptiveRetrieval.sessionDedup?.similarityThreshold ?? 0,
    };
  }

  /** 清除会话去重状态，允许相同查询再次召回 */
  clearRecallDedup(_AgentId: string): { success: boolean; message: string } {
    this.lastRecallQuery = '';
    this.lastRecallTime = 0;
    return { success: true, message: '会话去重状态已清除，同一查询可再次召回' };
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

      // 读取最近 N 条记忆的 ID 作为指纹
      const recentMemories = queryAll(this._db(),
        `SELECT id FROM memories ORDER BY created_at DESC LIMIT ?`,
        [this.config.sessionSummary.maxItems]
      ) as unknown as Array<{ id: string }>;
      if (recentMemories.length === 0) return;

      const currentIds = recentMemories.map(m => m.id).join(',');

      // 读取上次写入的 ID 指纹，避免无变化重复写入
      let lastIds = '';
      if (fs.existsSync(markerPath)) lastIds = fs.readFileSync(markerPath, 'utf-8').trim();
      if (lastIds === currentIds) return; // 无新内容，跳过

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
      fs.writeFileSync(markerPath, currentIds, 'utf-8'); // 保存本次 ID 指纹
      this.log.info(`[algo-memory] Session 摘要已写入: ${filePath}`);
    } catch (err) {
      this.log.error('[algo-memory] Session 摘要写入失败:', err);
    }
  }

  close(): void {
    // 写入 session 摘要（双重保险：session_end 钩子 + close 时写入）
    this.writeSessionSummary();
    if (this.cleanupInterval) { clearInterval(this.cleanupInterval); this.cleanupInterval = null; }
    this.cache.clear();
    this.sessionCache.clear();
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
  version: '2.2.3',
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
            .map((m: any) => m.content.trim()).filter(Boolean);
          if (userMessages.length === 0) return;
          const query = userMessages.slice(-3).join(' ');
          // Session dedup is handled inside shouldRetrieve via plugin.lastRecallQuery/Time
          if (!shouldRetrieve(query, config.adaptiveRetrieval, { lastQuery: plugin.lastRecallQuery, lastRecallTime: plugin.lastRecallTime })) return;

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
      { name: 'algo_memory_session', description: '获取 Session 临时记忆', parameters: Type.Object({ agentId: Type.Optional(Type.String()) }) },
      { name: 'algo_memory_session_add', description: '写入 Session 临时记忆', parameters: Type.Object({ agentId: Type.Optional(Type.String()), content: Type.String() }) },
      { name: 'algo_memory_metrics', description: '查看运行时指标', parameters: Type.Object({}) },
      { name: 'algo_memory_recall_stats', description: '召回统计（含 MMR、会话去重状态、DB 信息）', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_recall_info', description: '查看最近召回记录（上一个查询和时间）', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_recall_reset', description: '清除会话去重状态，允许相同查询再次召回', parameters: Type.Object({ agentId: Type.String() }) },
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
              case 'algo_memory_session': result = plugin.getSessionMemory(params.agentId || 'default'); break;
              case 'algo_memory_session_add': result = { success: plugin.addSessionMemory(params.agentId || 'default', params.content) }; break;
              case 'algo_memory_metrics': result = plugin.getMetrics(); break;
              case 'algo_memory_recall_stats': result = plugin.getRecallStats(params.agentId); break;
              case 'algo_memory_recall_info': result = plugin.getLastRecallInfo(params.agentId); break;
              case 'algo_memory_recall_reset': result = plugin.clearRecallDedup(params.agentId); break;
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

    api.registerService(plugin);
  }
};


