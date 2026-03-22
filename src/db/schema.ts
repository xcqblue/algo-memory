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
      created_at INTEGER, last_accessed INTEGER, content_hash TEXT,
      metadata TEXT
    )
  `, 'memories 表');

  // Migration: drop deprecated urgency column (removed in v2.3.0)
  try { db.prepare('ALTER TABLE memories DROP COLUMN IF EXISTS urgency').run(); } catch (_) { /* ignore */ }

  // Indexes (non-fatal if they fail)
  for (const idx of [
    'CREATE INDEX IF NOT EXISTS idx_agent ON memories(agent_id)',
    'CREATE INDEX IF NOT EXISTS idx_tier ON memories(tier)',
    'CREATE INDEX IF NOT EXISTS idx_scope ON memories(scope)',
    'CREATE INDEX IF NOT EXISTS idx_agent_hash ON memories(agent_id, content_hash)',
    'CREATE INDEX IF NOT EXISTS idx_agent_tier_importance ON memories(agent_id, tier, importance DESC)',
    'CREATE INDEX IF NOT EXISTS idx_agent_last_accessed ON memories(agent_id, last_accessed DESC)',
  ]) {
    try { db.prepare(idx).run(); } catch (_) { /* index creation is non-fatal */ }
  }

  // FTS5 virtual table — better-sqlite3 supports FTS5 natively
  // WAL mode disabled to avoid file locking issues
  try {
    db.prepare("PRAGMA journal_mode = DELETE").run();
    db.prepare(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id, content, keywords, content='memories', content_rowid='rowid'
      )
    `).run();
    db.prepare(`CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, id, content, keywords) VALUES (new.rowid, new.id, new.content, new.keywords); END`).run();
    log.info('[algo-memory] FTS5 全文搜索已启用');
  } catch (err: any) {
    log.warn('[algo-memory] FTS5 创建失败，搜索将降级为 LIKE:', err.message);
  }
}
