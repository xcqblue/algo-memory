# 架构设计

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                      OpenClaw Gateway                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                   algo-memory 插件                      │  │
│  │                                                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │  │
│  │  │   工具层    │  │   钩子层    │  │   核心引擎   │ │  │
│  │  │ (17 Tools)  │  │ (4 Hooks)   │  │ (Engine)    │ │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘ │  │
│  │                        │                              │  │
│  │  ┌─────────────────────▼─────────────────────────┐  │  │
│  │  │            SQLite 数据库（better-sqlite3）        │  │  │
│  │  │  memories 表 + FTS5 虚拟表 + 7 个索引           │  │  │
│  │  └───────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 源码模块结构

```
src/
├── index.ts              # 插件入口，MemoryPlugin 类，工具/钩子注册
├── types.ts             # Config、Memory 类型接口 + DEFAULT_CONFIG
├── utils.ts              # 纯算法函数（分词/衰减/去重/评分/MMR）
├── db/
│   ├── schema.ts         # 建表 + FTS5 虚拟表 + 3 个触发器
│   └── queries.ts        # queryAll / queryOne / run / runOrThrow
└── engine/
    ├── store.ts          # 存储流程（normalize → 去重 → 写入）
    ├── recall.ts         # 召回流程（评分 → MMR → 截断 → 缓存）
    └── llm.ts            # LLM 客户端（8 家提供商 + retry）
```

---

## 数据库结构

### memories 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 主键，`mem_` + 16 位十六进制 |
| `agent_id` | TEXT | Agent ID（隔离粒度） |
| `scope` | TEXT | 作用域，`agent:{agentId}` 或 `global` |
| `content` | TEXT | 内容（已 XSS 转义） |
| `type` | TEXT | 类型，默认 `other` |
| `tier` | TEXT | 层级：`peripheral` / `working` / `core` |
| `layer` | TEXT | 层：`core` / `general` |
| `keywords` | TEXT | 关键词（逗号分隔） |
| `importance` | REAL | 重要性 0~1 |
| `access_count` | INTEGER | 访问次数（强化因子） |
| `cited_count` | INTEGER | 被引用次数（每次召回后 +1，log 曲线评分加成） |
| `urgency` | REAL | 紧急度，初始 1.0（字段保留，暂无评分接入） |
| `created_at` | INTEGER | 创建时间（Unix ms） |
| `last_accessed` | INTEGER | 最后访问时间（Unix ms） |
| `content_hash` | TEXT | SHA256 精确去重哈希 |
| `metadata` | TEXT | JSON 元数据 |

### FTS5 虚拟表 + 触发器

```sql
-- 虚拟表（FTS5 全文搜索）
CREATE VIRTUAL TABLE memories_fts USING fts5(
  id, content, keywords,
  content='memories',
  content_rowid='rowid'
);

-- 插入触发器
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, id, content, keywords)
    VALUES (new.rowid, new.id, new.content, new.keywords);
END;

-- 删除触发器
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, content, keywords)
    VALUES('delete', old.rowid, old.id, old.content, old.keywords);
END;

-- 更新触发器
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, content, keywords)
    VALUES('delete', old.rowid, old.id, old.content, old.keywords);
  INSERT INTO memories_fts(rowid, id, content, keywords)
    VALUES (new.rowid, new.id, new.content, new.keywords);
END;
```

---

## 评分公式

```
recall_score =
    tier_weight × importance
  × time_decay(0.5 + 0.5 × 0.5^(daysOld / halfLife))
  × reinforcement(if enabled)
  × length_norm(if enabled)
  × cited_mult(log10 curve, max ×1.45)
```

MMR（可选）：`λ × relevance − (1−λ) × max_sim_to_selected`

---

## 配置架构

```
Config
├── 基础              autoCapture / autoRecall / maxResults / cleanupDays / language
├── 核心识别           coreKeywords / recencyDecay / recencyHalfLife
├── 去重              smartDedup / dedupThreshold
├── 过滤              noiseFilter (skipGreetings / skipCommands)
├── 自适应召回         adaptiveRetrieval (minQueryLength / forceKeywords / sessionDedup)
├── 评分增强          weibullDecay / reinforcement / mmr / lengthNorm / hardMinScore
├── 三层晋升          tier (coreThreshold / peripheralThreshold / ageDays / weights)
├── Session 摘要       sessionSummary (enabled / dir / maxItems)
├── 隔离              scopes (enabled / visibleAgents)
└── LLM（可选）       llm / threshold
```
