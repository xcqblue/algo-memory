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
│  │  │ (12 Tools)  │  │ (2 Hooks)   │  │ (Engine)    │  │   │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │   │
│  │         │                │                │          │   │
│  │         └────────────────┼────────────────┘          │   │
│  │                          │                           │   │
│  │  ┌───────────────────────▼───────────────────────┐  │   │
│  │  │                  LLM 客户端                     │  │   │
│  │  │  (MiniMax/DeepSeek/Kimi/智谱/百炼/ollama...)  │  │   │
│  │  └───────────────────────┬───────────────────────┘  │   │
│  │                          │                           │   │
│  └──────────────────────────┼───────────────────────────┘   │
│                             │                                │
│  ┌──────────────────────────▼───────────────────────────┐   │
│  │                    SQLite 数据库 (sql.js)             │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │   │
│  │  │ memories │  │  FTS5    │  │    索引 (7个)    │   │   │
│  │  │   表     │  │ 全文索引 │  │                  │   │   │
│  │  └──────────┘  └──────────┘  └──────────────────┘   │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 源码模块结构

```
src/
├── index.ts              # 插件入口，MemoryPlugin 类，所有工具/钩子注册
├── types.ts              # Config、Memory 类型接口 + DEFAULT_CONFIG
├── utils.ts              # 纯算法工具函数（分词/衰减/去重/评分...）
├── sql.js.d.ts           # sql.js 类型声明
├── db/
│   ├── schema.ts         # 建表 + FTS5 虚拟表 + 三个触发器
│   └── queries.ts        # queryAll / queryOne / run / runOrThrow 封装
└── engine/
    ├── store.ts          # 存储流程（normalize → 去重 → 核心判断 → 写入）
    ├── recall.ts         # 召回流程（评分 → MMR → 截断 → 缓存）
    └── llm.ts            # LLM 客户端（8 家提供商 + retry 逻辑）
```

**依赖关系：**
```
types.ts → 所有模块
utils.ts → engine/ + index.ts
db/* → engine/ → index.ts
engine/llm.ts → engine/store.ts + index.ts
engine/store.ts + recall.ts → index.ts
index.ts → 插件入口，只做组装
```

---

## 核心模块

### MemoryPlugin 类

```typescript
class MemoryPlugin {
  private db: DbLike;                    // sql.js 数据库实例
  private cache: LRUCache<string, any>;  // 召回结果缓存（TTL + LRU）
  private sessionCache: LRUCache<string, any>; // Session 临时记忆
  private cleanupInterval: NodeJS.Timeout;  // 定时清理
  private config: Config;
  private llmClient: LLMClient | null;
  private ftsAvailable: boolean;         // FTS5 可用性探测标志
  private configHash: string;            // 召回参数稳定哈希（缓存 key 用）

  // 错误指标（通过 algo_memory_metrics 暴露）
  public metrics: {
    llmErrors: { core: number; extract: number; dedup: number };
    dbErrors: number;
    lastErrorAt: number | null;
  };
}
```

### LLM 客户端

```typescript
class LLMClient {
  // 核心判断（本地关键词优先，节省 API）
  async isCoreMemory(content: string): Promise<{ isCore: boolean; confidence: number }>

  // 关键词提取（纯算法优先，长文本才调 LLM）
  async extractKeywordsFromLLM(content: string): Promise<string>

  // 去重判断（相似度在模糊区间才调 LLM）
  async isDuplicateLLM(c1: string, c2: string): Promise<{ isDuplicate: boolean }>

  // 内部重试逻辑（指数退避，最多重试 3 次）
  private async llmCallWithRetry(payload: object): Promise<any>
}
```

---

## 数据结构

### memories 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 主键，`mem_` + 16 位十六进制 |
| `agent_id` | TEXT | Agent ID（隔离粒度） |
| `scope` | TEXT | 作用域，`agent:{agentId}` 或 `global` |
| `content` | TEXT | 内容（已 XSS 转义） |
| `type` | TEXT | 类型，`other` |
| `tier` | TEXT | 层级：`peripheral` / `working` / `core` |
| `layer` | TEXT | 层：`core` / `general` |
| `keywords` | TEXT | 关键词（逗号分隔） |
| `importance` | REAL | 重要性 0~1 |
| `access_count` | INTEGER | 访问次数（强化因子） |
| `created_at` | INTEGER | 创建时间（Unix ms） |
| `last_accessed` | INTEGER | 最后访问时间（Unix ms） |
| `content_hash` | TEXT | SHA256 精确去重哈希 |
| `metadata` | TEXT | JSON 元数据（category / confidence / session） |

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

## 配置架构

```typescript
interface Config {
  // 基础
  autoCapture: boolean;          // 自动存储
  autoRecall: boolean;            // 自动召回
  maxResults: number;             // 召回数量上限
  capturePerTurn: number;        // 每轮最多写入条数
  cleanupDays: number;           // 清理阈值（天）
  language: string;               // 语言：auto / zh / en ...

  // 核心识别
  coreKeywords: string[];         // 核心关键词列表
  recencyDecay: boolean;         // 时间衰减开关
  recencyHalfLife: number;       // 半衰期（天）

  // 去重
  smartDedup: boolean;           // 智能去重开关
  dedupThreshold: number;       // Jaccard 去重阈值

  // 过滤
  noiseFilter: NoiseFilterConfig;  // 噪声过滤（问候语/命令/确认语）

  // 自适应召回
  adaptiveRetrieval: AdaptiveRetrievalConfig;  // 查询长度 + 强制关键词

  // Session 记忆
  sessionMemory: SessionMemoryConfig;  // 进程内 LRU 缓存（不持久化）

  // 评分增强
  weibullDecay: WeibullDecayConfig;    // Weibull 分布衰减
  reinforcement: ReinforcementConfig;  // 访问次数强化
  mmr: MMRConfig;                      // 最大边际相关性去重
  lengthNorm: LengthNormConfig;         // 长度归一化
  hardMinScore: HardMinScoreConfig;     // 最低分硬过滤

  // 三层晋升
  tier: TierConfig & {
    weights: { core: number; working: number; peripheral: number };
  };

  // 隔离
  scopes: ScopesConfig;           // Agent 隔离 + 跨 Agent 可见配置

  // LLM
  llm: LLMConfig;                // 提供商 / API Key / 模型 / baseURL
  threshold: ThresholdConfig;      // LLM 触发阈值（长度 / 置信度区间）
}
```

---

## 依赖流程图

```
用户消息
    │
    ▼
┌─────────────────┐
│  agent_end 钩子 │  ← 插件自动触发
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  store()       │────▶│  文本归一化     │
│  存储模块       │     │  normalizeText  │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  噪声过滤       │────▶│  isNoise()      │
│                 │     └─────────────────┘
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  精确查重       │────▶│  SHA256 hash    │
│                 │     └─────────────────┘
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  智能去重       │────▶│  Jaccard 相似度 │
│                 │     │  + LLM 判断     │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  核心判断       │────▶│  isCoreKeyword  │
│                 │     │  + LLM 判断     │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│  写入数据库     │
│  runOrThrow()   │  ← 失败正常抛出
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  saveDatabase() │  ← 循环结束后一次性持久化
└─────────────────┘
```
