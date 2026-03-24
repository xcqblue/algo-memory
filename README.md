# algo-memory

> 基于 SQLite 的结构化长期记忆插件 for OpenClaw — 三层分级、FTS5 全文检索、LLaM 辅助捕获、完整 OpenClaw 生命周期接入。

**版本：** v2.6.0 | **OpenClaw:** v2026.3.23+ | **Node:** ≥20

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

### LLM 增强（可选）
- 自动提取关键词（批量，O(1) 次 LLM 调用 per store）
- LLM 辅助去重（jaccard 阈值 0.85）
- 语义压缩（按句子截断，保留关键信息）
- **纯算法模式零成本运行**，LLM 非必选

### OpenClaw 全生命周期接入
- 7 个 Hook 完整接入（见下文）
- `session_continuity` — 会话续接，上下文跨 Gateway 重启保留
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
| `after_tool_call` | 工具执行后 | 实时强化 `algo_memory_search` 召回的记忆 |
| `llm_output` | LLM 回复后 | 记录 token 使用统计 |
| `gateway_stop` | Gateway 关闭 | 干净 flush 所有 buffer，关闭 DB |

> `session_start` / `session_end` 是 Planned 事件，当前 OpenClaw 版本不触发，实际由 `agent_end` 统一处理 capture + 会话快照。

---

## 工具（18 个）

algo-memory 通过 OpenClaw `registerTool()` 自动暴露工具，无需额外配置 MCP。

### 核心工具
| 工具 | 说明 |
|------|------|
| `algo_memory_search` | 搜索记忆，支持 FTS5 + scoring + MMR |
| `algo_memory_list` | 列出记忆，支持分页 |
| `algo_memory_stats` | 统计：数量、分 tier 分布、DB 大小 |
| `algo_memory_get` | 获取单条记忆详情 |

### 管理工具
| 工具 | 说明 |
|------|------|
| `algo_memory_update` | 更新记忆内容 |
| `algo_memory_delete` | 删除单条记忆 |
| `algo_memory_delete_bulk` | 批量删除 |
| `algo_memory_clear` | 清空所有记忆 |
| `algo_memory_import` | 从 JSON 批量导入 |
| `algo_memory_export` | 导出为 JSON |

### 高级工具
| 工具 | 说明 |
|------|------|
| `algo_memory_metrics` | 运行时指标（LLM 调用、缓存命中率）|
| `algo_memory_diagnostics` | 诊断：DB 状态、MMR 配置、最后召回详情 |
| `algo_memory_recall_reset` | 清除会话去重状态 |
| `algo_memory_correct` | 修正记忆（直接更新 or AI 辅助定位）|
| `algo_memory_fts_rebuild` | 重建 FTS5 索引 |
| `algo_memory_compact` | 手动触发 compaction 强化 |
| `algo_memory_health` | 完整健康检查 |
| `algo_memory_sync` | 导出 core 记忆（已禁用直接写 workspace）|

---

## 快速开始

### 1. 安装
```bash
git clone https://github.com/xcqblue/algo-memory.git ~/.openclaw/extensions/algo-memory
cd ~/.openclaw/extensions/algo-memory && npm install && npm run build
```

### 2. 启用插件
```bash
openclaw plugins enable algo-memory
```

### 3. 重启
```bash
openclaw gateway restart
```

### 4. LLM API Key（可选）
algo-memory 的 LLM **不是必选功能**。如需关键词提取或去重：
```bash
export MINIMAX_API_KEY="your-key"      # MiniMax
export DEEPSEEK_API_KEY="your-key"    # DeepSeek
export KIMI_API_KEY="your-key"        # Kimi/Moonshot
export DASHSCOPE_API_KEY="your-key"   # 阿里百炼/通义千问
export ZHIPU_API_KEY="your-key"       # 智谱 GLM
export OPENAI_API_KEY="your-key"      # OpenAI
export ANTHROPIC_API_KEY="your-key"   # Anthropic
export SILICONFLOW_API_KEY="your-key" # SiliconFlow 聚合平台
```

然后在插件配置中指定 provider：

```json
{
  "plugins": {
    "algo-memory": {
      "llm": {
        "provider": "zhipu",
        "model": "glm-4.7-flash"
      }
    }
  }
}
```

---

## 支持模型

| Provider | 默认模型 | 推荐 |
|----------|---------|------|
| `minimax` | `abab6.5s-chat` | abab6.5s-chat（推荐）/ abab6.5g-chat |
| `deepseek` | `deepseek-chat` | deepseek-chat（V3）/ deepseek-reasoner（R1推理）|
| `kimi` | `moonshot-v1-8k` | moonshot-v1-8k（性价比）/ moonshot-v1-128k（长上下文）|
| `zhipu` | `glm-4-flash` | glm-4-flash（免费）/ glm-4-plus（最强）|
| `qwen` | `qwen-plus` | qwen-plus（推荐）/ qwen-max（最强）/ qwen2.5-72b-instruct（超大杯）|
| `openai` | `gpt-4o-mini` | gpt-4o-mini（快）/ gpt-4o（强）|
| `anthropic` | `claude-3-haiku` | claude-3-haiku（快）/ claude-3-5-sonnet（强）|
| `ollama` | `llama3` | 本地自定义 |
| `siliconflow` | `Qwen/Qwen2-7B-Instruct` | SiliconFlow 聚合 50+ 模型 |

> `qwen` / `dashscope` / `moonshot` 是别名，自动映射到内部 provider key。

**模型动态化**：内置 modelMap 只做日志展示用，模型名直接透传给 API。配置 `customModelNames` 可覆盖任意模型的显示名称：

```json
{
  "plugins": {
    "algo-memory": {
      "llm": {
        "provider": "deepseek",
        "model": "deepseek-r2-latest",
        "customModelNames": {
          "deepseek-r2-latest": "DeepSeek R2（最新内部测试版）"
        }
      }
    }
  }
}
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
| `cleanupDays` | `180` | peripheral 记忆超过此天数未访问则清理 |
| `snapshotRetentionDays` | `30` | session_snapshots 保留天数 |
| `metricsEnabled` | `true` | 记录 LLM token 使用统计 |

### 清理与分层
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `tier.coreThreshold` | `10` | access_count ≥ 此值直接升为 core |
| `tier.peripheralThreshold` | `0.15` | 复合评分低于此值为 peripheral |
| `tier.ageDays` | `60` | 超过此天数的记忆不因高 importance 升 core |
| `tier.weights.core` | `1.5` | core 层召回权重 |
| `tier.weights.working` | `1.0` | working 层召回权重 |
| `tier.weights.peripheral` | `0.5` | peripheral 层召回权重 |

### LLM
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `llm.enabled` | `false` | 是否启用 LLM（默认关闭，纯算法模式）|
| `llm.provider` | `"auto"` | 提供商 |
| `llm.model` | `""` | 模型名称（留空使用各 provider 默认）|
| `llm.customModelNames` | `{}` | 自定义模型显示名映射 |
| `threshold.useLlmForCore` | `false` | LLM 判断 core |
| `threshold.useLlmForExtract` | `false` | LLM 提取关键词 |
| `threshold.useLlmForDedup` | `false` | LLM 辅助去重 |

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
| `sessionContinuity.maxInjectTokens` | `800` | 注入上下文的最大 token 数 |
| `sessionContinuity.maxMessagesForSummary` | `30` | 生成摘要最多使用多少条消息 |
| `sessionSummary.enabled` | `true` | 结束时写摘要 |
| `sessionSummary.maxItems` | `50` | 摘要最大条数 |

### 自适应召回
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `adaptiveRetrieval.minQueryLength` | `2` | 查询长度小于此值不触发召回 |
| `adaptiveRetrieval.forceKeywords` | 见下方 | 含这些词强制触发召回 |
| `sessionDedup.enabled` | `true` | 开启会话内去重 |
| `sessionDedup.windowMs` | `30000` | 去重时间窗口（毫秒）|
| `sessionDedup.similarityThreshold` | `0.75` | Jaccard 相似度阈值 |

> **forceKeywords 默认值**
> 中文：`['记住', '之前', '上次', '记得', 'what', 'why', 'how', '什么', '为什么', '怎么']`
> 英文：`['remember', 'before', 'last', 'previously', 'earlier', 'what', 'why', 'how']`

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
  tier TEXT DEFAULT 'working',   -- core / working / peripheral / pending
  layer TEXT DEFAULT 'general',
  keywords TEXT DEFAULT '',
  importance REAL DEFAULT 0.5,
  access_count INTEGER DEFAULT 1,
  cited_count INTEGER DEFAULT 0,
  tier_confidence REAL DEFAULT 1.0,
  last_tier_update INTEGER,
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
- Weibull 时间衰减 + reinforcement 强化机制
- 结构化 import/export/correct 操作

---

## 项目结构

```
algo-memory/
├── src/
│   ├── index.ts          # MemoryPlugin 主类 + 工具注册 + Hook 绑定
│   ├── types.ts          # TypeScript 类型定义 + 配置默认值
│   ├── utils.ts          # 工具函数（Weibull/Jaccard/MMR/token估算）
│   ├── engine/
│   │   ├── store.ts     # 写入引擎（Buffer/LLM队列/批处理）
│   │   ├── retrieve.ts  # 检索引擎（FTS5/评分/MMR）
│   │   ├── recall.ts    # 召回决策（shouldRetrieve/sessionDedup）
│   │   └── llm.ts       # LLM 客户端（多provider/重试/缓存）
│   ├── db/
│   │   ├── schema.ts    # SQLite 建表 + FTS5 + 触发器
│   │   └── queries.ts   # queryAll/queryOne/run 封装
│   └── __tests__/       # 测试文件（228 个测试）
├── dist/                # TypeScript 编译输出
├── CHANGELOG.md         # 版本变更历史
├── ARCHITECTURE.md      # 系统架构设计文档
├── CONFIG.md            # 完整配置参考
├── INSTALL.md           # 安装指南
└── openclaw.plugin.json # OpenClaw 插件配置
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
