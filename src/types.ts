/**
 * algo-memory v2.2.3 - Types & Default Config
 */

// ============= Config Interface =============
export interface Config {
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
  sessionSummary: SessionSummaryConfig;
  feedback: FeedbackConfig;
  mcp: MCPConfig;
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

export interface NoiseFilterConfig {
  enabled: boolean;
  skipGreetings: boolean;
  skipCommands: boolean;
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

export interface SessionSummaryConfig {
  enabled: boolean;
  /** Markdown 摘要写入目录，默认为 <stateDir>/memory */
  dir: string;
  /** 摘要文件最大条数（超出截断旧条目） */
  maxItems: number;
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
  urgency: number;       // starts at 1.0 (urgencyDecay feature was removed, field kept for DB compatibility)
  created_at: number;
  last_accessed: number;
  content_hash: string;
  metadata: string;
  // Computed score used during recall ranking
  _score: number;
}

// ============= Default Config =============
export const DEFAULT_CONFIG: Config = {
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
  adaptiveRetrieval: {
    enabled: true,
    minQueryLength: 2,
    forceKeywords: ['记住', '之前', '上次', '记得', 'remember', 'before', 'last', '前', '上次', 'what', 'why', 'how', '什么', '为什么', '怎么'],
    sessionDedup: { enabled: true, windowMs: 30_000, similarityThreshold: 0.6 }
  },
  weibullDecay: { enabled: true, shape: 1.5, scale: 90 },
  reinforcement: { enabled: true, factor: 0.5, maxMultiplier: 3 },
  mmr: { enabled: true, threshold: 0.85, lambda: 0.7 },
  lengthNorm: { enabled: true, anchor: 500 },
  hardMinScore: { enabled: true, threshold: 0.35 },
  tier: { enabled: true, coreThreshold: 10, peripheralThreshold: 0.15, ageDays: 60, weights: { core: 1.5, working: 1.0, peripheral: 0.5 } },
  scopes: { enabled: true, defaultScope: 'agent', visibleAgents: [] },
  capturePerTurn: 3,
  llm: { enabled: false, provider: 'auto', apiKey: '', model: '', baseURL: '' },
  threshold: { useLlmForCore: false, useLlmForExtract: false, useLlmForDedup: false, minConfidence: 0.8, lengthForCore: 100, lengthForExtract: 200, dedupUncertaintyMin: 0.5, dedupUncertaintyMax: 0.98 },
  sessionSummary: { enabled: true, dir: 'memory', maxItems: 50 },
  feedback: { enabled: true, maxMemories: 5, matchThreshold: 0.6 },
  mcp: { enabled: false, transport: 'stdio', port: 8181 },
};
