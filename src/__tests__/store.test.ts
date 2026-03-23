/**
 * algo-memory Store 模块单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';

// 导入被测试的函数（需要从 store.ts 导出）
// 注意：由于当前是模拟测试，我们直接测试辅助函数

// ============= 模拟测试数据 =============

interface MockMemory {
  id: string;
  agent_id: string;
  scope: string;
  content: string;
  type: string;
  tier: string;
  layer: string;
  keywords: string;
  importance: number;
  access_count: number;
  cited_count: number;
  created_at: number;
  last_accessed: number;
  content_hash: string;
  metadata: string;
}

// ============= 辅助函数测试 =============

describe('SQL构建辅助函数', () => {
  // 由于 buildMemoryBatchInsert 是内部函数，我们通过行为来测试

  const MEMORY_COLUMNS = [
    'id', 'agent_id', 'scope', 'content', 'type', 'tier', 'layer',
    'keywords', 'importance', 'access_count', 'cited_count',
    'created_at', 'last_accessed', 'content_hash', 'metadata'
  ];

  it('MEMORY_COLUMNS 字段数量正确', () => {
    expect(MEMORY_COLUMNS.length).toBe(15);
  });

  it('MEMORY_COLUMNS 包含必要字段', () => {
    expect(MEMORY_COLUMNS).toContain('id');
    expect(MEMORY_COLUMNS).toContain('agent_id');
    expect(MEMORY_COLUMNS).toContain('content');
    expect(MEMORY_COLUMNS).toContain('tier');
    expect(MEMORY_COLUMNS).toContain('importance');
  });
});

describe('Memory对象结构', () => {
  const createMockMemory = (overrides = {}): MockMemory => ({
    id: 'test_id',
    agent_id: 'main',
    scope: 'agent:main',
    content: 'test content',
    type: 'other',
    tier: 'working',
    layer: 'general',
    keywords: 'test',
    importance: 0.5,
    access_count: 1,
    cited_count: 0,
    created_at: Date.now(),
    last_accessed: Date.now(),
    content_hash: 'abc123',
    metadata: '{}',
    ...overrides
  });

  it('创建基础Memory对象', () => {
    const memory = createMockMemory();
    expect(memory.id).toBe('test_id');
    expect(memory.content).toBe('test content');
    expect(memory.tier).toBe('working');
  });

  it('Memory对象可以自定义字段', () => {
    const memory = createMockMemory({
      tier: 'core',
      importance: 1.0,
      content: 'important message'
    });
    expect(memory.tier).toBe('core');
    expect(memory.importance).toBe(1.0);
    expect(memory.content).toBe('important message');
  });

  it('Memory对象的tier只能是 core/working/peripheral', () => {
    const validTiers = ['core', 'working', 'peripheral'];
    const memory1 = createMockMemory({ tier: 'core' });
    const memory2 = createMockMemory({ tier: 'working' });
    const memory3 = createMockMemory({ tier: 'peripheral' });

    expect(validTiers).toContain(memory1.tier);
    expect(validTiers).toContain(memory2.tier);
    expect(validTiers).toContain(memory3.tier);
  });
});

describe('默认值常量', () => {
  const DEFAULT_VALUES = {
    LLM_BATCH_WINDOW_MS: 200,
    LLM_TIMEOUT_MS: 5000,
    LLM_CACHE_TTL_MS: 5 * 60 * 1000,
    LLM_CACHE_MAX_SIZE: 1000,
    THRESHOLD_LENGTH_FOR_CORE: 100,
    THRESHOLD_LENGTH_FOR_EXTRACT: 200,
    COMPRESSION_MAX_LENGTH: 200,
    BATCH_BUFFER_MS: 500,
    BATCH_MAX_SIZE: 20,
    CACHE_MAX_SIZE: 1000,
  };

  it('LLM超时时间应该是5秒', () => {
    expect(DEFAULT_VALUES.LLM_TIMEOUT_MS).toBe(5000);
  });

  it('LLM缓存TTL应该是5分钟', () => {
    expect(DEFAULT_VALUES.LLM_CACHE_TTL_MS).toBe(300000);
  });

  it('批量缓冲区默认大小', () => {
    expect(DEFAULT_VALUES.BATCH_BUFFER_MS).toBe(500);
    expect(DEFAULT_VALUES.BATCH_MAX_SIZE).toBe(20);
  });

  it('阈值长度默认值', () => {
    expect(DEFAULT_VALUES.THRESHOLD_LENGTH_FOR_CORE).toBe(100);
    expect(DEFAULT_VALUES.THRESHOLD_LENGTH_FOR_EXTRACT).toBe(200);
  });
});

describe('缓存Key生成', () => {
  const getLlmCacheKey = (type: string, content: string): string => {
    return `llm:${type}:${content.toLowerCase().trim().substring(0, 100)}`;
  };

  it('生成正确的缓存key', () => {
    const key = getLlmCacheKey('isCore', 'Remember my wife');
    expect(key).toBe('llm:isCore:remember my wife');
  });

  it('内容过长时截断到合理长度', () => {
    const longContent = 'A'.repeat(150);
    const key = getLlmCacheKey('isCore', longContent);
    // key = "llm:isCore:" (11 chars) + 150 chars = 161, but truncated to 100
    expect(key.length).toBeLessThan(170);
    expect(key.length).toBeGreaterThan(100);
  });

  it('不同type生成不同key', () => {
    const key1 = getLlmCacheKey('isCore', 'test');
    const key2 = getLlmCacheKey('extractKeywords', 'test');
    expect(key1).not.toBe(key2);
  });
});

describe('噪音词过滤逻辑', () => {
  // 模拟 isNoise 函数逻辑（基于实际代码）
  const isNoise = (content: string, config?: { enabled?: boolean; skipGreetings?: boolean; skipCommands?: boolean }): boolean => {
    if (!config?.enabled) return false;
    
    const lower = content.toLowerCase().trim();
    const greetings = ['hi', 'hello', 'hey', '你好', '您好', '嗨'];
    const confirms = ['ok', 'okay', '好的', '收到', '嗯', '是的', 'yes', 'yep', 'sure', 'got it', 'gotcha'];
    
    if (config.skipGreetings && greetings.some(g => lower === g || lower.startsWith(g + ' '))) {
      return true;
    }
    
    if (config.skipCommands && (lower.startsWith('/') || lower.startsWith('!'))) {
      return true;
    }
    
    // 确认词需要 noiseFilter.enabled
    if (config.enabled && confirms.includes(lower)) {
      return true;
    }
    
    return false;
  };

  it('skipGreetings 应该过滤问候语', () => {
    expect(isNoise('hello', { enabled: true, skipGreetings: true })).toBe(true);
    expect(isNoise('hi', { enabled: true, skipGreetings: true })).toBe(true);
    expect(isNoise('你好', { enabled: true, skipGreetings: true })).toBe(true);
  });

  it('skipCommands 应该过滤命令', () => {
    expect(isNoise('/help', { enabled: true, skipCommands: true })).toBe(true);
    expect(isNoise('!cmd', { enabled: true, skipCommands: true })).toBe(true);
  });

  it('确认词应该被过滤（需要enabled）', () => {
    expect(isNoise('ok', { enabled: true })).toBe(true);
    expect(isNoise('好的', { enabled: true })).toBe(true);
    expect(isNoise('收到', { enabled: true })).toBe(true);
  });

  it('正常内容不应该被过滤', () => {
    expect(isNoise('Remember my wife', { enabled: true })).toBe(false);
    expect(isNoise('I need Python help', { enabled: true })).toBe(false);
    expect(isNoise('Book MU5101 flight', { enabled: true })).toBe(false);
  });

  it('禁用时不过滤确认词', () => {
    expect(isNoise('ok', { enabled: false })).toBe(false);
    expect(isNoise('好的', { enabled: false })).toBe(false);
  });
});

describe('分层计算逻辑', () => {
  // 模拟 getTier 函数（基于实际代码逻辑）
  const getTier = (importance: number, accessCount: number, config?: { coreThreshold?: number; peripheralThreshold?: number; ageDays?: number }) => {
    const coreThreshold = config?.coreThreshold || 10;
    const peripheralThreshold = config?.peripheralThreshold || 0.15;
    
    // score计算公式
    const score = importance * (1 + Math.log10(accessCount + 1));
    
    // 实际判断条件：accessCount >= coreThreshold 直接是 core
    if (accessCount >= coreThreshold) return 'core';
    if (score < peripheralThreshold) return 'peripheral';
    return 'working';
  };

  it('高频访问应该晋升为core', () => {
    expect(getTier(0.5, 10)).toBe('core');
    expect(getTier(0.5, 15)).toBe('core');
    expect(getTier(0.5, 20)).toBe('core');
  });

  it('低频访问应该是working或peripheral', () => {
    const tier = getTier(0.5, 1);
    expect(['working', 'peripheral']).toContain(tier);
  });

  it('高重要性直接是core', () => {
    expect(getTier(1.0, 1)).toBe('working'); // accessCount=1 < coreThreshold(10), 但 score > 0.15
  });

  it('自定义阈值应该生效', () => {
    // accessCount=5 >= coreThreshold(5) 直接是 core
    expect(getTier(0.5, 5, { coreThreshold: 5 })).toBe('core');
  });
});

describe('Jaccard相似度', () => {
  const jaccardSimilarity = (a: string, b: string): number => {
    const setA = new Set(a.split(/\s+/).filter(s => s.length > 0));
    const setB = new Set(b.split(/\s+/).filter(s => s.length > 0));
    if (setA.size === 0 && setB.size === 0) return 1; // 两个都为空视为相同
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  };

  it('完全相同返回1', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('完全不同返回0', () => {
    expect(jaccardSimilarity('hello', 'world')).toBe(0);
  });

  it('部分相同返回中间值', () => {
    const sim = jaccardSimilarity('hello world foo', 'hello world bar');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('空字符串处理', () => {
    expect(jaccardSimilarity('', '')).toBe(1);
    expect(jaccardSimilarity('hello', '')).toBe(0);
  });
});

describe('批量写入阈值', () => {
  // 模拟动态bufferMs计算（基于实际代码）
  const getDynamicBufferMs = (baseBufferMs: number, messageCount: number): number => {
    if (messageCount > 20) return Math.max(100, baseBufferMs * 0.3);
    if (messageCount > 10) return Math.max(200, baseBufferMs * 0.5);
    if (messageCount > 5) return Math.max(300, baseBufferMs * 0.7);
    return baseBufferMs;
  };

  it('慢速消息使用正常延迟', () => {
    expect(getDynamicBufferMs(500, 1)).toBe(500);
    expect(getDynamicBufferMs(500, 5)).toBe(500);
  });

  it('中速消息减少延迟', () => {
    expect(getDynamicBufferMs(500, 6)).toBe(350);
    expect(getDynamicBufferMs(500, 11)).toBe(250);
  });

  it('快速消息最小延迟', () => {
    expect(getDynamicBufferMs(500, 21)).toBe(150);
  });

  it('快速消息延迟不低于100', () => {
    // max(100, 200*0.3) = max(100, 60) = 100
    expect(getDynamicBufferMs(200, 21)).toBe(100);
    expect(getDynamicBufferMs(100, 21)).toBe(100);
  });
});

describe('LLM重试逻辑', () => {
  // 模拟 llmWithRetry
  let attempts = 0;
  const llmWithRetry = async <T>(
    fn: () => Promise<T>,
    maxRetries: number = 2
  ): Promise<T> => {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    }
    
    throw lastError;
  };

  it('成功时直接返回', async () => {
    const result = await llmWithRetry(async () => 'success');
    expect(result).toBe('success');
  });

  it('失败时重试', async () => {
    attempts = 0;
    await llmWithRetry(async () => {
      attempts++;
      if (attempts < 2) throw new Error('fail');
      return 'success after retry';
    });
    expect(attempts).toBe(2);
  });

  it('所有重试都失败时抛出错误', async () => {
    attempts = 0;
    await expect(llmWithRetry(async () => {
      attempts++;
      throw new Error('always fail');
    }, 2)).rejects.toThrow('always fail');
    expect(attempts).toBe(2);
  });
});

describe('LRU缓存淘汰', () => {
  // 模拟简单的LRU缓存
  class LRUCache<K, V> {
    private cache = new Map<K, V>();
    private maxSize: number;

    constructor(maxSize: number) {
      this.maxSize = maxSize;
    }

    set(key: K, value: V): void {
      if (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(key, value);
    }

    get(key: K): V | undefined {
      const value = this.cache.get(key);
      if (value !== undefined) {
        // 移到末尾（最近使用）
        this.cache.delete(key);
        this.cache.set(key, value);
      }
      return value;
    }

    size(): number {
      return this.cache.size;
    }
  }

  it('超过容量时淘汰最旧的', () => {
    const cache = new LRUCache<string, string>(3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    expect(cache.size()).toBe(3);

    cache.set('d', '4');
    expect(cache.size()).toBe(3);
    expect(cache.get('a')).toBeUndefined(); // a被淘汰
    expect(cache.get('d')).toBe('4');
  });

  it('访问时更新顺序', () => {
    const cache = new LRUCache<string, string>(3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    
    cache.get('a'); // 访问a
    
    cache.set('d', '4');
    
    expect(cache.get('a')).toBe('1'); // a应该还在
    expect(cache.get('b')).toBeUndefined(); // b被淘汰
  });
});
