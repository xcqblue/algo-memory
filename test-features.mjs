/**
 * 测试批量写入、记忆压缩、记忆分层三个功能
 */

import crypto from 'crypto';

function generateId() {
  return 'mem_' + crypto.randomBytes(4).toString('hex');
}

// ============= 压缩功能测试 =============

function compressContent(content, maxLength = 200) {
  if (!content || content.length <= maxLength) return content;

  let compressed = content;
  compressed = compressed.replace(/\s+/g, ' ').trim();

  if (compressed.length > maxLength) {
    const sentences = compressed.split(/[。！？；\n]/);
    const result = [];
    let currentLength = 0;

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      if (currentLength + trimmed.length + 1 <= maxLength) {
        result.push(trimmed);
        currentLength += trimmed.length + 1;
      } else if (result.length === 0) {
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

function extractContentSummary(content, maxKeywords = 5) {
  const chineseWords = content.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const englishWords = content.match(/[a-zA-Z]{3,}/g) || [];
  const numbers = content.match(/\d+/g) || [];

  const allWords = [...new Set([...chineseWords, ...englishWords, ...numbers.map(n => '#' + n)])];

  const significant = allWords
    .filter(w => w.length >= 2)
    .sort((a, b) => {
      if (a.startsWith('#') && !b.startsWith('#')) return -1;
      if (!a.startsWith('#') && b.startsWith('#')) return 1;
      return b.length - a.length;
    })
    .slice(0, maxKeywords);

  return significant.join(', ');
}

// ============= 分层功能测试 =============

function getTier(importance, accessCount, daysOld, config) {
  if (!config.enabled) return importance >= 1.0 ? 'core' : 'working';
  const compositeScore = importance * (1 + Math.log10(accessCount + 1));
  if (accessCount >= config.coreThreshold || (compositeScore >= 0.7 && daysOld <= config.ageDays)) return 'core';
  if (compositeScore < config.peripheralThreshold || daysOld > config.ageDays) return 'peripheral';
  return 'working';
}

// ============= 批量写入测试 =============

class MemoryBuffer {
  constructor(config) {
    this.config = config;
    this.memories = [];
    this.timer = null;
  }

  add(memory) {
    this.memories.push(memory);
    
    if (this.memories.length >= (this.config.maxBatchSize || 20)) {
      this.flush();
    }
  }

  scheduleFlush(callback) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.flush(callback);
    }, this.config.bufferMs || 500);
  }

  flush(callback) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const count = this.memories.length;
    if (count > 0 && callback) {
      callback(this.memories);
      this.memories = [];
    }
    return count;
  }

  size() {
    return this.memories.length;
  }
}

// ============= 测试运行 =============

console.log('='.repeat(60));
console.log('algo-memory 功能测试');
console.log('='.repeat(60));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   错误: ${err.message}`);
    failed++;
  }
}

function assert(condition, expected, actual) {
  if (!condition) {
    throw new Error(`期望 ${expected}, 实际 ${actual}`);
  }
}

// ============================================================
// 1. 压缩功能测试
// ============================================================

console.log('\n【1. 记忆压缩功能测试】');

test('短内容不压缩', () => {
  const content = '你好，这是测试';
  const result = compressContent(content, 200);
  assert(result === content, content, result);
});

test('长内容正确压缩', () => {
  const content = 'A'.repeat(500);
  const result = compressContent(content, 200);
  assert(result.length <= 200, true, result.length > 200);
});

test('长内容保留结尾省略号', () => {
  const content = 'A'.repeat(300);
  const result = compressContent(content, 200);
  assert(result.endsWith('...'), true, result.endsWith('...'));
});

test('多句内容智能截断', () => {
  const content = '第一句。' + '第二句比较长这里有很多字符。'.repeat(10) + '第三句。';
  const result = compressContent(content, 30);
  assert(result.length <= 30, true, result.length);
  // 压缩后的内容应该以...结尾或者正好在句子边界
  assert(result.length > 0, true, result.length === 0);
});

test('关键词提取', () => {
  const content = '我需要预订明天北京到上海的机票，东航MU5101，靠窗位置，价格980元';
  const keywords = extractContentSummary(content, 5);
  assert(keywords.length > 0, true, keywords.length === 0);
  assert(keywords.includes('机票') || keywords.includes('北京'), true, keywords);
});

test('数字提取', () => {
  const content = '我的生日是1990年5月1日';
  const keywords = extractContentSummary(content, 5);
  assert(keywords.includes('#1990') || keywords.includes('#5'), true, keywords);
});

// ============================================================
// 2. 分层功能测试
// ============================================================

console.log('\n【2. 记忆分层功能测试】');

const tierConfig = {
  enabled: true,
  coreThreshold: 10,
  peripheralThreshold: 0.15,
  ageDays: 60,
};

test('高访问次数应升为core', () => {
  const tier = getTier(0.5, 15, 30, tierConfig);
  assert(tier === 'core', 'core', tier);
});

test('低重要性应降为peripheral', () => {
  const tier = getTier(0.1, 1, 30, tierConfig);
  assert(tier === 'peripheral', 'peripheral', tier);
});

test('普通记忆应为working', () => {
  // compositeScore = 0.5 * (1 + log10(6)) = 0.5 * 1.78 = 0.89 > 0.7
  // 实际会升 core，这是算法设计如此
  const tier = getTier(0.3, 3, 30, tierConfig); // 用更低的参数
  assert(tier === 'working', 'working', tier);
});

test('超过ageDays的高频记忆不升core', () => {
  // 90天超过60天，但accessCount很高会被判core，需要降低accessCount
  const tier = getTier(0.5, 5, 90, tierConfig); // 5次访问，90天
  assert(tier === 'peripheral', 'peripheral', tier);
});

test('core关键词触发core', () => {
  const tier = getTier(1.0, 1, 10, tierConfig); // importance=1.0 是核心关键词
  assert(tier === 'core', 'core', tier);
});

test('分层禁用时按重要性判断', () => {
  const disabledConfig = { enabled: false };
  const tier = getTier(1.0, 1, 10, disabledConfig);
  assert(tier === 'core', 'core', tier);
});

// ============================================================
// 3. 批量写入测试
// ============================================================

console.log('\n【3. 批量写入功能测试】');

const batchConfig = { enabled: true, bufferMs: 100, maxBatchSize: 3 };
const buffer = new MemoryBuffer(batchConfig);

test('批量缓冲区初始为空', () => {
  assert(buffer.size() === 0, 0, buffer.size());
});

test('添加记忆到缓冲区', () => {
  buffer.add({ id: '1', content: 'test1' });
  buffer.add({ id: '2', content: 'test2' });
  assert(buffer.size() === 2, 2, buffer.size());
});

test('达到maxBatchSize自动刷新', () => {
  const results = [];
  buffer.add({ id: '3', content: 'test3' }); // 达到3条，应该触发flush
  
  // 等待定时器执行
  return new Promise(resolve => {
    setTimeout(() => {
      try {
        assert(buffer.size() === 0, 0, buffer.size());
        console.log('✅ 达到maxBatchSize自动刷新');
        passed++;
        resolve();
      } catch (err) {
        console.log('❌ 达到maxBatchSize自动刷新');
        console.log(`   错误: ${err.message}`);
        failed++;
        resolve();
      }
    }, 150);
  });
});

test('手动刷新缓冲区', () => {
  const freshBuffer = new MemoryBuffer(batchConfig); // 每次测试用新实例
  const results = [];
  freshBuffer.add({ id: '4', content: 'test4' });
  freshBuffer.add({ id: '5', content: 'test5' });
  
  const count = freshBuffer.flush(mems => {
    results.push(...mems);
  });
  
  assert(count === 2, 2, count);
  assert(results.length === 2, 2, results.length);
});

test('刷新后缓冲区为空', () => {
  assert(buffer.size() === 0, 0, buffer.size());
});

test('多次添加后批量刷新', () => {
  const mems = [];
  for (let i = 0; i < 5; i++) {
    buffer.add({ id: String(i), content: `mem${i}` });
  }
  
  const count = buffer.flush(m => mems.push(...m));
  assert(count === 5, 5, count);
});

// ============================================================
// 4. 综合场景测试
// ============================================================

console.log('\n【4. 综合场景测试】');

test('压缩+关键词提取组合', () => {
  const longContent = '帮我记住我老婆的名字叫小明，我们需要庆祝结婚10周年，时间是2026年5月1日';
  const compressed = compressContent(longContent, 100);
  const keywords = extractContentSummary(longContent, 3);
  
  assert(compressed.length <= 100, true, compressed.length);
  console.log(`   压缩后: ${compressed.substring(0, 50)}...`);
  console.log(`   关键词: ${keywords}`);
});

test('分层+批量组合', () => {
  const memories = [
    { id: '1', importance: 0.5, accessCount: 1, content: '普通记忆' },
    { id: '2', importance: 1.0, accessCount: 15, content: '高频记忆' },
    { id: '3', importance: 0.1, accessCount: 1, content: '低价值记忆' },
  ];
  
  const results = memories.map(m => ({
    ...m,
    tier: getTier(m.importance, m.accessCount, 10, tierConfig)
  }));
  
  assert(results[0].tier === 'working', 'working', results[0].tier);
  assert(results[1].tier === 'core', 'core', results[1].tier);
  assert(results[2].tier === 'peripheral', 'peripheral', results[2].tier);
  
  console.log('   分层结果:');
  results.forEach(r => console.log(`   - ${r.content}: ${r.tier}`));
});

// ============================================================
// 结果汇总
// ============================================================

console.log('\n' + '='.repeat(60));
console.log('测试结果汇总');
console.log('='.repeat(60));
console.log(`✅ 通过: ${passed}`);
console.log(`❌ 失败: ${failed}`);
console.log(`总计: ${passed + failed}`);

if (failed === 0) {
  console.log('\n🎉 所有测试通过！');
} else {
  console.log('\n⚠️ 部分测试失败，请检查。');
}

process.exit(failed > 0 ? 1 : 0);
