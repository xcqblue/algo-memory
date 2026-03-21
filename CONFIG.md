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

> **forceKeywords 默认值**
> `['记住', '之前', '上次', '记得', 'remember', 'before', 'last', 'what', 'why', 'how', '什么', '为什么', '怎么']`

### 评分增强

| 配置 | 默认 | 说明 |
|------|------|------|
| `weibullDecay.enabled` | `false` | Weibull 分布衰减（替代指数衰减） |
| `reinforcement.enabled` | `false` | 访问次数强化（访问越多分数越高） |
| `mmr.enabled` | `false` | 开启 MMR 多样性去重 |
| `mmr.lambda` | `0.7` | λ×相关 − (1−λ)×多样，λ=1 只求相关，λ=0 只求多样 |
| `mmr.threshold` | `0.85` | 早停阈值 |
| `lengthNorm.enabled` | `false` | 长度归一化（防止长文本霸榜） |
| `hardMinScore.enabled` | `false` | 硬阈值过滤，分数低于此值的结果丢弃 |

**时间衰减公式**：`score × (0.5 + 0.5 × 0.5^(daysOld / halfLife))`

### 三层晋升

| 配置 | 默认 | 说明 |
|------|------|------|
| `tier.enabled` | `false` | 启用三层晋升 |
| `tier.coreThreshold` | `10` | 访问次数达到此值晋升 core |
| `tier.peripheralThreshold` | `0.15` | 分数低于此值降级 peripheral |
| `tier.ageDays` | `60` | 超过此天数的记忆不因高 importance 升 core |

### Session 摘要

| 配置 | 默认 | 说明 |
|------|------|------|
| `sessionSummary.enabled` | `false` | 开启 session 结束时写 Markdown 摘要 |
| `sessionSummary.dir` | `"memory"` | 摘要目录（相对于 stateDir） |
| `sessionSummary.maxItems` | `50` | 每次写入的最大条数 |

### 隔离与 LLM

| 配置 | 默认 | 说明 |
|------|------|------|
| `scopes.enabled` | `true` | 启用 Agent 隔离模式 |
| `scopes.visibleAgents` | `[]` | 允许查看的 Agent ID（`["*"]` 表示全部） |
| `llm.enabled` | `true` | `false` = 纯算法零成本模式 |
| `llm.provider` | `"auto"` | 自动探测可用提供商 |

> 支持提供商：MiniMax / DeepSeek / 智谱 / Kimi / 百炼 / 混元 / SiliconFlow / OpenAI / Anthropic / Ollama
