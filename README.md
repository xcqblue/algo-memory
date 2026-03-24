# algo-memory

> 基于 SQLite 的结构化长期记忆插件 for OpenClaw — 三层分级、FTS5 全文检索、LLaM 辅助捕获、完整 OpenClaw 生命周期接入。

**版本：** v2.7.0 | **OpenClaw:** v2026.3.23+ | **Node:** ≥20

---

## 核心特性

### 记忆分层（三级自动管理）
- **core** — 高 importance × log(access_count)，被频繁召回的重要记忆
- **working** — 中等重要度，日常信息
- **peripheral** — 低重要度，随时间自然衰减（Weibull, shape=1.5, scale=90天）

### 全文检索（FTS5）
- SQLite FTS5 虚拟表，无需外部 embedding API，离线/隐私友好
- BM25 排序，支持 Query Expansion 降级
- **MMR 多样化检索**（λ=0.7）— 避免重复结果

### LLM 增强（可选）
- 自动提取关键词（批量，每批次仅 1 次 LLM 调用）
- LLM 辅助去重（jaccard 阈值 0.85）
- 语义压缩（按句子截断，保留关键信息）
- **纯算法模式零成本运行**，LLM 非必选

### OpenClaw 全生命周期接入
- 6 个 Hook 完整接入（见下文）
- `compaction` 强化 — compaction 周期自动升级 peripheral / 强化 core
- `after_tool_call` — 工具调用后实时强化召回的记忆

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
| `gateway_stop` | Gateway 关闭 | 干净 flush 所有 buffer，关闭 DB |

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
export DEEPSEEK_API_KEY="your-key"     # DeepSeek
export KIMI_API_KEY="your-key"         # Kimi/Moonshot
export DASHSCOPE_API_KEY="your-key"   # 阿里百炼/通义千问
export ZHIPU_API_KEY="your-key"        # 智谱 GLM
export HUNYUAN_API_KEY="your-key"     # 腾讯混元
export WENXIN_API_KEY="your-key"      # 百度文心
export SILICONFLOW_API_KEY="your-key"  # SiliconFlow 聚合平台
export OPENAI_API_KEY="your-key"       # OpenAI
export ANTHROPIC_API_KEY="your-key"    # Anthropic
```

然后在插件配置中指定 provider：

```json
{
  "plugins": {
    "algo-memory": {
      "llm": {
        "provider": "zhipu",
        "model": "glm-4-flash"
      }
    }
  }
}
```

---

## 支持模型

### 国内模型

| Provider | 别名 | 默认模型 | 推荐 |
|----------|------|---------|------|
| `minimax` | — | `abab6.5s-chat` | abab6.5s-chat（推荐）/ abab6.5g-chat |
| `deepseek` | — | `deepseek-chat` | deepseek-chat（V3）/ deepseek-reasoner（R1推理）|
| `kimi` | `moonshot` | `moonshot-v1-8k` | moonshot-v1-8k（性价比）/ moonshot-v1-128k（长上下文）|
| `zhipu` | — | `glm-4-flash` | glm-4-flash（免费）/ glm-4-plus（最强）|
| `qwen` | `dashscope`、`bailian` | `qwen-plus` | qwen-plus（推荐）/ qwen-max（最强）/ qwen2.5-72b-instruct（超大杯）|
| `hunyuan` | — | `hunyuan-standard` | hunyuan-pro（腾讯混元 Pro）|
| `wenxin` | — | `ernie-3.5-8k` | ernie-4.0-8k（百度文心）|
| `siliconflow` | `silicon` | `Qwen/Qwen2-7B-Instruct` | SiliconFlow 聚合 50+ 模型 |

### 国外模型

| Provider | 默认模型 | 推荐 |
|----------|---------|------|
| `openai` | `gpt-4o-mini` | gpt-4o-mini（快）/ gpt-4o（强）|
| `anthropic` | `claude-3-haiku-20240307` | claude-3-haiku（快）/ claude-3-5-sonnet（强）|
| `ollama` | `llama2` | 本地自定义模型 |

### 完整模型列表

```
MiniMax:     abab6.5s-chat, abab6.5g-chat, abab6.5s-chat-200k,
             abab1.8s-chat, abab1.8g-chat, abab6s-chat, abab5.5s-chat
DeepSeek:    deepseek-chat, deepseek-coder, deepseek-reasoner
Kimi:        moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k,
             kimi-chat, kimi-chat-latest
智谱 GLM:    glm-4-flash, glm-4, glm-4-plus, glm-3-turbo
阿里百炼:    qwen-plus, qwen-turbo, qwen-max, qwen-long,
             qwen2.5-72b-instruct
腾讯混元:    hunyuan-pro, hunyuan-standard
百度文心:    ernie-4.0-8k, ernie-3.5-8k, ernie-speed-8k
SiliconFlow: Qwen/Qwen2-7B-Instruct, THUDM/glm-4-9b-chat,
             deepseek-ai/DeepSeek-V2-Chat
OpenAI:      gpt-4o-mini
Anthropic:   claude-3-haiku-20240307
Ollama:      llama2, mistral
```

---

## 配置项说明

### 基础配置
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `autoCapture` | `true` | agent_end 时自动捕获消息 |
| `autoRecall` | `true` | before_prompt_build 时自动召回 |
| `maxResults` | `5` | 最多召回记忆条数 |
| `maxInjectTokens` | `1500` | 注入上下文的最大 token 数 |
| `capturePerTurn` | `3` | 每轮对话最多存储条数 |
| `cleanupDays` | `180` | peripheral 记忆超过此天数未访问则清理 |
| `metricsEnabled` | `true` | 记录 LLM token 使用统计 |
| `language` | `"auto"` | 语言：`auto` / `zh` / `en` |

### 核心识别
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `coreKeywords` | 见下方 | 命中这些关键词的消息直接标记为 core |
| `recencyDecay` | `true` | 开启时间衰减 |
| `recencyHalfLife` | `180` 天 | 时间衰减半衰期 |

> **coreKeywords 默认值**
> `["记住", "牢记", "重要", "不要忘记", "记住它", "remember", "important", "never forget"]`

### 三层分级
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `tier.coreThreshold` | `10` | access_count ≥ 此值直接升为 core |
| `tier.peripheralThreshold` | `0.15` | 复合评分低于此值为 peripheral |
| `tier.ageDays` | `60` | 超过此天数的记忆不因高 importance 升 core |
| `tier.weights.core` | `1.5` | core 层召回权重 |
| `tier.weights.working` | `1.0` | working 层召回权重 |
| `tier.weights.peripheral` | `0.5` | peripheral 层召回权重 |

### 评分增强
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `weibullDecay.enabled` | `true` | Weibull 分布衰减 |
| `weibullDecay.shape` | `1.5` | Weibull 形状参数 |
| `weibullDecay.scale` | `90` | Weibull 尺度参数（天） |
| `reinforcement.enabled` | `true` | 访问次数强化 |
| `reinforcement.factor` | `0.5` | 每次访问的强化因子 |
| `reinforcement.maxMultiplier` | `3` | 最大强化倍数 |
| `lengthNorm.enabled` | `true` | 长度归一化 |
| `lengthNorm.anchor` | `500` | 锚点长度 |
| `hardMinScore.enabled` | `true` | 硬阈值过滤 |
| `hardMinScore.threshold` | `0.35` | 分数低于此值的结果丢弃 |

### MMR 多样化检索
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `mmr.enabled` | `true` | 启用 MMR 多样化检索 |
| `mmr.lambda` | `0.7` | 相关性/多样性平衡（1=全相关，0=全多样）|
| `mmr.threshold` | `0.85` | MMR 截断阈值 |

### 自适应召回
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `adaptiveRetrieval.minQueryLength` | `2` | 查询长度小于此值不触发召回 |
| `adaptiveRetrieval.forceKeywords` | 见下方 | 含这些词强制触发召回 |
| `adaptiveRetrieval.sessionDedup.enabled` | `true` | 开启会话内去重 |
| `adaptiveRetrieval.sessionDedup.windowMs` | `30000` | 去重时间窗口（毫秒）|
| `adaptiveRetrieval.sessionDedup.similarityThreshold` | `0.75` | Jaccard 相似度阈值 |

> **forceKeywords 默认值**
> 中文：`['记住', '之前', '上次', '记得', '前', 'what', 'why', 'how', '什么', '为什么', '怎么']`
> 英文：`['remember', 'before', 'last', 'previously', 'earlier', 'what', 'why', 'how']`

### 去重与过滤
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `smartDedup` | `true` | 开启 Jaccard 智能去重 |
| `dedupThreshold` | `0.85` | Jaccard 相似度阈值 |
| `noiseFilter.enabled` | `true` | 开启噪声过滤 |
| `noiseFilter.skipGreetings` | `true` | 过滤 hi/hello/hey/你好/您好/嗨 |
| `noiseFilter.skipCommands` | `true` | 过滤 / ! - 开头的命令 |

### LLM（可选，默认关闭）
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `llm.enabled` | `false` | 是否启用 LLM |
| `llm.provider` | `"auto"` | 提供商 |
| `llm.model` | `""` | 模型名称（留空使用各 provider 默认）|
| `llm.customModelNames` | `{}` | 自定义模型显示名映射 |
| `threshold.useLlmForCore` | `false` | LLM 判断 core |
| `threshold.useLlmForExtract` | `false` | LLM 提取关键词 |
| `threshold.useLlmForDedup` | `false` | LLM 辅助去重 |

### 批量与压缩
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `batchWrite.enabled` | `true` | 开启批量写入 |
| `batchWrite.bufferMs` | `500` | 批量缓冲区延迟（毫秒）|
| `batchWrite.maxBatchSize` | `20` | 超过此条数立即写入 |
| `compression.enabled` | `true` | 开启压缩存储 |
| `compression.maxLength` | `200` | 压缩后最大长度 |
| `compression.extractKeywords` | `true` | 提取关键词补充摘要 |

---

## 数据结构

### memories 表
```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  scope TEXT DEFAULT 'agent',
  content TEXT NOT NULL,
  type TEXT DEFAULT 'other',
  tier TEXT DEFAULT 'working',      -- core / working / peripheral
  layer TEXT DEFAULT 'general',
  keywords TEXT,
  importance REAL DEFAULT 0.5,
  access_count INTEGER DEFAULT 0,
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
-- INSERT/UPDATE/DELETE 触发器自动同步
```

### tier_history 表（可选）
```sql
CREATE TABLE tier_history (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  old_tier TEXT,
  new_tier TEXT NOT NULL,
  reason TEXT,
  access_count INTEGER,
  created_at INTEGER
);
```

---

## 与 OpenClaw 内置 memory 的关系

algo-memory 和 OpenClaw 内置的 `memory-core` / `memory-lancedb` **共用同一插槽，不可同时使用**。

```json
{
  "plugins": {
    "slots": {
      "memory": "algo-memory"
    }
  }
}
```

**algo-memory 的独有价值：**
- 无需 embedding API，离线/隐私友好
- importance / cited_count / tier 三层分级
- Weibull 时间衰减 + reinforcement 强化机制
- 结构化 import/export/correct 操作
- 纯算法模式零 LLM 成本

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
