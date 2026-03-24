/**
 * algo-memory v2.3.0 - Utility Functions
 */

import * as crypto from 'crypto';
import type { Config, NoiseFilterConfig, TierConfig, ReinforcementConfig, Memory, SessionDedupConfig } from './types.js';

/**
 * 简单关键词提取（纯规则，无需 LLM）
 * v2.5.0: 用于 topic drift 检测
 */
export function extractSimpleKeywords(text: string, maxKeywords = 10): string[] {
  // 去掉停用词
  const stopWords = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '这', '那', '有', '没有', '和', '与', '或', '不', '很', '都', '也', '就', '还', '又', '但', '而', '及', '与', '把', '被', '让', '给', '对', '于', '用', '从', '到', '去', '来', '上', '下', '里', '外', '前', '后', '中', '内', '间', '等', '各', '本', '此', '一', '一个', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'he', 'she', 'it', 'what', 'which', 'who', 'when', 'where', 'why', 'how']);
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w) && !/^\d+$/.test(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([w]) => w);
}

/**
 * 计算两组关键词的 Jaccard 重叠度
 */
export function keywordOverlap(kw1: string[], kw2: string[]): number {
  if (kw1.length === 0 || kw2.length === 0) return 0;
  const set2 = new Set(kw2);
  const intersection = kw1.filter(k => set2.has(k)).length;
  return intersection / Math.max(kw1.length, kw2.length);
}

/**
 * 检测话题是否发生漂移（v2.5.0: proactive recall 前置检测）
 * @param messages 最近 N 条消息（role=user）
 * @param driftConfig topicDrift 配置
 * @returns true = 检测到话题漂移，应触发预加载
 */
export function detectTopicDrift(
  messages: string[],
  driftConfig: { windowSize: number; driftThreshold: number }
): boolean {
  if (messages.length < driftConfig.windowSize * 2) return false;
  const half = driftConfig.windowSize;
  const recent = messages.slice(-half);
  const previous = messages.slice(-half * 2, -half);
  const kw1 = extractSimpleKeywords(recent.join(' '));
  const kw2 = extractSimpleKeywords(previous.join(' '));
  const overlap = keywordOverlap(kw1, kw2);
  // overlap 越小 = 话题变化越大
  return overlap < (1 - driftConfig.driftThreshold);
}

// ============= Constants =============
export const MAX_MESSAGE_LENGTH = 10000;
export const CACHE_MAX_SIZE = 100;
export const CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_KEYWORDS = 10;
export const MAX_SIMILAR_CHECK = 10;
export const RETRY_MAX_ATTEMPTS = 2;
export const RETRY_DELAY_MS = 1000;
export const MIN_CJK_QUERY_LENGTH = 6;
export const MIN_EN_QUERY_LENGTH = 15;

// ============= Feishu / OpenClaw Metadata Stripper =============
// OpenClaw injects a "Conversation info (untrusted metadata): {json}" block
// before every user message. Strip it so only real user text is stored.
const METADATA_PATTERN = /^Conversation info[\s\S]*?---\s*/;

export function stripInboundMetadata(raw: string): string {
  if (!raw || typeof raw !== 'string') return raw;
  return raw.replace(METADATA_PATTERN, '').trim();
}

/**
 * Extract plain text from msg.content which may be:
 * - string
 * - array: [{type, text}, ...] Feishu multi-block format
 * - object: {type, text} single block
 * Then strip Conversation info metadata.
 */
export function extractMessageText(raw: any): string {
  let str = '';
  if (Array.isArray(raw)) {
    str = raw.map(b => typeof b === 'object' && b !== null ? (b.text || '') : String(b)).join('');
  } else if (typeof raw === 'object' && raw !== null) {
    str = (raw as any).text || '';
  } else {
    str = String(raw ?? '');
  }
  return stripInboundMetadata(str);
}

// ============= ID / Hash =============
export function generateId(): string {
  return 'mem_' + crypto.randomBytes(8).toString('hex');
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ============= Text Normalization =============
export function normalizeText(text: string): string {
  let normalized = text.trim();
  normalized = normalized.replace(/@[\w]+/g, ''); // 移除所有 @mention
  normalized = normalized.replace(/\s+/g, ' ').trim();
  normalized = normalized.replace(/^(以下是|根据|按照).*?:?\s*/i, '');
  return normalized;
}

// ============= Noise Filter =============
export function isNoise(content: string, config: NoiseFilterConfig): boolean {
  if (!config.enabled) return false;
  const lower = content.toLowerCase().trim();

  // 空内容
  if (!content || lower.length === 0) return true;

  // 太短且无实义内容（纯英文少于3个字母，或无意义的短文本）
  if (lower.length <= 2 && !/[a-zA-Z]{3,}/.test(lower)) return true;

  // 纯标点/符号
  if (/^[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?\s]+$/.test(content)) return true;

  if (config.skipGreetings) {
    const greetings = ['hi', 'hello', 'hey', '你好', '您好', '嗨', '嗨你好', '你好呀', 'hiya',
      '早上好', '早安', '上午好', '中午好', '下午好', '晚安', '晚上好', '夜好',
      '初次见面', '很高兴认识', '幸会', '打扰了', '请问', '劳驾', '在吗', '在不在',
      '哈喽', '嗨喽', 'tks', 'thx', 'thanks', 'thank you'];
    if (greetings.some(g => lower === g || lower.startsWith(g + ' '))) return true;
  }

  if (config.skipCommands) {
    if (lower.startsWith('/') || lower.startsWith('!') || lower.startsWith('-')) return true;
  }

  // 确认词和常用噪音
  const confirms = [
    'ok', 'okay', '好', '好的', '收到', '了解', '明白', 'yes', 'no', '嗯', '哦', 'yep', 'sure',
    'got it', 'gotcha', 'roger', 'copy that', 'tks', 'thanks', 'thx', '👍', '😂', '哈哈哈',
    '嘿嘿', '哈哈', '哦哦', '啊啊', '这样子', '这样啊', '好吧', '行吧', '算了', '没事', '没关系',
    '不好意思', '抱歉', '稍等', '等等', '等一下', '稍等一下', '让我想想', '我想想', '等会',
    '一会儿', '算了算了', '随便', '都可以', '无所谓', '好的好的', '嗯嗯', '哦哦', '对对',
    '没错', '是的', '确实是', '可能吧', '也许吧', '大概', '差不多', '应该', '好吧好吧'
  ];

  // 精确匹配
  if (confirms.includes(lower)) return true;

  // 包含关系（处理"好的我知道了"这类）
  if (confirms.some(c => lower.includes(c) && lower.length <= c.length + 5)) return true;

  return false;
}

// ============= Content Compression =============

// 语义压缩模式 - 提取关键信息的正则表达式
const SEMANTIC_PATTERNS = {
  // 航班相关
  flight: /([A-Z]{2,}\d{3,4})|航班[号]?\s*([A-Z0-9]+)/gi,
  // 日期时间
  date: /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?)|(\d{1,2}[-/月]\d{1,2}[日]?)|(今天|明天|后天|昨天|前天)/g,
  // 时间
  time: /(\d{1,2}[时点]\d{0,2}分?)|(\d{1,2}:\d{2})/g,
  // 金额价格
  money: /(\d+(?:[万千百])?\s*元)|(?:价格|价钱|花费|费用|成本)[：:]?\s*(\d+(?:[万千百])?(?:\.\d+)?(?:元|块)?)/gi,
  // 地点
  location: /([\u4e00-\u9fff]{2,6}(?:省|市|区|县|路|街|道|机场|车站|火车站|酒店|医院|学校|商场))/g,
  // 联系方式
  contact: /(?:电话|手机|微信|邮箱|邮箱|QQ)[：:]?\s*([\w@.+-]+|\d{11})/gi,
  // 人名
  person: /(?:叫|名叫|姓名|名字)[：:]?\s*([\u4e00-\u9fff]{2,4})/g,
  // 数量
  quantity: /(\d+(?:[个条件次封张本把个])?)|([一二三四五六七八九十百千万\d]+(?:个|条|件|次|封|张|本|把|次))/g,
};

// 关键信息类型
interface SemanticInfo {
  flight?: string;
  date?: string;
  time?: string;
  money?: string;
  location?: string;
  contact?: string;
  person?: string;
}

/**
 * 提取内容中的语义关键信息
 */
export function extractSemanticInfo(content: string): SemanticInfo {
  const info: SemanticInfo = {};

  for (const [key, pattern] of Object.entries(SEMANTIC_PATTERNS)) {
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      // 去重
      const unique = [...new Set(matches)];
      (info as any)[key] = unique.slice(0, 3).join(',');
    }
  }

  return info;
}

/**
 * 语义增强压缩
 * 优先保留关键信息，然后保留核心句子
 */
export function semanticCompress(content: string, maxLength: number = 200): string {
  if (!content || content.length <= maxLength) return content;

  const semanticInfo = extractSemanticInfo(content);
  const infoParts: string[] = [];

  // 按优先级提取关键信息
  const priorityKeys = ['flight', 'date', 'money', 'person', 'location', 'contact'];
  for (const key of priorityKeys) {
    if ((semanticInfo as any)[key]) {
      infoParts.push((semanticInfo as any)[key]);
    }
  }

  // 构建压缩结果
  let result = infoParts.join(' | ');
  if (result.length > maxLength * 0.6) {
    result = result.substring(0, Math.floor(maxLength * 0.6));
  }

  // 如果还有空间，添加核心句子
  const remainingLength = maxLength - result.length - 3;
  if (remainingLength > 20) {
    // 提取第一句完整的话
    const firstSentence = content.split(/[。！？；\n]/)[0].trim();
    if (firstSentence.length > 0) {
      const truncated = firstSentence.length > remainingLength
        ? firstSentence.substring(0, remainingLength - 3) + '...'
        : firstSentence;
      result = result ? `${result} | ${truncated}` : truncated;
    }
  }

  // 去除多余空格
  result = result.replace(/\s+/g, ' ').trim();

  return result || content.substring(0, maxLength);
}

/**
 * 压缩记忆内容，提取关键信息
 * 策略：
 * 1. 去除冗余修饰词
 * 2. 提取核心句子
 * 3. 保留关键信息（数字、时间、专有名词）
 */
export function compressContent(content: string, maxLength: number = 200, semanticEnhance: boolean = false): string {
  if (!content || content.length <= maxLength) return content;

  // 如果启用语义增强，使用语义压缩
  if (semanticEnhance) {
    return semanticCompress(content, maxLength);
  }

  let compressed = content;

  // 去除多余的空白字符
  compressed = compressed.replace(/\s+/g, ' ').trim();

  // 如果还是太长，进行智能截断
  if (compressed.length > maxLength) {
    // 尝试在句号、逗号处截断
    const sentences = compressed.split(/[。！？；\n]/);
    const result: string[] = [];
    let currentLength = 0;

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      if (currentLength + trimmed.length + 1 <= maxLength) {
        result.push(trimmed);
        currentLength += trimmed.length + 1;
      } else if (result.length === 0) {
        // 第一句话就超长，直接截断
        result.push(trimmed.substring(0, maxLength - 3) + '...');
        break;
      } else {
        break;
      }
    }

    compressed = result.join('。');
    if (compressed.length > maxLength) {
      compressed = compressed.substring(0, maxLength - 3) + '...';
    }
  }

  return compressed;
}

/**
 * 提取内容的关键词摘要
 */
export function extractContentSummary(content: string, maxKeywords: number = 5): string {
  // 提取中文词
  const chineseWords = content.match(/[\u4e00-\u9fff]{2,}/g) || [];
  // 提取英文词
  const englishWords = content.match(/[a-zA-Z]{3,}/g) || [];
  // 提取数字
  const numbers = content.match(/\d+/g) || [];

  // 合并并去重
  const allWords = [...new Set([...chineseWords, ...englishWords, ...numbers.map(n => '#' + n)])];

  // 按长度排序，优先保留有意义的词
  const significant = allWords
    .filter(w => w.length >= 2)
    .sort((a, b) => {
      // 数字优先
      if (a.startsWith('#') && !b.startsWith('#')) return -1;
      if (!a.startsWith('#') && b.startsWith('#')) return 1;
      // 长度优先
      return b.length - a.length;
    })
    .slice(0, maxKeywords);

  return significant.join(', ');
}

// ============= Keyword Extraction =============
export function extractKeywords(content: string): string {
  // CJK 单字分词（与 jaccardSimilarity 保持一致），英文/数字按词
  const words = content.toLowerCase().match(/[\u4e00-\u9fa5]|[a-z0-9]+/gi) || [];
  return [...new Set(words)].slice(0, MAX_KEYWORDS).join(',');
}

export function isCoreKeyword(content: string, keywords: string[]): boolean {
  return keywords.some(k => content.toLowerCase().includes(k.toLowerCase()));
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

export function detectLanguage(text: string): string {
  if (!text) return 'en';
  const patterns: Record<string, RegExp> = {
    zh: /[\u4e00-\u9fa5]/g,
    ja: /[\u3040-\u309f\u30a0-\u30ff]/g,
    ko: /[\uac00-\ud7af]/g
  };
  let maxLang = 'en', maxCount = 0;
  for (const [lang, pattern] of Object.entries(patterns)) {
    const count = (text.match(pattern) || []).length;
    if (count > maxCount) { maxCount = count; maxLang = lang; }
  }
  return maxLang;
}
/**
 * Rough token estimator — no API call needed.
 * CJK characters: ~1 token each.
 * ASCII/Latin words: ~4 chars per token.
 * This is conservative (slightly over-estimates) to avoid under-counting.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjk = text.length - cjkChars;
  return cjkChars + Math.ceil(nonCjk / 4);
}

// NOTE: detectLanguage is defined for future language-aware keyword selection.
// Planned integration: use detected language to pick from CORE_KEYWORDS_MAP / RETRIEVE_KEYWORDS_MAP
// so e.g. a Chinese query uses zh forceKeywords and an English query uses en forceKeywords.

export function getCoreKeywords(language: string, customKeywords?: string[]): string[] {
  if (customKeywords && customKeywords.length > 0) return customKeywords;
  if (language === 'auto') return CORE_KEYWORDS_MAP.zh.concat(CORE_KEYWORDS_MAP.en);
  return CORE_KEYWORDS_MAP[language] || CORE_KEYWORDS_MAP.en;
}

export function getRetrieveKeywords(language: string): string[] {
  if (language === 'auto') return RETRIEVE_KEYWORDS_MAP.zh.concat(RETRIEVE_KEYWORDS_MAP.en);
  return RETRIEVE_KEYWORDS_MAP[language] || RETRIEVE_KEYWORDS_MAP.en;
}

// ============= Retrieval Decision =============
const META_PATTERNS = [
  // English meta-questions
  /^(do you|can you|could you|would you)\s+(remember|know|recall)/i,
  /^(what|how)\s+do\s+(i|you)/i,
  // Chinese meta-questions
  /^你还记得|^你知道吗|^你能记住|^记得.*吗/i,
  /^什么是|^什么叫|^如何/i,
  // "what is X" short queries
  /^(what|who|which)\s+\w+\??$/i,
  /^(什么|谁|哪个|怎样)\??$/i,
];

const EMOJI_ONLY = /^[\s😊👍❤️😂😎😢😡🎉🔥✨💡⭐✅❌🤔🙏🎵🎮🎬📸💻📱🌟😴🚀💼😁🥰😇🤝]+$/;
const SKIP_COMMANDS = /^(hey|hi|hello|嗨|你好|您好)$/i;

export function shouldRetrieve(
  query: string,
  config: Config['adaptiveRetrieval'],
  sessionDedup?: { lastQuery: string; lastRecallTime: number }
): boolean {
  if (!config.enabled) return true;
  if (!query || query.trim().length < 1) return false;

  const trimmed = query.trim();
  const lowerQuery = trimmed.toLowerCase();

  // Skip pure emoji messages
  if (EMOJI_ONLY.test(trimmed)) return false;

  // Skip bare greetings / commands
  if (SKIP_COMMANDS.test(trimmed)) return false;

  // Skip short "what/who/which X" without detail (likely just asking for definition)
  if (/^(what|who|which)\s+\w{1,8}\??$/i.test(trimmed) && trimmed.length < 15) return false;
  if (/^(什么|谁|哪个)\??$/.test(trimmed)) return false;

  // Force keywords always trigger retrieval — check BEFORE META_PATTERNS
  // so that "记得...吗" / "remember..." etc. are never filtered out.
  const langKeywords = getRetrieveKeywords(detectLanguage(trimmed));
  const allForceKeywords = [...(config.forceKeywords || []), ...langKeywords];
  if (allForceKeywords.some((k: string) => lowerQuery.includes(k))) return true;

  // Skip meta-questions (反问句 / interrogative about memory itself)
  if (META_PATTERNS.some(p => p.test(trimmed))) return false;

  // Length gate
  const isCJK = /[\u4e00-\u9fa5]/.test(trimmed);
  const minLen = isCJK ? MIN_CJK_QUERY_LENGTH : MIN_EN_QUERY_LENGTH;
  if (trimmed.length < minLen) return false;

  // Session deduplication: skip if query is too similar to recent recall within window
  if (sessionDedup && config.sessionDedup?.enabled) {
    const { lastQuery, lastRecallTime } = sessionDedup;
    const { windowMs, similarityThreshold } = config.sessionDedup;
    if (lastQuery && Date.now() - lastRecallTime < windowMs) {
      const sim = jaccardSimilarity(query, lastQuery);
      if (sim >= similarityThreshold) return false;
    }
  }

  return true;
}

// ============= Similarity =============
export function jaccardSimilarity(text1: string, text2: string): number {
  // CJK 单字为词，英文/数字按词分
  const words1 = new Set(text1.toLowerCase().match(/[\u4e00-\u9fa5]|[a-z0-9]+/gi) || []);
  const words2 = new Set(text2.toLowerCase().match(/[\u4e00-\u9fa5]|[a-z0-9]+/gi) || []);
  if (words1.size === 0 || words2.size === 0) return 0;
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  return intersection.size / union.size;
}

// ============= Scoring Functions =============
/**
 * Weibull decay: f(t) = exp(-(t/scale)^shape)
 *
 * shape < 1:  "早期快" — 前期衰减迅速，后期趋于平稳（类似指数衰减）
 * shape = 1:  纯指数衰减
 * shape > 1:  "后期快" — 前期保护（记忆巩固期），后期加速遗忘
 *
 * 默认 shape=1.5 > 1，所以：
 *   0-30天  衰减很少（0.94+），保护新记忆
 *   30-60天 衰减加快（0.94 → 0.71）
 *   90天+   快速遗忘（0.37 → 0.06），实现"越久越容易忘"
 *
 * 这与 tier 分层配合：core 层访问≥10次进入永久保留；peripheral 按此曲线自然消亡。
 */
export function weibullDecay(daysOld: number, shape: number, scale: number): number {
  return Math.exp(-Math.pow(Math.max(0, daysOld) / scale, shape));
}

export function lengthNorm(content: string, anchor: number): number {
  const len = content.length;
  if (len <= anchor) return 1.0;
  return anchor / len;
}

export function reinforcementFactor(accessCount: number, config: ReinforcementConfig): number {
  if (!config.enabled || accessCount <= 1) return 1.0;
  return Math.min(config.maxMultiplier, 1.0 + (accessCount - 1) * config.factor);
}

export function mmrDeduplicate(items: Memory[], config: Config['mmr']): Memory[] {
  if (!config.enabled || items.length <= 1) return items;
  const { threshold, lambda = 0.7 } = config;

  // Pre-compute word sets for all items (avoid repeated tokenization in the loop)
  const wordSets: Map<string, Set<string>> = new Map();
  const getWords = (content: string): Set<string> => {
    if (!wordSets.has(content)) {
      wordSets.set(content, new Set(content.toLowerCase().match(/[\u4e00-\u9fa5]|[a-z0-9]+/gi) || []));
    }
    return wordSets.get(content)!;
  };

  const selected: Memory[] = [];
  const candidates: Memory[] = items.map(m => ({ ...m }));

  while (candidates.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i];
      const relevance = item._score ?? item.importance;

      // Diversity: max similarity to any already-selected item
      let maxSim = 0;
      for (const sel of selected) {
        const sim = jaccardSimilarity(item.content, sel.content);
        if (sim > maxSim) maxSim = sim;
      }

      // MMR formula: λ * relevance - (1 - λ) * diversity
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    const picked = candidates.splice(bestIdx, 1)[0];
    selected.push(picked);

    // Early exit: track the maximum relevance of all remaining candidates.
    // If even the best remaining item can't reach threshold, stop selecting.
    let maxRemainingRelevance = -Infinity;
    for (const c of candidates) {
      const rel = c._score ?? c.importance;
      if (rel > maxRemainingRelevance) maxRemainingRelevance = rel;
    }
    if (candidates.length > 0 && lambda * maxRemainingRelevance < threshold) break;
  }

  return selected;
}

export function getTier(importance: number, accessCount: number, daysOld: number, config: TierConfig): 'core' | 'working' | 'peripheral' {
  if (!config.enabled) return importance >= 1.0 ? 'core' : 'working';
  const compositeScore = importance * (1 + Math.log10(accessCount + 1));
  if (accessCount >= config.coreThreshold || (compositeScore >= 0.7 && daysOld <= config.ageDays)) return 'core';
  if (compositeScore < config.peripheralThreshold || daysOld > config.ageDays) return 'peripheral';
  return 'working';
}

/**
 * 计算复合评分（用于 tier 决策，v2.5.0 支持 pending/decay）
 */
export function compositeScore(importance: number, accessCount: number): number {
  return importance * (1 + Math.log10(accessCount + 1));
}

/**
 * 判断 pending tier 是否应该升级（被 recall → 升 working）
 * v2.5.0: post-capture classification
 */
export function shouldUpgradePending(
  memory: { tier: string; cited_count: number; access_count: number },
  recallBoost = 0
): boolean {
  if (memory.tier !== 'pending') return false;
  // 被 recall 一次就升 working（说明有价值）
  return recallBoost > 0 || memory.cited_count > 0 || memory.access_count > 1;
}

/**
 * 计算 tier confidence 衰减
 * v2.5.0: smarter tier decay
 * @param currentConfidence 当前 confidence
 * @param staleDays 无 citation 的天数
 * @param config tier.decay 配置
 * @returns 新 confidence
 */
export function decayTierConfidence(
  currentConfidence: number,
  staleDays: number,
  config: { coreStaleDays: number; decayPerStep: number }
): number {
  if (staleDays <= 0) return currentConfidence;
  const steps = Math.floor(staleDays / config.coreStaleDays);
  return Math.max(0, currentConfidence - steps * config.decayPerStep);
}

/**
 * 判断是否应该降级（confidence 低于阈值）
 */
export function shouldDemote(confidence: number, config: { demoteThreshold: number }): boolean {
  return confidence < config.demoteThreshold;
}

// ============= Sleep =============
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
