# ⚙️ 配置详解

## 版本更新 v2.2.3

- ✅ **autoRecall 修复**：自动召回功能现在可以正常工作
- ✅ **批量导入优化**：importMemories 使用事务批量提交，性能大幅提升
- ✅ **缓存优化**：recall 减少重复计算

## 最简配置

```json
{
  "plugins": {
    "entries": {
      "algo-memory": {
        "enabled": true
      }
    }
  }
}
```

**零配置自动启用所有功能！**

---

## 完整配置

```json
{
  "plugins": {
    "slots": { "memory": "algo-memory" },
    "entries": {
      "algo-memory": {
        "enabled": true,
        "config": {
          "autoCapture": true,
          "autoRecall": true,
          "maxResults": 5,
          "cleanupDays": 180,
          "recencyDecay": true,
          "recencyHalfLife": 180,
          "smartDedup": true,
          "dedupThreshold": 0.85,
          "coreKeywords": ["记住", "重要", "不要忘记", "remember", "important"],
          
          "noiseFilter": {
            "enabled": true,
            "skipGreetings": true,
            "skipCommands": true
          },
          
          "adaptiveRetrieval": {
            "enabled": true,
            "minQueryLength": 2,
            "forceKeywords": ["之前", "上次", "记得", "remember", "before"]
          },
          
          "sessionMemory": {
            "enabled": false,
            "maxSessionItems": 10
          },
          
          "tier": {
            "enabled": false,
            "coreThreshold": 3,
            "peripheralThreshold": 0.3,
            "ageDays": 90
          },
          
          "weibullDecay": {
            "enabled": false,
            "shape": 1.5,
            "scale": 90
          },
          
          "reinforcement": {
            "enabled": false,
            "factor": 0.1,
            "maxMultiplier": 2.0
          },
          
          "mmr": {
            "enabled": false,
            "threshold": 0.85
          },
          
          "scopes": {
            "enabled": true,
            "defaultScope": "agent",
            "visibleAgents": []
          },
          
          "llm": {
            "enabled": true,
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
          }
        }
      }
    }
  }
}
```

---

## 配置项说明

### 基础配置

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | true | 启用插件 |
| `autoCapture` | boolean | true | 自动存储记忆 |
| `autoRecall` | boolean | true | 自动召回记忆 |
| `maxResults` | number | 5 | 召回数量上限 |
| `capturePerTurn` | number | 3 | 每轮最多存储条数 |
| `cleanupDays` | number | 180 | 自动清理天数 |
| `language` | string | "auto" | 语言: auto/zh/en/ja/ko/es/fr/de |

### 核心配置

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `coreKeywords` | string[] | [...] | 核心关键词列表 |
| `recencyDecay` | boolean | true | 启用时间衰减 |
| `recencyHalfLife` | number | 180 | 半衰期(天) |
| `smartDedup` | boolean | true | 智能去重 |
| `dedupThreshold` | number | 0.85 | 去重阈值 |

### 噪声过滤

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `noiseFilter.enabled` | boolean | true | 启用过滤 |
| `noiseFilter.skipGreetings` | boolean | true | 跳过问候语 |
| `noiseFilter.skipCommands` | boolean | true | 跳过命令 |

### 自适应检索

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `adaptiveRetrieval.enabled` | boolean | true | 启用自适应 |
| `adaptiveRetrieval.minQueryLength` | number | 2 | 最小查询长度 |
| `adaptiveRetrieval.forceKeywords` | string[] | [...] | 强制触发关键词 |

### 三层晋升

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `tier.enabled` | boolean | false | 启用三层晋升 |
| `tier.coreThreshold` | number | 10 | 晋升核心阈值 |
| `tier.peripheralThreshold` | number | 0.15 | 边缘阈值 |
| `tier.ageDays` | number | 60 | 天数阈值 |

### 多 Scope 隔离

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `scopes.enabled` | boolean | true | 启用Agent隔离模式 |
| `scopes.defaultScope` | string | "agent" | 默认作用域 |
| `scopes.visibleAgents` | string[] | [] | 允许查看的Agent列表 |

**visibleAgents 配置示例：**

| 配置 | 行为 |
|------|------|
| `[]` (空) | 只能看自己的记忆（默认） |
| `["*"]` | 可以看全部Agent的记忆 |
| `["agent-A", "agent-B"]` | 可以看自己和指定Agent的记忆 |

### 时间衰减

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `weibullDecay.enabled` | boolean | false | 启用 Weibull 衰减 |
| `weibullDecay.shape` | number | 1.5 | 形状参数 |
| `weibullDecay.scale` | number | 90 | 尺度参数 |

### LLM 配置

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `llm.enabled` | boolean | true | 启用 LLM |
| `llm.provider` | string | "auto" | 模型供应商 |
| `llm.apiKey` | string | "" | API 密钥 |
| `llm.model` | string | "" | 模型名称 |
| `llm.baseURL` | string | "" | API 地址 |

### LLM 阈值

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `threshold.useLlmForCore` | boolean | false | LLM 判断核心 |
| `threshold.useLlmForExtract` | boolean | false | LLM 提取关键词 |
| `threshold.useLlmForDedup` | boolean | false | LLM 判断去重 |
| `threshold.lengthForCore` | number | 100 | 触发核心判断长度 |
| `threshold.lengthForExtract` | number | 200 | 触发提取长度 |
| `threshold.dedupUncertaintyMin` | number | 0.5 | 去重不确定区间下限 |
| `threshold.dedupUncertaintyMax` | number | 0.98 | 去重不确定区间上限 |

---

## LLM 模型列表

### 🇨🇳 国内（推荐）

| provider | baseURL | 可选模型 |
|----------|---------|----------|
| minimax | https://api.minimax.chat/v1 | abab6.5s-chat, abab6.5g-chat, abab6.5s-chat-200k, abab1.8s-chat, abab6s-chat |
| bailian | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-plus, qwen-turbo, qwen-max, qwen-long |
| deepseek | https://api.deepseek.com/v1 | deepseek-chat, deepseek-coder |
| kimi | https://api.moonshot.cn/v1 | kimi-chat, kimi-chat-latest |
| zhipu | https://open.bigmodel.cn/api/paas/v4 | glm-4, glm-4-flash, glm-3-turbo |
| hunyuan | https://hunyuan.tencent.com/proxy/v1 | hunyuan-pro, hunyuan-standard |
| wenxin | https://qianfan.baidubce.com/v2 | ernie-4.0-8k, ernie-3.5-8k, ernie-speed-8k |
| siliconflow | https://api.siliconflow.cn/v1 | Qwen/Qwen2-7B-Instruct, THUDM/glm-4-9b-chat, deepseek-ai/DeepSeek-V2-Chat |

### 🌍 国外

| provider | baseURL | 默认模型 |
|----------|---------|----------|
| openai | https://api.openai.com/v1 | gpt-4o-mini |
| anthropic | https://api.anthropic.com/v1 | claude-3-haiku |
| ollama | http://localhost:11434/v1 | llama2 |

---

## LLM 阈值触发说明

LLM 仅在以下情况触发，避免不必要的 API 调用：

| 场景 | 触发条件 |
|------|----------|
| **核心判断** | 内容长度 ≥ `lengthForCore` (默认100字符) |
| **关键词提取** | 内容长度 ≥ `lengthForExtract` (默认200字符) |
| **去重判断** | 相似度在 [0.5, 0.98] 区间 |

---

## Agent 隔离示例

### 示例 1：默认隔离

```json
{
  "scopes": {
    "enabled": true,
    "visibleAgents": []
  }
}
```
- 每个 Agent 只能看自己的记忆

### 示例 2：查看全部

```json
{
  "scopes": {
    "enabled": true,
    "visibleAgents": ["*"]
  }
}
```
- 所有 Agent 可以互相查看记忆

### 示例 3：部分共享

```json
{
  "scopes": {
    "enabled": true,
    "visibleAgents": ["assistant", "helper"]
  }
}
```
- Agent A 可以看自己 + assistant + helper 的记忆
