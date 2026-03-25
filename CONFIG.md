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

---

## v3.3.0 新增配置项

### coreCleanupDays - 核心记忆保护

```json
{
  "coreCleanupDays": 365
}
```

**说明：**
- 核心记忆专属保留天数，不受 `cleanupDays` 限制
- 超过此天数未访问的 core 记忆会被**降级为 peripheral**，然后在下次 cleanup 时被删除
- 设为 `0` 表示不启用核心保护（与旧版本行为一致）

**使用场景：**
- 希望重要记忆保留更长时间（比如 1 年）
- 核心记忆不会因为长期不访问就被删掉，而是先降级保护

---

### adaptiveCapture - 动态捕获

```json
{
  "adaptiveCapture": {
    "enabled": true,
    "maxPerTurn": 10,
    "burstThreshold": 5,
    "burstWindowMs": 60000
  }
}
```

**说明：**
- `enabled`：是否启用动态捕获调整
- `maxPerTurn`：密集对话时每轮最多捕获条数上限
- `burstThreshold`：触发密集模式的连续消息数阈值
- `burstWindowMs`：密集模式持续时间（毫秒）

**使用场景：**
- 密集对话时自动提高捕获上限，避免重要记忆被截断
- 普通对话维持较低的 `capturePerTurn` 限制，节省存储

---

### 增强的 skipPatterns（v3.3.0 新增过滤规则）

以下系统消息前缀会被自动过滤，不会成为记忆：

| 模式 | 说明 |
|------|------|
| `[Subagent Context]` | 子代理上下文信息 |
| `[Inter-session message]` | 跨会话消息 |
| `[Internal task completion event]` | 内部任务完成事件 |
| `OpenClaw runtime context` | OpenClaw 运行时上下文 |
| `[Runtime generated]` | 运行时生成内容 |
| `sourceSession=` / `sourceChannel=` / `sourceTool=` | 元数据前缀 |
| `[[reply_to_current]]` / `[[reply_to:...]]` | 回复标签 |
| `HEARTBEAT_OK` / `NO_REPLY` | 心跳/静默回复标记 |
| `session_key=` / `Runtime:` / `Dashboard\|` 等 | 状态输出格式 |

这些内容不会进入记忆库，避免系统噪音污染。

