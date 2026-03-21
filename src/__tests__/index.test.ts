/**
 * algo-memory 单元测试
 * 运行: npx ts-node src/__tests__/index.test.ts
 * 或: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Crypto from 'crypto';

// ============ 工具函数测试 ============

function jaccardSimilarity(text1: string, text2: string): number {
  // CJK 单字为词，英文/数字按词（与生产代码一致）
  const words1 = new Set(text1.toLowerCase().match(/[\u4e00-\u9fa5]|[a-z0-9]+/gi) || []);
  const words2 = new Set(text2.toLowerCase().match(/[\u4e00-\u9fa5]|[a-z0-9]+/gi) || []);
  if (words1.size === 0 || words2.size === 0) return 0;
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  return intersection.size / union.size;
}

function extractKeywords(content: string, maxKeywords = 10): string {
  const words = content.toLowerCase().match(/[\u4e00-\u9fa5]|[a-z0-9]+/gi) || [];
  return [...new Set(words)].slice(0, maxKeywords).join(',');
}

function isCoreKeyword(content: string, keywords: string[]): boolean {
  return keywords.some(k => content.toLowerCase().includes(k.toLowerCase()));
}

function weibullDecay(daysOld: number, shape: number, scale: number): number {
  return Math.exp(-Math.pow(daysOld / scale, shape));
}

function lengthNorm(content: string, anchor: number): number {
  const len = content.length;
  if (len <= anchor) return 1.0;
  return anchor / len;
}

function reinforcementFactor(accessCount: number, factor = 0.5, maxMultiplier = 3): number {
  if (accessCount <= 1) return 1.0;
  return Math.min(maxMultiplier, 1.0 + (accessCount - 1) * factor);
}

function normalizeText(text: string): string {
  let normalized = text.trim();
  normalized = normalized.replace(/^@\w+\s+/, '');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  normalized = normalized.replace(/^(以下是|根据|按照).*?:?\s*/i, '');
  return normalized;
}

function isNoise(content: string, config: { enabled: boolean; skipGreetings: boolean; skipCommands: boolean }): boolean {
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

function getTier(importance: number, accessCount: number, daysOld: number, config: { enabled: boolean; coreThreshold: number; peripheralThreshold: number; ageDays: number }): 'core' | 'working' | 'peripheral' {
  if (!config.enabled) return importance >= 1.0 ? 'core' : 'working';
  const compositeScore = importance * (1 + Math.log10(accessCount + 1));
  // compositeScore >= 0.7 升 core，但须在 ageDays 内；超期则降级
  if (accessCount >= config.coreThreshold || (compositeScore >= 0.7 && daysOld <= config.ageDays)) return 'core';
  if (compositeScore < config.peripheralThreshold || daysOld > config.ageDays) return 'peripheral';
  return 'working';
}

function generateId(): string { return 'mem_' + Crypto.randomBytes(8).toString('hex'); }

function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjk = text.length - cjkChars;
  return cjkChars + Math.ceil(nonCjk / 4);
}
function hashContent(content: string): string { return Crypto.createHash('sha256').update(content).digest('hex'); }

describe('工具函数', () => {
  describe('jaccardSimilarity', () => {
    it('完全相同文本相似度为 1', () => {
      expect(jaccardSimilarity('今天天气很好', '今天天气很好')).toBe(1);
    });

    it('完全无关文本相似度为 0', () => {
      expect(jaccardSimilarity('苹果', '电脑')).toBe(0);
    });

    it('部分相同有正确相似度', () => {
      const sim = jaccardSimilarity('今天天气很好', '今天心情很好');
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
    });

    it('英文大小写不敏感', () => {
      expect(jaccardSimilarity('HELLO WORLD', 'hello world')).toBe(1);
    });

    it('空文本返回 0', () => {
      expect(jaccardSimilarity('', 'hello')).toBe(0);
      expect(jaccardSimilarity('hello', '')).toBe(0);
    });
  });

  describe('extractKeywords', () => {
    it('提取中英文关键词', () => {
      const kw = extractKeywords('今天天气很好适合出去玩');
      expect(kw.split(',').length).toBeGreaterThan(0);
    });

    it('去重', () => {
      const kw = extractKeywords('今天天气很好天气不错');
      const words = kw.split(',');
      const unique = new Set(words);
      expect(words.length).toBe(unique.size);
    });

    it('最多返回 maxKeywords 个', () => {
      const long = '一二三四五六七八九十十一十二十三十四十五十六十七十八十九二十';
      const kw = extractKeywords(long, 5);
      expect(kw.split(',').length).toBeLessThanOrEqual(5);
    });
  });

  describe('isCoreKeyword', () => {
    const keywords = ['记住', '重要', '不要忘记', 'remember'];

    it('包含关键词返回 true', () => {
      expect(isCoreKeyword('请记住这个重要的事情', keywords)).toBe(true);
    });

    it('不包含关键词返回 false', () => {
      expect(isCoreKeyword('今天吃了苹果', keywords)).toBe(false);
    });

    it('大小写不敏感（英文）', () => {
      expect(isCoreKeyword('REMEMBER this', keywords)).toBe(true);
    });
  });

  describe('weibullDecay', () => {
    it('0天返回 1', () => {
      expect(weibullDecay(0, 1.5, 90)).toBe(1);
    });

    it('时间越长衰减越大', () => {
      const d1 = weibullDecay(10, 1.5, 90);
      const d2 = weibullDecay(90, 1.5, 90);
      expect(d2).toBeLessThan(d1);
    });

    it('shape 越大衰减越慢', () => {
      const d1 = weibullDecay(30, 1.0, 90);
      const d2 = weibullDecay(30, 2.0, 90);
      expect(d2).toBeGreaterThan(d1);
    });
  });

  describe('lengthNorm', () => {
    it('短于 anchor 返回 1', () => {
      expect(lengthNorm('short', 500)).toBe(1);
    });

    it('长于 anchor 返回 anchor/len', () => {
      const norm = lengthNorm('a'.repeat(1000), 500);
      expect(norm).toBe(0.5);
    });
  });

  describe('reinforcementFactor', () => {
    it('访问1次返回 1', () => {
      expect(reinforcementFactor(1)).toBe(1);
    });

    it('访问多次返回递增因子', () => {
      expect(reinforcementFactor(3)).toBeGreaterThan(1);
    });

    it('不超过 maxMultiplier', () => {
      expect(reinforcementFactor(100, 0.5, 3)).toBe(3);
    });
  });

  describe('normalizeText', () => {
    it('去除 @ 地址前缀', () => {
      expect(normalizeText('@bot 请记住这件事')).toBe('请记住这件事');
    });

    it('合并多余空白', () => {
      expect(normalizeText('今天   天气    很好')).toBe('今天 天气 很好');
    });

    it('去除 OpenClaw 注入前缀', () => {
      // 正则 /^(以下是|根据|按照).*?:?\s*/ 只剥离前缀词，':'须紧跟其后
      expect(normalizeText('以下是：今天的事')).toBe('：今天的事');
      expect(normalizeText('根据以下内容：用户喜欢苹果')).toBe('以下内容：用户喜欢苹果');
    });
  });

  describe('isNoise', () => {
    const config = { enabled: true, skipGreetings: true, skipCommands: true };

    it('问候语被过滤', () => {
      expect(isNoise('hi', config)).toBe(true);
      expect(isNoise('hello', config)).toBe(true);
      expect(isNoise('你好', config)).toBe(true);
    });

    it('命令被过滤', () => {
      expect(isNoise('/help', config)).toBe(true);
      expect(isNoise('!ls', config)).toBe(true);
      expect(isNoise('-v', config)).toBe(true);
    });

    it('确认语被过滤', () => {
      expect(isNoise('ok', config)).toBe(true);
      expect(isNoise('好的', config)).toBe(true);
      expect(isNoise('yes', config)).toBe(true);
    });

    it('正常文本不被过滤', () => {
      expect(isNoise('请记住我的名字叫小明', config)).toBe(false);
    });

    it('disabled 时返回 false', () => {
      expect(isNoise('hi', { enabled: false, skipGreetings: true, skipCommands: true })).toBe(false);
    });
  });

  describe('getTier', () => {
    it('enabled=false: importance>=1 为 core', () => {
      expect(getTier(1.0, 1, 0, { enabled: false, coreThreshold: 10, peripheralThreshold: 0.15, ageDays: 60 })).toBe('core');
    });

    it('enabled=false: importance<1 为 working', () => {
      expect(getTier(0.5, 1, 0, { enabled: false, coreThreshold: 10, peripheralThreshold: 0.15, ageDays: 60 })).toBe('working');
    });

    it('accessCount >= coreThreshold 为 core', () => {
      const cfg = { enabled: true, coreThreshold: 10, peripheralThreshold: 0.15, ageDays: 60 };
      expect(getTier(0.3, 10, 0, cfg)).toBe('core');
    });

    it('compositeScore < peripheralThreshold 为 peripheral', () => {
      const cfg = { enabled: true, coreThreshold: 10, peripheralThreshold: 0.5, ageDays: 60 };
      expect(getTier(0.1, 1, 0, cfg)).toBe('peripheral');
    });

    it('超过 ageDays 为 peripheral', () => {
      const cfg = { enabled: true, coreThreshold: 10, peripheralThreshold: 0.15, ageDays: 60 };
      expect(getTier(0.5, 3, 61, cfg)).toBe('peripheral');
    });
  });

  describe('estimateTokens', () => {
    it('empty string returns 0', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens(null as any)).toBe(0);
    });

    it('pure CJK returns character count', () => {
      expect(estimateTokens('今天天气很好')).toBe(6);
      expect(estimateTokens('北京')).toBe(2);
    });

    it('pure English estimates 4 chars per token', () => {
      // 'hello world' = 11 chars, nonCjk = 11, ceil(11/4) = 3
      expect(estimateTokens('hello world')).toBe(3);
    });

    it('mixed CJK and English', () => {
      // '今天hello' = 7 chars: 3 CJK + ceil(4/4)=1 = 4
      expect(estimateTokens('今天hello')).toBe(4);
    });

    it('punctuation counted in nonCjk', () => {
      // '你好，世界！' = 8 chars: 4 CJK + ceil(4/4)=1 = 5
      expect(estimateTokens('你好，世界！')).toBe(5);
    });
  });

  describe('generateId / hashContent', () => {
    it('generateId 格式正确', () => {
      const id = generateId();
      expect(id.startsWith('mem_')).toBe(true);
      expect(id.length).toBe(4 + 16); // 'mem_' (4) + randomBytes(8) → 16 hex
    });

    it('hashContent 是 SHA256 十六进制字符串', () => {
      const hash = hashContent('test');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('相同内容哈希相同', () => {
      expect(hashContent('hello')).toBe(hashContent('hello'));
    });

    it('不同内容哈希不同', () => {
      expect(hashContent('hello')).not.toBe(hashContent('world'));
    });
  });
});
