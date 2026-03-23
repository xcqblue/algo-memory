/**
 * algo-memory 综合流程模拟 - 多场景测试
 * 
 * 测试场景：
 * 1. 正常会话流程
 * 2. 会话切换检测
 * 3. Gateway 重启恢复
 * 4. Edge Case: 空消息
 * 5. Edge Case: 极长消息
 * 6. Edge Case: 特殊字符
 * 7. Edge Case: 快速连续切换
 * 8. Edge Case: 跨日期会话
 * 9. 稳定性检查
 */

import crypto from 'crypto';

function generateId() {
  return 'id_' + crypto.randomBytes(6).toString('hex');
}

function estimateTokens(text) {
  if (!text) return 0;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjk = text.length - cjkChars;
  return cjkChars + Math.ceil(nonCjk / 4);
}

function normalizeForStorage(content) {
  return content
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

// ============= 配置 =============

const CONFIG = {
  sessionContinuity: { enabled: true, maxInjectTokens: 800, maxMessagesForSummary: 30 },
  cleanupDays: 180,
  snapshotRetentionDays: 7,
};

// ============= 模拟数据库 =============

class MockDatabase {
  constructor() {
    this.memories = [];
    this.snapshots = [];
    this.metadata = [];
    this.logs = [];
  }

  log(action, data) {
    this.logs.push({ action, data, time: Date.now() });
  }
}

// ============= 插件核心类 =============

class MemoryPlugin {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.lastSessionKey = new Map();
    this.lastRecallQuery = new Map();
  }

  // 从多个来源获取 agentId
  resolveAgentId(event, ctx) {
    return ctx?.agentId || event?.agentId || ctx?.sessionKey?.split(':')[2] || 'default';
  }

  // 生成会话摘要
  generateSessionSummary(messages, maxMessages = 30) {
    if (!messages || messages.length === 0) return '';
    const recentMessages = messages.slice(-maxMessages);
    const lines = [];
    for (const msg of recentMessages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        const content = msg.content.length > 200 ? msg.content.substring(0, 200) + '...' : msg.content;
        lines.push(`用户: ${content}`);
      } else if (msg.role === 'assistant' && msg.content && !msg.isError) {
        const content = typeof msg.content === 'string'
          ? (msg.content.length > 200 ? msg.content.substring(0, 200) + '...' : msg.content)
          : '[助手回复]';
        lines.push(`助手: ${content}`);
      }
    }
    return lines.join('\n');
  }

  // 提取上下文快照
  extractContextSnapshot(messages, maxMessages = 30) {
    if (!messages || messages.length === 0) return '';
    const recentMessages = messages.slice(-maxMessages);
    const seen = new Set();
    const lines = [];

    for (const msg of recentMessages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        const normalized = normalizeForStorage(msg.content);
        if (normalized.length < 3) continue;
        const key = normalized.substring(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);
        const content = normalized.length > 300 ? normalized.substring(0, 300) + '...' : normalized;
        lines.push(`用户: ${content}`);
      } else if (msg.role === 'assistant' && msg.content && !msg.isError) {
        const content = typeof msg.content === 'string' ? normalizeForStorage(msg.content) : '';
        if (!content || content.length < 3) continue;
        const key = 'a:' + content.substring(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);
        const truncated = content.length > 300 ? content.substring(0, 300) + '...' : content;
        lines.push(`助手: ${truncated}`);
      }
    }
    return lines.join('\n');
  }

  // 保存会话快照
  saveSessionSnapshot(agentId, sessionKey, messages) {
    if (!this.config.sessionContinuity.enabled) return null;
    if (!messages || messages.length === 0) return null;

    const maxMessages = this.config.sessionContinuity.maxMessagesForSummary || 30;
    const summary = this.generateSessionSummary(messages, maxMessages);
    const contextSnapshot = this.extractContextSnapshot(messages, maxMessages);
    const messageCount = messages.length;
    const totalTokens = estimateTokens(JSON.stringify(messages));

    const snapshot = {
      id: 'snap_' + generateId(),
      agent_id: agentId,
      session_key: sessionKey,
      ended_at: Date.now(),
      summary,
      context_snapshot: contextSnapshot,
      message_count: messageCount,
      total_tokens: totalTokens,
      created_at: Date.now(),
    };

    this.db.snapshots.push(snapshot);
    this.db.log('SAVE_SNAPSHOT', { agentId, sessionKey, messageCount, totalTokens });

    // 持久化 lastSessionKey
    const metaIndex = this.db.metadata.findIndex(m => m.agent_id === agentId);
    const meta = { agent_id: agentId, last_session_key: sessionKey, updated_at: Date.now() };
    if (metaIndex >= 0) {
      this.db.metadata[metaIndex] = meta;
    } else {
      this.db.metadata.push(meta);
    }

    this.lastSessionKey.set(agentId, sessionKey);
    return snapshot;
  }

  // 检测会话切换
  detectSessionChangeAndGetSnapshot(agentId, currentSessionKey) {
    if (!this.config.sessionContinuity.enabled) return null;

    const lastKey = this.lastSessionKey.get(agentId);
    this.db.log('DETECT', { agentId, lastKey, currentSessionKey });

    if (lastKey === currentSessionKey) {
      return null;
    }

    this.lastSessionKey.set(agentId, currentSessionKey);

    if (!lastKey) {
      return null;
    }

    // 查找上会话快照
    const snapshot = this.db.snapshots
      .filter(s => s.agent_id === agentId)
      .sort((a, b) => b.ended_at - a.ended_at)[0];

    if (snapshot) {
      this.db.log('SESSION_CHANGE', { from: lastKey, to: currentSessionKey });
    }

    return snapshot;
  }

  // 构建续接上下文
  buildSessionContinuityContext(snapshot) {
    if (!snapshot) return { text: '', tokens: 0 };

    const maxTokens = this.config.sessionContinuity.maxInjectTokens || 800;
    const lines = [];

    if (snapshot.summary) {
      lines.push('【上会话摘要】');
      const summaryLines = snapshot.summary.split('\n').slice(-10);
      for (const line of summaryLines) {
        if (estimateTokens(lines.join('\n') + '\n' + line) <= maxTokens) {
          lines.push(line);
        }
      }
    }

    if (snapshot.context_snapshot) {
      lines.push('');
      lines.push('【上会话详情】');
      const contextLines = snapshot.context_snapshot.split('\n').slice(-20);
      for (const line of contextLines) {
        if (estimateTokens(lines.join('\n') + '\n' + line) <= maxTokens) {
          lines.push(line);
        } else {
          break;
        }
      }
    }

    const text = lines.join('\n');
    return { text, tokens: estimateTokens(text) };
  }

  // 清理过期快照
  cleanupSnapshots() {
    const cutoff = Date.now() - this.config.snapshotRetentionDays * 24 * 60 * 60 * 1000;
    const before = this.db.snapshots.length;
    this.db.snapshots = this.db.snapshots.filter(s => s.ended_at >= cutoff);
    const deleted = before - this.db.snapshots.length;
    if (deleted > 0) {
      this.db.log('CLEANUP_SNAPSHOTS', { deleted, remaining: this.db.snapshots.length });
    }
    return deleted;
  }

  // 从数据库恢复
  restoreLastSessionKey(agentId) {
    const meta = this.db.metadata.find(m => m.agent_id === agentId);
    if (meta?.last_session_key) {
      this.lastSessionKey.set(agentId, meta.last_session_key);
      this.db.log('RESTORE', { agentId, lastSessionKey: meta.last_session_key });
    }
  }
}

// ============= 模拟 API =============

class MockApi {
  constructor() {
    this.hooks = {};
    this.injectedContexts = [];
  }

  on(event, handler) {
    this.hooks[event] = handler;
  }

  prependSystemContext(text) {
    const tokens = estimateTokens(text);
    this.injectedContexts.push({ text, tokens });
  }

  // trigger 接受两个参数: event(字符串) 和 data(包含所有数据的对象)
  trigger(eventName, data) {
    if (this.hooks[eventName]) {
      this.hooks[eventName](data, {});
    }
  }
}

// ============= 测试场景 =============

function runTests() {
  console.log('='.repeat(70));
  console.log('algo-memory 综合流程模拟 - 多场景测试');
  console.log('='.repeat(70));

  const results = [];
  let testNum = 0;

  function assert(name, condition, expected, actual) {
    testNum++;
    const pass = condition;
    results.push({ num: testNum, name, pass, expected, actual });
    console.log(`\n[测试${testNum}] ${name}`);
    console.log(`  ${pass ? '✅ 通过' : '❌ 失败'}`);
    if (!pass) {
      console.log(`  期望: ${expected}`);
      console.log(`  实际: ${actual}`);
    }
    return pass;
  }

  const db = new MockDatabase();
  const plugin = new MemoryPlugin(CONFIG, db);
  const api = new MockApi();

  // 注册 hooks
  api.on('session_start', (data) => {
    const agentId = plugin.resolveAgentId(data, {});
    const sessionKey = data?.sessionKey || 'unknown';
    const snapshot = plugin.detectSessionChangeAndGetSnapshot(agentId, sessionKey);
    if (snapshot) {
      const { text, tokens } = plugin.buildSessionContinuityContext(snapshot);
      if (text && tokens > 0) {
        api.prependSystemContext('\n\n' + text + '\n');
      }
    }
  });

  api.on('agent_end', (data) => {
    const agentId = plugin.resolveAgentId(data, {});
    const sessionKey = data?.sessionKey || 'unknown';
    const messages = data?.messages || [];
    plugin.saveSessionSnapshot(agentId, sessionKey, messages);
  });

  // ============================================================
  // 场景1: 正常首次会话
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景1: 正常首次会话');
  console.log('='.repeat(70));

  api.trigger('session_start', { sessionKey: 'feishu:direct:user001:2026-03-23-10:00', agentId: 'main' });
  assert('首次会话不应注入上下文', api.injectedContexts.length === 0, 0, api.injectedContexts.length);

  api.trigger('agent_end', { messages: [{ role: 'user', content: '你好' }], agentId: 'main', sessionKey: 'feishu:direct:user001:2026-03-23-10:00' });
  assert('首次会话应保存快照', db.snapshots.length === 1, 1, db.snapshots.length);

  // ============================================================
  // 场景2: 同一会话继续
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景2: 同一会话继续');
  console.log('='.repeat(70));

  api.injectedContexts = [];
  api.trigger('session_start', { sessionKey: 'feishu:direct:user001:2026-03-23-10:00', agentId: 'main' });
  assert('同一会话不应注入上下文', api.injectedContexts.length === 0, 0, api.injectedContexts.length);

  // ============================================================
  // 场景3: 会话切换
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景3: 会话切换');
  console.log('='.repeat(70));

  api.trigger('session_start', { sessionKey: 'feishu:direct:user001:2026-03-23-14:00', agentId: 'main' });
  assert('会话切换应注入上下文', api.injectedContexts.length === 1, 1, api.injectedContexts.length);
  if (api.injectedContexts.length > 0) {
    assert('注入的上下文应包含摘要', api.injectedContexts[0].text.includes('【上会话摘要】'), true, api.injectedContexts[0].text.includes('【上会话摘要】'));
    assert('注入的上下文应在token限制内', api.injectedContexts[0].tokens <= CONFIG.sessionContinuity.maxInjectTokens, true, api.injectedContexts[0].tokens);
  }

  api.trigger('agent_end', { messages: [{ role: 'user', content: '继续订票' }], agentId: 'main', sessionKey: 'feishu:direct:user001:2026-03-23-14:00' });

  // ============================================================
  // 场景4: Gateway 重启恢复
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景4: Gateway 重启恢复');
  console.log('='.repeat(70));

  const savedLastSessionKey = plugin.lastSessionKey.get('main');
  plugin.lastSessionKey.clear();
  console.log('  [模拟] Gateway 重启，内存丢失');

  plugin.restoreLastSessionKey('main');
  const restored = plugin.lastSessionKey.get('main');
  assert('重启后应从数据库恢复 lastSessionKey', restored === savedLastSessionKey, savedLastSessionKey, restored);

  api.injectedContexts = [];
  api.trigger('session_start', { sessionKey: 'feishu:direct:user001:2026-03-23-18:00', agentId: 'main' });
  assert('重启后切换会话应注入上下文', api.injectedContexts.length === 1, 1, api.injectedContexts.length);

  // ============================================================
  // 场景5: Edge Case - 空消息
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景5: Edge Case - 空消息');
  console.log('='.repeat(70));

  const snapshotCountBefore = db.snapshots.length;
  api.trigger('agent_end', { messages: [], agentId: 'main', sessionKey: 'feishu:direct:user001:2026-03-23-18:30' });
  assert('空消息不应保存快照', db.snapshots.length === snapshotCountBefore, snapshotCountBefore, db.snapshots.length);

  api.trigger('agent_end', { messages: null, agentId: 'main', sessionKey: 'feishu:direct:user001:2026-03-23-18:31' });
  assert('null 消息不应保存快照', db.snapshots.length === snapshotCountBefore, snapshotCountBefore, db.snapshots.length);

  // ============================================================
  // 场景6: Edge Case - 极长消息
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景6: Edge Case - 极长消息');
  console.log('='.repeat(70));

  const longContent = 'A'.repeat(10000);
  api.trigger('agent_end', { messages: [{ role: 'user', content: longContent }], agentId: 'main', sessionKey: 'feishu:direct:user001:2026-03-23-19:00' });

  const lastSnapshot = db.snapshots[db.snapshots.length - 1];
  assert('长消息应保存快照', lastSnapshot !== undefined, true, lastSnapshot);
  if (lastSnapshot) {
    assert('长消息摘要应被截断', lastSnapshot.summary.length <= 250, true, lastSnapshot.summary.length);
    assert('长消息上下文应被截断', lastSnapshot.context_snapshot.length <= 350, true, lastSnapshot.context_snapshot.length);
  }

  // ============================================================
  // 场景7: Edge Case - 特殊字符
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景7: Edge Case - 特殊字符');
  console.log('='.repeat(70));

  api.trigger('agent_end', {
    messages: [
      { role: 'user', content: 'Hello 👋🎉 你好 😎' },
      { role: 'assistant', content: 'Hi there! 😊 你好！' },
      { role: 'user', content: '```js\nconsole.log("test")\n```' },
    ],
    agentId: 'main',
    sessionKey: 'feishu:direct:user001:2026-03-23-19:30'
  });

  const emojiSnapshot = db.snapshots[db.snapshots.length - 1];
  assert('emoji消息应保存快照', emojiSnapshot !== undefined, true, emojiSnapshot);
  if (emojiSnapshot) {
    // emoji可能被保留（取决于normalizeForStorage的处理）
    const hasEmoji = emojiSnapshot.summary.includes('👋') || emojiSnapshot.summary.includes('Hello');
    assert('emoji或内容应被保留', hasEmoji, true, hasEmoji);
    // 代码块被normalizeForStorage替换，检查context_snapshot而非summary
    assert('代码块应在上下文中被替换', emojiSnapshot.context_snapshot.includes('[代码块]'), true, emojiSnapshot.context_snapshot.includes('[代码块]'));
  }

  // ============================================================
  // 场景8: Edge Case - 快速连续切换
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景8: Edge Case - 快速连续切换');
  console.log('='.repeat(70));

  api.injectedContexts = [];
  const rapidSessions = [
    'feishu:direct:user001:2026-03-23-20:00',
    'feishu:direct:user001:2026-03-23-20:01',
    'feishu:direct:user001:2026-03-23-20:02',
  ];

  for (const sk of rapidSessions) {
    api.trigger('session_start', { sessionKey: sk, agentId: 'main' });
  }
  // 每次 session 切换都会注入，这是正确行为
  assert('快速连续切换每次都注入（设计如此）', api.injectedContexts.length === 3, 3, api.injectedContexts.length);

  // ============================================================
  // 场景9: Edge Case - 跨日期会话
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景9: Edge Case - 跨日期会话');
  console.log('='.repeat(70));

  const oldSession = {
    id: 'snap_old',
    agent_id: 'main',
    session_key: 'feishu:direct:user001:2026-03-15-23:00',
    ended_at: Date.now() - 8 * 24 * 60 * 60 * 1000,
    summary: '旧会话摘要',
    context_snapshot: '旧会话详情',
    message_count: 5,
    total_tokens: 100,
    created_at: Date.now() - 8 * 24 * 60 * 60 * 1000,
  };
  db.snapshots.push(oldSession);

  api.injectedContexts = [];
  api.trigger('session_start', { sessionKey: 'feishu:direct:user001:2026-03-23-10:00', agentId: 'main' });
  assert('新会话应注入快照', api.injectedContexts.length === 1, 1, api.injectedContexts.length);
  if (api.injectedContexts.length > 0) {
    const injectedText = api.injectedContexts[0].text;
    // 旧会话的summary是"旧会话摘要"，检查注入的不应是旧的
    const hasOldContent = injectedText.includes('旧会话摘要');
    assert('注入的不应是最旧的8天前的会话', !hasOldContent, false, hasOldContent);
  }

  // ============================================================
  // 场景10: 清理过期快照
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景10: 清理过期快照');
  console.log('='.repeat(70));

  const beforeCleanup = db.snapshots.length;
  const deleted = plugin.cleanupSnapshots();
  const afterCleanup = db.snapshots.length;
  assert('清理应删除过期快照', beforeCleanup > afterCleanup, true, beforeCleanup > afterCleanup);
  assert('应保留7天内的快照', db.snapshots.every(s => s.ended_at >= Date.now() - CONFIG.snapshotRetentionDays * 24 * 60 * 60 * 1000), true, true);

  // ============================================================
  // 场景11: 多 Agent 隔离
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景11: 多 Agent 隔离');
  console.log('='.repeat(70));

  api.trigger('agent_end', { messages: [{ role: 'user', content: 'Agent B 的消息' }], agentId: 'agent_b', sessionKey: 'feishu:direct:user002:2026-03-23-10:00' });

  api.injectedContexts = [];
  api.trigger('session_start', { sessionKey: 'feishu:direct:user001:2026-03-23-22:00', agentId: 'main' });

  const agentAHasAgentBMemory = api.injectedContexts.some(ctx => ctx.text.includes('Agent B'));
  assert('Agent A 不应看到 Agent B 的记忆', !agentAHasAgentBMemory, false, agentAHasAgentBMemory);

  // ============================================================
  // 场景12: 消息去重测试
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📋 场景12: 消息去重测试');
  console.log('='.repeat(70));

  api.trigger('agent_end', {
    messages: [
      { role: 'user', content: '同样的问题' },
      { role: 'user', content: '同样的问题' },
      { role: 'user', content: '同样的问题' },
    ],
    agentId: 'main',
    sessionKey: 'feishu:direct:user001:2026-03-23-23:00'
  });

  const dedupSnapshot = db.snapshots[db.snapshots.length - 1];
  if (dedupSnapshot) {
    // 注意：去重在 context_snapshot 中进行，不在 summary 中
    // summary 保留原始消息（便于理解），context_snapshot 去重（节省空间）
    const summaryLines = dedupSnapshot.summary.split('\n').filter(l => l.includes('同样的问题')).length;
    const contextLines = dedupSnapshot.context_snapshot.split('\n').filter(l => l.includes('同样的问题')).length;
    assert('summary 保留所有消息', summaryLines === 3, 3, summaryLines);
    assert('context_snapshot 应去重', contextLines <= 1, 1, contextLines);
  }

  // ============================================================
  // 结果汇总
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('📊 测试结果汇总');
  console.log('='.repeat(70));

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log(`\n总计: ${testNum} 个测试`);
  console.log(`  ✅ 通过: ${passed}`);
  console.log(`  ❌ 失败: ${failed}`);

  if (failed > 0) {
    console.log('\n失败的测试:');
    results.filter(r => !r.pass).forEach(r => {
      console.log(`  [${r.num}] ${r.name}`);
    });
  }

  // ============================================================
  // 稳定性分析
  // ============================================================
  console.log('\n\n' + '='.repeat(70));
  console.log('🔍 稳定性分析');
  console.log('='.repeat(70));

  const stabilityIssues = [];

  // 检查1: sessionKey 获取
  const noUnknownKey = db.logs.every(log =>
    log.action !== 'SAVE_SNAPSHOT' || log.data.sessionKey !== 'unknown'
  );
  stabilityIssues.push({
    type: noUnknownKey ? '🟢' : '🟡',
    issue: 'sessionKey 获取',
    detail: noUnknownKey ? '所有快照都获取到了有效的 sessionKey' : '部分快照使用了 unknown'
  });

  // 检查2: 内存与数据库一致性
  const memKeys = Array.from(plugin.lastSessionKey.entries());
  const dbKeys = db.metadata.map(m => ({ agentId: m.agent_id, key: m.last_session_key }));
  const memDbConsistent = memKeys.every(([aid, key]) =>
    dbKeys.find(m => m.agentId === aid && m.key === key)
  );
  stabilityIssues.push({
    type: memDbConsistent ? '🟢' : '🔴',
    issue: '内存与数据库一致性',
    detail: memDbConsistent ? 'lastSessionKey 内存与数据库同步' : '存在不一致'
  });

  // 检查3: token 限制
  const allWithinLimit = api.injectedContexts.every(ctx => ctx.tokens <= CONFIG.sessionContinuity.maxInjectTokens);
  stabilityIssues.push({
    type: allWithinLimit ? '🟢' : '🔴',
    issue: 'Token 限制',
    detail: allWithinLimit ? `所有注入的上下文都在 ${CONFIG.sessionContinuity.maxInjectTokens} tokens 限制内` : '存在超出限制'
  });

  stabilityIssues.forEach(issue => {
    console.log(`\n${issue.type} ${issue.issue}`);
    console.log(`   ${issue.detail}`);
  });

  console.log('\n\n' + '='.repeat(70));
  console.log('✅ 模拟完成');
  console.log('='.repeat(70));
  console.log(`\n测试结果: ${passed}/${testNum} 通过`);
  if (failed === 0) {
    console.log('所有核心功能测试通过！');
  }

  return { passed, failed, total: testNum };
}

// 运行测试
const { passed, failed, total } = runTests();
process.exit(failed > 0 ? 1 : 0);
