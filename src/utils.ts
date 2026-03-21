/**
 * algo-memory v2.2.3 - Utility Functions
 */

import * as crypto from 'crypto';
import type { Config, NoiseFilterConfig, TierConfig, ReinforcementConfig, Memory, SessionDedupConfig, LexicalOverlapConfig } from './types.js';

// ============= Constants =============
export const MAX_MESSAGE_LENGTH = 10000;
export const CACHE_MAX_SIZE = 100;
export const CACHE_TTL_MS = 5 * 60 * 1000;
export const SESSION_CACHE_MAX_SIZE = 50;
export const SESSION_CACHE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_KEYWORDS = 10;
export const MAX_SIMILAR_CHECK = 10;
export const RETRY_MAX_ATTEMPTS = 2;
export const RETRY_DELAY_MS = 1000;
export const MIN_CJK_QUERY_LENGTH = 6;
export const MIN_EN_QUERY_LENGTH = 15;

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
  normalized = normalized.replace(/^@\w+\s+/, '');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  normalized = normalized.replace(/^(以下是|根据|按照).*?:?\s*/i, '');
  return normalized;
}

// ============= Noise Filter =============
export function isNoise(content: string, config: NoiseFilterConfig): boolean {
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
export function shouldRetrieve(
  query: string,
  config: Config['adaptiveRetrieval'],
  sessionDedup?: { lastQuery: string; lastRecallTime: number }
): boolean {
  if (!config.enabled) return true;
  if (!query || query.trim().length < 1) return false;

  const lowerQuery = query.toLowerCase();
  // Force keywords always trigger retrieval (even after recent recall)
  if (config.forceKeywords?.some((k: string) => lowerQuery.includes(k))) return true;

  // Length gate
  const isCJK = /[\u4e00-\u9fa5]/.test(query);
  const minLen = isCJK ? MIN_CJK_QUERY_LENGTH : MIN_EN_QUERY_LENGTH;
  if (query.trim().length < minLen) return false;

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
export function weibullDecay(daysOld: number, shape: number, scale: number): number {
  return Math.exp(-Math.pow(daysOld / scale, shape));
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

    // Early exit: if the best possible MMR score (relevance alone, no diversity cost)
    // is already below threshold, stop selecting more items
    const bestPossibleScore = lambda * (picked._score ?? picked.importance);
    if (bestPossibleScore < threshold) break;
  }

  return selected;
}

/**
 * Lexical Overlap Suppression — post-MMR secondary pass.
 * For each pair of selected items above the threshold, penalize the lower-score one.
 * Unlike MMR which greedily builds the set, this scans already-selected items
 * and applies a multiplicative penalty to the runner-up if word overlap is too high.
 * This catches overlap that MMR's sequential selection may have missed.
 */
export function lexicalOverlapSuppress(items: Memory[], config: LexicalOverlapConfig): Memory[] {
  if (!config.enabled || items.length <= 1) return items;
  const { threshold, penalty } = config;

  const getWords = (content: string): Set<string> =>
    new Set(content.toLowerCase().match(/[\u4e00-\u9fa5]|[a-z0-9]+/gi) || []);

  const wordCache = new Map<string, Set<string>>();
  const getCachedWords = (content: string): Set<string> => {
    if (!wordCache.has(content)) wordCache.set(content, getWords(content));
    return wordCache.get(content)!;
  };

  const result = items.map(m => ({ ...m }));
  for (let i = 0; i < result.length; i++) {
    const a = result[i];
    if ((a._score ?? a.importance) <= 0) continue;
    for (let j = i + 1; j < result.length; j++) {
      const b = result[j];
      if ((b._score ?? b.importance) <= 0) continue;
      const wordsA = getCachedWords(a.content);
      const wordsB = getCachedWords(b.content);
      if (wordsA.size === 0 || wordsB.size === 0) continue;
      const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
      const union = new Set([...wordsA, ...wordsB]);
      const overlap = intersection.size / union.size;
      if (overlap > threshold) {
        // Penalize the lower-scoring item
        if ((a._score ?? a.importance) >= (b._score ?? b.importance)) {
          b._score = (b._score ?? b.importance) * penalty;
        } else {
          a._score = (a._score ?? a.importance) * penalty;
        }
      }
    }
  }
  return result.sort((a, b) => (b._score ?? b.importance) - (a._score ?? a.importance));
}

export function getTier(importance: number, accessCount: number, daysOld: number, config: TierConfig): 'core' | 'working' | 'peripheral' {
  if (!config.enabled) return importance >= 1.0 ? 'core' : 'working';
  const compositeScore = importance * (1 + Math.log10(accessCount + 1));
  // compositeScore >= 0.7 升 core，但须在 ageDays 内；超期则降级
  if (accessCount >= config.coreThreshold || (compositeScore >= 0.7 && daysOld <= config.ageDays)) return 'core';
  if (compositeScore < config.peripheralThreshold || daysOld > config.ageDays) return 'peripheral';
  return 'working';
}

// ============= Sleep =============
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
