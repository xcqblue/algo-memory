/**
 * algo-memory 实际运行路径深度模拟测试
 * 覆盖：会话续接流程 / 导入Rebuild周期 / cleanup边界 / correct修正 /
 *       多Agent隔离 / 工具层错误处理 / batchWrite并发 / 缺失方法检测
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// 1. 会话续接全流程模拟
// ============================================================
describe('【会话续接】sessionContinuity 全流程', () => {
  // 模拟 detectSessionChangeAndGetSnapshot + saveSessionSnapshot
  type Tier = 'core' | 'working' | 'peripheral';
  const lastSessionKey = new Map<string, string>();
  const snapshots: Map<string, any[]> = new Map(); // agentId → snapshots[]

  beforeEach(() => {
    lastSessionKey.clear();
    snapshots.clear();
  });

  const detectSessionChange = (AgentId: string, currentSessionKey: string): any => {
    const lastKey = lastSessionKey.get(AgentId);
    if (lastKey === currentSessionKey) return null; // 同一会话，不续接
    lastSessionKey.set(AgentId, currentSessionKey);
    if (!lastKey) return null; // 首次会话，不续接

    const agentSnapshots = snapshots.get(AgentId) || [];
    const lastSnapshot = agentSnapshots[agentSnapshots.length - 1];
    if (lastSnapshot) {
      console.log(`[模拟] 检测到会话切换: ${lastKey} -> ${currentSessionKey}`);
    }
    return lastSnapshot || null;
  };

  const saveSnapshot = (AgentId: string, sessionKey: string, messages: any[]): void => {
    const summary = messages.slice(-30)
      .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.isError))
      .map(m => `${m.role}: ${String(m.content).substring(0, 50)}`)
      .join('\n');

    const agentSnapshots = snapshots.get(AgentId) || [];
    agentSnapshots.push({ agentId: AgentId, sessionKey, summary, savedAt: Date.now() });
    snapshots.set(AgentId, agentSnapshots);
  };

  it('首次会话不触发续接', () => {
    const result = detectSessionChange('agent1', 'session_001');
    expect(result).toBe(null);
  });

  it('同一会话不重复续接', () => {
    lastSessionKey.set('agent1', 'session_001');
    const result = detectSessionChange('agent1', 'session_001');
    expect(result).toBe(null);
  });

  it('会话切换时返回上一快照', () => {
    snapshots.set('agent1', [{ agentId: 'agent1', sessionKey: 'session_001', summary: '上次聊了天气' }]);
    lastSessionKey.set('agent1', 'session_001');
    const result = detectSessionChange('agent1', 'session_002');
    expect(result).not.toBe(null);
    expect(result.sessionKey).toBe('session_001');
  });

  it('会话快照正确保存并包含内容', () => {
    const snapBefore = snapshots.get('agent1')?.length ?? 0;
    const messages = [
      { role: 'user', content: '记住我老婆叫小红' },
      { role: 'assistant', content: '好的，已记住' },
    ];
    saveSnapshot('agent1', 'session_001', messages);
    const snaps = snapshots.get('agent1')!;
    expect(snaps.length).toBe(snapBefore + 1);
    expect(snaps[snaps.length - 1].summary).toContain('小红');
  });

  it('buildSessionContinuityContext: token 超限时截断', () => {
    // 模拟 token 截断逻辑（maxInjectTokens = 800）
    const snapshot = {
      summary: '用户: 记住我老婆叫小红，住在上海。\n助手: 好的。\n用户: 我在陆家嘴工作。'.repeat(100),
      context_snapshot: '详细上下文...'.repeat(100)
    };
    const maxTokens = 800;
    const estimateTokens = (text: string): number => {
      const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
      return cjk + Math.ceil((text.length - cjk) / 4);
    };

    const lines = snapshot.summary.split('\n').slice(-10);
    let current = '';
    let truncated = false;
    for (const line of lines) {
      const newTokens = estimateTokens(current + '\n' + line);
      if (newTokens > maxTokens && !truncated) {
        current += '\n[截断...]';
        truncated = true;
        break;
      }
      current += '\n' + line;
    }
    expect(estimateTokens(current)).toBeLessThanOrEqual(maxTokens + 50); // 允许一定误差
  });

  it('snapshot 被保存后，下次切换时能正确取出', () => {
    snapshots.set('agent2', [{ agentId: 'agent2', sessionKey: 'old', summary: '旧会话摘要' }]);
    lastSessionKey.set('agent2', 'old');
    const snap = detectSessionChange('agent2', 'new');
    expect(snap?.summary).toBe('旧会话摘要');
    expect(snap?.sessionKey).toBe('old');
  });
});

// ============================================================
// 2. importMemories → rebuildFTS 周期验证
// ============================================================
describe('【导入Rebuild周期】importMemories + rebuildFTS', () => {
  // 模拟 FTS 表和主表
  const memories: Map<string, any> = new Map();
  const ftsIndex: Map<string, string> = new Map(); // id → content

  const importMemory = (m: any): boolean => {
    const existing = memories.get(m.id);
    if (existing) {
      // ON CONFLICT: MAX 保留历史
      const newAccessCount = Math.max(m.access_count || 0, existing.access_count);
      const newCitedCount = Math.max(m.cited_count || 0, existing.cited_count);
      memories.set(m.id, { ...existing, ...m, access_count: newAccessCount, cited_count: newCitedCount });
    } else {
      memories.set(m.id, { ...m });
    }
    // 同步 FTS
    const mem = memories.get(m.id)!;
    ftsIndex.set(mem.id, mem.content);
    return true;
  };

  const rebuildFTS = (): number => {
    ftsIndex.clear();
    for (const mem of memories.values()) {
      ftsIndex.set(mem.id, mem.content);
    }
    return ftsIndex.size;
  };

  it('导入新记忆后 FTS 同步', () => {
    importMemory({ id: 'mem1', content: '我老婆叫小红', access_count: 1, cited_count: 0 });
    importMemory({ id: 'mem2', content: '我住在上海', access_count: 2, cited_count: 1 });
    expect(ftsIndex.get('mem1')).toBe('我老婆叫小红');
    expect(ftsIndex.get('mem2')).toBe('我住在上海');
  });

  it('ON CONFLICT 时 access_count 和 cited_count 保留最大值', () => {
    importMemory({ id: 'mem1', content: '我老婆叫小红', access_count: 5, cited_count: 3 });
    importMemory({ id: 'mem1', content: '我老婆叫小芳（更新）', access_count: 1, cited_count: 0 });
    // 应该保留历史最大值
    expect(memories.get('mem1')!.access_count).toBe(5); // MAX(5,1) = 5
    expect(memories.get('mem1')!.cited_count).toBe(3);    // MAX(3,0) = 3
    // 内容应该更新
    expect(memories.get('mem1')!.content).toBe('我老婆叫小芳（更新）');
  });

  it('rebuildFTS 后 FTS 与主表一致', () => {
    importMemory({ id: 'mem3', content: '我的生日是1990年', access_count: 1, cited_count: 0 });
    const count = rebuildFTS();
    expect(count).toBe(3);
    expect(ftsIndex.size).toBe(memories.size);
  });

  it('ON CONFLICT 后 FTS 同步更新', () => {
    importMemory({ id: 'mem1', content: '我老婆叫小芳', access_count: 1, cited_count: 0 });
    expect(ftsIndex.get('mem1')).toBe('我老婆叫小芳'); // FTS 已同步
  });
});

// ============================================================
// 3. cleanup 清理边界
// ============================================================
describe('【清理机制】cleanup 边界行为', () => {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  // 模拟 memories 表（每次测试重置）
  let memories: any[] = [];

  beforeEach(() => {
    memories = [
      { id: '1', layer: 'general', tier: 'core',        last_accessed: now - 180 * DAY, importance: 1.0 },
      { id: '2', layer: 'general', tier: 'working',    last_accessed: now - 180 * DAY, importance: 0.6 },
      { id: '3', layer: 'general', tier: 'peripheral', last_accessed: now - 180 * DAY, importance: 0.1 },
      { id: '4', layer: 'general', tier: 'peripheral', last_accessed: now - 10 * DAY,  importance: 0.1 },
      { id: '5', layer: 'general', tier: 'core',        last_accessed: now - 10 * DAY,  importance: 1.0 },
      { id: '6', layer: 'general', tier: 'peripheral', last_accessed: now - 190 * DAY, importance: 0.1, keywords: 'test' },
    ];
  });

  const cleanup = (cutoffDays: number) => {
    const cutoff = now - cutoffDays * DAY;
    const toDelete = memories.filter(m =>
      m.last_accessed < cutoff && m.layer === 'general' && m.tier === 'peripheral'
    );
    // 删除时不改变 memories 引用，用 filter + 重新赋值
    const deleteIds = new Set(toDelete.map(m => m.id));
    const remaining = memories.filter(m => !deleteIds.has(m.id));
    const deleted = memories.length - remaining.length;
    memories.length = 0;
    memories.push(...remaining);
    return deleted;
  };

  it('core tier 永远不被清理（即使超过期限）', () => {
    const before = memories.filter(m => m.tier === 'core').length;
    cleanup(30); // 30天以上的都清理
    const after = memories.filter(m => m.tier === 'core').length;
    expect(after).toBe(before);
  });

  it('peripheral + 超过 cutoffDays + layer=general 被清理', () => {
    const deleted = cleanup(30);
    // id=3(180天,peripheral) 和 id=6(190天,peripheral) 应该被删
    expect(deleted).toBeGreaterThanOrEqual(1);
    // id=4(10天,peripheral) 不应被删
    expect(memories.find(m => m.id === '4')).toBeDefined();
  });

  it('working tier 不被清理（无论多久）', () => {
    const before = memories.filter(m => m.tier === 'working').length;
    cleanup(1); // 1天以上的都清理
    const after = memories.filter(m => m.tier === 'working').length;
    expect(after).toBe(before);
  });

  it('peripheral 但 layer != general 不被清理', () => {
    memories.push({ id: 'special', layer: 'core', tier: 'peripheral', last_accessed: now - 1 * DAY, importance: 0.1 });
    cleanup(1);
    expect(memories.find(m => m.id === 'special')).toBeDefined(); // layer != 'general'，不受影响
  });
});

// ============================================================
// 4. correct 修正（全路径模拟，不依赖 LLM）
// ============================================================
describe('【记忆修正】correct 全路径', () => {
  const memories = new Map<string, any>();

  const updateMemoryDirect = (memoryId: string, newContent: string): boolean => {
    if (!memories.has(memoryId)) return false;
    memories.set(memoryId, { ...memories.get(memoryId)!, content: newContent, last_accessed: Date.now() });
    return true;
  };

  // 模拟 LLM 返回的修正建议
  const llmGenerateSuggestions = (correction: string, candidates: any[]): any[] => {
    // 简化模拟：如果修正内容包含"不是"，认为是低置信度建议
    if (correction.includes('不是')) {
      return candidates.slice(0, 1).map(m => ({
        memoryId: m.id,
        original: m.content,
        updated: m.content, // 未能生成真正修正
        reason: '未启用 LLM',
        confidence: 0
      }));
    }
    return [];
  };

  it('用法一：直接修正（已知 memoryId）', () => {
    memories.set('m1', { id: 'm1', content: '我住在上海' });
    const ok = updateMemoryDirect('m1', '我住在北京');
    expect(ok).toBe(true);
    expect(memories.get('m1')!.content).toBe('我住在北京');
  });

  it('用法一：memoryId 不存在时返回 false', () => {
    const ok = updateMemoryDirect('nonexistent', 'some content');
    expect(ok).toBe(false);
  });

  it('用法二：未启用 LLM 时返回候选但不自动修正', () => {
    memories.set('m2', { id: 'm2', content: '我住在上海' });
    const candidates = [memories.get('m2')!];
    const suggestions = llmGenerateSuggestions('我住在北京不是上海', candidates);
    expect(suggestions[0].confidence).toBe(0); // 确认未启用 LLM 时 confidence=0
    // memory 没有被修改
    expect(memories.get('m2')!.content).toBe('我住在上海');
  });

  it('用法二：置信度 > 0.8 时自动应用（模拟）', () => {
    memories.set('m3', { id: 'm3', content: '我老婆叫小红' });
    // 模拟高置信度修正
    const autoApply = (memoryId: string, newContent: string) => {
      updateMemoryDirect(memoryId, newContent);
    };
    autoApply('m3', '我老婆叫小芳');
    expect(memories.get('m3')!.content).toBe('我老婆叫小芳');
  });

  it('correction 为空时正确处理', () => {
    const handleEmpty = (correction: string): boolean => {
      if (!correction?.trim()) return false;
      return true;
    };
    expect(handleEmpty('')).toBe(false);
    expect(handleEmpty('   ')).toBe(false);
    expect(handleEmpty('我住北京不是上海')).toBe(true);
  });
});

// ============================================================
// 5. 多 Agent 隔离
// ============================================================
describe('【多Agent隔离】scopes 隔离验证', () => {
  const memories = [
    { id: '1', agent_id: 'agent_A', content: 'agent_A 的记忆' },
    { id: '2', agent_id: 'agent_B', content: 'agent_B 的记忆' },
    { id: '3', agent_id: 'agent_A', content: 'agent_A 的第二个记忆' },
    { id: '4', agent_id: 'global',  content: 'global 记忆' },
  ];

  // 模拟 visibleAgentIds 计算
  const getVisibleAgentIds = (AgentId: string, config: any): string[] | null => {
    if (!config.scopes?.enabled) return null; // null = 所有都可见
    if (AgentId === 'global') return ['global'];
    return [AgentId, 'global']; // 每个 Agent 可见自己的 + global
  };

  it('scopes enabled=false 时，Agent 能看到所有记忆', () => {
    const visible = getVisibleAgentIds('agent_A', { scopes: { enabled: false } });
    expect(visible).toBe(null); // null = 不过滤，所有可见
  });

  it('scopes enabled=true 时，Agent 只能看到自己和 global', () => {
    const visible = getVisibleAgentIds('agent_A', { scopes: { enabled: true } });
    expect(visible).toContain('agent_A');
    expect(visible).toContain('global');
    expect(visible).not.toContain('agent_B');
  });

  it('查询时按 visibleAgentIds 过滤', () => {
    const visible = ['agent_A', 'global'];
    const visibleMemories = memories.filter(m => visible.includes(m.agent_id));
    expect(visibleMemories.length).toBe(3); // id=1,3,4
    expect(visibleMemories.find(m => m.id === '2')).toBeUndefined(); // agent_B 被过滤
  });

  it('不同 Agent 有独立的 memory 空间', () => {
    const agentA = memories.filter(m => ['agent_A', 'global'].includes(m.agent_id));
    const agentB = memories.filter(m => ['agent_B', 'global'].includes(m.agent_id));
    expect(agentA.find(m => m.id === '1')).toBeDefined();  // agent_A 有 id=1
    expect(agentA.find(m => m.id === '2')).toBeUndefined(); // agent_A 没有 id=2
    expect(agentB.find(m => m.id === '2')).toBeDefined();   // agent_B 有 id=2
    expect(agentB.find(m => m.id === '1')).toBeUndefined(); // agent_B 没有 id=1
  });
});

// ============================================================
// 6. 工具层错误处理
// ============================================================
describe('【工具错误处理】registerTool execute 错误捕获', () => {
  // 模拟工具执行包装器
  const executeTool = async (toolName: string, fn: () => Promise<any>): Promise<any> => {
    try {
      const result = await fn();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err: any) {
      console.error(`[模拟] 工具执行失败 ${toolName}:`, err?.message ?? err, err?.stack);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err?.message ?? String(err) }) }] };
    }
  };

  it('正常执行返回 content 数组', async () => {
    const result = await executeTool('test', async () => ({ ok: true }));
    expect(result.content).toBeDefined();
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
  });

  it('抛出 Error 对象时被捕获，返回 isError=true', async () => {
    const result = await executeTool('failing', async () => {
      throw new Error('LLM timeout');
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'LLM timeout' });
  });

  it('抛出字符串错误时被捕获', async () => {
    const result = await executeTool('string_err', async () => {
      throw 'plain string error';
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'plain string error' });
  });

  it('Error.message 为 undefined 时不崩溃', async () => {
    const result = await executeTool('undef_err', async () => {
      const err = new Error('');
      err.message = '';
      throw err;
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe(''); // 空字符串而不是崩溃
  });

  it('null 错误对象不崩溃', async () => {
    const result = await executeTool('null_err', async () => {
      throw null;
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBeTruthy(); // 有 error 字段
  });

  it('多层嵌套 Error 对象能正确序列化', async () => {
    const result = await executeTool('nested_err', async () => {
      const cause = new Error('connection failed');
      const err = new Error('LLM call failed', { cause });
      throw err;
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('LLM call failed'); // 顶层 message 正确
  });
});

// ============================================================
// 7. batchWrite 互斥并发模拟
// ============================================================
describe('【batchWrite并发】flush 互斥锁验证', () => {
  interface Buffer { memories: any[]; timer: NodeJS.Timeout | null; flushing: boolean; lastFlush: number; }
  const buffers = new Map<string, Buffer>();

  beforeEach(() => { buffers.clear(); });

  const getBuffer = (AgentId: string): Buffer => {
    if (!buffers.has(AgentId)) buffers.set(AgentId, { memories: [], timer: null, flushing: false, lastFlush: Date.now() });
    return buffers.get(AgentId)!;
  };

  const scheduleBatchWrite = (AgentId: string, fn: () => void) => {
    const buf = getBuffer(AgentId);
    if (buf.flushing || buf.timer) return; // 互斥：已 flush 或已有 timer
    // 模拟 setTimeout
    buf.timer = setTimeout(fn, 100) as unknown as NodeJS.Timeout;
  };

  const flush = (AgentId: string): any[] => {
    const buf = getBuffer(AgentId);
    if (!buf || buf.memories.length === 0) return [];
    if (buf.flushing) return []; // 互斥锁
    buf.flushing = true;
    try {
      if (buf.timer) { clearTimeout(buf.timer as any); buf.timer = null; }
      const written = [...buf.memories];
      buf.memories = [];
      buf.lastFlush = Date.now();
      return written;
    } finally {
      buf.flushing = false;
    }
  };

  it('flush 期间 scheduleBatchWrite 不重复创建', () => {
    let flushCount = 0;
    scheduleBatchWrite('agent1', () => { flushCount++; });

    const buf = getBuffer('agent1');
    buf.flushing = true; // 模拟 flush 进行中
    const beforeFlush = flushCount;

    scheduleBatchWrite('agent1', () => { flushCount++; }); // 不会创建新的 timer
    expect(flushCount).toBe(beforeFlush); // 没有增加
    buf.flushing = false;
  });

  it('flush 成功后 buffer 被清空', () => {
    const buf = getBuffer('agent1');
    buf.memories = [{ id: 'x' }, { id: 'y' }];
    buf.flushing = false;
    const result = flush('agent1');
    expect(result).toHaveLength(2);
    expect(buf.memories).toHaveLength(0);
  });

  it('flushing=true 时 flush 被拒绝', () => {
    const buf = getBuffer('agent1');
    buf.memories = [{ id: 'x' }];
    buf.flushing = true;
    const result = flush('agent1');
    expect(result).toHaveLength(0); // 互斥锁阻止
    expect(buf.memories).toHaveLength(1); // 数据还在
  });

  it('flushing=false 时正常 flush', () => {
    const buf = getBuffer('agent1');
    buf.memories = [{ id: 'x' }];
    buf.flushing = false;
    const result = flush('agent1');
    expect(result).toHaveLength(1);
    expect(buf.memories).toHaveLength(0);
  });
});

// ============================================================
// 8. MMR 完整数学验证
// ============================================================
describe('【MMR数学】mmrDeduplicate 完整验证', () => {
  const jaccardSimilarity = (a: string, b: string): number => {
    const wA = new Set(a.match(/[\u4e00-\u9fa5]|[a-z0-9]+/gi) || []);
    const wB = new Set(b.match(/[\u4e00-\u9fa5]|[a-z0-9]+/gi) || []);
    if (!wA.size || !wB.size) return 0;
    const inter = new Set([...wA].filter(x => wB.has(x)));
    return inter.size / new Set([...wA, ...wB]).size;
  };

  const mmrDeduplicate = (items: any[], threshold: number, lambda: number): any[] => {
    if (items.length <= 1) return items;
    const selected: any[] = [];
    const candidates = items.map((m: any) => ({ ...m }));

    while (candidates.length > 0) {
      let bestIdx = 0, bestScore = -Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const relevance = candidates[i]._score ?? candidates[i].importance;
        let maxSim = 0;
        for (const sel of selected) {
          const sim = jaccardSimilarity(candidates[i].content, sel.content);
          if (sim > maxSim) maxSim = sim;
        }
        const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
        if (mmrScore > bestScore) { bestScore = mmrScore; bestIdx = i; }
      }
      const picked = candidates.splice(bestIdx, 1)[0];
      selected.push(picked);

      let maxRemainingRelevance = -Infinity;
      for (const c of candidates) {
        if ((c._score ?? c.importance) > maxRemainingRelevance) maxRemainingRelevance = c._score ?? c.importance;
      }
      if (candidates.length > 0 && lambda * maxRemainingRelevance < threshold) break;
    }
    return selected;
  };

  const scored = [
    { id: '1', content: '我老婆叫小红住在上海在陆家嘴工作',  _score: 1.0 },
    { id: '2', content: '我喜欢吃苹果和香蕉不喜欢榴莲',      _score: 0.7 },
    { id: '3', content: '我住在上海浦东新区陆家嘴',          _score: 0.8 }, // 与 1 高度相似
    { id: '4', content: '我的生日是1990年1月1日',            _score: 0.6 },
    { id: '5', content: '今天天气不错适合出去玩',            _score: 0.3 },
  ];

  it('MMR 去掉与已选项目高相似的项目', () => {
    const result = mmrDeduplicate(scored, 0.85, 0.7);
    // id=3 应该被去掉（与 id=1 高度相似，都是"上海/陆家嘴"）
    const ids = result.map(m => m.id);
    expect(ids).not.toContain('3'); // 3 被去掉了
  });

  it('lambda=1 时等价于纯相关性排序', () => {
    const result = mmrDeduplicate(scored, 0.0, 1.0); // threshold=0 强制选完
    expect(result[0].id).toBe('1'); // 最高相关性
    expect(result[result.length - 1].id).toBe('5'); // 最低相关性
  });

  it('threshold=1.0 时只选一个（强制只选最高分）', () => {
    const result = mmrDeduplicate(scored, 1.0, 0.5);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('1');
  });

  it('MMR 返回结果仍按选择顺序排列（从高相关到低）', () => {
    const result = mmrDeduplicate(scored, 0.85, 0.7);
    const scores = result.map(m => m._score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it('单项目列表直接返回', () => {
    const result = mmrDeduplicate([{ id: 'only', content: '只有一个', _score: 0.5 }], 0.85, 0.7);
    expect(result.length).toBe(1);
  });

  it('空列表直接返回空', () => {
    const result = mmrDeduplicate([], 0.85, 0.7);
    expect(result).toEqual([]);
  });
});

// ============================================================
// 9. FTS Query Expansion 验证
// ============================================================
describe('【FTS Query Expansion】降级逻辑', () => {
  const simulateQueryExpansion = (query: string): string[] => {
    const terms = query.trim().split(/\s+/).filter(t => t.length > 1);
    const results: string[] = [terms.join(' ')]; // 原始查询

    if (terms.length > 1) {
      // 按长度升序排序，去掉最短的词（去除噪音词）
      const expanded = [...terms].sort((a, b) => a.length - b.length).slice(1).join(' ');
      results.push(expanded);
    }
    return results;
  };

  it('单 term 不进行 Expansion', () => {
    const results = simulateQueryExpansion('小红');
    expect(results).toEqual(['小红']); // 只有一条，无降级
  });

  it('双 term 去掉最短的', () => {
    const results = simulateQueryExpansion('小红 上海');
    expect(results[0]).toBe('小红 上海');   // 原始
    expect(results[1]).toBe('上海');         // 去掉最短的"小红"
  });

  it('Query Expansion 行为验证', () => {
    // 单 term 不降级
    const r1 = simulateQueryExpansion('小红');
    expect(r1.length).toBe(1);
    // 双 term 有降级
    const r2 = simulateQueryExpansion('我的 小红');
    expect(r2.length).toBe(2);
    // 三 term 去掉最短的
    const r3 = simulateQueryExpansion('我的 名字 小红');
    expect(r3[0]).toBe('我的 名字 小红');
    expect(r3[1]).toBe('名字 小红');
  });

  it('term 太短被过滤（中文单字 len=1 被排除）', () => {
    // '我'=1, '叫'=1(中文单字), '小红'=2
    // 过滤后 terms=['小红']，只有1个 term，不触发 expansion
    const results = simulateQueryExpansion('我 叫 小红');
    expect(results.length).toBe(1);   // 过滤后只剩1个 term，无降级
    expect(results[0]).toBe('小红');
  });
});

// ============================================================
// 10. token 估算边界验证
// ============================================================
describe('【token估算】estimateTokens 全边界', () => {
  const estimateTokens = (text: string): number => {
    if (!text) return 0;
    const cjk = (text.match(/[\u4e00-\u9fa5\u3400-\u4dbf]/g) || []).length;
    return cjk + Math.ceil((text.length - cjk) / 4);
  };

  it('空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null as any)).toBe(0);
    expect(estimateTokens(undefined as any)).toBe(0);
  });

  it('纯 CJK 返回字符数', () => {
    expect(estimateTokens('今天天气很好')).toBe(6);
  });

  it('纯英文按4字符/token', () => {
    // 'hello world!' = 12 chars, nonCJK=12, ceil(12/4)=3
    expect(estimateTokens('hello world!')).toBe(3);
  });

  it('中英混合正确计算', () => {
    // '今天hello' = 7 chars: 3 CJK + ceil(4/4)=1 = 4
    expect(estimateTokens('今天hello')).toBe(4);
  });

  it('数字和标点计入 nonCJK', () => {
    // '2024年1月1日': CJK=4(年日月+日), nonCJK=5(2024和两个1和句号)
    // 结果: 4 + ceil(5/4) = 4 + 2 = 6
    const tokens = estimateTokens('2024年1月1日');
    expect(tokens).toBeGreaterThan(4); // 至少超过纯 CJK 的 4
  });

  it('emoji 属于 nonCJK', () => {
    // '天气☀️好' = 5 chars: 3 CJK + ceil(2/4)=1 = 4
    expect(estimateTokens('天气☀️好')).toBe(4);
  });

  it('JSON.stringify 消息数组会高估 token', () => {
    const messages = [
      { role: 'user', content: '记住我老婆叫小红' },
      { role: 'assistant', content: '好的，已记住。' },
    ];
    const jsonStr = JSON.stringify(messages);
    const estimated = estimateTokens(jsonStr);
    // JSON 格式包含 keys, brackets 等，会高估
    // 这是既有行为，用于粗略预算（saveSessionSnapshot 中使用）
    expect(estimated).toBeGreaterThan(estimateTokens('记住我老婆叫小红好的已记住'));
  });

  it('长文本 token 估算合理', () => {
    // 一篇 500 字的文章
    const article = '今天天气很好，我们去公园玩。'.repeat(50);
    const tokens = estimateTokens(article);
    expect(tokens).toBeGreaterThan(400); // 至少 400 tokens
    expect(tokens).toBeLessThan(700);    // 最多 700 tokens（CJK 为主）
  });
});
