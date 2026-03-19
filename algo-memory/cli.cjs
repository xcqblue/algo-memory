/**
 * algo-memory CLI 工具
 * 命令行管理记忆
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getDb() {
  const dbPath = process.env.ALGO_MEMORY_DB || path.join(process.env.HOME || '/home/x', '.openclaw', 'workspace', 'algo-memory', 'memories.db');
  if (!fs.existsSync(dbPath)) {
    console.error('数据库不存在:', dbPath);
    process.exit(1);
  }
  return new Database(dbPath);
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'list': {
    const db = getDb();
    const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '20');
    const agentId = args.find(a => a.startsWith('--agent='))?.split('=')[1] || 'default';
    const memories = db.prepare('SELECT * FROM memories WHERE agent_id = ? ORDER BY tier, importance DESC, created_at DESC LIMIT ?').all(agentId, limit);
    console.log(JSON.stringify(memories, null, 2));
    db.close();
    break;
  }

  case 'search': {
    const db = getDb();
    const query = args.find(a => a.startsWith('--query='))?.split('=')[1] || '';
    const agentId = args.find(a => a.startsWith('--agent='))?.split('=')[1] || 'default';
    const q = `%${query}%`;
    const memories = db.prepare('SELECT * FROM memories WHERE agent_id = ? AND (content LIKE ? OR keywords LIKE ?) ORDER BY importance DESC LIMIT 20').all(agentId, q, q);
    console.log(JSON.stringify(memories, null, 2));
    db.close();
    break;
  }

  case 'stats': {
    const db = getDb();
    const agentId = args.find(a => a.startsWith('--agent='))?.split('=')[1] || 'default';
    const total = db.prepare('SELECT COUNT(*) as c FROM memories WHERE agent_id = ?').get(agentId).c;
    const core = db.prepare('SELECT COUNT(*) as c FROM memories WHERE agent_id = ? AND tier = "core"').get(agentId).c;
    const working = db.prepare('SELECT COUNT(*) as c FROM memories WHERE agent_id = ? AND tier = "working"').get(agentId).c;
    const peripheral = db.prepare('SELECT COUNT(*) as c FROM memories WHERE agent_id = ? AND tier = "peripheral"').get(agentId).c;
    console.log(JSON.stringify({ total, core, working, peripheral }, null, 2));
    db.close();
    break;
  }

  case 'delete': {
    const db = getDb();
    const id = args.find(a => a.startsWith('--id='))?.split('=')[1];
    if (!id) { console.error('需要 --id 参数'); process.exit(1); }
    const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    console.log(JSON.stringify({ deleted: result.changes }));
    db.close();
    break;
  }

  case 'clear': {
    const db = getDb();
    const agentId = args.find(a => a.startsWith('--agent='))?.split('=')[1] || 'default';
    const keepCore = !args.includes('--no-keep-core');
    const result = keepCore 
      ? db.prepare('DELETE FROM memories WHERE agent_id = ? AND tier != "core"').run(agentId)
      : db.prepare('DELETE FROM memories WHERE agent_id = ?').run(agentId);
    console.log(JSON.stringify({ deleted: result.changes, keepCore }));
    db.close();
    break;
  }

  case 'export': {
    const db = getDb();
    const agentId = args.find(a => a.startsWith('--agent='))?.split('=')[1] || 'default';
    const output = args.find(a => a.startsWith('--output='))?.split('=')[1];
    const memories = db.prepare('SELECT * FROM memories WHERE agent_id = ?').all(agentId);
    const data = JSON.stringify(memories, null, 2);
    if (output) {
      fs.writeFileSync(output, data);
      console.log('已导出到:', output);
    } else {
      console.log(data);
    }
    db.close();
    break;
  }

  case 'import': {
    const db = getDb();
    const file = args.find(a => a.startsWith('--file='))?.split('=')[1];
    const agentId = args.find(a => a.startsWith('--agent='))?.split('=')[1] || 'default';
    if (!file) { console.error('需要 --file 参数'); process.exit(1); }
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    let imported = 0;
    for (const m of data) {
      try {
        db.prepare('INSERT INTO memories (id, agent_id, scope, content, type, tier, layer, keywords, importance, access_count, created_at, last_accessed, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          m.id || 'mem_' + crypto.randomBytes(8).toString('hex'), agentId, m.scope || 'global', m.content, m.type || 'other', m.tier || 'working', m.layer || 'general', m.keywords || '', m.importance || 0.5, m.access_count || 1, m.created_at || Date.now(), m.last_accessed || Date.now(), m.content_hash || hashContent(m.content)
        );
        imported++;
      } catch (e) { /* ignore */ }
    }
    console.log(JSON.stringify({ imported }));
    db.close();
    break;
  }

  default:
    console.log(`
algo-memory CLI

用法: node cli.cjs <command> [options]

命令:
  list           列出记忆 (--agent=xxx --limit=20)
  search         搜索记忆 (--query=xxx --agent=xxx)
  stats          查看统计 (--agent=xxx)
  delete         删除记忆 (--id=xxx)
  clear          清空记忆 (--agent=xxx [--no-keep-core])
  export         导出记忆 (--agent=xxx --output=file.json)
  import         导入记忆 (--agent=xxx --file=file.json)
`);
}
