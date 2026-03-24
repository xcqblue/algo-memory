import type { AnyDatabase } from './queries.js';

/**
 * Initialize database schema (tables, indexes, FTS5).
 * Called once during plugin init.
 * Throws on critical schema errors so the plugin fails fast.
 */
export function initSchema(db: AnyDatabase, log: any): void {
  const required = (sql: string, label: string) => {
    try {
      db.prepare(sql).run();
    } catch (err) {
      throw new Error(`[algo-memory] ${label} 创建失败: ${err}`);
    }
  };

  // Create main memories table
  required(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, scope TEXT DEFAULT 'agent',
      content TEXT NOT NULL, type TEXT DEFAULT 'other', tier TEXT DEFAULT 'working',
      layer TEXT DEFAULT 'general', keywords TEXT, importance REAL DEFAULT 0.5,
      access_count INTEGER DEFAULT 0, cited_count INTEGER DEFAULT 0,
      tier_confidence REAL DEFAULT 1.0,
      last_tier_update INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      created_at INTEGER, last_accessed INTEGER, content_hash TEXT,
      metadata TEXT
    )
  `, 'memories 表');

  // Create session_snapshots table for cross-session continuity
  required(`
    CREATE TABLE IF NOT EXISTS session_snapshots (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      ended_at INTEGER NOT NULL,
      summary TEXT,
      context_snapshot TEXT,
      message_count INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
  `, 'session_snapshots 表');

  // Index for session_snapshots
  try {
    db.prepare('CREATE INDEX IF NOT EXISTS idx_snapshots_agent ON session_snapshots(agent_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_snapshots_agent_ended ON session_snapshots(agent_id, ended_at DESC)').run();
  } catch (_) { /* index creation is non-fatal */ }

  // Create session_metadata table for persisting session state across restarts
  required(`
    CREATE TABLE IF NOT EXISTS session_metadata (
      agent_id TEXT PRIMARY KEY,
      last_session_key TEXT,
      updated_at INTEGER
    )
  `, 'session_metadata 表');

  // Create tier_history table for tracking memory tier changes
  required(`
    CREATE TABLE IF NOT EXISTS tier_history (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      old_tier TEXT,
      new_tier TEXT NOT NULL,
      reason TEXT,
      access_count INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
  `, 'tier_history 表');

  // Index for tier_history
  try {
    db.prepare('CREATE INDEX IF NOT EXISTS idx_tier_history_memory ON tier_history(memory_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_tier_history_created ON tier_history(created_at DESC)').run();
  } catch (_) { /* index creation is non-fatal */ }

  // Migration: drop deprecated urgency column (removed in v2.3.0)
  try { db.prepare('ALTER TABLE memories DROP COLUMN IF EXISTS urgency').run(); } catch (_) { /* ignore */ }

  // Migration: add tier_confidence + last_tier_update (v2.5.0: smarter tier system)
  try { db.prepare('ALTER TABLE memories ADD COLUMN tier_confidence REAL DEFAULT 1.0').run(); } catch (_) { /* ignore */ }
  try { db.prepare('ALTER TABLE memories ADD COLUMN last_tier_update INTEGER DEFAULT (strftime(\'%s\', \'now\') * 1000)').run(); } catch (_) { /* ignore */ }

  // Indexes (non-fatal if they fail)
  for (const idx of [
    'CREATE INDEX IF NOT EXISTS idx_agent ON memories(agent_id)',
    'CREATE INDEX IF NOT EXISTS idx_tier ON memories(tier)',
    'CREATE INDEX IF NOT EXISTS idx_scope ON memories(scope)',
    'CREATE INDEX IF NOT EXISTS idx_agent_hash ON memories(agent_id, content_hash)',
    'CREATE INDEX IF NOT EXISTS idx_agent_tier_importance ON memories(agent_id, tier, importance DESC)',
    'CREATE INDEX IF NOT EXISTS idx_agent_last_accessed ON memories(agent_id, last_accessed DESC)',
    'CREATE INDEX IF NOT EXISTS idx_tier_confidence ON memories(tier, tier_confidence)',
  ]) {
    try { db.prepare(idx).run(); } catch (_) { /* index creation is non-fatal */ }
  }

  // FTS5 virtual table — use id as primary join key instead of rowid
  // rowid drifts after VACUUM/REINDEX, so we manage FTS manually via triggers
  // and join by id (stable) rather than rowid (volatile)
  try {
    db.prepare("PRAGMA journal_mode = DELETE").run();
    db.prepare(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED, content, keywords
      )
    `).run();
    // Manually sync: no content=... content_rowid=... — we manage FTS rows explicitly
    db.prepare(`CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(id, content, keywords) VALUES (new.id, new.content, new.keywords); END`).run();
    db.prepare(`CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN DELETE FROM memories_fts WHERE id = old.id; END`).run();
    db.prepare(`CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN DELETE FROM memories_fts WHERE id = old.id; INSERT INTO memories_fts(id, content, keywords) VALUES (new.id, new.content, new.keywords); END`).run();
    log.info('[algo-memory] FTS5 全文搜索已启用（id 稳定键，无 rowid 漂移）');
  } catch (err: any) {
    log.warn('[algo-memory] FTS5 创建失败，搜索将降级为 LIKE:', err.message);
  }
}
