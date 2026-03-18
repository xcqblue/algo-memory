# 🏗️ 架构设计

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                      OpenClaw Gateway                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   algo-memory 插件                     │   │
│  │                                                      │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │   │
│  │  │   工具层    │  │   钩子层    │  │   核心引擎   │  │   │
│  │  │ (11 Tools)  │  │ (2 Hooks)   │  │ (Engine)    │  │   │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │   │
│  │         │                │                │          │   │
│  │         └────────────────┼────────────────┘          │   │
│  │                          │                           │   │
│  │  ┌───────────────────────▼───────────────────────┐  │   │
│  │  │                  LLM 客户端                     │  │   │
│  │  │     (MiniMax/DeepSeek/Kimi/智谱/百炼/...)       │  │   │
│  │  └───────────────────────┬───────────────────────┘  │   │
│  │                          │                           │   │
│  └──────────────────────────┼───────────────────────────┘   │
│                             │                                │
│  ┌──────────────────────────▼───────────────────────────┐   │
│  │                    SQLite 数据库                       │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │   │
│  │  │ memories │  │  FTS5    │  │    索引          │   │   │
│  │  │   表     │  │ 全文索引 │  │ (7个)            │   │   │
│  │  └──────────┘  └──────────┘  └──────────────────┘   │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心模块

### 1. MemoryPlugin 类

```typescript
class MemoryPlugin {
  private db: Database;        // SQLite 数据库
  private cache: LRUCache;     // 内存缓存
  private sessionCache: LRUCache; // Session 缓存
  private llmClient: LLMClient;    // LLM 客户端
  private config: Config;      // 配置
}
```

### 2. LLM 客户端

```typescript
class LLMClient {
  // 核心判断
  async isCoreMemory(content: string): Promise<{ isCore: boolean; confidence: number }>
  
  // 关键词提取
  async extractKeywords(content: string): Promise<string>
  
  // 去重判断
  async isDuplicate(c1: string, c2: string): Promise<{ isDuplicate: boolean; similarity: number }>
}
```

---

## 数据结构

### memories 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 主键 |
| `agent_id` | TEXT | Agent ID |
| `scope` | TEXT | 作用域 |
| `content` | TEXT | 内容 |
| `type` | TEXT | 类型 |
| `tier` | TEXT | 层级: peripheral/working/core |
| `layer` | TEXT | 层: core/general |
| `keywords` | TEXT | 关键词 |
| `importance` | REAL | 重要性 0-1 |
| `access_count` | INTEGER | 访问次数 |
| `created_at` | INTEGER | 创建时间 |
| `last_accessed` | INTEGER | 最后访问 |
| `content_hash` | TEXT | 内容哈希 |
| `metadata` | TEXT | 元数据 JSON |

### 索引

```sql
-- Agent 索引
CREATE INDEX idx_agent ON memories(agent_id);

-- 层级索引
CREATE INDEX idx_tier ON memories(tier);

-- 作用域索引
CREATE INDEX idx_scope ON memories(scope);

-- 查重索引
CREATE INDEX idx_agent_hash ON memories(agent_id, content_hash);

-- 排序索引
CREATE INDEX idx_agent_tier_importance ON memories(agent_id, tier, importance DESC);

-- 时间索引
CREATE INDEX idx_agent_last_accessed ON memories(agent_id, last_accessed DESC);
```

---

## FTS5 全文搜索

```sql
-- 创建虚拟表
CREATE VIRTUAL TABLE memories_fts USING fts5(
  id, content, keywords, 
  content='memories', 
  content_rowid='rowid'
);

-- 触发器：插入
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, id, content, keywords) 
  VALUES (new.rowid, new.id, new.content, new.keywords);
END;

-- 触发器：删除
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, content, keywords) 
  VALUES('delete', old.rowid, old.id, old.content, old.keywords);
END;

-- 触发器：更新
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, content, keywords) 
  VALUES('delete', old.rowid, old.id, old.content, old.keywords);
  INSERT INTO memories_fts(rowid, id, content, keywords) 
  VALUES (new.rowid, new.id, new.content, new.keywords);
END;
```

---

## 配置架构

```typescript
interface Config {
  // 基础
  autoCapture: boolean;
  autoRecall: boolean;
  maxResults: number;
  
  // 存储
  noiseFilter: NoiseFilterConfig;
  smartDedup: boolean;
  dedupThreshold: number;
  
  // 召回
  recencyDecay: boolean;
  recencyHalfLife: number;
  adaptiveRetrieval: AdaptiveRetrievalConfig;
  
  // LLM
  llm: LLMConfig;
  threshold: ThresholdConfig;
  
  // 进阶
  tier: TierConfig;
  weibullDecay: WeibullDecayConfig;
  reinforcement: ReinforcementConfig;
  mmr: MMRConfig;
  scopes: ScopesConfig;
}
```

---

## 依赖关系

```
用户请求
    │
    ▼
┌─────────────────┐
│   钩子触发      │
│ (agent_end)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│   store()      │────▶│  文本归一化     │
│   存储模块     │     │  normalizeText  │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│   噪声过滤     │────▶│  isNoise()      │
│                 │     └─────────────────┘
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│   精确查重     │────▶│  content_hash   │
│                 │     └─────────────────┘
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│   智能去重     │────▶│  Jaccard 相似度 │
│                 │     │  + LLM 判断     │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│   核心判断     │────▶│  isCoreKeyword  │
│                 │     │  + LLM 判断     │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│   写入数据库   │
│   SQLite       │
└─────────────────┘
```
