# 配置参考

完整默认值见 `openclaw.plugin.json` 的 `configSchema`。

## 快速配置

```json
{
  "enabled": true,
  "autoCapture": true,
  "autoRecall": true,
  "maxResults": 5,
  "coreKeywords": ["记住", "重要", "别忘"]
}
```

---

## 基础配置

| 配置 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 启用插件 |
| `autoCapture` | `true` | 自动存储消息 |
| `autoRecall` | `true` | 自动注入记忆 |
| `maxResults` | `5` | 召回最大条数 |
| `capturePerTurn` | `3` | 每轮最多存3条 |
| `cleanupDays` | `180` | peripheral 记忆超期清理 |
| `language` | `"auto"` | 自动检测语言 |

---

## 核心识别

| 配置 | 默认 | 说明 |
|------|------|------|
| `coreKeywords` | 见下方 | 命中直接标记core |

```json
["记住", "牢记", "重要", "不要忘记", "remember", "important", "never forget"]
```

---

## 智能去重

| 配置 | 默认 | 说明 |
|------|------|------|
| `smartDedup` | `true` | Jaccard 智能去重 |
| `dedupThreshold` | `0.85` | 相似度阈值 |

## 噪声过滤

| 配置 | 默认 | 说明 |
|------|------|------|
| `noiseFilter.enabled` | `true` | 开启过滤 |
| `noiseFilter.skipGreetings` | `true` | 过滤 hi/hello/你好 |
| `noiseFilter.skipCommands` | `true` | 过滤 / ! 命令 |

---

## 存储分层

| 配置 | 默认 | 说明 |
|------|------|------|
| `tier.enabled` | `true` | 启用分层 |
| `tier.coreThreshold` | `10` | 访问≥10次晋升core |
| `tier.peripheralThreshold` | `0.15` | 分数低于此降级peripheral |

---

## 会话续接

解决"第二天忘记昨天聊什么"

| 配置 | 默认 | 说明 |
|------|------|------|
| `sessionContinuity.enabled` | `true` | 启用续接 |
| `sessionContinuity.maxInjectTokens` | `800` | 注入最大token数 |

---

## LLM 配置（可选）

| 配置 | 默认 | 说明 |
|------|------|------|
| `llm.enabled` | `false` | 启用LLM判断 |
| `llm.provider` | `"auto"` | auto/openai/anthropic |
| `llm.batchWindowMs` | `200` | 批量窗口 |

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
  "coreKeywords": ["记住", "重要", "别忘", "不要忘记"],
  "smartDedup": true,
  "dedupThreshold": 0.85,
  "noiseFilter": {
    "enabled": true,
    "skipGreetings": true,
    "skipCommands": true
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
  "llm": {
    "enabled": false,
    "provider": "auto",
    "batchWindowMs": 200
  },
  "compression": {
    "enabled": true,
    "maxLength": 200,
    "semanticEnhance": false
  },
  "batchWrite": {
    "enabled": true,
    "bufferMs": 500,
    "maxBatchSize": 20
  }
}
```
