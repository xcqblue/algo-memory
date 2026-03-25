# 配置参考

> 完整默认值和类型定义见 `openclaw.plugin.json` 的 `configSchema`。

---

## Tier 评分公式

```
tier_score = importance × multiplier(access_count)

multiplier 分段（v2.9.0 优化）：
  ac 1~10:    1 + log10(ac + 1)           （快速提升）
  ac 10~100:  1 + log10(11) + 0.3×(√ac - √10)  （平稳期，避免对数饱和）
  ac 100+:    min(5.0, 缓增对数上限)       （防马太效应）

core:       access_count ≥ 10
            OR (tier_score ≥ 0.7 AND age ≤ 60 days)

peripheral: tier_score < 0.15
            OR (age > 60 days AND tier_score < 0.7)

working:    everything in between
```

---

## 完整配置示例

```json
{
  "plugins": {
    "algo-memory": {
      "autoCapture": true,
      "autoRecall": true,
      // v3.1.0: OpenClaw 兼容性模式
      // - "auto"（默认）：自动检测，OpenClaw built-in memory 启用时自动切换为 retrieval-only
      // - "standalone"：algo-memory 完全独立，不考虑 OpenClaw built-in memory
      // - "retrieval-only"：关闭 auto-capture hooks，存储交给 OpenClaw built-in memory，
      //                     algo-memory 仅通过 ContextEngine assemble() 提供 FTS5 检索增强
      "openClawMemoryMode": "auto",
      // v3.1.0: 同步到 workspace Markdown
      // - 启用后，每次 store() 时同步将记忆写入 workspace Markdown 文件
      // - core tier → MEMORY.md（核心长期记忆）
      // - 所有 tier → memory/YYYY-MM-DD.md（每日日志）
      // - 格式兼容 OpenClaw memory_search 工具，可直接搜索
      // - 需要 gateway 对 workspace 有写入权限
      "syncToWorkspace": false,
      "maxResults": 5,
      "capturePerTurn": 3,
      "cleanupDays": 180,
      "metricsEnabled": true,
      "language": "auto",
      "coreKeywords": ["记住", "牢记", "重要", "不要忘记", "记住它", "remember", "important", "never forget"],
      "recencyDecay": true,
      "recencyHalfLife": 180,
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
        "forceKeywords": ["记住", "之前", "上次", "记得", "前", "what", "why", "how", "什么", "为什么", "怎么"],
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
      "scopes": {
        "enabled": true,
        "defaultScope": "agent",
        "visibleAgents": []
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
        "baseURL": ""
      },
      "threshold": {
        "useLlmForCore": false,
        "useLlmForExtract": false,
        "useLlmForDedup": false,
        "minConfidence": 0.8,
        "lengthForCore": 100,
        "lengthForExtract": 200,
        "dedupUncertaintyMin": 0.5,
        "dedupUncertaintyMax": 0.98
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
  }
}
```
