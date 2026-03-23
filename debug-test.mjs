import crypto from 'crypto';

function generateId() {
  return 'snap_' + crypto.randomBytes(8).toString('hex');
}

// 模拟数据库
class MockDb {
  constructor() {
    this.snapshots = [];
  }
  saveSnapshot(snapshot) {
    console.log('[DB] 保存快照, id:', snapshot.id);
    this.snapshots.push(snapshot);
  }
  getLastSnapshot(agentId) {
    console.log('[DB] 查找快照, agentId:', agentId, '当前快照数:', this.snapshots.length);
    const filtered = this.snapshots.filter(s => s.agent_id === agentId);
    console.log('[DB] 过滤后:', filtered.length, '条');
    return filtered.sort((a, b) => b.ended_at - a.ended_at)[0] || null;
  }
}

class SessionContinuity {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.lastSessionKey = new Map();
    console.log('[Init] SessionContinuity 创建, enabled:', config.enabled);
  }

  saveSessionSnapshot(agentId, sessionKey, messages) {
    console.log('[Continuity] saveSessionSnapshot called, agentId:', agentId, 'sessionKey:', sessionKey);
    const snapshot = {
      id: generateId(),
      agent_id: agentId,
      session_key: sessionKey,
      ended_at: Date.now(),
      summary: '测试摘要',
      context_snapshot: '测试上下文',
      message_count: messages.length,
      total_tokens: 100,
      created_at: Date.now(),
    };
    this.db.saveSnapshot(snapshot);
    // 重要：同时更新 lastSessionKey
    this.lastSessionKey.set(agentId, sessionKey);
    console.log('[Continuity] lastSessionKey 已更新为:', sessionKey);
    return snapshot;
  }

  detectSessionChangeAndGetSnapshot(agentId, currentSessionKey) {
    console.log('[Continuity] detectSessionChangeAndGetSnapshot, agentId:', agentId, 'currentSessionKey:', currentSessionKey);
    const lastKey = this.lastSessionKey.get(agentId);
    console.log('[Continuity] lastKey:', lastKey);
    
    if (lastKey === currentSessionKey) {
      console.log('[Continuity] 同一会话，返回null');
      return null;
    }
    
    this.lastSessionKey.set(agentId, currentSessionKey);
    console.log('[Continuity] 更新lastSessionKey');
    
    if (!lastKey) {
      console.log('[Continuity] 首次会话，返回null');
      return null;
    }
    
    const snapshot = this.db.getLastSnapshot(agentId);
    console.log('[Continuity] 获取到快照:', snapshot ? '有' : '无');
    return snapshot;
  }
}

const db = new MockDb();
const continuity = new SessionContinuity({ enabled: true }, db);

// 场景1：晚上会话
const nightSessionKey = 'feishu:night:2026-03-22-23:50';
console.log('\n=== 场景1：保存晚上会话 ===');
continuity.saveSessionSnapshot('main', nightSessionKey, [{role:'user', content:'test'}]);

// 场景2：早上会话
const morningSessionKey = 'feishu:morning:2026-03-23-06:00';
console.log('\n=== 场景2：检测会话切换 ===');
const snapshot = continuity.detectSessionChangeAndGetSnapshot('main', morningSessionKey);
console.log('\n结果:', snapshot ? '有快照 ✅' : '无快照 ❌');
