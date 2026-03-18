/**
 * algo-memory v2.2.3
 * 纯算法长期记忆插件 - 无需 LLM 也能工作
 * 支持多语言: zh/en/ja/ko/es/fr/de
 * 支持 FTS5 全文搜索
 * 支持国内主流模型: MiniMax/百炼/DeepSeek/Kimi/智谱/腾讯/百度
 * 默认启用Agent隔离模式，支持配置跨Agent查看
 */

import { Type } from '@sinclair/typebox';

// ============= 常量定义 =============
const MAX_MESSAGE_LENGTH = 10000;  // 消息最大长度限制
const CACHE_MAX_SIZE = 100;  // LRU 缓存最大条目数
const CACHE_TTL_MS = 5 * 60 * 1000;  // 缓存 TTL: 5分钟
const SESSION_CACHE_MAX_SIZE = 50;  // 会话缓存最大条目数
const SESSION_CACHE_TTL_MS = 30 * 60 * 1000;  // 会话缓存 TTL: 30分钟
const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;  // 清理周期: 24小时
const MAX_KEYWORDS = 10;  // 最大关键词数量
const MAX_SIMILAR_CHECK = 10;  // 相似度检查的最大条目数
const RETRY_MAX_ATTEMPTS = 2;  // LLM 重试次数
const RETRY_DELAY_MS = 1000;  // 重试延迟
const MIN_CJK_QUERY_LENGTH = 6;  // CJK 语言最小查询长度
const MIN_EN_QUERY_LENGTH = 15;  // 英语最小查询长度
import LRUCache from 'lru-cache';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ============= 最小默认配置 =============
// 注意：完整配置定义在 openclaw.plugin.json 的 configSchema 中
// 此处仅保留代码运行所需的最小默认配置
interface Config {
  autoCapture: boolean;
  autoRecall: boolean;
  maxResults: number;
  cleanupDays: number;
  language: string;
  coreKeywords: string[];
  recencyDecay: boolean;
  recencyHalfLife: number;
  smartDedup: boolean;
  dedupThreshold: number;
  noiseFilter: { enabled: boolean; skipGreetings: boolean; skipCommands: boolean };
  adaptiveRetrieval: { enabled: boolean; minQueryLength: number; forceKeywords: string[] };
  sessionMemory: { enabled: boolean; maxSessionItems: number };
  weibullDecay: { enabled: boolean; shape: number; scale: number };
  reinforcement: { enabled: boolean; factor: number; maxMultiplier: number };
  mmr: { enabled: boolean; threshold: number };
  lengthNorm: { enabled: boolean; anchor: number };
  hardMinScore: { enabled: boolean; threshold: number };
  tier: { enabled: boolean; coreThreshold: number; peripheralThreshold: number; ageDays: number };
  scopes: { enabled: boolean; defaultScope: string; visibleAgents: string[] };
  capturePerTurn: number;
  llm: { enabled: boolean; provider: string; apiKey: string; model: string; baseURL: string };
  threshold: { useLlmForCore: boolean; useLlmForExtract: boolean; useLlmForDedup: boolean; minConfidence: number; lengthForCore: number; lengthForExtract: number; dedupUncertaintyMin: number; dedupUncertaintyMax: number };
}

// 最小默认配置（完整配置由 openclaw.plugin.json 提供）
const DEFAULT_CONFIG: Config = {
  autoCapture: true,
  autoRecall: true,
  maxResults: 5,
  cleanupDays: 180,
  language: 'auto',
  coreKeywords: ['记住', '牢记', '重要', '不要忘记', '记住它', 'remember', 'important', 'never forget'],
  recencyDecay: true,
  recencyHalfLife: 180,
  smartDedup: true,
  dedupThreshold: 0.85,
  noiseFilter: { enabled: true, skipGreetings: true, skipCommands: true },
  adaptiveRetrieval: { enabled: true, minQueryLength: 2, forceKeywords: ['记住', '之前', '上次', '记得', 'remember', 'before', 'last', '前', '上次'] },
  sessionMemory: { enabled: false, maxSessionItems: 10 },
  weibullDecay: { enabled: false, shape: 1.5, scale: 90 },
  reinforcement: { enabled: false, factor: 0.5, maxMultiplier: 3 },
  mmr: { enabled: false, threshold: 0.85 },
  lengthNorm: { enabled: false, anchor: 500 },
  hardMinScore: { enabled: false, threshold: 0.35 },
  tier: { enabled: false, coreThreshold: 10, peripheralThreshold: 0.15, ageDays: 60 },
  scopes: { enabled: true, defaultScope: 'agent', visibleAgents: [] },
  capturePerTurn: 3,
  llm: { enabled: true, provider: 'auto', apiKey: '', model: '', baseURL: '' },
  threshold: { useLlmForCore: false, useLlmForExtract: false, useLlmForDedup: false, minConfidence: 0.8, lengthForCore: 100, lengthForExtract: 200, dedupUncertaintyMin: 0.5, dedupUncertaintyMax: 0.98 }
};

// ============= 工具函数 =============
function generateId(): string { return 'mem_' + crypto.randomBytes(8).toString('hex'); }
function hashContent(content: string): string { return crypto.createHash('sha256').update(content).digest('hex'); }
function extractKeywords(content: string): string {
  const words = content.toLowerCase().match(/[\u4e00-\u9fa5a-zA-Z0-9]{2,}/g) || [];
  return [...new Set(words)].slice(0, MAX_KEYWORDS).join(',');
}
function isCoreKeyword(content: string, keywords: string[]): boolean { return keywords.some(k => content.includes(k)); }

// 文本归一化 (借鉴 memory-lancedb-pro)
function normalizeText(text: string): string {
  let normalized = text.trim();
  // 去除 addressing (如 @bot 或 @agent)
  normalized = normalized.replace(/^@\w+\s+/, '');
  // 去除多余空白
  normalized = normalized.replace(/\s+/g, ' ').trim();
  // 去除 OpenClaw 注入前缀
  normalized = normalized.replace(/^(以下是|根据|按照).*?:?\s*/i, '');
  return normalized;
}

// 噪声过滤
function isNoise(content: string, config: Config['noiseFilter']): boolean {
  if (!config.enabled) return false;
  const lower = content.toLowerCase().trim();
  if (config.skipGreetings) {
    const greetings = ['hi', 'hello', 'hey', '你好', '您好', '嗨'];
    if (greetings.some(g => lower === g || lower.startsWith(g + ' '))) return true;
  }
  if (config.skipCommands) {
    if (lower.startsWith('/') || lower.startsWith('!') || lower.startsWith('-')) return true;
  }
  const confirms = ['ok', 'okay', '好', '好的', '收到', '了解', '明白', 'yes', 'no', '嗯', '哦'];
  if (confirms.includes(lower)) return true;
  if (!lower || /^[.。!?！?\s]+$/.test(lower)) return true;
  return false;
}

// ============= Multi-language Support =============
const CORE_KEYWORDS_MAP: Record<string, string[]> = {
  zh: ['记住', '牢记', '重要', '不要忘记', '记住它', '这是关键', '永久保留', '一直记住', '别忘了'],
  en: ['remember', 'important', 'never forget', 'always remember', 'keep in mind', 'note that', 'must remember', 'critical'],
  ja: ['覚えて', '重要', '忘れないで', '常に', '心に留めて', '鍵'],
  ko: ['기억', '중요', '잊지마', '반드시', '핵심'],
  es: ['recordar', 'importante', 'nunca olvides', 'ten en mente', 'esencial'],
  fr: ['rappelez', 'important', 'noubliez jamais', 'à retenir', 'essentiel'],
  de: ['merken', 'wichtig', 'nie vergessen', 'behalten', 'wesentlich']
};

const RETRIEVE_KEYWORDS_MAP: Record<string, string[]> = {
  zh: ['记住', '之前', '上次', '记得', '以前'],
  en: ['remember', 'before', 'last', 'previously', 'earlier'],
  ja: ['覚えて', '以前', '前に'],
  ko: ['기억', '이전', '전에'],
  es: ['recordar', 'antes', 'anterior'],
  fr: ['rappelez', 'avant', 'précédemment'],
  de: ['merken', 'vorher', 'früher']
};

function detectLanguage(text: string): string {
  if (!text) return 'en';
  const patterns: Record<string, RegExp> = { zh: /[\u4e00-\u9fa5]/g, ja: /[\u3040-\u309f\u30a0-\u30ff]/g, ko: /[\uac00-\ud7af]/g };
  let maxLang = 'en', maxCount = 0;
  for (const [lang, pattern] of Object.entries(patterns)) {
    const count = (text.match(pattern) || []).length;
    if (count > maxCount) { maxCount = count; maxLang = lang; }
  }
  return maxLang;
}

function getCoreKeywords(language: string, customKeywords?: string[]): string[] {
  if (customKeywords && customKeywords.length > 0) return customKeywords;
  if (language === 'auto') return CORE_KEYWORDS_MAP.zh.concat(CORE_KEYWORDS_MAP.en);
  return CORE_KEYWORDS_MAP[language] || CORE_KEYWORDS_MAP.en;
}

function getRetrieveKeywords(language: string): string[] {
  if (language === 'auto') return RETRIEVE_KEYWORDS_MAP.zh.concat(RETRIEVE_KEYWORDS_MAP.en);
  return RETRIEVE_KEYWORDS_MAP[language] || RETRIEVE_KEYWORDS_MAP.en;
}
// ============= End Multi-language Support =============

// CJK + 自适应检索
function shouldRetrieve(query: string, config: Config['adaptiveRetrieval']): boolean {
  if (!config.enabled) return true;
  if (!query || query.trim().length < 1) return false;
  const lowerQuery = query.toLowerCase();
  if (config.forceKeywords?.some(k => lowerQuery.includes(k))) return true;
  const isCJK = /[\u4e00-\u9fa5]/.test(query);
  const minLen = isCJK ? MIN_CJK_QUERY_LENGTH : MIN_EN_QUERY_LENGTH;
  if (query.trim().length < minLen) return false;
  return true;
}

// Jaccard
function jaccardSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().match(/[\u4e00-\u9fa5a-zA-Z0-9]{2,}/g) || []);
  const words2 = new Set(text2.toLowerCase().match(/[\u4e00-\u9fa5a-zA-Z0-9]{2,}/g) || []);
  if (words1.size === 0 || words2.size === 0) return 0;
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  return intersection.size / union.size;
}

// Weibull 衰减
function weibullDecay(daysOld: number, shape: number, scale: number): number {
  return Math.exp(-Math.pow(daysOld / scale, shape));
}

// 长度归一化
function lengthNorm(content: string, anchor: number): number {
  const len = content.length;
  if (len <= anchor) return 1.0;
  return anchor / len;
}

// 访问强化
function reinforcementFactor(accessCount: number, config: Config['reinforcement']): number {
  if (!config.enabled || accessCount <= 1) return 1.0;
  return Math.min(config.maxMultiplier, 1.0 + (accessCount - 1) * config.factor);
}

// MMR
function mmrDeduplicate(items: any[], config: Config['mmr']): any[] {
  if (!config.enabled || items.length <= 1) return items;
  const result: any[] = [];
  const scores = items.map(m => ({ ...m, _score: m._score || m.importance }));
  while (scores.length > 0) {
    scores.sort((a, b) => b._score - a._score);
    const top = scores.shift()!;
    result.push(top);
    const remaining: any[] = [];
    for (const item of scores) {
      const sim = jaccardSimilarity(top.content, item.content);
      if (sim < config.threshold) remaining.push(item);
    }
    scores.length = 0;
    scores.push(...remaining);
  }
  return result;
}

// 三层晋升
function getTier(importance: number, accessCount: number, daysOld: number, config: Config['tier']): 'core' | 'working' | 'peripheral' {
  if (!config.enabled) return importance >= 1.0 ? 'core' : 'working';
  const compositeScore = importance * (1 + Math.log10(accessCount + 1));
  if (accessCount >= config.coreThreshold || compositeScore >= 0.7) return 'core';
  if (compositeScore < config.peripheralThreshold || daysOld > config.ageDays) return 'peripheral';
  return 'working';
}

// 睡眠辅助函数
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

// LLM 模型配置（国内为主）
const LLM_PROVIDERS = {
  // ===== 国内模型 =====
  
  // MiniMax (默认推荐)
  minimax: {
    baseURL: 'https://api.minimax.chat/v1',
    models: [
      // 2.5 系列
      'abab6.5s-chat',    // MiniMax 2.5 (默认)
      'abab6.5g-chat',    // MiniMax 2.5 增强版
      'abab6.5s-chat-200k', // MiniMax 2.5 200K上下文
      // 1.8 系列
      'abab1.8s-chat',    // MiniMax 1.8
      'abab1.8g-chat',    // MiniMax 1.8 增强版
      // 1.5 系列
      'abab6s-chat',     // MiniMax 1.5
      'abab5.5s-chat'    // MiniMax 1.5.5
    ],
    defaultModel: 'abab6.5s-chat'
  },
  // 阿里云百炼
  bailian: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long'],
    defaultModel: 'qwen-plus'
  },
  // DeepSeek
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-coder'],
    defaultModel: 'deepseek-chat'
  },
  // Kimi (月之暗面)
  kimi: {
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['kimi-chat', 'kimi-chat-latest'],
    defaultModel: 'kimi-chat'
  },
  // 智谱 AI
  zhipu: {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4', 'glm-4-flash', 'glm-3-turbo'],
    defaultModel: 'glm-4-flash'
  },
  // 腾讯混元
  hunyuan: {
    baseURL: 'https://hunyuan.tencent.com/proxy/v1',
    models: ['hunyuan-pro', 'hunyuan-standard'],
    defaultModel: 'hunyuan-standard'
  },
  // 百度文心
  wenxin: {
    baseURL: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-4.0-8k', 'ernie-3.5-8k', 'ernie-speed-8k'],
    defaultModel: 'ernie-3.5-8k'
  },
  // SiliconFlow (国内聚合)
  siliconflow: {
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2-7B-Instruct', 'THUDM/glm-4-9b-chat', 'deepseek-ai/DeepSeek-V2-Chat'],
    defaultModel: 'Qwen/Qwen2-7B-Instruct'
  },
  
  // ===== 国外模型（保留少量） =====
  
  // OpenAI (可选)
  openai: {
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini'
  },
  // Anthropic (可选)
  anthropic: {
    baseURL: 'https://api.anthropic.com/v1',
    models: ['claude-3-haiku-20240307'],
    defaultModel: 'claude-3-haiku-20240307'
  },
  // Ollama (本地)
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    models: ['llama2', 'mistral'],
    defaultModel: 'llama2'
  }
};

// 自动选择 LLM 配置
function resolveLLMConfig(config: Config['llm']): Config['llm'] {
  if (!config.enabled) return config;
  
  // 如果 provider 是 auto，自动检测
  if (config.provider === 'auto' || !config.provider) {
    // 优先使用 MiniMax（默认推荐，国内访问快）
    return { ...config, provider: 'minimax', ...LLM_PROVIDERS.minimax };
  }
  
  const provider = config.provider.toLowerCase();
  const providerConfig = LLM_PROVIDERS[provider as keyof typeof LLM_PROVIDERS];
  
  if (!providerConfig) {
    // 未知 provider，回退到 MiniMax
    return { ...config, provider: 'minimax', ...LLM_PROVIDERS.minimax };
  }
  
  // 使用用户提供的配置
  return {
    ...config,
    baseURL: config.baseURL || providerConfig.baseURL,
    model: config.model || providerConfig.defaultModel
  };
}

// LLM 调用重试辅助函数
async function llmCallWithRetry<T>(fn: () => Promise<T>, maxRetries: number = RETRY_MAX_ATTEMPTS, delayMs: number = RETRY_DELAY_MS): Promise<T> {
  let lastError: any;
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); } 
    catch (err) { lastError = err; if (i < maxRetries) await sleep(delayMs); }
  }
  throw lastError;
}

// LLM 客户端
class LLMClient {
  private config: Config;
  private log: any;
  constructor(config: Config, log: any) { this.config = config; this.log = log; }
  
  async isCoreMemory(content: string): Promise<{ isCore: boolean; confidence: number }> {
    const localResult = isCoreKeyword(content, this.config.coreKeywords);
    if (localResult) return { isCore: true, confidence: 1.0 };
    if (!this.config.llm.enabled || !this.config.llm.apiKey) return { isCore: false, confidence: 0.5 };
    
    try {
      const result = await llmCallWithRetry(async () => {
        const response = await fetch(`${this.config.llm.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.llm.apiKey}` },
          body: JSON.stringify({ model: this.config.llm.model, messages: [{ role: 'system', content: '判断是否重要需要长期记住。回复JSON: {"isCore": true/false, "confidence": 0-1}' }, { role: 'user', content }], max_tokens: 100, temperature: 0.1 })
        });
        if (!response.ok) {
          throw new Error(`LLM API 错误: ${response.status} ${response.statusText}`);
        }
        const jsonResponse = await response.json() as any;
        if (!jsonResponse?.choices?.[0]?.message?.content) {
          throw new Error('LLM 响应格式错误');
        }
        return JSON.parse(jsonResponse.choices[0].message.content);
      }, RETRY_MAX_ATTEMPTS, RETRY_DELAY_MS);
      return result;
    } catch (err) { this.log.error('[algo-memory] LLM isCoreMemory 失败:', err); return { isCore: false, confidence: 0.5 }; }
  }
  
  async extractKeywords(content: string): Promise<string> {
    const local = extractKeywords(content);
    if (!this.config.llm.enabled || !this.config.llm.apiKey) return local;
    try {
      const result = await llmCallWithRetry(async () => {
        const response = await fetch(`${this.config.llm.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.llm.apiKey}` },
          body: JSON.stringify({ model: this.config.llm.model, messages: [{ role: 'system', content: '提取关键词，最多10个。回复JSON: {"keywords": ["k1", "k2"]}' }, { role: 'user', content }], max_tokens: 200, temperature: 0.2 })
        });
        if (!response.ok) {
          throw new Error(`LLM API 错误: ${response.status} ${response.statusText}`);
        }
        const jsonResponse2 = await response.json() as any;
        if (!jsonResponse2?.choices?.[0]?.message?.content) {
          throw new Error('LLM 响应格式错误');
        }
        const parsed = JSON.parse(jsonResponse2.choices[0].message.content);
        if (!parsed?.keywords) {
          throw new Error('LLM 响应缺少 keywords 字段');
        }
        return parsed.keywords.join(',');
      }, RETRY_MAX_ATTEMPTS, RETRY_DELAY_MS);
      return result;
    } catch (err) { this.log.error('[algo-memory] LLM extractKeywords 失败:', err); return local; }
  }
  
  async isDuplicate(c1: string, c2: string): Promise<{ isDuplicate: boolean; similarity: number }> {
    const sim = jaccardSimilarity(c1, c2);
    if (sim >= 0.98 || sim < 0.5) return { isDuplicate: sim >= 0.98, similarity: sim };
    if (!this.config.llm.enabled || !this.config.llm.apiKey) return { isDuplicate: false, similarity: sim };
    try {
      const result = await llmCallWithRetry(async () => {
        const response = await fetch(`${this.config.llm.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.llm.apiKey}` },
          body: JSON.stringify({ model: this.config.llm.model, messages: [{ role: 'system', content: '判断是否重复。回复JSON: {"isDuplicate": true/false, "similarity": 0-1}' }, { role: 'user', content: `内容1: ${c1}\n内容2: ${c2}` }], max_tokens: 100, temperature: 0.1 })
        });
        if (!response.ok) {
          throw new Error(`LLM API 错误: ${response.status} ${response.statusText}`);
        }
        const jsonResponse3 = await response.json() as any;
        if (!jsonResponse3?.choices?.[0]?.message?.content) {
          throw new Error('LLM 响应格式错误');
        }
        return JSON.parse(jsonResponse3.choices[0].message.content);
      }, RETRY_MAX_ATTEMPTS, RETRY_DELAY_MS);
      return result;
    } catch (err) { this.log.error('[algo-memory] LLM isDuplicate 失败:', err); return { isDuplicate: sim >= this.config.dedupThreshold, similarity: sim }; }
  }
}

// ============= 核心类 =============
class MemoryPlugin {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any = null;
  private dbPath: string = '';  // 数据库路径，用于保存
  private SQL: any = null;  // sql.js 初始化结果
  private cache: LRUCache<string, any>;
  private sessionCache: LRUCache<string, any>;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private config: Config;
  private llmClient: LLMClient | null = null;
  private log: any;
  private configHash: string = '';  // 缓存的配置哈希

  constructor(config: Partial<Config>, log: any = console) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log = log;
    this.cache = new LRUCache({ max: CACHE_MAX_SIZE, ttl: CACHE_TTL_MS });
    this.sessionCache = new LRUCache({ max: SESSION_CACHE_MAX_SIZE, ttl: SESSION_CACHE_TTL_MS });
    // 缓存配置哈希，避免每次 recall 时重复计算
    this.configHash = hashContent(`${this.config.maxResults}:${this.config.recencyDecay}:${this.config.recencyHalfLife}`);
    if (this.config.llm.enabled && this.config.llm.apiKey) this.llmClient = new LLMClient(this.config, log);
  }

  async init(stateDir: string): Promise<void> {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    this.dbPath = path.join(stateDir, 'memories.db');
    
    // 初始化 sql.js
    const SQL = await initSqlJs();
    this.SQL = SQL;
    
    // 尝试加载已有数据库
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
    
    // 创建表
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, scope TEXT DEFAULT 'agent',
        content TEXT NOT NULL, type TEXT DEFAULT 'other', tier TEXT DEFAULT 'working',
        layer TEXT DEFAULT 'general', keywords TEXT, importance REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0, created_at INTEGER, last_accessed INTEGER, content_hash TEXT,
        metadata TEXT
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_agent ON memories(agent_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_tier ON memories(tier)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_scope ON memories(scope)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_agent_hash ON memories(agent_id, content_hash)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_agent_tier_importance ON memories(agent_id, tier, importance DESC)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_agent_last_accessed ON memories(agent_id, last_accessed DESC)');
    
    // 创建 FTS5 虚拟表用于全文搜索
    try {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          id, content, keywords, content='memories', content_rowid='rowid'
        )
      `);
      this.db.run(`CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, id, content, keywords) VALUES (new.rowid, new.id, new.content, new.keywords); END`);
      this.db.run(`CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, id, content, keywords) VALUES('delete', old.rowid, old.id, old.content, old.keywords); END`);
      this.db.run(`CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, id, content, keywords) VALUES('delete', old.rowid, old.id, old.content, old.keywords); INSERT INTO memories_fts(rowid, id, content, keywords) VALUES (new.rowid, new.id, new.content, new.keywords); END`);
      this.log.info('[algo-memory] FTS5 全文搜索已启用');
    } catch (err: any) {
      this.log.warn('[algo-memory] FTS5 创建失败，使用备用搜索:', err.message);
    }
    
    this.saveDatabase();
    this.log.info('[algo-memory] 数据库初始化:', this.dbPath);
    this.log.info(`[algo-memory] 每轮最多写入: ${this.config.capturePerTurn} 条`);
    this.cleanupInterval = setInterval(() => this.cleanup(), DEFAULT_CLEANUP_INTERVAL_MS);
  }

  // 保存数据库到文件
  private saveDatabase(): void {
    if (!this.db || !this.dbPath) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (err) {
      this.log.error('[algo-memory] 保存数据库失败:', err);
    }
  }

  // sql.js 辅助方法：将结果转换为对象数组
  private queryAll(sql: string, params: any[] = []): any[] {
    try {
      const stmt = this.db.prepare(sql);
      if (params.length > 0) stmt.bind(params);
      const results: any[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      return results;
    } catch (err) {
      this.log.error('[algo-memory] 查询失败:', sql, err);
      return [];
    }
  }

  // sql.js 辅助方法：执行单条查询
  private queryOne(sql: string, params: any[] = []): any {
    const results = this.queryAll(sql, params);
    return results.length > 0 ? results[0] : null;
  }

  // sql.js 辅助方法：执行更新
  private run(sql: string, params: any[] = []): number {
    try {
      this.db.run(sql, params);
      const changes = this.db.getRowsModified();
      this.saveDatabase();  // 保存更改
      return changes;
    } catch (err) {
      this.log.error('[algo-memory] 执行失败:', sql, err);
      return 0;
    }
  }

  // 获取当前 Agent 可见的 Agent 列表（用于跨Agent查询）
  private getVisibleAgentIds(AgentId: string): string[] {
    const { scopes } = this.config;
    // 如果未启用隔离模式，返回包含所有Agent的通配符
    if (!scopes.enabled) return ['%'];
    
    // 如果配置了 visibleAgents
    if (scopes.visibleAgents && scopes.visibleAgents.length > 0) {
      // 如果包含 *，返回所有
      if (scopes.visibleAgents.includes('*')) return ['%'];
      // 返回配置的列表 + 自己的
      return [AgentId, ...scopes.visibleAgents];
    }
    
    // 默认只能看自己
    return [AgentId];
  }

  async store(AgentId: string, messages: any[]): Promise<void> {
    // 边界情况处理
    if (!AgentId) {
      this.log.warn('[algo-memory] store 失败: agentId 为空');
      AgentId = 'default';
    }
    if (!messages?.length || !this.db) {
      this.log.warn('[algo-memory] store 失败: 无消息或数据库未初始化');
      return;
    }
    
    // 边界情况处理：消息过长时截断
    messages = messages.map(msg => ({
      ...msg,
      content: msg.content?.length > MAX_MESSAGE_LENGTH 
        ? msg.content.substring(0, MAX_MESSAGE_LENGTH) + '...[截断]' 
        : msg.content
    }));
    
    let captured = 0;
    const maxCapture = this.config.capturePerTurn || 3;
    const storeStartTime = Date.now();
    
    try {
    for (const msg of messages) {
      if (captured >= maxCapture) break;
      if (msg.role !== 'user') continue;
      
      // 文本归一化
      const content = normalizeText(msg.content);
      if (!content || isNoise(content, this.config.noiseFilter)) continue;
      
      const safeContent = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const contentHash = hashContent(safeContent);

      // 精确查重
      const existing = this.queryOne('SELECT id FROM memories WHERE agent_id = ? AND content_hash = ?', [AgentId, contentHash]);
      if (existing) {
        this.run('UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?', [Date.now(), existing.id]);
        this.cache.delete(`recall:${AgentId}`);
        this.updateTier(existing.id);
        continue;
      }

      // 智能去重
      if (this.config.smartDedup) {
        const similar = this.queryAll("SELECT id, content FROM memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?", [AgentId, MAX_SIMILAR_CHECK]);
        let isDuplicate = false;
        for (const s of similar) {
          let score = jaccardSimilarity(safeContent, s.content);
          // 阈值触发LLM去重判断
          const { dedupUncertaintyMin, dedupUncertaintyMax } = this.config.threshold;
          const inUncertaintyZone = score >= dedupUncertaintyMin && score < dedupUncertaintyMax;
          if (this.config.threshold.useLlmForDedup && this.llmClient && inUncertaintyZone) {
            const r = await this.llmClient.isDuplicate(safeContent, s.content);
            isDuplicate = r.isDuplicate;
          } else {
            isDuplicate = score >= this.config.dedupThreshold;
          }
          if (isDuplicate) {
            this.run('UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?', [Date.now(), s.id]);
            this.cache.delete(`recall:${AgentId}`);
            this.updateTier(s.id);
            break;  // 找到重复，跳过写入
          }
        }
        if (isDuplicate) continue;  // 已处理重复，跳过本次
      }

      // 核心判断
      let isCore = isCoreKeyword(safeContent, this.config.coreKeywords);
      let keywords = extractKeywords(safeContent);
      let importance = isCore ? 1.0 : 0.5;
      
      // 阈值触发LLM核心判断：长度超过阈值 或 未命中关键词
      const needLLMForCore = this.config.threshold.useLlmForCore && 
                             this.llmClient && 
                             (!isCore || safeContent.length >= this.config.threshold.lengthForCore);
      if (needLLMForCore) {
        const r = await this.llmClient.isCoreMemory(safeContent);
        isCore = r.isCore; importance = r.confidence;
      }
      
      // 阈值触发LLM关键词提取：长度超过阈值
      const needLLMForExtract = this.config.threshold.useLlmForExtract && 
                                 this.llmClient && 
                                 safeContent.length >= this.config.threshold.lengthForExtract;
      if (needLLMForExtract) keywords = await this.llmClient.extractKeywords(safeContent);

      const scope = this.config.scopes.enabled ? `${this.config.scopes.defaultScope}:${AgentId}` : 'global';
      const tier = getTier(importance, 1, 0, this.config.tier);
      
      // Smart metadata
      const metadata = JSON.stringify({
        memory_category: isCore ? 'fact' : 'other',
        confidence: importance,
        source_session: AgentId,
        l0_abstract: safeContent.substring(0, 100)
      });

      const memory = { id: generateId(), agent_id: AgentId, scope, content: safeContent, type: 'other', tier, layer: isCore ? 'core' : 'general', keywords, importance, access_count: 1, created_at: Date.now(), last_accessed: Date.now(), content_hash: contentHash, metadata };
      this.run('INSERT INTO memories (id, agent_id, scope, content, type, tier, layer, keywords, importance, access_count, created_at, last_accessed, content_hash, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
        [memory.id, memory.agent_id, memory.scope, memory.content, memory.type, memory.tier, memory.layer, memory.keywords, memory.importance, memory.access_count, memory.created_at, memory.last_accessed, memory.content_hash, memory.metadata]);
      captured++;
    }
    // 日志增强：记录存储操作统计和性能
    const storeDuration = Date.now() - storeStartTime;
    if (captured > 0) {
      this.log.info(`[algo-memory] 存储完成, 新增: ${captured}, agentId: ${AgentId}, 耗时: ${storeDuration}ms`);
    }
    } catch (err) {
      this.log.error('[algo-memory] store 操作失败:', err);
    }
  }

  private updateTier(memoryId: string): void {
    if (!this.config.tier.enabled || !this.db) return;
    const mem = this.queryOne('SELECT importance, access_count, created_at FROM memories WHERE id = ?', [memoryId]);
    if (!mem) return;
    const daysOld = (Date.now() - mem.created_at) / (1000 * 60 * 60 * 24);
    const newTier = getTier(mem.importance, mem.access_count, daysOld, this.config.tier);
    this.run('UPDATE memories SET tier = ? WHERE id = ?', [newTier, memoryId]);
  }

  async recall(AgentId: string, query: string): Promise<{ hasMemory: boolean; memories: any[] }> {
    // 数据库连接检查
    if (!this.db) {
      this.log.warn('[algo-memory] recall 失败: 数据库未初始化');
      return { hasMemory: false, memories: [] };
    }
    
    const recallStartTime = Date.now();
    if (!shouldRetrieve(query, this.config.adaptiveRetrieval)) return { hasMemory: false, memories: [] };
    // 使用缓存的配置哈希
    const cacheKey = `recall:${AgentId}:${this.configHash}:${query}`;
    if (this.cache.has(cacheKey)) {
      this.log.info(`[algo-memory] 召回完成(缓存命中), agentId: ${AgentId}, 耗时: ${Date.now() - recallStartTime}ms`);
      return this.cache.get(cacheKey)!;
    }

    let visibleAgentIds = this.getVisibleAgentIds(AgentId);
    let memories;
    if (visibleAgentIds.includes('%')) {
      // 可以看全部
      memories = this.queryAll("SELECT * FROM memories ORDER BY CASE tier WHEN 'core' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, importance DESC, access_count DESC LIMIT ?", [this.config.maxResults * 3]);
    } else {
      // 只能看指定的几个
      const placeholders = visibleAgentIds.map(() => '?').join(',');
      memories = this.queryAll(`SELECT * FROM memories WHERE agent_id IN (${placeholders}) ORDER BY CASE tier WHEN 'core' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, importance DESC, access_count DESC LIMIT ?`, [...visibleAgentIds, this.config.maxResults * 3]);
    }

    if (this.config.recencyDecay) {
      const halfLife = this.config.recencyHalfLife || 180;
      memories = memories.map(m => {
        const daysOld = (Date.now() - m.last_accessed) / (1000 * 60 * 60 * 24);
        let score = (m.tier === 'core' ? 1.5 : m.tier === 'working' ? 1.0 : 0.5) * m.importance;
        if (this.config.weibullDecay.enabled) {
          score *= weibullDecay(daysOld, this.config.weibullDecay.shape, this.config.weibullDecay.scale);
        } else {
          score *= (0.3 + 0.7 * Math.pow(0.5, daysOld / halfLife));
        }
        score *= reinforcementFactor(m.access_count, this.config.reinforcement);
        if (this.config.lengthNorm.enabled) score *= lengthNorm(m.content, this.config.lengthNorm.anchor);
        return { ...m, _score: score };
      }).sort((a, b) => b._score - a._score);
    }

    if (this.config.mmr.enabled) memories = mmrDeduplicate(memories, this.config.mmr);
    if (this.config.hardMinScore.enabled) memories = memories.filter(m => (m._score || m.importance) >= this.config.hardMinScore.threshold);

    const limited = memories.slice(0, this.config.maxResults);
    const result = { hasMemory: limited.length > 0, memories: limited };
    this.cache.set(cacheKey, result);
    const recallDuration = Date.now() - recallStartTime;
    this.log.info(`[algo-memory] 召回完成, agentId: ${AgentId}, 命中: ${limited.length}, 耗时: ${recallDuration}ms`);
    return result;
  }

  addSessionMemory(AgentId: string, content: string): void {
    if (!this.config.sessionMemory.enabled) return;
    const key = `session:${AgentId}`;
    const session = this.sessionCache.get(key) || [];
    session.unshift({ content, time: Date.now() });
    if (session.length > this.config.sessionMemory.maxSessionItems) session.pop();
    this.sessionCache.set(key, session);
  }

  getSessionMemory(AgentId: string): any[] { return this.config.sessionMemory.enabled ? (this.sessionCache.get(`session:${AgentId}`) || []) : []; }

  cleanup(): void {
    if (!this.db) return;
    const cutoff = Date.now() - this.config.cleanupDays * 24 * 60 * 60 * 1000;
    const changes = this.run('DELETE FROM memories WHERE last_accessed < ? AND layer = "general" AND tier = "peripheral"', [cutoff]);
    this.log.info('[algo-memory] 清理了', changes, '条过期记忆');
  }

  // 工具
  listMemories(AgentId: string, limit: number = 20): any[] { 
    if (!this.db) return []; 
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    if (visibleAgentIds.includes('%')) {
      return this.queryAll('SELECT * FROM memories ORDER BY tier, importance DESC, created_at DESC LIMIT ?', [limit]);
    }
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    return this.queryAll(`SELECT * FROM memories WHERE agent_id IN (${placeholders}) ORDER BY tier, importance DESC, created_at DESC LIMIT ?`, [...visibleAgentIds, limit]);
  }
  searchMemories(AgentId: string, query: string): any[] {
    if (!this.db) return [];
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    
    try {
      // 尝试使用 FTS5 全文搜索
      const ftsQuery = query.replace(/[^\w\s\u4e00-\u9fa5]/g, ' ').trim().split(/\s+/).map((w: string) => `"${w}"*`).join(' OR ');
      if (ftsQuery) {
        let results;
        if (visibleAgentIds.includes('%')) {
          results = this.queryAll(`
            SELECT m.* FROM memories m
            JOIN memories_fts fts ON m.id = fts.id
            WHERE memories_fts MATCH ?
            ORDER BY bm25(memories_fts) DESC, m.importance DESC
            LIMIT 20
          `, [ftsQuery]);
        } else {
          const placeholders = visibleAgentIds.map(() => '?').join(',');
          results = this.queryAll(`
            SELECT m.* FROM memories m
            JOIN memories_fts fts ON m.id = fts.id
            WHERE m.agent_id IN (${placeholders}) AND memories_fts MATCH ?
            ORDER BY bm25(memories_fts) DESC, m.importance DESC
            LIMIT 20
          `, [...visibleAgentIds, ftsQuery]);
        }
        if (results.length > 0) return results;
      }
    } catch (err) {
      this.log.warn('[algo-memory] FTS5 搜索失败，使用备用:', err);
    }
    // 备用：LIKE 查询
    const q = `%${query}%`;
    if (visibleAgentIds.includes('%')) {
      return this.queryAll('SELECT * FROM memories WHERE (content LIKE ? OR keywords LIKE ?) ORDER BY importance DESC LIMIT 20', [q, q]);
    }
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    return this.queryAll(`SELECT * FROM memories WHERE agent_id IN (${placeholders}) AND (content LIKE ? OR keywords LIKE ?) ORDER BY importance DESC LIMIT 20`, [...visibleAgentIds, q, q]);
  }
  getStats(AgentId: string): { total: number; core: number; working: number; peripheral: number; general: number } {
    if (!this.db) return { total: 0, core: 0, working: 0, peripheral: 0, general: 0 };
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    let total = 0, core = 0, peripheral = 0, general = 0;
    if (visibleAgentIds.includes('%')) {
      total = this.queryOne('SELECT COUNT(*) as c FROM memories')?.c || 0;
      core = this.queryOne('SELECT COUNT(*) as c FROM memories WHERE tier = ?', ['core'])?.c || 0;
      peripheral = this.queryOne('SELECT COUNT(*) as c FROM memories WHERE tier = ?', ['peripheral'])?.c || 0;
      general = this.queryOne('SELECT COUNT(*) as c FROM memories WHERE layer = ?', ['general'])?.c || 0;
    } else {
      const placeholders = visibleAgentIds.map(() => '?').join(',');
      total = this.queryOne(`SELECT COUNT(*) as c FROM memories WHERE agent_id IN (${placeholders})`, visibleAgentIds)?.c || 0;
      core = this.queryOne(`SELECT COUNT(*) as c FROM memories WHERE agent_id IN (${placeholders}) AND tier = ?`, [...visibleAgentIds, 'core'])?.c || 0;
      peripheral = this.queryOne(`SELECT COUNT(*) as c FROM memories WHERE agent_id IN (${placeholders}) AND tier = ?`, [...visibleAgentIds, 'peripheral'])?.c || 0;
      general = this.queryOne(`SELECT COUNT(*) as c FROM memories WHERE agent_id IN (${placeholders}) AND layer = ?`, [...visibleAgentIds, 'general'])?.c || 0;
    }
    return { total, core, working: total - core - peripheral, peripheral, general };
  }
  getMemory(AgentId: string, memoryId: string): any | null { if (!this.db) return null; return this.queryOne('SELECT * FROM memories WHERE id = ? AND agent_id = ?', [memoryId, AgentId]); }
  deleteMemory(AgentId: string, memoryId: string): boolean { if (!this.db) return false; const changes = this.run('DELETE FROM memories WHERE id = ? AND agent_id = ?', [memoryId, AgentId]); this.cache.delete(`recall:${AgentId}`); return changes > 0; }
  deleteBulk(AgentId: string, memoryIds: string[]): number { if (!this.db) return 0; const placeholders = memoryIds.map(() => '?').join(','); const changes = this.run(`DELETE FROM memories WHERE id IN (${placeholders}) AND agent_id = ?`, [...memoryIds, AgentId]); this.cache.delete(`recall:${AgentId}`); return changes; }
  clearMemories(AgentId: string, keepCore: boolean = true): number { if (!this.db) return 0; const changes = keepCore ? this.run('DELETE FROM memories WHERE agent_id = ? AND tier != ?', [AgentId, 'core']) : this.run('DELETE FROM memories WHERE agent_id = ?', [AgentId]); this.cache.delete(`recall:${AgentId}`); return changes; }
  updateMemory(AgentId: string, memoryId: string, content: string): boolean { 
    const safe = normalizeText(content).replace(/</g, '&lt;').replace(/>/g, '&gt;'); 
    const isCore = isCoreKeyword(safe, this.config.coreKeywords);
    const tier = getTier(isCore ? 1.0 : 0.5, 1, 0, this.config.tier);
    const changes = this.run('UPDATE memories SET content = ?, tier = ?, layer = ?, keywords = ?, importance = ?, last_accessed = ? WHERE id = ? AND agent_id = ?', [safe, tier, isCore ? 'core' : 'general', extractKeywords(safe), isCore ? 1.0 : 0.5, Date.now(), memoryId, AgentId]); 
    this.cache.delete(`recall:${AgentId}`); 
    return changes > 0; 
  }
  
  exportMemories(AgentId: string): any[] { 
    if (!this.db) return []; 
    const visibleAgentIds = this.getVisibleAgentIds(AgentId);
    if (visibleAgentIds.includes('%')) {
      return this.queryAll('SELECT * FROM memories');
    }
    const placeholders = visibleAgentIds.map(() => '?').join(',');
    return this.queryAll(`SELECT * FROM memories WHERE agent_id IN (${placeholders})`, visibleAgentIds);
  }
  importMemories(AgentId: string, memories: any[]): number {
    if (!this.db) return 0;
    let imported = 0;
    // 使用事务批量提交，提升性能
    try {
      this.db.run('BEGIN TRANSACTION');
      for (const m of memories) {
        try {
          const tier = getTier(m.importance || 0.5, m.access_count || 1, 0, this.config.tier);
          this.db.run('INSERT INTO memories (id, agent_id, scope, content, type, tier, layer, keywords, importance, access_count, created_at, last_accessed, content_hash, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
            [m.id || generateId(), AgentId, m.scope || 'global', m.content, m.type || 'other', tier, m.layer || 'general', m.keywords || '', m.importance || 0.5, m.access_count || 1, m.created_at || Date.now(), m.last_accessed || Date.now(), m.content_hash || hashContent(m.content), m.metadata || null]
          );
          imported++;
        } catch (e) {
          this.log.warn('[algo-memory] 导入单条记忆失败:', e);
        }
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      this.log.error('[algo-memory] 导入记忆事务失败:', e);
      return 0;
    }
    // 导入后清理缓存，防止缓存和数据库不一致
    if (imported > 0) {
      this.saveDatabase();
      this.cache.delete(`recall:${AgentId}`);
    }
    return imported;
  }

  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    // 清理缓存防止内存泄漏
    this.cache.clear();
    this.sessionCache.clear();
    if (this.db) {
      this.saveDatabase();
      this.db.close();
      this.db = null;
    }
    this.log.info('[algo-memory] 插件已关闭');
  }
}

// OpenClaw 插件导出（符合官方规范）
// 注意：configSchema 应只在 openclaw.plugin.json 中定义，此处不再重复
const algoMemoryPlugin = {
  id: "algo-memory",
  name: "Algo Memory",
  description: "纯算法长期记忆插件 - 支持多模型/智能去重/时间衰减",
  kind: "memory" as const,

  async register(api: any) {
    const log = api.logger || console;
    // 使用配置或默认配置，确保插件能正常工作
    const userConfig = api.pluginConfig || api.config || {};
    // 合并完整配置（包含高级配置项）
    const config = {
      autoCapture: userConfig.autoCapture !== false,
      autoRecall: userConfig.autoRecall !== false,
      maxResults: userConfig.maxResults || 5,
      cleanupDays: userConfig.cleanupDays || 180,
      language: userConfig.language || 'auto',
      coreKeywords: userConfig.coreKeywords || DEFAULT_CONFIG.coreKeywords,
      recencyDecay: userConfig.recencyDecay !== undefined ? userConfig.recencyDecay : DEFAULT_CONFIG.recencyDecay,
      recencyHalfLife: userConfig.recencyHalfLife || DEFAULT_CONFIG.recencyHalfLife,
      smartDedup: userConfig.smartDedup !== undefined ? userConfig.smartDedup : DEFAULT_CONFIG.smartDedup,
      dedupThreshold: userConfig.dedupThreshold || DEFAULT_CONFIG.dedupThreshold,
      capturePerTurn: userConfig.capturePerTurn || DEFAULT_CONFIG.capturePerTurn,
      noiseFilter: userConfig.noiseFilter || DEFAULT_CONFIG.noiseFilter,
      adaptiveRetrieval: userConfig.adaptiveRetrieval || DEFAULT_CONFIG.adaptiveRetrieval,
      sessionMemory: userConfig.sessionMemory || DEFAULT_CONFIG.sessionMemory,
      weibullDecay: userConfig.weibullDecay || DEFAULT_CONFIG.weibullDecay,
      reinforcement: userConfig.reinforcement || DEFAULT_CONFIG.reinforcement,
      mmr: userConfig.mmr || DEFAULT_CONFIG.mmr,
      lengthNorm: userConfig.lengthNorm || DEFAULT_CONFIG.lengthNorm,
      hardMinScore: userConfig.hardMinScore || DEFAULT_CONFIG.hardMinScore,
      tier: userConfig.tier || DEFAULT_CONFIG.tier,
      scopes: userConfig.scopes || DEFAULT_CONFIG.scopes,
      llm: userConfig.llm || DEFAULT_CONFIG.llm,
      threshold: userConfig.threshold || DEFAULT_CONFIG.threshold
    };
    const plugin = new MemoryPlugin(config, log);
    // 兼容不同版本的 OpenClaw API
    const stateDir = api.getStateDir?.() || api.stateDir || path.join(process.env.HOME || process.env.USERPROFILE || '/home/x', '.openclaw', 'state', 'algo-memory');
    // 使用 await 确保异步初始化完成
    await plugin.init(stateDir);
    
    log.info('[algo-memory] 插件已加载，自动捕获: ' + config.autoCapture + ', 自动召回: ' + config.autoRecall);

  // 工具定义（使用 Typebox 符合官方规范）
  const toolDefinitions = [
    {
      name: 'algo_memory_list',
      description: '列出所有记忆',
      parameters: Type.Object({
        agentId: Type.String(),
        limit: Type.Optional(Type.Number())
      })
    },
    {
      name: 'algo_memory_search',
      description: '搜索记忆',
      parameters: Type.Object({
        agentId: Type.String(),
        query: Type.String()
      })
    },
    {
      name: 'algo_memory_stats',
      description: '查看记忆统计',
      parameters: Type.Object({
        agentId: Type.String()
      })
    },
    {
      name: 'algo_memory_get',
      description: '获取单条记忆详情',
      parameters: Type.Object({
        agentId: Type.String(),
        memoryId: Type.String()
      })
    },
    {
      name: 'algo_memory_delete',
      description: '删除单条记忆',
      parameters: Type.Object({
        agentId: Type.String(),
        memoryId: Type.String()
      })
    },
    {
      name: 'algo_memory_delete_bulk',
      description: '批量删除记忆',
      parameters: Type.Object({
        agentId: Type.String(),
        memoryIds: Type.Array(Type.String())
      })
    },
    {
      name: 'algo_memory_clear',
      description: '清空记忆（可选保留核心记忆）',
      parameters: Type.Object({
        agentId: Type.String(),
        keepCore: Type.Optional(Type.Boolean())
      })
    },
    {
      name: 'algo_memory_update',
      description: '更新记忆内容',
      parameters: Type.Object({
        agentId: Type.String(),
        memoryId: Type.String(),
        content: Type.String()
      })
    },
    {
      name: 'algo_memory_export',
      description: '导出所有记忆',
      parameters: Type.Object({
        agentId: Type.String()
      })
    },
    {
      name: 'algo_memory_import',
      description: '导入记忆',
      parameters: Type.Object({
        agentId: Type.String(),
        memories: Type.Array(Type.Object({}))
      })
    },
    {
      name: 'algo_memory_session',
      description: '获取当前 Session 的临时记忆',
      parameters: Type.Object({
        agentId: Type.String()
      })
    }
  ];

  // 注册工具
  toolDefinitions.forEach(tool => {
    api.registerTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_id: string, params: any) {
        try {
          let result: any;
          switch (tool.name) {
            case 'algo_memory_list':
              result = plugin.listMemories(params.agentId, params.limit || 20);
              break;
            case 'algo_memory_search':
              result = plugin.searchMemories(params.agentId, params.query);
              break;
            case 'algo_memory_stats':
              result = plugin.getStats(params.agentId);
              break;
            case 'algo_memory_get':
              result = plugin.getMemory(params.agentId, params.memoryId);
              break;
            case 'algo_memory_delete':
              result = { success: plugin.deleteMemory(params.agentId, params.memoryId) };
              break;
            case 'algo_memory_delete_bulk':
              result = { deleted: plugin.deleteBulk(params.agentId, params.memoryIds) };
              break;
            case 'algo_memory_clear':
              result = { deleted: plugin.clearMemories(params.agentId, params.keepCore !== false) };
              break;
            case 'algo_memory_update':
              result = { success: plugin.updateMemory(params.agentId, params.memoryId, params.content) };
              break;
            case 'algo_memory_export':
              result = plugin.exportMemories(params.agentId);
              break;
            case 'algo_memory_import':
              result = { imported: plugin.importMemories(params.agentId, params.memories) };
              break;
            case 'algo_memory_session':
              result = plugin.getSessionMemory(params.agentId);
              break;
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: 'Error: ' + String(err) }], isError: true };
        }
      }
    });
  });

  // 配置已在注册时处理完成

  // 基础钩子 - 使用正确的 API
  if (typeof api.on === 'function') {
    // agent_end: 存储记忆（agent 响应结束后）
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

    // before_prompt_build: 自动召回记忆（在构建 prompt 前注入上下文）
    // 这是正确的 API，用 prependSystemContext 注入记忆
    if (config.autoRecall) {
      api.on('before_prompt_build', async (event: any, ctx: any) => {
        try {
          const agentId = event?.agentId || 'default';
          const messages = event?.messages || [];
          // 获取最后一条用户消息作为查询
          const userMessage = messages.filter((m: any) => m.role === 'user').pop();
          const query = userMessage?.content || '';
          
          if (query && shouldRetrieve(query, config.adaptiveRetrieval)) {
            const { hasMemory, memories } = await plugin.recall(agentId, query);
            if (hasMemory && memories.length > 0) {
              const memoryContext = memories.map((m: any) => `[记忆] ${m.content}`).join('\n\n');
              log.info(`[algo-memory] 已召回 ${memories.length} 条相关记忆`);
              
              // 使用 prependSystemContext 正确注入记忆到系统提示之前
              return {
                prependSystemContext: `\n\n以下是相关记忆：\n${memoryContext}\n`
              };
            }
          }
        } catch (err) {
          log.error('[algo-memory] before_prompt_build 钩子错误:', err);
        }
      }, { priority: 10 });
    }
  }

  // 注册服务生命周期
  api.registerService({
    id: "algo-memory",
    start: async () => {
      log.info('[algo-memory] 服务已启动');
    },
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
