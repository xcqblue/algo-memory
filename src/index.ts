/**
 * algo-memory v2.2.3
 * 纯算法长期记忆插件 - 无需 LLM 也能工作
 * 支持多语言: zh/en/ja/ko/es/fr/de
 * 支持 FTS5 全文搜索
 * 支持国内主流模型: MiniMax/百炼/DeepSeek/Kimi/智谱/腾讯/百度
 * 默认启用Agent隔离模式，支持配置跨Agent查看
 */

import { Type } from '@sinclair/typebox';
import LRUCache from 'lru-cache';
import initSqlJs from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

import type { Config, Memory } from './types.js';
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
import { initSchema } from './db/schema.js';
import { queryAll, queryOne, run, runOrThrow } from './db/queries.js';
import { LLMClient, resolveLLMConfig } from './engine/llm.js';
import { store as doStore, type StoreDeps } from './engine/store.js';
import { recall as doRecall, type RecallDeps } from './engine/recall.js';

// ============= Config merge helper =============
// Spreads userConfig over DEFAULT_CONFIG for every top-level key,
// returning the fully-typed merged Config. Avoids repetitive `??` chains.
function mergeConfig(userConfig: Partial<Config>): Config {
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
    scopes: { ...DEFAULT_CONFIG.scopes, ...userConfig.scopes },
    llm: resolveLLMConfig({ ...DEFAULT_CONFIG.llm, ...userConfig.llm }),
    threshold: { ...DEFAULT_CONFIG.threshold, ...userConfig.threshold },
    // Simple scalar overrides
    autoCapture: userConfig.autoCapture !== undefined ? userConfig.autoCapture : DEFAULT_CONFIG.autoCapture,
    autoRecall: userConfig.autoRecall !== undefined ? userConfig.autoRecall : DEFAULT_CONFIG.autoRecall,
    maxResults: userConfig.maxResults ?? DEFAULT_CONFIG.maxResults,
    cleanupDays: userConfig.cleanupDays ?? DEFAULT_CONFIG.cleanupDays,
    language: userConfig.language ?? DEFAULT_CONFIG.language,
    coreKeywords: userConfig.coreKeywords ?? DEFAULT_CONFIG.coreKeywords,
    recencyDecay: userConfig.recencyDecay !== undefined ? userConfig.recencyDecay : DEFAULT_CONFIG.recencyDecay,
    recencyHalfLife: userConfig.recencyHalfLife ?? DEFAULT_CONFIG.recencyHalfLife,
    smartDedup: userConfig.smartDedup !== undefined ? userConfig.smartDedup : DEFAULT_CONFIG.smartDedup,
    dedupThreshold: userConfig.dedupThreshold ?? DEFAULT_CONFIG.dedupThreshold,
    capturePerTurn: userConfig.capturePerTurn ?? DEFAULT_CONFIG.capturePerTurn,
  };
}

// ============= MemoryPlugin =============
class MemoryPlugin {
  private db: any = null;
  private dbPath: string = '';
  private SQL: any = null;
  private cache: LRUCache<string, any>;
  private sessionCache: LRUCache<string, any>;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private config: Config;
  private llmClient: LLMClient | null = null;
  private log: any;
  private configHash: string = '';
  // FTS5 availability — determined once at init, never changes
  private ftsAvailable: boolean = false;

  // Error metrics (Task 3)
  public metrics = {
    llmErrors: { core: 0, extract: 0, dedup: 0 },
    dbErrors: 0,
    lastErrorAt: null as number | null
  };

  constructor(config: Partial<Config>, log: any = console) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log = log;
    this.cache = new LRUCache({ max: CACHE_MAX_SIZE, ttl: CACHE_TTL_MS });
    this.sessionCache = new LRUCache({ max: SESSION_CACHE_MAX_SIZE, ttl: SESSION_CACHE_TTL_MS });
    // Include all config fields that affect recall scoring
    this.configHash = hashContent(JSON.stringify({
      maxResults: this.config.maxResults,
      recencyDecay: this.config.recencyDecay,
      recencyHalfLife: this.config.recencyHalfLife,
      weibullDecay: this.config.weibullDecay,
      reinforcement: this.config.reinforcement,
      mmr: this.config.mmr,
      lengthNorm: this.config.lengthNorm,
      hardMinScore: this.config.hardMinScore,
      tier: this.config.tier,
    }));

    if (this.config.llm.enabled && this.config.llm.apiKey) {
      this.llmClient = new LLMClient(this.config, log);
      // Wire up error metrics callbacks
      this.llmClient.onCoreError = () => { this.metrics.llmErrors.core++; this.metrics.lastErrorAt = Date.now(); };
      this.llmClient.onExtractError = () => { this.metrics.llmErrors.extract++; this.metrics.lastErrorAt = Date.now(); };
      this.llmClient.onDedupError = () => { this.metrics.llmErrors.dedup++; this.metrics.lastErrorAt = Date.now(); };
    }
  }

  async init(stateDir: string): Promise<void> {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    this.dbPath = path.join(stateDir, 'memories.db');

    // Detect duplicate plugin instances via PID file
    const pidPath = path.join(stateDir, 'algo-memory.pid');
    try {
      if (fs.existsSync(pidPath)) {
        const oldPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        // Check if that PID is still alive (works on Linux/macOS)
        try {
          process.kill(oldPid, 0);
          this.log.warn(`[algo-memory] 检测到另一个 algo-memory 实例正在运行 (PID ${oldPid})，当前实例不会覆盖其数据。`);
        } catch (_) {
          // Old PID is dead, safe to proceed
        }
      }
      fs.writeFileSync(pidPath, String(process.pid));
    } catch (e) {
      this.log.warn('[algo-memory] 无法写入 PID 文件:', e);
    }

    const SQL = await initSqlJs();
    this.SQL = SQL;

    if (fs.existsSync(this.dbPath)) {
      try {
        const fileBuffer = fs.readFileSync(this.dbPath);
        this.db = new SQL.Database(fileBuffer);
      } catch (err) {
        this.log.warn('[algo-memory] 加载数据库失败，创建新数据库:', err);
        this.db = new SQL.Database();
      }
    } else {
      this.db = new SQL.Database();
    }

    initSchema(this.db, this.log);
    // Probe FTS5 availability once
    try {
      this.db.exec("SELECT count(*) FROM memories_fts LIMIT 0");
      this.ftsAvailable = true;
    } catch (_) {
      this.ftsAvailable = false;
      this.log.warn('[algo-memory] FTS5 不可用，搜索将降级为 LIKE');
    }
    this.saveDatabase();

    this.log.info('[algo-memory] 数据库初始化:', this.dbPath);
    this.log.info(`[algo-memory] 每轮最多写入: ${this.config.capturePerTurn} 条`);

    // Kick off first cleanup immediately so the timer doesn't drift for days
    this.cleanup();
    this.cleanupInterval = setInterval(() => this.cleanup(), DEFAULT_CLEANUP_INTERVAL_MS);
    this.startFlushTimer();
  }

  private saveDatabase(): void {
    if (!this.db || !this.dbPath) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (err) {
      this.log.error('[algo-memory] 保存数据库失败:', err);
      this.metrics.dbErrors++;
      this.metrics.lastErrorAt = Date.now();
    }
  }

  // Debounced save — avoids hammering disk on rapid store() calls
  private pendingSave: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;   // periodic forced flush
  private lastPersistTime: number = Date.now();       // track last save for periodic check

  private scheduleSave(): void {
    if (this.pendingSave) return;  // already scheduled
    this.pendingSave = setTimeout(() => {
      this.pendingSave = null;
      this.saveDatabase();
      this.lastPersistTime = Date.now();
    }, 500);  // flush within 500ms
  }

  private startFlushTimer(): void {
    // Every 30s force a flush — guarantees data at risk < 30s even on crash
    this.flushTimer = setInterval(() => {
      if (this.pendingSave) {
        clearTimeout(this.pendingSave);
        this.pendingSave = null;
        this.saveDatabase();
        this.lastPersistTime = Date.now();
      }
    }, 30_000);
  }

  private clearRecallCache(AgentId: string): void {
    // Invalidate all recall cache entries for this agent
    // Cache key format: recall:${AgentId}:${configHash}:${query}
    const cache = (this.cache as any).cache as Map<string, any>;
    for (const key of cache.keys()) {
      if (key.startsWith(`recall:${AgentId}:`)) {
        cache.delete(key);
      }
    }
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

  async store(AgentId: string, messages: any[]): Promise<void> {
    const deps: StoreDeps = {
      db: this.db,
      config: this.config,
      llmClient: this.llmClient,
      log: this.log,
      saveDatabase: () => this.saveDatabase(),
      clearRecallCache: (aid) => this.clearRecallCache(aid),
      metrics: this.metrics
    };
    await doStore(deps, AgentId, messages);
  }

  private updateTier(memoryId: string): void {
    if (!this.config.tier.enabled || !this.db) return;
    const mem = queryOne(this.db, 'SELECT importance, access_count, created_at FROM memories WHERE id = ?', [memoryId]) as any;
    if (!mem) return;
    const daysOld = (Date.now() - mem.created_at) / (1000 * 60 * 60 * 24);
    const newTier = getTier(mem.importance, mem.access_count, daysOld, this.config.tier);
    run(this.db, 'UPDATE memories SET tier = ? WHERE id = ?', [newTier, memoryId]);
  }

  async recall(AgentId: string, query: string): Promise<{ hasMemory: boolean; memories: any[] }> {
    const deps: RecallDeps = {
      db: this.db,
      config: this.config,
      log: this.log,
      getVisibleAgentIds: (aid) => this.getVisibleAgentIds(aid),
      cache: (this.cache as any).cache as Map<string, any>,
      configHash: this.configHash
    };
    return doRecall(deps, AgentId, query);
  }

  addSessionMemory(AgentId: string, content: string): void {
    if (!this.config.sessionMemory.enabled) return;
    const key = `session:${AgentId}`;
    const session = this.sessionCache.get(key) || [];
    session.unshift({ content, time: Date.now() });
    if (session.length > this.config.sessionMemory.maxSessionItems) session.pop();
    this.sessionCache.set(key, session);
  }

  getSessionMemory(AgentId: string): any[] {
    return this.config.sessionMemory.enabled
      ? (this.sessionCache.get(`session:${AgentId}`) || [])
      : [];
  }

  cleanup(): void {
    if (!this.db) return;
    const cutoff = Date.now() - this.config.cleanupDays * 24 * 60 * 60 * 1000;
    const changes = run(this.db,
      'DELETE FROM memories WHERE last_accessed < ? AND layer = "general" AND tier = "peripheral"',
      [cutoff]
    );
    if (changes > 0) this.scheduleSave();
    this.log.info('[algo-memory] 清理了', changes, '条过期记忆');
  }

  // ===== Tool Methods =====
  listMemories(AgentId: string, limit: number = 20, offset: number = 0): any[] {
    if (!this.db) return [];
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    if (visibleAgentIds === null) {
      return queryAll(this.db,
        'SELECT * FROM memories ORDER BY CASE tier WHEN \'core\' THEN 0 WHEN \'working\' THEN 1 ELSE 2 END, importance DESC, created_at DESC LIMIT ? OFFSET ?',
        [limit, offset]
      );
    }
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    return queryAll(this.db,
      `SELECT * FROM memories WHERE agent_id IN (${placeholders}) ORDER BY CASE tier WHEN 'core' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, importance DESC, created_at DESC LIMIT ? OFFSET ?`,
      [...visibleAgentIds, limit, offset]
    );
  }

  searchMemories(AgentId: string, query: string): any[] {
    if (!this.db) return [];
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);

    try {
      if (!this.ftsAvailable) throw new Error('FTS5 unavailable');
      // Strip FTS5 special characters; limit query length to prevent ReDoS / abuse
      const rawQuery = query.replace(/[^\w\s\u4e00-\u9fa5]/g, ' ').trim();
      const terms = rawQuery.split(/\s+/).filter(Boolean).slice(0, 20);  // max 20 terms
      const ftsQuery = terms.map((w: string) => `"${w}"*`).join(' OR ') || '';
      if (ftsQuery) {
        let results;
        if (visibleAgentIds === null) {
          results = queryAll(this.db,
            `SELECT m.* FROM memories m JOIN memories_fts fts ON m.id = fts.id WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) DESC, m.importance DESC LIMIT 20`,
            [ftsQuery]
          );
        } else {
          const placeholders = visibleAgentIds.map(() => '?').join(',');
          results = queryAll(this.db,
            `SELECT m.* FROM memories m JOIN memories_fts fts ON m.id = fts.id WHERE m.agent_id IN (${placeholders}) AND memories_fts MATCH ? ORDER BY bm25(memories_fts) DESC, m.importance DESC LIMIT 20`,
            [...visibleAgentIds, ftsQuery]
          );
        }
        if (results.length > 0) return results;
      }
    } catch (err) {
      this.log.warn('[algo-memory] FTS5 搜索不可用，使用 LIKE 备用:', (err as Error).message);
    }

    // Fallback: LIKE query
    const q = `%${query}%`;
    if (visibleAgentIds === null) {
      return queryAll(this.db, 'SELECT * FROM memories WHERE (content LIKE ? OR keywords LIKE ?) ORDER BY importance DESC LIMIT 20', [q, q]);
    }
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    return queryAll(this.db,
      `SELECT * FROM memories WHERE agent_id IN (${placeholders}) AND (content LIKE ? OR keywords LIKE ?) ORDER BY importance DESC LIMIT 20`,
      [...visibleAgentIds, q, q]
    );
  }

  getStats(AgentId: string): { total: number; core: number; working: number; peripheral: number; general: number; metrics: typeof MemoryPlugin.prototype.metrics } {
    if (!this.db) return { total: 0, core: 0, working: 0, peripheral: 0, general: 0, metrics: this.metrics };
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);

    let row: Record<string, unknown> | null;
    if (visibleAgentIds === null) {
      row = queryOne(this.db,
        `SELECT
          COUNT(*) as total,
          SUM(tier = 'core') as core,
          SUM(tier = 'peripheral') as peripheral,
          SUM(layer = 'general') as general
         FROM memories`
      );
    } else {
      const placeholders = visibleAgentIds.map(() => '?').join(',');
      row = queryOne(this.db,
        `SELECT
          COUNT(*) as total,
          SUM(tier = 'core') as core,
          SUM(tier = 'peripheral') as peripheral,
          SUM(layer = 'general') as general
         FROM memories WHERE agent_id IN (${placeholders})`,
        visibleAgentIds
      );
    }

    const total = (row?.total as number) || 0;
    const core = (row?.core as number) || 0;
    const peripheral = (row?.peripheral as number) || 0;
    const general = (row?.general as number) || 0;

    return {
      total,
      core,
      working: total - core - peripheral,
      peripheral,
      general,
      metrics: this.metrics
    };
  }

  getMemory(AgentId: string, memoryId: string): any | null {
    if (!this.db) return null;
    return queryOne(this.db, 'SELECT * FROM memories WHERE id = ? AND agent_id = ?', [memoryId, AgentId]);
  }

  deleteMemory(AgentId: string, memoryId: string): boolean {
    if (!this.db) return false;
    const changes = run(this.db, 'DELETE FROM memories WHERE id = ? AND agent_id = ?', [memoryId, AgentId]);
    this.clearRecallCache(AgentId);
    if (changes > 0) this.scheduleSave();
    return changes > 0;
  }

  deleteBulk(AgentId: string, memoryIds: string[]): number {
    if (!this.db || memoryIds.length === 0) return 0;
    const placeholders = memoryIds.map(() => '?').join(',');
    const changes = run(this.db, `DELETE FROM memories WHERE id IN (${placeholders}) AND agent_id = ?`, [...memoryIds, AgentId]);
    this.clearRecallCache(AgentId);
    if (changes > 0) this.scheduleSave();
    return changes;
  }

  clearMemories(AgentId: string, keepCore: boolean = true): number {
    if (!this.db) return 0;
    const changes = keepCore
      ? run(this.db, 'DELETE FROM memories WHERE agent_id = ? AND tier != ?', [AgentId, 'core'])
      : run(this.db, 'DELETE FROM memories WHERE agent_id = ?', [AgentId]);
    this.clearRecallCache(AgentId);
    if (changes > 0) this.scheduleSave();
    return changes;
  }

  updateMemory(AgentId: string, memoryId: string, content: string): boolean {
    const safe = normalizeText(content).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const isCore = isCoreKeyword(safe, this.config.coreKeywords);
    const tier = getTier(isCore ? 1.0 : 0.5, 1, 0, this.config.tier);
    const changes = run(this.db,
      'UPDATE memories SET content = ?, tier = ?, layer = ?, keywords = ?, importance = ?, last_accessed = ? WHERE id = ? AND agent_id = ?',
      [safe, tier, isCore ? 'core' : 'general', extractKeywords(safe), isCore ? 1.0 : 0.5, Date.now(), memoryId, AgentId]
    );
    this.clearRecallCache(AgentId);
    if (changes > 0) this.scheduleSave();
    return changes > 0;
  }

  exportMemories(AgentId: string): any[] {
    if (!this.db) return [];
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    if (visibleAgentIds === null) {
      return queryAll(this.db, 'SELECT * FROM memories');
    }
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    return queryAll(this.db, `SELECT * FROM memories WHERE agent_id IN (${placeholders})`, visibleAgentIds);
  }

  importMemories(AgentId: string, memories: any[]): number {
    if (!this.db) return 0;
    let imported = 0;
    try {
      runOrThrow(this.db, 'BEGIN TRANSACTION');
      for (const m of memories) {
        try {
          const tier = getTier(m.importance || 0.5, m.access_count || 1, 0, this.config.tier);
          run(this.db,
            `INSERT INTO memories (id, agent_id, scope, content, type, tier, layer, keywords, importance, access_count, created_at, last_accessed, content_hash, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              m.id || generateId(),
              AgentId,
              m.scope || 'global',
              m.content,
              m.type || 'other',
              tier,
              m.layer || 'general',
              m.keywords || '',
              m.importance || 0.5,
              m.access_count || 1,
              m.created_at || Date.now(),
              m.last_accessed || Date.now(),
              m.content_hash || hashContent(m.content),
              m.metadata || null
            ]
          );
          imported++;
        } catch (e) {
          this.log.warn('[algo-memory] 导入单条记忆失败:', e);
        }
      }
      runOrThrow(this.db, 'COMMIT');
    } catch (e) {
      try { this.db.run('ROLLBACK'); } catch (_) { /* ignore */ }
      this.log.error('[algo-memory] 导入记忆事务失败:', e);
      this.metrics.dbErrors++;
      this.metrics.lastErrorAt = Date.now();
      return 0;
    }
    if (imported > 0) {
      this.scheduleSave();
      this.clearRecallCache(AgentId);
    }
    return imported;
  }

  // ===== Metrics =====
  getMetrics(): typeof MemoryPlugin.prototype.metrics {
    return this.metrics;
  }

  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.cache.clear();
    this.sessionCache.clear();
    if (this.pendingSave) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }
    if (this.db) {
      // Force immediate flush before closing — no more async scheduling
      this.saveDatabase();
      this.db.close();
      this.db = null;
    }
    // Remove PID file so a fresh start is clean next time
    try {
      const pidPath = path.join(
        process.env.HOME || '/home/x',
        '.openclaw', 'state', 'algo-memory', 'algo-memory.pid'
      );
      fs.unlinkSync(pidPath);
    } catch (_) { /* ignore */ }
    this.log.info('[algo-memory] 插件已关闭');
  }
}

// ============= Plugin Export =============
// Shared dedup key: prevents re-injecting the same memory block on
// successive before_prompt_build calls within the same conversation
const lastRecallKey: Map<string, string> = new Map();

const algoMemoryPlugin = {
  id: "algo-memory",
  name: "Algo Memory",
  description: "纯算法长期记忆插件 - 支持多模型/智能去重/时间衰减",
  kind: "memory" as const,

  async register(api: any) {
    const log = api.logger || console;
    const userConfig = api.pluginConfig || api.config || {};
    const config = mergeConfig(userConfig);

    const plugin = new MemoryPlugin(config, log);

    const stateDir = api.getStateDir?.() || api.stateDir ||
      path.join(process.env.HOME || process.env.USERPROFILE || '/home/x', '.openclaw', 'state', 'algo-memory');

    await plugin.init(stateDir);

    log.info('[algo-memory] 插件已加载，自动捕获: ' + config.autoCapture + ', 自动召回: ' + config.autoRecall);

    // ===== Tool Definitions =====
    const toolDefinitions = [
      { name: 'algo_memory_list', description: '列出所有记忆', parameters: Type.Object({ agentId: Type.String(), limit: Type.Optional(Type.Number()), offset: Type.Optional(Type.Number()) }) },
      { name: 'algo_memory_search', description: '搜索记忆', parameters: Type.Object({ agentId: Type.String(), query: Type.String() }) },
      { name: 'algo_memory_stats', description: '查看记忆统计', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_get', description: '获取单条记忆详情', parameters: Type.Object({ agentId: Type.String(), memoryId: Type.String() }) },
      { name: 'algo_memory_delete', description: '删除单条记忆', parameters: Type.Object({ agentId: Type.String(), memoryId: Type.String() }) },
      { name: 'algo_memory_delete_bulk', description: '批量删除记忆', parameters: Type.Object({ agentId: Type.String(), memoryIds: Type.Array(Type.String()) }) },
      { name: 'algo_memory_clear', description: '清空记忆（可选保留核心记忆）', parameters: Type.Object({ agentId: Type.String(), keepCore: Type.Optional(Type.Boolean()) }) },
      { name: 'algo_memory_update', description: '更新记忆内容', parameters: Type.Object({ agentId: Type.String(), memoryId: Type.String(), content: Type.String() }) },
      { name: 'algo_memory_export', description: '导出所有记忆', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_import', description: '导入记忆', parameters: Type.Object({ agentId: Type.String(), memories: Type.Array(Type.Object({})) }) },
      { name: 'algo_memory_session', description: '获取当前 Session 的临时记忆', parameters: Type.Object({ agentId: Type.String() }) },
      { name: 'algo_memory_metrics', description: '导出错误指标（LLM/DB 错误计数及最后错误时间）', parameters: Type.Object({}) },
      { name: 'algo_memory_session_add', description: '写入当前 Session 的临时记忆', parameters: Type.Object({ agentId: Type.String(), content: Type.String() }) }
    ];

    // ===== Register Tools =====
    toolDefinitions.forEach(tool => {
      api.registerTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        async execute(_id: string, params: any) {
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
              case 'algo_memory_export': result = plugin.exportMemories(params.agentId); break;
              case 'algo_memory_import': result = { imported: plugin.importMemories(params.agentId, params.memories) }; break;
              case 'algo_memory_session': result = plugin.getSessionMemory(params.agentId); break;
              case 'algo_memory_metrics': result = plugin.getMetrics(); break;
              case 'algo_memory_session_add': result = { success: plugin.addSessionMemory(params.agentId, params.content) }; break;
            }
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          } catch (err: any) {
            return { content: [{ type: 'text', text: 'Error: ' + String(err) }], isError: true };
          }
        }
      });
    });

    // ===== Lifecycle Hooks =====
    if (typeof api.on === 'function') {
      // agent_end: store memories after agent response
      api.on('agent_end', async (event: any) => {
        try {
          const agentId = event?.agentId || 'default';
          const messages = event?.messages || [];
          if (config.autoCapture && messages.length > 0) {
            await plugin.store(agentId, messages);
          }
        } catch (err) {
          log.error('[algo-memory] agent_end 钩子错误:', err);
        }
      });

      // before_prompt_build: inject memory context before prompt building
      // Task 1 fix: use api.prependSystemContext() instead of return value
      if (config.autoRecall) {
        api.on('before_prompt_build', async (event: any) => {
          try {
            const agentId = event?.agentId || 'default';
            const messages = event?.messages || [];
            // Collect all user messages in this turn to form a comprehensive query
            const userMessages = (messages as any[])
              .filter((m: any) => m.role === 'user' && typeof m.content === 'string')
              .map((m: any) => m.content.trim())
              .filter(Boolean);
            if (userMessages.length === 0) return;

            // Join last few user messages as query (up to 3 to avoid over-loading)
            const query = userMessages.slice(-3).join(' ');
            if (!shouldRetrieve(query, config.adaptiveRetrieval)) return;

            // Skip if the query is identical to last recall — memories already in context
            const lastKey = lastRecallKey.get(agentId) || '';
            if (query === lastKey) return;
            lastRecallKey.set(agentId, query);

            const { hasMemory, memories } = await plugin.recall(agentId, query);
            if (hasMemory && memories.length > 0) {
              // Token-budgeted injection: fill context up to MAX_INJECT_TOKENS,
              // keeping highest-importance memories first
              const MAX_INJECT_TOKENS = 1500;
              const header = '\n\n以下是相关记忆：\n';
              const headerTokens = estimateTokens(header);
              const selected: string[] = [];
              let tokenCount = headerTokens;
              let omitted = 0;
              for (const m of memories) {
                const line = `[记忆] ${m.content}`;
                const lineTokens = estimateTokens(line) + 1;  // +1 for '\n'
                if (tokenCount + lineTokens <= MAX_INJECT_TOKENS) {
                  selected.push(line);
                  tokenCount += lineTokens;
                } else {
                  omitted++;
                }
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
    }

    // ===== Service Lifecycle =====
    api.registerService({
      id: "algo-memory",
      start: async () => { log.info('[algo-memory] 服务已启动'); },
      stop: async () => {
        try {
          plugin.close();
          log.info('[algo-memory] 服务已停止');
        } catch (err) {
          log.error('[algo-memory] 服务停止错误:', err);
        }
      }
    });

    log.info(`[algo-memory] 插件已就绪, 工具数: ${toolDefinitions.length}, 自动捕获: ${config.autoCapture}, 自动召回: ${config.autoRecall}`);
  }
};

export default algoMemoryPlugin;
