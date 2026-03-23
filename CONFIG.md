# 配置参考

完整默认值见 `openclaw.plugin.json` 的 `configSchema`。

## 快速开始

```json
{
  "autoCapture": true,
  "autoRecall": true,
  "maxResults": 5,
  "coreKeywords": ["记住", "重要", "不要忘记"]
}
```

---

## 配置项

### 基础

| 配置 | 默认 | 说明 |
|------|------|------|
| `autoCapture` | `true` | 自动存储用户消息 |
| `autoRecall` | `true` | 自动注入记忆到 prompt |
| `maxResults` | `5` | 单次召回最大条数 |
| `capturePerTurn` | `3` | 每轮最多存储条数 |
| `cleanupDays` | `180` | peripheral 记忆超过此天数后清理 |
| `language` | `"auto"` | 语言：`auto` / `zh` / `en` |

### 核心识别

| 配置 | 默认 | 说明 |
|------|------|------|
| `coreKeywords` | 见下方 | 命中后直接标记为 core |
| `recencyDecay` | `true` | 开启时间衰减（地板 0.5） |
| `recencyHalfLife` | `180` 天 | 时间衰减半衰期 |

> **coreKeywords 默认值**
> `['记住', '牢记', '重要', '不要忘记', 'remember', 'important', 'never forget']`

### 去重与过滤

| 配置 | 默认 | 说明 |
|------|------|------|
| `smartDedup` | `true` | 开启 Jaccard 智能去重 |
| `dedupThreshold` | `0.85` | Jaccard 相似度阈值 |
| `noiseFilter.enabled` | `true` | 开启噪声过滤 |
| `noiseFilter.skipGreetings` | `true` | 过滤 hi/hello/你好 |
| `noiseFilter.skipCommands` | `true` | 过滤 / ! - 开头的命令 |

### 自适应召回

| 配置 | 默认 | 说明 |
|------|------|------|
| `adaptiveRetrieval.enabled` | `true` | 开启自适应检索判断 |
| `adaptiveRetrieval.minQueryLength` | `2` | 小于此值不触发召回 |
| `adaptiveRetrieval.forceKeywords` | 见下方 | 含这些词强制触发召回 |
| `adaptiveRetrieval.sessionDedup.enabled` | `true` | 开启会话去重 |
| `adaptiveRetrieval.sessionDedup.windowMs` | `30000` | 去重时间窗口（毫秒） |
| `adaptiveRetrieval.sessionDedup.similarityThreshold` | `0.6` | Jaccard 相似度阈值 |

> **forceKeywords 默认值**（语言感知，从 `RETRIEVE_KEYWORDS_MAP` 动态加载）
> 中文：`['记住', '之前', '上次', '记得']`
> 英文：`['remember', 'before', 'last', 'previously', 'earlier']`
> 日/韩/西/法/德亦有对应词表。配置中的 `forceKeywords` 会与语言默认值合并。

### 评分增强（默认均开启）

| 配置 | 默认 | 说明 |
|------|------|------|
| `weibullDecay.enabled` | `true` | Weibull 分布衰减（替代指数衰减） |
| `reinforcement.enabled` | `true` | 访问次数强化（访问越多分数越高） |
| `mmr.enabled` | `true` | 开启 MMR 多样性去重（recall 模式） |
| `mmr.lambda` | `0.7` | λ×相关 − (1−λ)×多样，λ=1 只求相关，λ=0 只求多样 |
| `mmr.threshold` | `0.85` | 早停阈值 |
| `lengthNorm.enabled` | `true` | 长度归一化（防止长文本霸榜） |
| `hardMinScore.enabled` | `true` | 硬阈值过滤，分数低于此值的结果丢弃 |

**时间衰减公式**：`score × (0.5 + 0.5 × 0.5^(daysOld / halfLife))`

### 三层晋升

| 配置 | 默认 | 说明 |
|------|------|------|
| `tier.enabled` | `true` | 启用三层晋升 |
| `tier.coreThreshold` | `10` | 访问次数达到此值晋升 core |
| `tier.peripheralThreshold` | `0.15` | 分数低于此值降级 peripheral |
| `tier.ageDays` | `60` | 超过此天数的记忆不因高 importance 升 core |

### Session 摘要

| 配置 | 默认 | 说明 |
|------|------|------|
| `sessionSummary.enabled` | `true` | 开启 session 结束时写 Markdown 摘要 |
| `sessionSummary.dir` | `"memory"` | 摘要目录（相对于 stateDir） |
| `sessionSummary.maxItems` | `50` | 每次写入的最大条数 |

### 会话续接

| 配置 | 默认 | 说明 |
|------|------|------|
| `sessionContinuity.enabled` | `true` | 开启会话续接功能 |
| `sessionContinuity.maxInjectTokens` | `800` | 注入上会话上下文的最大 token 数 |
| `sessionContinuity.maxMessagesForSummary` | `30` | 生成摘要时最多使用的消息条数 |

> **会话续接功能**：解决"晚上对话后，第二天早上继续时上下文丢失"的问题。
> 当检测到会话切换（新 session）时，自动从数据库读取上会话快照并注入上下文。
> `lastSessionKey` 会持久化到数据库，Gateway 重启后不会丢失。

### 批量写入

| 配置 | 默认 | 说明 |
|------|------|------|
| `batchWrite.enabled` | `true` | 开启批量写入，减少数据库 IO |
| `batchWrite.bufferMs` | `500` | 批量写入的缓冲时间（毫秒） |
| `batchWrite.maxBatchSize` | `20` | 单次批量写入的最大条数 |

> **批量写入功能**：将多条消息累积后一次性写入数据库，减少 IO 次数。
> 例如：用户连续发3条消息，会先缓存，500ms 后批量写入一次而非3次。

### 记忆压缩

| 配置 | 默认 | 说明 |
|------|------|------|
| `compression.enabled` | `true` | 开启记忆内容压缩 |
| `compression.maxLength` | `200` | 压缩后内容的最大字符数 |
| `compression.extractKeywords` | `true` | 是否提取关键词作为摘要补充 |
| `compression.semanticEnhance` | `false` | 启用语义增强压缩（保留关键信息如航班号、日期、价格等） |

> **记忆压缩功能**：长内容自动压缩存储，减少存储空间和 token 消耗。
> 例如：500字符的内容会压缩到200字符，保留核心信息。
> 元数据中会记录原文摘要，便于需要时恢复完整信息。
>
> **语义增强模式** (`semanticEnhance: true`):
> - 自动提取航班号、日期、时间、金额、地点等关键信息
> - 优先保留关键信息，格式如：`MU5101 | 3/24 | 980元 | 核心句子...`

### 批量写入优化

| 配置 | 默认 | 说明 |
|------|------|------|
| `batchWrite.enabled` | `true` | 开启批量写入，减少数据库 IO |
| `batchWrite.bufferMs` | `500` | 批量写入的缓冲时间（毫秒） |
| `batchWrite.maxBatchSize` | `20` | 单次批量写入的最大条数 |

> **批量写入功能**：将多条消息累积后一次性写入数据库，减少 IO 次数。
> 例如：用户连续发3条消息，会先缓存，500ms 后批量写入一次而非3次。
>
> **Idle 检测优化**：当检测到用户空闲（无新消息）超过 bufferMs 的 50% 时，会提前刷新缓冲区。

### 分层历史记录

| 配置 | 默认 | 说明 |
|------|------|------|
| `tier.enabled` | `true` | 开启记忆分层 |
| `tier.coreThreshold` | `10` | 晋升为 core 的访问次数阈值 |
| `tier.peripheralThreshold` | `0.15` | 降级为 peripheral 的复合分数阈值 |
| `tier.ageDays` | `60` | 超过此天数的记忆不晋升为 core |

> **分层历史功能**：自动记录记忆的分层变化历史。
> 当记忆从 peripheral → working → core 晋升（或降级）时，会记录：
> - 变化时间
> - 原分层 → 新分层
> - 触发原因（访问次数/重要性/时间）
>
> 可通过查询 `tier_history` 表查看记忆的变化历史。

### 记忆修正

| 配置 | 默认 | 说明 |
|------|------|------|
| `feedback.enabled` | `true` | 开启自然语言修正功能 |
| `feedback.maxMemories` | `5` | 每次修正时召回的最大候选数 |
| `feedback.matchThreshold` | `0.6` | LLM 修正建议最低置信度 |

### 隔离与 LLM

| 配置 | 默认 | 说明 |
|------|------|------|
| `scopes.enabled` | `true` | 启用 Agent 隔离模式 |
| `scopes.visibleAgents` | `[]` | 允许查看的 Agent ID（`["*"]` 表示全部） |
| `llm.enabled` | `false` | `false` = 纯算法零成本模式（默认推荐） |
| `llm.provider` | `"auto"` | 自动探测可用提供商 |
| `threshold.useLlmForCore` | `false` | LLM 判断是否为重要记忆，需同时开启 `llm.enabled` 并配置 API Key |
| `threshold.useLlmForExtract` | `false` | LLM 提取关键词，需同时开启 `llm.enabled` 并配置 API Key |
| `threshold.useLlmForDedup` | `false` | LLM 判断是否重复，需同时开启 `llm.enabled` 并配置 API Key |

> ⚠️ 开启 LLM 功能后，首次启动时若未配置 `llm.apiKey`，会输出警告并降级为规则判断。

> 支持提供商：MiniMax / DeepSeek / 智谱 / Kimi / 百炼 / 混元 / SiliconFlow / OpenAI / Anthropic / Ollama

### MCP（默认关闭）

| 配置 | 默认 | 说明 |
|------|------|------|
| `mcp.enabled` | `false` | 开启后通过 MCP 协议暴露所有工具给外部 AI 调用 |
| `mcp.transport` | `"stdio"` | 传输模式（`stdio` 或 `http`） |
| `mcp.port` | `8181` | HTTP 模式监听端口 |
