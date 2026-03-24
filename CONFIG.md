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
| `autoCapture` | `true` | agent_end 时自动存储用户消息 |
| `autoRecall` | `true` | before_prompt_build 时自动注入记忆 |
| `maxResults` | `5` | 单次召回最大条数 |
| `capturePerTurn` | `3` | 每轮对话最多存储条数 |
| `cleanupDays` | `180` | peripheral 层记忆超过此天数后清理 |
| `snapshotRetentionDays` | `30` | session_snapshots 表保留天数 |
| `metricsEnabled` | `true` | 记录 LLM token 使用统计 |
| `language` | `"auto"` | 语言：`auto` / `zh` / `en` |

---

## 核心识别

| 配置 | 默认 | 说明 |
|------|------|------|
| `coreKeywords` | 见下方 | 命中这些关键词的消息直接标记为 core |
| `recencyDecay` | `true` | 开启时间衰减 |
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

---

## 自适应召回

| 配置 | 默认 | 说明 |
|------|------|------|
| `adaptiveRetrieval.enabled` | `true` | 开启自适应检索判断 |
| `adaptiveRetrieval.minQueryLength` | `2` | 查询长度小于此值不触发召回 |

### 会话去重

| 配置 | 默认 | 说明 |
|------|------|------|
| `adaptiveRetrieval.sessionDedup.enabled` | `true` | 开启会话内去重 |
| `adaptiveRetrieval.sessionDedup.windowMs` | `30000` | 去重时间窗口（毫秒）|
| `adaptiveRetrieval.sessionDedup.similarityThreshold` | `0.75` | Jaccard 相似度阈值 |

### 强制召回关键词

| 配置 | 默认 | 说明 |
|------|------|------|
| `adaptiveRetrieval.forceKeywords` | 见下方 | 含这些词强制触发召回 |

> **forceKeywords 默认值**
> - 中文：`['记住', '之前', '上次', '记得', '前', 'what', 'why', 'how', '什么', '为什么', '怎么']`
> - 英文：`['remember', 'before', 'last', 'previously', 'earlier', 'what', 'why', 'how']`

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
| `lengthNorm.enabled` | `true` | 长度归一化 |
| `lengthNorm.anchor` | `500` | 锚点长度 |
| `hardMinScore.enabled` | `true` | 硬阈值过滤 |
| `hardMinScore.threshold` | `0.35` | 分数低于此值的结果丢弃 |

---

## MMR 多样化检索

| 配置 | 默认 | 说明 |
|------|------|------|
| `mmr.enabled` | `true` | 开启 MMR 多样性检索 |
| `mmr.lambda` | `0.7` | λ×相关 − (1−λ)×多样（1=全相关，0=全多样）|
| `mmr.threshold` | `0.85` | 早停阈值 |

---

## 三层分级

| 配置 | 默认 | 说明 |
|------|------|------|
| `tier.enabled` | `true` | 启用三层分级 |
| `tier.coreThreshold` | `10` | 访问次数达到此值晋升 core |
| `tier.peripheralThreshold` | `0.15` | 复合评分低于此值降级 peripheral |
| `tier.ageDays` | `60` | 超过此天数的记忆不因高 importance 升 core |

### 层级权重（recall 时的得分乘数）

| 层级 | 默认权重 | 说明 |
|------|---------|------|
| core | ×1.5 | 高频访问或高 importance |
| working | ×1.0 | 普通对话 |
| peripheral | ×0.5 | 低频/超期，自动清理 |

### 晋升条件

```
tier score = importance × (1 + log10(access_count + 1))

core:       access_count ≥ 10
            OR (score ≥ 0.7 AND age ≤ 60 days)

peripheral: score < 0.15
            OR (age > 60 days AND score < 0.7)

working:    everything in between
```

---

## 会话续接

解决"晚上对话后，第二天早上继续时上下文丢失"的问题。

| 配置 | 默认 | 说明 |
|------|------|------|
| `sessionContinuity.enabled` | `true` | 启用会话续接 |
| `sessionContinuity.maxInjectTokens` | `800` | 注入上下文的最大 token 数 |
| `sessionContinuity.maxMessagesForSummary` | `30` | 生成摘要最多使用多少条消息 |

**工作原理：**
1. `agent_end` 钩子：保存会话快照到 `session_snapshots` 表
2. 下次会话开始：检测到 sessionKey 变化，从 DB 读取上会话摘要注入上下文

---

## Session 摘要

| 配置 | 默认 | 说明 |
|------|------|------|
| `sessionSummary.enabled` | `true` | 开启 session 结束时写摘要 |
| `sessionSummary.maxItems` | `50` | 摘要最大条数（超出截断旧条目）|

> 注意：`sessionSummary.dir` 配置已废弃（v2.6.0 禁用了直接写 workspace 文件，避免与 workspace plugin 冲突）。如需导出，使用 `algo_memory_export` 工具。

---

## 反馈修正

| 配置 | 默认 | 说明 |
|------|------|------|
| `feedback.enabled` | `true` | 开启反馈修正 |
| `feedback.maxMemories` | `5` | 单次反馈最多召回的记忆条数 |
| `feedback.matchThreshold` | `0.6` | LLM 匹配置信度阈值 |

---

## LLM 配置（可选，默认关闭）

| 配置 | 默认 | 说明 |
|------|------|------|
| `llm.enabled` | `false` | 是否启用 LLM 调用 |
| `llm.provider` | `"auto"` | 提供商：minimax / deepseek / kimi / zhipu / qwen / openai / anthropic / ollama / siliconflow |
| `llm.apiKey` | `""` | API Key |
| `llm.model` | `""` | 模型名称（留空使用各 provider 默认）|
| `llm.baseURL` | `""` | API Base URL（可选）|
| `llm.batchWindowMs` | `200` | LLM 批量处理窗口期（毫秒）|

### LLM 辅助开关

| 配置 | 默认 | 说明 |
|------|------|------|
| `threshold.useLlmForCore` | `false` | LLM 判断 core（额外 LLM 调用）|
| `threshold.useLlmForExtract` | `false` | LLM 提取关键词（批量，1次/batch）|
| `threshold.useLlmForDedup` | `false` | LLM 辅助去重（额外 LLM 调用）|

> **注意**：LLM 默认关闭，纯算法模式零成本运行。

---

## 批量写入

| 配置 | 默认 | 说明 |
|------|------|------|
| `batchWrite.enabled` | `true` | 开启批量写入 |
| `batchWrite.bufferMs` | `500` | 批量缓冲区延迟（毫秒）|
| `batchWrite.maxBatchSize` | `20` | 超过此条数立即写入 |

---

## 压缩存储

| 配置 | 默认 | 说明 |
|------|------|------|
| `compression.enabled` | `true` | 开启压缩存储 |
| `compression.maxLength` | `200` | 压缩后最大长度 |
| `compression.extractKeywords` | `true` | 提取关键词补充摘要 |

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
  "snapshotRetentionDays": 30,
  "metricsEnabled": true,
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
      "similarityThreshold": 0.75
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
    "ageDays": 60,
    "weights": {
      "core": 1.5,
      "working": 1.0,
      "peripheral": 0.5
    }
  },
  "sessionContinuity": {
    "enabled": true,
    "maxInjectTokens": 800,
    "maxMessagesForSummary": 30
  },
  "sessionSummary": {
    "enabled": true,
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
    "extractKeywords": true
  },
  "batchWrite": {
    "enabled": true,
    "bufferMs": 500,
    "maxBatchSize": 20
  }
}
```
