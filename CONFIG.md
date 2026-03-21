# 配置参考

完整默认配置见 `openclaw.plugin.json` 的 `configSchema`。

## 快速配置

```json
{
  "autoCapture": true,
  "autoRecall": true,
  "maxResults": 5,
  "coreKeywords": ["记住", "重要"]
}
```

## 配置项详解

### 基础

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `autoCapture` | boolean | `true` | 自动存储用户消息 |
| `autoRecall` | boolean | `true` | 自动注入相关记忆到 prompt |
| `maxResults` | number | `5` | 单次召回最大条数 |
| `capturePerTurn` | number | `3` | 每轮最多存储条数 |
| `cleanupDays` | number | `180` | peripheral 记忆超过此天数后被清理 |
| `language` | string | `"auto"` | 语言：auto / zh / en |

### 核心记忆

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `coreKeywords` | string[] | 见下方 | 命中后直接标记为 core 的关键词 |
| `recencyDecay` | boolean | `true` | 开启时间衰减评分（地板 0.5） |
| `recencyHalfLife` | number | `180` | 时间衰减半衰期（天） |

**coreKeywords 默认值**：`['记住', '牢记', '重要', '不要忘记', '记住它', 'remember', 'important', 'never forget']`

### 去重

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `smartDedup` | boolean | `true` | 开启 Jaccard 智能去重 |
| `dedupThreshold` | number | `0.85` | Jaccard 相似度阈值（超过即认为重复） |

### 过滤

```json
"noiseFilter": {
  "enabled": true,
  "skipGreetings": true,
  "skipCommands": true
}
```

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `noiseFilter.enabled` | boolean | `true` | 开启噪声过滤 |
| `noiseFilter.skipGreetings` | boolean | `true` | 过滤 hi/hello/你好 等问候语 |
| `noiseFilter.skipCommands` | boolean | `true` | 过滤 / ! - 开头的命令 |

### 自适应召回

```json
"adaptiveRetrieval": {
  "enabled": true,
  "minQueryLength": 2,
  "forceKeywords": ["记住", "之前", "上次", ...],
  "sessionDedup": {
    "enabled": true,
    "windowMs": 30000,
    "similarityThreshold": 0.6
  }
}
```

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `adaptiveRetrieval.enabled` | boolean | `true` | 开启自适应检索判断 |
| `adaptiveRetrieval.minQueryLength` | number | `2` | 查询长度小于此值时不触发召回（中文 6 字符，英文 15 字符） |
| `adaptiveRetrieval.forceKeywords` | string[] | 见下方 | 包含这些词时强制触发召回 |
| `adaptiveRetrieval.sessionDedup.enabled` | boolean | `true` | 开启会话去重 |
| `adaptiveRetrieval.sessionDedup.windowMs` | number | `30000` | 去重时间窗口（毫秒） |
| `adaptiveRetrieval.sessionDedup.similarityThreshold` | number | `0.6` | Jaccard 相似度超过此值视为同一查询 |

**forceKeywords 默认值**：`['记住', '之前', '上次', '记得', 'remember', 'before', 'last', '前', 'what', 'why', 'how', '什么', '为什么', '怎么']`

**注意**：会话去重启用时，召回结果不缓存，确保每次判断都是实时的。

### 评分增强

```json
"weibullDecay": { "enabled": false, "shape": 1.5, "scale": 90 },
"reinforcement": { "enabled": false, "factor": 0.5, "maxMultiplier": 3 },
"urgencyDecay": { "enabled": false, "halfLifeHours": 168 },
"citedBoost": { "enabled": true, "factor": 0.05 },
"mmr": { "enabled": false, "threshold": 0.85, "lambda": 0.7 },
"lexicalOverlap": { "enabled": true, "threshold": 0.5, "penalty": 0.3 },
"lengthNorm": { "enabled": false, "anchor": 500 },
"hardMinScore": { "enabled": false, "threshold": 0.35 }
```

| 配置 | 说明 |
|------|------|
| `weibullDecay` | Weibull 分布衰减（替代指数衰减） |
| `reinforcement` | 访问次数强化因子（访问越多分数越高） |
| `urgencyDecay` | 新记忆 urgency=1.0，按半衰期快速淡化（默认 168h = 7 天） |
| `citedBoost` | 被引用次数多的记忆排名更高：`score × (1 + factor × cited_count)` |
| `mmr` | 最大边际相关性：真 MMR 公式 `λ×rel − (1−λ)×div`，`lambda` 控制相关/多样权重 |
| `lexicalOverlap` | MMR 后二次词重叠降权，超阈值 penalize 低分项 |
| `lengthNorm` | 长度归一化，防止长记忆占太多分数 |
| `hardMinScore` | 硬阈值过滤，分数低于此值的结果直接丢弃 |

**时间衰减公式**（recencyDecay）：
```
score *= 0.5 + 0.5 * 0.5^(daysOld / halfLife)
```
地板值 0.5，老记忆最低保留 50% 权重。

### 三层晋升

```json
"tier": {
  "enabled": false,
  "coreThreshold": 10,
  "peripheralThreshold": 0.15,
  "ageDays": 60,
  "weights": {
    "core": 1.5,
    "working": 1.0,
    "peripheral": 0.5
  }
}
```

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `tier.enabled` | boolean | `false` | 启用三层晋升 |
| `tier.coreThreshold` | number | `10` | 访问次数达到此值后晋升为 core |
| `tier.peripheralThreshold` | number | `0.15` | compositeScore 低于此值降级为 peripheral |
| `tier.ageDays` | number | `60` | 超过此天数的记忆不会因高 importance 而升 core |
| `tier.weights.core` | number | `1.5` | core 记忆的召回权重倍数 |
| `tier.weights.working` | number | `1.0` | working 记忆的召回权重倍数 |
| `tier.weights.peripheral` | number | `0.5` | peripheral 记忆的召回权重倍数 |

> 召回评分公式：`score = tier权重 × importance × 时间衰减 × (0.5 + 0.5 × decay)`

### Session 摘要

```json
"sessionSummary": {
  "enabled": false,
  "dir": "memory",
  "maxItems": 50
}
```

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `sessionSummary.enabled` | boolean | `false` | 开启 session 结束时写 Markdown 摘要 |
| `sessionSummary.dir` | string | `"memory"` | 摘要目录（相对于 stateDir） |
| `sessionSummary.maxItems` | number | `50` | 每次写入的最大条数 |

### Agent 隔离

```json
"scopes": {
  "enabled": true,
  "defaultScope": "agent",
  "visibleAgents": []
}
```

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `scopes.enabled` | boolean | `true` | 启用 Agent 隔离模式 |
| `scopes.visibleAgents` | string[] | `[]` | 允许查看的 Agent ID 列表（设为 `["*"]` 表示全部） |

### LLM（可选）

```json
"llm": {
  "enabled": true,
  "provider": "auto",
  "apiKey": "",
  "model": "",
  "baseURL": ""
}
```

支持提供商：MiniMax / DeepSeek / 智谱 / Kimi / 百炼 / 混元 / SiliconFlow / OpenAI / Anthropic / Ollama。

| 配置 | 说明 |
|------|------|
| `llm.enabled=false` | 纯算法模式，零 API 费用 |
| `llm.enabled=true` | LLM 增强（核心判断、关键词提取、去重判断） |

### 阈值（Threshold）

```json
"threshold": {
  "useLlmForCore": false,
  "useLlmForExtract": false,
  "useLlmForDedup": false,
  "minConfidence": 0.8,
  "lengthForCore": 100,
  "lengthForExtract": 200,
  "dedupUncertaintyMin": 0.5,
  "dedupUncertaintyMax": 0.98
}
```

| 配置 | 说明 |
|------|------|
| `useLlmForCore` | 用 LLM 判断是否为核心记忆 |
| `useLlmForExtract` | 用 LLM 提取关键词 |
| `useLlmForDedup` | 在不确定区间内用 LLM 判断重复 |
| `dedupUncertaintyMin/Max` | Jaccard 在此区间内调用 LLM 去重 |
