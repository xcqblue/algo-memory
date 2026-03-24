/**
 * algo-memory v2.3.0 - Utility Functions
 */

import * as crypto from 'crypto';
import type { Config, NoiseFilterConfig, TierConfig, ReinforcementConfig, Memory, SessionDedupConfig } from './types.js';

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

/**
 * 压缩记忆内容，提取关键信息
 * 策略：
 * 1. 去除冗余修饰词
 * 2. 提取核心句子
 * 3. 保留关键信息（数字、时间、专有名词）
 */
export function compressContent(content: string, maxLength: number = 200): string {
  if (!content || content.length <= maxLength) return content;

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

// ============= Sleep =============
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============= Synonym Expansion for FTS5 Query =============
// 离线同义词扩展，提升 FTS5 的语义泛化能力

/**
 * 中文同义词表（可根据需求扩充）
 * key = 标准词，value = 同义词列表
 */
const SYNONYMS: Record<string, string[]> = {
  // 人物关系
  '老婆': ['媳妇', '妻子', '爱人'],
  '老公': ['丈夫', '老公'],
  '孩子': ['儿子', '女儿', '娃'],
  // 地点
  '北京': ['帝都', '京城'],
  '上海': ['沪', '魔都'],
  // 动作/状态
  '住': ['居住', '定居', '住在'],
  '吃': ['吃东西', '用餐', '吃饭', '进食'],
  '喝': ['喝水', '喝茶', '喝咖啡'],
  '工作': ['上班', '干活', '办公'],
  '出差': ['商务出行'],
  '讨厌': ['不喜欢', '厌恶', '抵触', '拒绝', '不想'],
  '喜欢': ['爱', '偏爱', '喜好'],
  // 职业
  '老板': ['上司', '领导'],
  // 数字/时间
  '生日': ['出生日期', '哪天生日'],
  // 手机/电脑/设备
  '手机': ['iPhone', '安卓', '智能手机'],
  '电脑': ['计算机', '笔记本', 'Mac'],
  'Mac': ['苹果电脑', 'Apple'],
  'iPhone': ['苹果手机', '苹果', '手机'],
  // 设备状态
  '坏': ['碎', '裂', '爆', '损坏', '故障', '坏了'],
  '碎': ['坏', '裂', '爆', '损坏'],
  '崩': ['死机', '蓝屏', '黑屏', '崩溃', '宕机'],
  '死机': ['崩', '蓝屏', '黑屏', '宕机', '卡死'],
  '蓝屏': ['死机', '宕机', '崩'],
  '没电': ['充电', '电量', '电池'],
  // 项目/代码
  '项目': ['proj', 'project'],
  '代码': ['code', '源码', '程序'],
  // 常用表达
  '记住': ['记得', '别忘', '重要'],
  // 时间
  '今天': ['本日', '今日', '近日'],
  '明天': ['次日', '明日'],
  '昨天': ['昨日', '前一天'],
  // 餐饮
  '午饭': ['午餐', '中饭', '中餐'],
  '早餐': ['早饭', '早点'],
  '晚餐': ['晚饭', '晚膳'],
  '宵夜': ['夜宵', '夜宵'],
  // 食物
  '辣': ['麻辣', '川菜', '火锅', '麻辣烫'],
};

/**
 * 中文停用词列表（FTS5 查询时不单独检索这些）
 */
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '你', '他', '她', '它', '们',
  '这', '那', '有', '和', '与', '或', '不', '很', '都', '也',
  '就', '还', '又', '但', '而', '及', '把', '被', '让', '给',
  '对', '于', '用', '从', '到', '去', '来', '上', '下', '里',
  '外', '前', '后', '中', '内', '间', '等', '各', '本', '此',
  '一', '一个', 'the', 'a', 'an', 'is', 'are', 'was', 'were',
]);

/**
 * 判断是否为中文句子（包含中文字符）
 */
export function isChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/**
 * 从纯中文文本中提取能在 SYNONYMS 表中找到的子词
 * 用于解决"屏幕碎了"这类连续中文无法切分的核心问题
 * 方法：检查 2-gram/3-gram 子串是否命中 SYNONYMS 表的任意词
 */
function extractSynonymTokensFromChinese(text: string): string[] {
  const found: string[] = [];
  const upper = text.toUpperCase();

  // 检查整个词或子串是否命中 SYNONYMS
  for (const [key, vals] of Object.entries(SYNONYMS)) {
    const all = [key, ...vals];
    // 检查 text 中是否包含 key（子串匹配）
    if (upper.includes(key.toUpperCase())) {
      if (!found.includes(key)) found.push(key);
      for (const v of vals) {
        if (!STOP_WORDS.has(v) && v.length > 1 && !found.includes(v)) found.push(v);
      }
    }
    // 检查 text 的子串是否与 SYNONYMS 的 value 有包含关系
    for (const v of all) {
      if (v.length < 2) continue;
      // v 是否在 text 中（子串）
      if (upper.includes(v.toUpperCase())) {
        if (!found.includes(v)) found.push(v);
      }
    }
  }

  return found; // 去重，由调用方保证唯一性
}

/**
 * 智能中英分词（脚本感知切分）
 * - 英文/数字段：保留原样（iPhone, Mac, 123）
 * - 中文段：提取 SYNONYMS 子词（解决"屏幕碎了"整词无切分问题）
 * - 合并连续英文字母和数字
 */
export function simpleChineseTokenize(text: string): string[] {
  // 第一步：按脚本类型切分（Latin vs CJK）
  const segments: { text: string; lang: 'latin' | 'cjk' }[] = [];
  let current = '';
  let currentScript: 'latin' | 'cjk' | null = null;

  for (const char of text) {
    const isLatin = /[a-zA-Z0-9]/.test(char);
    const isPunct = /[^\p{L}\p{N}\s]/u.test(char);
    if (isPunct) {
      if (current) { segments.push({ text: current, lang: currentScript! }); current = ''; currentScript = null; }
      continue;
    }
    const script: 'latin' | 'cjk' = isLatin ? 'latin' : 'cjk';
    if (currentScript === null) {
      current = char; currentScript = script;
    } else if (script === currentScript) {
      current += char;
    } else {
      segments.push({ text: current, lang: currentScript });
      current = char; currentScript = script;
    }
  }
  if (current) segments.push({ text: current, lang: currentScript! });

  const tokens = new Set<string>();
  for (const seg of segments) {
    if (STOP_WORDS.has(seg.text.toLowerCase())) continue;
    if (seg.lang === 'latin') {
      // 合并连续英文/数字
      const cleaned = seg.text.toLowerCase().replace(/\s+/g, '');
      if (cleaned.length > 1) tokens.add(cleaned);
    } else {
      // 纯中文：提取 SYNONYMS 子词
      const subs = extractSynonymTokensFromChinese(seg.text);
      if (subs.length > 0) {
        subs.forEach(s => tokens.add(s));
      } else if (seg.text.length > 1 && !STOP_WORDS.has(seg.text)) {
        tokens.add(seg.text);
      }
    }
  }

  return [...tokens];
}

/**
 * FTS5 OR 扩展查询构建
 * 输入: "我想去北京出差"
 * 输出: "我 OR 想去 OR 北京 OR 帝都 OR 出差 OR 商务出行"
 */
export function buildFts5ExpandedQuery(query: string): string {
  const tokens = simpleChineseTokenize(query);
  if (tokens.length === 0) return query;

  const seen = new Set<string>();
  const allTokens: string[] = [];

  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      allTokens.push(token);
    }
    // 查同义词
    for (const [key, syns] of Object.entries(SYNONYMS)) {
      if (key === token || syns.includes(token)) {
        for (const syn of [key, ...syns]) {
          if (!seen.has(syn)) {
            seen.add(syn);
            allTokens.push(syn);
          }
        }
        break;
      }
    }
  }

  if (allTokens.length === 0) return query;
  if (allTokens.length === 1) return allTokens[0];

  // 构建 OR 查询
  return allTokens.map(t => `"${t}"`).join(' OR ');
}

/**
 * 多路召回 Query 列表生成
 * 输入: "我想去北京出差"
 * 输出: ["我想去北京出差", "北京出差", "想去北京", "帝都商务出行"]
 */
export function generateMultiPathQueries(query: string, maxPaths = 4): string[] {
  const tokens = simpleChineseTokenize(query);
  if (tokens.length === 0) return [query];

  const queries: string[] = [query]; // 原始 query 优先

  if (tokens.length >= 2) {
    // 路径1：取前3个token（去掉尾部不重要的词）
    const prefix = tokens.slice(0, Math.min(3, tokens.length)).join(' ');
    if (prefix !== query) queries.push(prefix);

    // 路径2：最后2个token（通常包含核心词）
    const suffix = tokens.slice(-2).join(' ');
    if (suffix !== query && suffix !== prefix) queries.push(suffix);
  }

  if (tokens.length >= 3) {
    // 路径3：只取首尾token（去除中间填充词）
    const headTail = `${tokens[0]} ${tokens[tokens.length - 1]}`;
    if (headTail !== query) queries.push(headTail);
  }

  return queries.slice(0, maxPaths);
}

/**
 * BM25+ 评分增强
 * 在 SQLite BM25 基础上加 δ=1.0，避免短文本评分过低
 * 只对 score > 0 的结果加偏移，等效于 BM25+ 的下界保护
 */
export function bm25PlusBoost(score: number, delta = 1.0): number {
  if (score <= 0) return score;
  return score + delta;
}
