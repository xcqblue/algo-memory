# 配置参考

完整默认值见 `openclaw.plugin.json` 的 `configSchema`。

## 快速开始

```json
{
  "enabled": true,
  "autoCapture": true,
  "autoRecall": true,
  "maxResults": 5,
  "coreKeywords": ["记住", "重要", "不要忘记"]
}
```

---

## 基础配置

| 配置 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 是否启用插件 |
| `autoCapture` | `true` | 自动存储用户消息 |
| `autoRecall` | `true` | 自动注入记忆到 prompt |
| `maxResults` | `5` | 单次召回最大条数 |
| `capturePerTurn` | `3` | 每轮对话最多存储条数 |
| `cleanupDays` | `180` | peripheral 层记忆超过此天数后清理 |
| `language` | `"auto"` | 语言：`auto` / `zh` / `en` |

---

## 核心识别

| 配置 | 默认 | 说明 |
|------|------|------|
| `coreKeywords` | 见下方 | 命中这些关键词的消息直接标记为 core |
| `recencyDecay` | `true` | 开启时间衰减（地板 0.5） |
| `recencyHalfLife` | `180` 天 | 时间衰减半衰期 |

> **coreKeywords 默认值**
> ```json
> ["记住", "牢记", "重要", "不要忘记", "记住它", "remember", "important", "never forget"]
> ```

---

## 去重与过滤

| 配置 | 默认 | 说明 |
|------|------|------|
| `smartDedup` | `true` | 开启 Jaccard 智能去重 |
| `dedupThreshold` | `0.85` | Jaccard 相似度阈值，超过此值认为是重复 |

### 噪声过滤

| 配置 | 默认 | 说明 |
|------|------|------|
| `noiseFilter.enabled` | `true` | 开启噪声过滤 |
| `noiseFilter.skipGreetings` | `true` | 过滤 hi/hello/hey/你好/您好/嗨 |
| `noiseFilter.skipCommands` | `true` | 过滤 / ! - 开头的命令 |

> **注意**：`noiseFilter.enabled = false` 会完全禁用噪声过滤

---

## 自适应召回

| 配置 | 默认 | 说明 |
|------|------|------|
| `adaptiveRetrieval.enabled` | `true` | 开启自适应检索判断 |
| `adaptiveRetrieval.minQueryLength` | `2` | 查询长度小于此值不触发召回 |
| `adaptiveRetrieval.forceKeywords` | 见下方 | 含这些词强制触发召回（与语言默认值合并） |

### 会话去重

| 配置 | 默认 | 说明 |
|------|------|------|
| `adaptiveRetrieval.sessionDedup.enabled` | `true` | 开启会话内去重 |
| `adaptiveRetrieval.sessionDedup.windowMs` | `30000` | 去重时间窗口（毫秒） |
| `adaptiveRetrieval.sessionDedup.similarityThreshold` | `0.6` | Jaccard 相似度阈值 |

> **forceKeywords 默认值**
> - 中文：`['记住', '之前', '上次', '记得', '前', '上次', 'what', 'why', 'how', '什么', '为什么', '怎么']`
> - 英文：`['remember', 'before', 'last', 'previously', 'earlier', 'what', 'why', 'how']`
> - 日/韩/西/法/德亦有对应词表

---

## 评分增强

| 配置 | 默认 | 说明 |
|------|------|------|
| `weibullDecay.enabled` | `true` | Weibull 分布衰减（替代指数衰减） |
| `weibullDecay.shape` | `1.5` | Weibull 形状参数 |
| `weibullDecay.scale` | `90` | Weibull 尺度参数（天） |
| `reinforcement.enabled` | `true` | 访问次数强化 |
| `reinforcement.factor` | `0.5` | 每次访问的强化因子 |
| `reinforcement.maxMultiplier` | `3` | 最大强化倍数 |
| `mmr.enabled` | `true` | 开启 MMR 多样性去重（recall 模式） |
| `mmr.lambda` | `0.7` | λ×相关 − (1−λ)×多样 |
| `mmr.threshold` | `0.85` | 早停阈值 |
| `lengthNorm.enabled` | `true` | 长度归一化 |
| `lengthNorm.anchor` | `500` | 锚点长度 |
| `hardMinScore.enabled` | `true` | 硬阈值过滤 |
| `hardMinScore.threshold` | `0.35` | 分数低于此值的结果丢弃 |

> **时间衰减公式**：`score × (0.5 + 0.5 × 0.5^(daysOld / halfLife))`

---

## 三层晋升

| 配置 | 默认 | 说明 |
|------|------|------|
| `tier.enabled` | `true` | 启用三层晋升 |
| `tier.coreThreshold` | `10` | 访问次数达到此值晋升 core |
| `tier.peripheralThreshold` | `0.15` | 分数低于此值降级 peripheral |
| `tier.ageDays` | `60` | 超过此天数的记忆不因高 importance 升 core |

### 层级说明

| 层级 | 条件 | 权重 |
|------|------|------|
| core | 高频访问（≥coreThreshold）或高 importance | ×1.5 |
| working | 普通对话 | ×1.0 |
| peripheral | 低频/超期 | ×0.5（自动清理）|

---

## 会话续接

解决"晚上对话后，第二天早上继续时上下文丢失"的问题。

| 配置 | 默认 | 说明 |
|------|------|------|
| `sessionContinuity.enabled` | `true` | 启用会话续接 |
| `sessionContinuity.maxInjectTokens` | `800` | 注入上下文的最大 token 数 |
| `sessionContinuity.maxMessagesForSummary` | `30` | 生成摘要时最多使用多少条消息 |

### 工作原理

1. `agent_end` 钩子：保存会话快照到数据库
2. `session_start` 钩子：检测会话切换，注入上会话上下文

---

## Session 摘要

| 配置 | 默认 | 说明 |
|------|------|------|
| `sessionSummary.enabled` | `true` | 开启 session 结束时写 Markdown 摘要 |
| `sessionSummary.dir` | `"memory"` | 摘要目录（相对于 stateDir） |
| `sessionSummary.maxItems` | `50` | 每次写入的最大条数 |

---

## 反馈修正

| 配置 | 默认 | 说明 |
|------|------|------|
| `feedback.enabled` | `true` | 开启反馈修正 |
| `feedback.maxMemories` | `5` | 单次反馈最多修正的记忆条数 |
| `feedback.matchThreshold` | `0.6` | 匹配阈值 |

---

## LLM 配置（可选）

| 配置 | 默认 | 说明 |
|------|------|------|
| `llm.enabled` | `false` | 是否启用 LLM 调用 |
| `llm.provider` | `"auto"` | 提供商：auto / openai / anthropic / azure / gemini / ollama |
| `llm.apiKey` | `""` | API Key |
| `llm.model` | `""` | 模型名称 |
| `llm.baseURL` | `""` | API Base URL（可选） |
| `llm.batchWindowMs` | `200` | LLM 批量处理窗口期（毫秒） |

> **注意**：LLM 默认关闭，纯算法模式零成本运行

---

## 批量写入

| 配置 | 默认 | 说明 |
|------|------|------|
| `batchWrite.enabled` | `true` | 开启批量写入 |
| `batchWrite.bufferMs` | `500` | 批量缓冲区延迟（毫秒） |
| `batchWrite.maxBatchSize` | `20` | 超过此条数立即写入 |

---

## 压缩存储

| 配置 | 默认 | 说明 |
|------|------|------|
| `compression.enabled` | `true` | 开启压缩存储 |
| `compression.maxLength` | `200` | 压缩后最大长度 |
| `compression.extractKeywords` | `true` | 提取关键词补充 |
| `compression.semanticEnhance` | `false` | 语义增强压缩 |

---

## 完整配置示例

```json
{
  "enabled": true,
  "autoCapture": true,
  "autoRecall": true,
  "maxResults": 5,
  "capturePerTurn": 3,
  "cleanupDays": 180,
  "language": "auto",
  "coreKeywords": ["记住", "重要", "别忘", "不要忘记", "remember", "important", "never forget"],
  "smartDedup": true,
  "dedupThreshold": 0.85,
  "noiseFilter": {
    "enabled": true,
    "skipGreetings": true,
    "skipCommands": true
  },
  "adaptiveRetrieval": {
    "enabled": true,
    "minQueryLength": 2,
    "forceKeywords": ["记住", "之前", "上次", "记得"],
    "sessionDedup": {
      "enabled": true,
      "windowMs": 30000,
      "similarityThreshold": 0.6
    }
  },
  "weibullDecay": {
    "enabled": true,
    "shape": 1.5,
    "scale": 90
  },
  "reinforcement": {
    "enabled": true,
    "factor": 0.5,
    "maxMultiplier": 3
  },
  "mmr": {
    "enabled": true,
    "threshold": 0.85,
    "lambda": 0.7
  },
  "lengthNorm": {
    "enabled": true,
    "anchor": 500
  },
  "hardMinScore": {
    "enabled": true,
    "threshold": 0.35
  },
  "tier": {
    "enabled": true,
    "coreThreshold": 10,
    "peripheralThreshold": 0.15,
    "ageDays": 60
  },
  "sessionContinuity": {
    "enabled": true,
    "maxInjectTokens": 800,
    "maxMessagesForSummary": 30
  },
  "sessionSummary": {
    "enabled": true,
    "dir": "memory",
    "maxItems": 50
  },
  "feedback": {
    "enabled": true,
    "maxMemories": 5,
    "matchThreshold": 0.6
  },
  "llm": {
    "enabled": false,
    "provider": "auto",
    "apiKey": "",
    "model": "",
    "baseURL": "",
    "batchWindowMs": 200
  },
  "compression": {
    "enabled": true,
    "maxLength": 200,
    "extractKeywords": true,
    "semanticEnhance": false
  },
  "batchWrite": {
    "enabled": true,
    "bufferMs": 500,
    "maxBatchSize": 20
  }
}
```
