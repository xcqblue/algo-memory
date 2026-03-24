# algo-memory

> Structured SQLite-based memory plugin for OpenClaw — tier scoring, FTS5 search, LLM-augmented capture, and full OpenClaw lifecycle integration.

**版本：** v2.5.0 | **OpenClaw:** v2026.3.23+ | **Node:** ≥20

---

## 核心特性

### 记忆分层（三级自动管理）
- **core** — 高 importance × log(access_count)，被频繁召回的重要记忆
- **working** — 中等重要度，日常信息
- **peripheral** — 低重要度，随时间自然衰减（Weibull, shape=1.5, scale=90天）

### 全文检索（FTS5）
- SQLite FTS5 虚拟表，无需外部 embedding API
- BM25 排序，支持 Query Expansion 降级
- **MMR 多样化检索**（λ=0.7）— 避免重复结果

### LLM 增强（可选，默认为 MiniMax）
- 自动提取关键词（批量，O(1) 次 LLM 调用 per store）
- LLM 辅助去重（jaccard 阈值 0.85）
- 语义压缩（按句子截断，保留关键信息）

### OpenClaw 全生命周期接入
- 9 个 Hook 完整接入（见下文）
- `session:continuity` — 会话续接，上下文跨 Gateway 重启保留
- `compaction` 强化 — compaction 周期自动升级 peripheral / 强化 core

---

## OpenClaw Hook 接入

algo-memory 在以下事件触发时自动工作（无需配置）：

| Hook | 时机 | 行为 |
|------|------|------|
| `agent_end` | 每次对话结束 | capture 用户消息，写入 buffer |
| `before_prompt_build` | LLM 调用前 | 检索相关记忆，注入上下文 |
| `before_compaction` | compaction 开始前 | 从 session transcript 预捕获，触发强化（fire-and-forget）|
| `after_compaction` | compaction 结束后 | 强化 core / 清理低价值 peripheral |
| `session_start` | 会话开始 | 检测会话切换，注入上会话摘要 |
| `session_end` | 会话结束 | 写会话摘要到 workspace |
| `after_tool_call` | 工具执行后 | 实时强化 `algo_memory_search` 召回的记忆 |
| `llm_output` | LLM 回复后 | 记录 token 使用统计（可配置）|
| `gateway_stop` | Gateway 关闭 | 干净 flush 所有 buffer，关闭 DB |

---

## MCP 工具（16 个）

### 核心工具（推荐使用）
| 工具 | 说明 |
|------|------|
| `algo_memory_search` | 搜索记忆，支持 FTS5 + scoring + MMR |
| `algo_memory_list` | 列出记忆，支持 tier/scope 过滤 |
| `algo_memory_stats` | 统计：数量、分 tier 分布、DB 大小 |
| `algo_memory_get` | 获取单条记忆详情 |

### 管理工具
| 工具 | 说明 |
|------|------|
| `algo_memory_update` | 更新记忆内容/importance/tier |
| `algo_memory_delete` | 删除单条记忆 |
| `algo_memory_delete_bulk` | 批量删除 |
| `algo_memory_clear` | 清空所有记忆 |
| `algo_memory_import` | 从 JSON 文件导入 |
| `algo_memory_export` | 导出为 JSON |

### 高级工具
| 工具 | 说明 |
|------|------|
| `algo_memory_metrics` | 运行时指标（缓存命中率、LLM 调用统计）|
| `algo_memory_diagnostics` | 诊断信息（DB 状态、MMR 配置、最后召回详情）|
| `algo_memory_recall_reset` | 清除会话去重状态 |
| `algo_memory_correct` | 修正记忆内容 |
| `algo_memory_fts_rebuild` | 重建 FTS5 索引（修复 rowid 漂移）|
| `algo_memory_compact` | 手动触发 compaction 强化流程 |
| `algo_memory_health` | 完整健康检查（DB/FTS/buffer/LLM/配置）|

---

## 快速开始

### 1. 安装
```bash
npm install
npm run build
```

### 2. 配置（`~/.openclaw/config.json`）
```json
{
  "plugins": {
    "entries": {
      "memory": "algo-memory"
    }
  }
}
```

### 3. 插件配置（可选）
```json
{
  "plugins": {
    "algo-memory": {
      "autoCapture": true,
      "autoRecall": true,
      "maxResults": 5,
      "maxInjectTokens": 1500,
      "cleanupDays": 180,
      "sessionContinuity": { "enabled": true },
      "mmr": { "enabled": true, "lambda": 0.7 },
      "noiseFilter": { "dedup": true, "useLlmForDedup": false },
      "llm": { "provider": "minimax" }
    }
  }
}
```

### 4. LLM API Key
设置环境变量：
```bash
export MINIMAX_API_KEY="your-key"
# 或
export OPENAI_API_KEY="your-key"
```

---

## 配置项说明

### 核心配置
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `autoCapture` | `true` | agent_end 时自动捕获消息 |
| `autoRecall` | `true` | before_prompt_build 时自动召回 |
| `maxResults` | `5` | 最多召回记忆条数 |
| `maxInjectTokens` | `1500` | 注入上下文的最大 token 数 |

### 清理与分层
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `cleanupDays` | `180` | peripheral 记忆超过此天数未访问则清理 |
| `snapshotRetentionDays` | `30` | session_snapshots 保留天数 |
| `tier.coreThreshold` | `10` | access_count ≥ 此值直接升为 core |
| `tier.peripheralThreshold` | `0.15` | 复合评分低于此值为 peripheral |

### LLM
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `llm.provider` | `"minimax"` | LLM 提供商 |
| `llm.model` | `"auto"` | 模型名称 |
| `noiseFilter.useLlmForDedup` | `false` | 启用 LLM 辅助去重（额外 LLM 调用）|
| `noiseFilter.useLlmForCore` | `false` | 启用 LLM 判断 core（额外 LLM 调用）|
| `metricsEnabled` | `true` | 记录 LLM token 使用统计 |

### MMR 多样化
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `mmr.enabled` | `true` | 启用 MMR 多样化检索 |
| `mmr.threshold` | `0.85` | MMR 截断阈值 |
| `mmr.lambda` | `0.7` | 相关性/多样性平衡（1=全相关，0=全多样）|

### 会话
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `sessionContinuity.enabled` | `true` | 启用会话续接 |
| `sessionSummary.enabled` | `true` | 结束时写摘要 |
| `sessionDedup.similarityThreshold` | `0.75` | 会话内相似查询跳过阈值 |

---

## 数据结构

### memories 表
```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  scope TEXT DEFAULT 'global',
  content TEXT NOT NULL,
  type TEXT DEFAULT 'other',
  tier TEXT DEFAULT 'working',   -- core / working / peripheral
  layer TEXT DEFAULT 'general', -- general / core-keyword
  keywords TEXT DEFAULT '',
  importance REAL DEFAULT 0.5,
  access_count INTEGER DEFAULT 1,
  cited_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  metadata TEXT
);
```

### memories_fts 表（FTS5）
```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content, keywords);
-- 触发器自动同步 INSERT/DELETE/UPDATE
```

---

## 与 memory-lancedb 的关系

algo-memory 和 OpenClaw 内置的 `memory-lancedb` **不可同时使用**（会导致重复 capture）。

如果使用 algo-memory，在 OpenClaw 配置中设置：
```json
{
  "plugins": {
    "slots": {
      "memory": "algo-memory"
    }
  }
}
```

algo-memory 的独有价值：
- 无需 embedding API，离线/隐私友好
- importance / cited_count / tier 分层
- 结构化 import/export/correct 操作
- Weibull 时间衰减 + reinforcement 强化机制

---

## 项目结构

```
algo-memory/
├── src/
│   ├── index.ts          # MemoryPlugin 主类 + MCP 工具注册 + Hook 绑定
│   ├── types.ts          # TypeScript 类型定义 + 配置默认值
│   ├── utils.ts          # 工具函数（Weibull/Jaccard/MMR/token估算）
│   ├── engine/
│   │   ├── store.ts     # 写入引擎（Buffer/LLM队列/批处理）
│   │   ├── retrieve.ts  # 检索引擎（FTS5/评分/MMR）
│   │   ├── recall.ts    # 召回决策（shouldRetrieve/sessionDedup）
│   │   └── llm.ts      # LLM 客户端（8个provider/重试/缓存）
│   ├── db/
│   │   ├── schema.ts    # SQLite 建表 + FTS5 + 触发器
│   │   └── queries.ts   # queryAll/queryOne/run 封装
│   └── __tests__/       # 测试文件（228 个测试）
├── dist/                  # TypeScript 编译输出
├── CHANGELOG.md          # 版本变更历史
├── ARCHITECTURE.md        # 系统架构设计文档
└── openclaw.plugin.json  # OpenClaw 插件配置
```

---

## 兼容性

| 版本 | 最低要求 |
|------|----------|
| OpenClaw | v2026.3.23+ |
| Node | ≥ 20.0.0 |
| SQLite | FTS5 支持（Node ≥ 20 内置）|
| better-sqlite3 | ≥ 11.0.0 |

---

## License

MIT
