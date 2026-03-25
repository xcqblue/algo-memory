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
| `smartDedup` | `true` | 开启 Jaccard 智能去重（含元数据结构感知增强） |
| `dedupThreshold` | `0.85` | Jaccard 相似度阈值；双方或一方为元数据内容时自动降低（50% / 75%）|

### 噪声过滤

| 配置 | 默认 | 说明 |
|------|------|------|
| `noiseFilter.enabled` | `true` | 开启噪声过滤 |
| `noiseFilter.skipGreetings` | `true` | 过滤 hi/hello/hey/你好/您好/嗨 |
| `noiseFilter.skipCommands` | `true` | 过滤 / ! - 开头的命令 |
| `noiseFilter.skipPatterns` | 见下方 | 正则数组，符合任一 pattern 的内容在评分前直接跳过 |
| `noiseFilter.skipSystemSource` | `true` | 预留：跳过系统/元数据来源的消息 |

> **skipPatterns 默认值**（过滤 OpenClaw 飞书等平台的元数据包裹层）
> ```json
> [
>   "^Conversation info",
>   "^```json",
>   "^```json\\{",
>   "^{.*\"message_id\"",
>   "^{.*\"sender_id\""
> ]
> ```

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

| `feedback.matchThreshold` | `0.6` | LLM 匹配置信度阈值 |

---

## LLM 配置（可选，默认关闭）

| 配置 | 默认 | 说明 |
|------|------|------|
| `llm.enabled` | `false` | 是否启用 LLM 调用 |
| `llm.provider` | `"auto"` | 提供商：minimax / deepseek / kimi / zhipu / qwen（等价于dashscope）/ openai / anthropic / ollama / siliconflow |
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
| `compression.minLengthForCompression` | `300` | 最小长度阈值：超过此长度才执行压缩（避免短内容被截断） |
| `compression.skipMetadataCompression` | `true` | 元数据类内容直接存储原文，不执行压缩 |

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
  "metricsEnabled": true,
  "language": "auto",
  "coreKeywords": ["记住", "重要", "别忘", "不要忘记", "remember", "important", "never forget"],
  "smartDedup": true,
  "dedupThreshold": 0.85,
  "noiseFilter": {
    "enabled": true,
    "skipGreetings": true,
    "skipCommands": true,
    "skipPatterns": [
      "^Conversation info",
      "^```json",
      "^```json\\{",
      "^{.*\"message_id\"",
      "^{.*\"sender_id\""
    ],
    "skipSystemSource": true
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
    "minLengthForCompression": 300,
    "skipMetadataCompression": true
  },
  "batchWrite": {
    "enabled": true,
    "bufferMs": 500,
    "maxBatchSize": 20
  }
}
