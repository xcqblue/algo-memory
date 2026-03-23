/**
 * algo-memory 会话续接功能测试
 * 
 * 模拟测试场景：
 * 1. 用户在晚上12点开始对话
 * 2. 对话进行中，生成了多条消息
 * 3. 第二天早上6点，用户继续对话（此时 sessionKey 变了）
 * 4. 验证：新的 agent_start 时能检测到会话切换，并注入上会话摘要
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Mock logger
const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Mock config with sessionContinuity enabled
const testConfig = {
  sessionContinuity: {
    enabled: true,
    maxInjectTokens: 800,
    maxMessagesForSummary: 30,
  },
  autoCapture: false,
  autoRecall: false,
  maxResults: 5,
  maxInjectTokens: 1500,
  cleanupDays: 180,
  language: 'auto',
  coreKeywords: [],
  recencyDecay: false,
  recencyHalfLife: 180,
  smartDedup: false,
  dedupThreshold: 0.85,
  noiseFilter: { enabled: false, skipGreetings: false, skipCommands: false },
  adaptiveRetrieval: { enabled: false, minQueryLength: 2, forceKeywords: [], sessionDedup: { enabled: false, windowMs: 30000, similarityThreshold: 0.6 } },
  weibullDecay: { enabled: false, shape: 1.5, scale: 90 },
  reinforcement: { enabled: false, factor: 0.5, maxMultiplier: 3 },
  mmr: { enabled: false, threshold: 0.85, lambda: 0.7 },
  lengthNorm: { enabled: false, anchor: 500 },
  hardMinScore: { enabled: false, threshold: 0.35 },
  tier: { enabled: false, coreThreshold: 10, peripheralThreshold: 0.15, ageDays: 60, weights: { core: 1.5, working: 1.0, peripheral: 0.5 } },
  scopes: { enabled: false, defaultScope: 'agent', visibleAgents: [] },
  capturePerTurn: 3,
  llm: { enabled: false, provider: 'auto', apiKey: '', model: '', baseURL: '' },
  threshold: { useLlmForCore: false, useLlmForExtract: false, useLlmForDedup: false, minConfidence: 0.8, lengthForCore: 100, lengthForExtract: 200, dedupUncertaintyMin: 0.5, dedupUncertaintyMax: 0.98 },
  sessionSummary: { enabled: false, dir: 'memory', maxItems: 50 },
  feedback: { enabled: false, maxMemories: 5, matchThreshold: 0.6 },
  mcp: { enabled: false, transport: 'stdio' as const, port: 8181 },
};

describe('会话续接功能测试', () => {
  let plugin: MemoryPlugin;
  let db: Database.Database;
  const testDbPath = path.join('/tmp', `test-algo-memory-${Date.now()}.db`);

  beforeAll(async () => {
    // Create test database
    db = new Database(testDbPath);
    
    // Initialize plugin
    plugin = new MemoryPlugin(testConfig as any, mockLog);
    (plugin as any).db = db;
    (plugin as any).dbPath = testDbPath;
    
    // Initialize schema
    const { initSchema } = await import('../db/schema.js');
    initSchema(db, mockLog);
    
    console.log('Test setup complete');
  });

  afterAll(() => {
    // Cleanup
    if (db) db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    console.log('Test cleanup complete');
  });

  beforeEach(() => {
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  describe('1. generateSessionSummary - 会话摘要生成', () => {
    test('空消息列表应返回空字符串', () => {
      const result = plugin.generateSessionSummary([]);
      expect(result).toBe('');
    });

    test('应正确提取用户和助手消息', () => {
      const messages = [
        { role: 'user', content: '我想了解一下明天的天气' },
        { role: 'assistant', content: '明天天气晴，温度15-25度。' },
        { role: 'user', content: '那后天呢？' },
        { role: 'assistant', content: '后天多云，可能有雨。' },
      ];
      
      const result = plugin.generateSessionSummary(messages);
      
      expect(result).toContain('用户: 我想了解一下明天的天气');
      expect(result).toContain('用户: 那后天呢？');
      expect(result).toContain('助手: 明天天气晴');
      expect(result).toContain('助手: 后天多云');
    });

    test('应截断过长的消息内容', () => {
      const longContent = 'A'.repeat(300);
      const messages = [
        { role: 'user', content: longContent },
      ];
      
      const result = plugin.generateSessionSummary(messages);
      
      expect(result).toContain('...');
      expect(result.length).toBeLessThan(250);
    });

    test('应跳过错误消息', () => {
      const messages = [
        { role: 'user', content: '正常消息' },
        { role: 'assistant', content: '正常回复' },
        { role: 'assistant', content: '错误消息', isError: true },
      ];
      
      const result = plugin.generateSessionSummary(messages);
      
      expect(result).toContain('正常消息');
      expect(result).toContain('正常回复');
      expect(result).not.toContain('错误消息');
    });
  });

  describe('2. extractContextSnapshot - 上下文快照提取', () => {
    test('应正确去重', () => {
      const messages = [
        { role: 'user', content: '同样的问题' },
        { role: 'user', content: '同样的问题' },
        { role: 'user', content: '不同的问题' },
      ];
      
      const result = plugin.extractContextSnapshot(messages);
      const lines = result.split('\n').filter(l => l.trim());
      
      // 应该只有2条（去重后）
      expect(lines.length).toBe(2);
    });

    test('应正确区分用户和助手消息', () => {
      const messages = [
        { role: 'user', content: '用户消息1' },
        { role: 'assistant', content: '助手消息1' },
        { role: 'user', content: '用户消息2' },
      ];
      
      const result = plugin.extractContextSnapshot(messages);
      
      expect(result).toContain('用户: 用户消息1');
      expect(result).toContain('助手: 助手消息1');
      expect(result).toContain('用户: 用户消息2');
    });
  });

  describe('3. saveSessionSnapshot - 会话快照保存', () => {
    test('应正确保存会话快照到数据库', () => {
      const agentId = 'test-agent';
      const sessionKey = 'session-2026-03-22-001';
      const messages = [
        { role: 'user', content: '晚上好，我想订一张机票' },
        { role: 'assistant', content: '好的，您想订哪天的机票？' },
        { role: 'user', content: '明天早上8点的' },
        { role: 'assistant', content: '好的，为您查询明天早上8点的航班...' },
      ];

      plugin.saveSessionSnapshot(agentId, sessionKey, messages);

      // 验证保存成功
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('会话快照已保存')
      );
    });

    test('应能正确读取保存的快照', () => {
      const agentId = 'test-agent';
      const snapshot = plugin.getLastSessionSnapshot(agentId);

      expect(snapshot).not.toBeNull();
      expect(snapshot.agent_id).toBe(agentId);
      expect(snapshot.summary).toContain('晚上好，我想订一张机票');
      expect(snapshot.context_snapshot).toContain('用户: 晚上好');
      expect(snapshot.message_count).toBe(4);
    });
  });

  describe('4. detectSessionChangeAndGetSnapshot - 会话切换检测', () => {
    test('首次会话应返回null（无上会话）', () => {
      const agentId = 'new-user';
      const currentSessionKey = 'session-first-time';
      
      const result = plugin.detectSessionChangeAndGetSnapshot(agentId, currentSessionKey);
      
      expect(result).toBeNull();
    });

    test('同一会话应返回null（不需要续接）', () => {
      const agentId = 'same-session-user';
      const sessionKey = 'session-same-001';
      
      // 首次调用
      plugin.detectSessionChangeAndGetSnapshot(agentId, sessionKey);
      
      // 第二次调用同一 sessionKey
      const result = plugin.detectSessionChangeAndGetSnapshot(agentId, sessionKey);
      
      expect(result).toBeNull();
    });

    test('会话切换时应返回上会话快照', () => {
      const agentId = 'session-change-user';
      const oldSessionKey = 'session-old-001';
      const newSessionKey = 'session-new-002';
      
      // 先保存一个快照
      const messages = [
        { role: 'user', content: '这是昨晚的对话' },
        { role: 'assistant', content: '好的，昨晚的安排是什么？' },
      ];
      plugin.saveSessionSnapshot(agentId, oldSessionKey, messages);
      
      // 模拟会话切换
      const result = plugin.detectSessionChangeAndGetSnapshot(agentId, newSessionKey);
      
      expect(result).not.toBeNull();
      expect(result.session_key).toBe(oldSessionKey);
      expect(result.summary).toContain('这是昨晚的对话');
    });
  });

  describe('5. buildSessionContinuityContext - 续接上下文构建', () => {
    test('应正确构建续接文本', () => {
      const snapshot = {
        summary: '用户: 订机票\n助手: 好的\n用户: 明天早上',
        context_snapshot: '用户: 订机票\n助手: 好的，为您查询\n用户: 明天早上8点的',
        agent_id: 'test',
        session_key: 'old-session',
        ended_at: Date.now() - 3600000,
        message_count: 3,
        total_tokens: 100,
      };

      const { text, tokens } = plugin.buildSessionContinuityContext(snapshot);

      expect(text).toContain('【上会话摘要】');
      expect(text).toContain('【上会话详情】');
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThanOrEqual(800); // 不应超过 maxInjectTokens
    });

    test('null 快照应返回空文本', () => {
      const { text, tokens } = plugin.buildSessionContinuityContext(null);

      expect(text).toBe('');
      expect(tokens).toBe(0);
    });
  });

  describe('6. 完整流程测试 - 模拟跨会话续接', () => {
    test('场景：晚上12点对话，第二天早上续接', () => {
      const agentId = 'user-night-to-morning';
      
      // === 第一天晚上的会话 ===
      const nightMessages = [
        { role: 'user', content: '帮我查一下明天去上海的机票' },
        { role: 'assistant', content: '好的，为您查询明天去上海的机票，请稍等...' },
        { role: 'user', content: '我要早上8点的' },
        { role: 'assistant', content: '找到了早上8点的东航MU5101，起飞时间8:00，到达10:30' },
        { role: 'user', content: '帮我订这张机票' },
        { role: 'assistant', content: '好的，正在为您订票...' },
      ];

      const nightSessionKey = 'feishu:direct:user001:2026-03-22-23:00';
      plugin.saveSessionSnapshot(agentId, nightSessionKey, nightMessages);
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('会话快照已保存'));

      // === 第二天早上的新会话 ===
      const morningSessionKey = 'feishu:direct:user001:2026-03-23-06:00';

      // 检测会话切换
      const snapshot = plugin.detectSessionChangeAndGetSnapshot(agentId, morningSessionKey);
      expect(snapshot).not.toBeNull();
      expect(snapshot.summary).toContain('机票');
      expect(snapshot.context_snapshot).toContain('订这张机票');

      // 构建续接上下文
      const { text, tokens } = plugin.buildSessionContinuityContext(snapshot);
      expect(text).toContain('【上会话摘要】');
      expect(text).toContain('机票');
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThanOrEqual(800);

      console.log('\n=== 跨会话续接测试结果 ===');
      console.log('昨晚会话:', nightSessionKey);
      console.log('今早会话:', morningSessionKey);
      console.log('续接上下文 tokens:', tokens);
      console.log('续接上下文内容:\n', text);
    });

    test('场景：飞书用户，同一会话中途断开再连接', () => {
      const agentId = 'feishu-user-001';
      
      // 第一段对话
      const part1Messages = [
        { role: 'user', content: '我想学习编程' },
        { role: 'assistant', content: '好的，您想学习什么编程语言？' },
        { role: 'user', content: 'Python' },
      ];

      const part1SessionKey = 'feishu:direct:ou_123:2026-03-23-11:00';
      plugin.saveSessionSnapshot(agentId, part1SessionKey, part1Messages);

      // 第二段对话（同一 sessionKey）
      const part2SessionKey = 'feishu:direct:ou_123:2026-03-23-11:05';
      const snapshot = plugin.detectSessionChangeAndGetSnapshot(agentId, part2SessionKey);
      
      // 同一会话，不需要续接
      expect(snapshot).toBeNull();
      console.log('\n=== 同一会话续接测试 ===');
      console.log('结果: 正确识别为同一会话，未触发续接');
    });
  });

  describe('7. 边界条件测试', () => {
    test('空 sessionKey 应正常处理', () => {
      const agentId = 'test-empty-skey';
      const snapshot = {
        summary: '',
        context_snapshot: '',
        agent_id: agentId,
        session_key: '',
        ended_at: Date.now(),
        message_count: 0,
        total_tokens: 0,
      };

      const { text, tokens } = plugin.buildSessionContinuityContext(snapshot);
      expect(text).toBe('');
      expect(tokens).toBe(0);
    });

    test('大量消息应正确截断', () => {
      const agentId = 'test-many-messages';
      const manyMessages = Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `消息内容第${i + 1}条 - ${'测试内容'.repeat(20)}`,
      }));

      plugin.saveSessionSnapshot(agentId, 'big-session', manyMessages);

      const snapshot = plugin.getLastSessionSnapshot(agentId);
      expect(snapshot.message_count).toBe(100);
      expect(snapshot.summary.length).toBeLessThan(5000); // 摘要不应过长
    });

    test('特殊字符应正确处理', () => {
      const agentId = 'test-special-chars';
      const messages = [
        { role: 'user', content: '你好👋🎉' },
        { role: 'assistant', content: 'Hi there! 😊' },
        { role: 'user', content: '测试表情和emoji 😎🤔👍' },
      ];

      plugin.saveSessionSnapshot(agentId, 'emoji-session', messages);
      const snapshot = plugin.getLastSessionSnapshot(agentId);

      expect(snapshot).not.toBeNull();
      expect(snapshot.summary).toContain('你好');
      expect(snapshot.context_snapshot).toContain('emoji');
    });
  });
});

console.log('测试文件加载成功');
