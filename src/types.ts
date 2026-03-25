/**
 * algo-memory v2.3.0 - Types & Default Config
 */

// ============= Config Interface =============
export interface Config {
  autoCapture: boolean;
  autoRecall: boolean;
  /**
   * v3.1.0 新增：OpenClaw 兼容性模式
   *
   * OpenClaw built-in memory 系统（memoryFlush / memory-core / memory-lancedb）与 algo-memory
   * 在存储和召回层面存在功能重叠。开启后 algo-memory 会自动检测 OpenClaw 配置，
   * 避免两套系统重复存储 / 重复注入 / 重复上下文。
   *
   * 可选值：
   * - `auto`（默认）：自动检测 OpenClaw built-in memory 是否启用
   *   · memoryFlush 或 memory-lancedb 启用 → `retrieval-only` 模式
   *   · 两者都未启用 → `standalone` 模式
   * - `standalone`：algo-memory 完全独立运行，不考虑 OpenClaw built-in memory
   *   （等于 v3.0.0 及之前的行为）
   * - `retrieval-only`：关闭 auto-capture hooks（避免与 memoryFlush 重复存储），
   *   仅通过 ContextEngine 的 assemble() 提供 FTS5 检索增强，
   *   存储完全交给 OpenClaw built-in memory
   *
   * 模式切换时的影响：
   * - `standalone` → `retrieval-only`：关闭 before_prompt_build + agent_end 的 store hooks
   * - `retrieval-only` → `standalone`：恢复完整的 store hooks
   */
  openClawMemoryMode: 'auto' | 'standalone' | 'retrieval-only';

  /**
   * v3.1.0 新增：同步到 workspace Markdown
   *
   * 启用后，algo-memory 在每次 store() 时同步将重要记忆写入 workspace 目录：
   * - `memory/YYYY-MM-DD.md` — 每日日志（append-only）
   * - `MEMORY.md` — 核心长期记忆（core tier 写入此文件）
   *
   * 这样 OpenClaw 的 `memory_search` / `memory_get` 工具可以直接搜索到 algo-memory 的记忆，
   * 两套系统共用同一份 Markdown 数据，真正实现互通。
   *
   * 注意：需要 gateway 对 workspace 有写入权限（`workspaceAccess: "rw"`）。
   */
  syncToWorkspace: boolean;

  maxResults: number;
  maxInjectTokens: number;
  cleanupDays: number;
  metricsEnabled: boolean; // enable llm_output hook to record LLM usage stats
 // how many days of session snapshots to keep
  language: string;
  coreKeywords: string[];
  recencyDecay: boolean;
  recencyHalfLife: number;
  smartDedup: boolean;
  dedupThreshold: number;
  noiseFilter: NoiseFilterConfig;
  adaptiveRetrieval: AdaptiveRetrievalConfig;
  weibullDecay: WeibullDecayConfig;
  reinforcement: ReinforcementConfig;
  mmr: MMRConfig;
  lengthNorm: LengthNormConfig;
  hardMinScore: HardMinScoreConfig;
  tier: TierConfig;
  scopes: ScopesConfig;
  capturePerTurn: number;
  llm: LLMConfig;
  threshold: ThresholdConfig;
  feedback: FeedbackConfig;
  mcp: MCPConfig;
  /** 批量写入配置 */
  batchWrite: BatchWriteConfig;
  /** 记忆压缩配置 */
  compression: CompressionConfig;
}

export interface FeedbackConfig {
  /** 是否启用自然语言修正功能 */
  enabled: boolean;
  /** 修正时召回的记忆数量上限 */
  maxMemories: number;
  /** LLM 判断匹配度阈值，超过才视为相关 */
  matchThreshold: number;
}

export interface MCPConfig {
  /** 是否启用 MCP 工具暴露 */
  enabled: boolean;
  /** MCP 传输方式：stdio | http */
  transport: 'stdio' | 'http';
  /** HTTP 模式下监听端口（仅 transport=http 时有效） */
  port: number;
}


export interface BatchWriteConfig {
  /** 是否启用批量写入 */
  enabled: boolean;
  /** 批量写入的缓冲时间（毫秒），多少时间内累积的消息一起写入 */
  bufferMs: number;
  /** 单次批量写入的最大条数 */
  maxBatchSize: number;
}

export interface CompressionConfig {
  /** 是否启用记忆压缩 */
  enabled: boolean;
  /** 压缩后内容的最大字符数 */
  maxLength: number;
  /** 是否提取关键词作为摘要补充 */
  extractKeywords: boolean;
  /** 最小长度阈值：超过此长度才压缩（避免短内容被过度压缩） */
  minLengthForCompression: number;
  /** 是否跳过元数据类内容的压缩（直接存储原文） */
  skipMetadataCompression: boolean;
}

export interface SessionSnapshot {
  id: string;
  agent_id: string;
  session_key: string;
  ended_at: number;
  summary: string;
  context_snapshot: string;
  message_count: number;
  total_tokens: number;
  created_at: number;
}

export interface NoiseFilterConfig {
  enabled: boolean;
  skipGreetings: boolean;
  skipCommands: boolean;
  /** 正则表达式数组，符合任一模式的内容直接跳过（早于 importance 评分） */
  skipPatterns: string[];
  /** 是否跳过系统/元数据来源的消息 */
  skipSystemSource: boolean;
}

export interface AdaptiveRetrievalConfig {
  enabled: boolean;
  minQueryLength: number;
  forceKeywords: string[];
  sessionDedup: SessionDedupConfig;
}

export interface SessionDedupConfig {
  enabled: boolean;
  /** 毫秒内相同/相似查询不再重复召回 */
  windowMs: number;
  /** Jaccard 相似度超过此值视为"同一查询" */
  similarityThreshold: number;
}

export interface WeibullDecayConfig {
  enabled: boolean;
  shape: number;
  scale: number;
}

export interface ReinforcementConfig {
  enabled: boolean;
  factor: number;
  maxMultiplier: number;
}

export interface MMRConfig {
  enabled: boolean;
  threshold: number;   // 相似度阈值，超过则排除（0-1）
  lambda: number;       // MMR公式中相关性权重（0-1），1=只看相关，0=只看多样
}

export interface LengthNormConfig {
  enabled: boolean;
  anchor: number;
}

export interface HardMinScoreConfig {
  enabled: boolean;
  threshold: number;
}


export interface TierConfig {
  enabled: boolean;
  coreThreshold: number;
  peripheralThreshold: number;
  ageDays: number;
  weights: {
    core: number;      // recall score multiplier for core memories
    working: number;   // recall score multiplier for working memories
    peripheral: number; // recall score multiplier for peripheral memories
  };
}

export interface ScopesConfig {
  enabled: boolean;
  defaultScope: string;
  visibleAgents: string[];
}

export interface LLMConfig {
  enabled: boolean;
  provider: string;
  apiKey: string;
  model: string;
  baseURL: string;
  batchWindowMs?: number;
}

export interface ThresholdConfig {
  useLlmForCore: boolean;
  useLlmForExtract: boolean;
  useLlmForDedup: boolean;
  minConfidence: number;
  lengthForCore: number;
  lengthForExtract: number;
  dedupUncertaintyMin: number;
  dedupUncertaintyMax: number;
}

// ============= Memory Type =============
export interface Memory {
  id: string;
  agent_id: string;
  scope: string;
  content: string;
  type: string;
  tier: 'core' | 'working' | 'peripheral';
  layer: string;
  keywords: string;
  importance: number;
  access_count: number;
  cited_count: number;
  tier_confidence: number;  // 0-1，tier 置信度（v2.5.0）
  last_tier_update: number; // 上次 tier 变更时间戳（v2.5.0）
  created_at: number;
  last_accessed: number;
  content_hash: string;
  metadata: string;
  // Computed score used during recall ranking
  _score: number;
}

// ============= Default Config =============
// ============= 配置默认值常量（统一管理）=============
export const DEFAULT_VALUES = {
  // LLM
  LLM_BATCH_WINDOW_MS: 200,
  LLM_TIMEOUT_MS: 5000,
  LLM_CACHE_TTL_MS: 5 * 60 * 1000,
  LLM_CACHE_MAX_SIZE: 1000,
  
  // 阈值
  THRESHOLD_LENGTH_FOR_CORE: 100,
  THRESHOLD_LENGTH_FOR_EXTRACT: 200,
  
  // 压缩
  COMPRESSION_MAX_LENGTH: 200,
  COMPRESSION_MIN_LENGTH: 300,
  
  // 批量写入
  BATCH_BUFFER_MS: 500,
  BATCH_MAX_SIZE: 20,
  
  // 缓存
  CACHE_MAX_SIZE: 1000,
} as const;

export const DEFAULT_CONFIG: Config = {
  autoCapture: true,
  autoRecall: true,
  openClawMemoryMode: 'auto',
  syncToWorkspace: false,
  maxResults: 5,
  maxInjectTokens: 1500,
  cleanupDays: 180,
  metricsEnabled: true,  // enable llm_output hook to record LLM usage stats

  language: 'auto',
  coreKeywords: ['记住', '牢记', '重要', '不要忘记', '记住它', 'remember', 'important', 'never forget'],
  recencyDecay: true,
  recencyHalfLife: 180,
  smartDedup: true,
  dedupThreshold: 0.85,
  noiseFilter: {
    enabled: true,
    skipGreetings: true,
    skipCommands: true,
    skipPatterns: [
      '^Conversation info',
      '^```json',
      '^```json\\{',
      '^{.*"message_id"',
      '^{.*"sender_id"'
    ],
    skipSystemSource: true
  },
  adaptiveRetrieval: {
    enabled: true,
    minQueryLength: 2,
    forceKeywords: ['记住', '之前', '上次', '记得', 'remember', 'before', 'last', '前', '上次', 'what', 'why', 'how', '什么', '为什么', '怎么'],
    sessionDedup: { enabled: true, windowMs: 30_000, similarityThreshold: 0.75 },
  },
  weibullDecay: { enabled: true, shape: 1.5, scale: 90 },
  reinforcement: { enabled: true, factor: 0.5, maxMultiplier: 3 },
  mmr: { enabled: true, threshold: 0.85, lambda: 0.7 },
  lengthNorm: { enabled: true, anchor: 500 },
  hardMinScore: { enabled: true, threshold: 0.35 },
  tier: {
    enabled: true,
    coreThreshold: 10,
    peripheralThreshold: 0.15,
    ageDays: 60,
    weights: { core: 1.5, working: 1.0, peripheral: 0.5 }
  },
  scopes: { enabled: true, defaultScope: 'agent', visibleAgents: [] },
  capturePerTurn: 3,
  llm: { enabled: false, provider: 'auto', apiKey: '', model: '', baseURL: '', batchWindowMs: 200 },
  threshold: { useLlmForCore: false, useLlmForExtract: false, useLlmForDedup: false, minConfidence: 0.8, lengthForCore: 100, lengthForExtract: 200, dedupUncertaintyMin: 0.5, dedupUncertaintyMax: 0.98 },
  feedback: { enabled: true, maxMemories: 5, matchThreshold: 0.6 },
  mcp: { enabled: false, transport: 'stdio', port: 8181 },
  batchWrite: { enabled: true, bufferMs: 500, maxBatchSize: 20 },
  compression: { enabled: true, maxLength: 200, extractKeywords: true, minLengthForCompression: 300, skipMetadataCompression: true },
};
