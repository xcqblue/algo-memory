# 🧠 algo-memory

**纯算法长期记忆插件 - 无需 LLM 也能工作**

[![Version](https://img.shields.io/badge/Version-2.2.3-blue)](https://github.com/xcqblue/algo-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## ✨ 特性

| 分类 | 特性 |
|------|------|
| **零配置** | 开箱即用，无需配置自动启用 |
| **纯算法** | 无需 LLM 也能正常工作 |
| **智能召回** | 自动召回相关记忆，上下文感知 |
| **LLM 支持** | 可选启用，支持 11+ 模型 |
| **存储** | 本地 SQLite（sql.js）/ FTS5 全文搜索 |
| **智能** | 核心记忆 / 智能去重 / 时间衰减 |
| **工具** | 10 个记忆管理工具 |
| **隔离** | Agent 记忆隔离 |

---

## 🚀 安装

### 方式一：手动安装（推荐）

```bash
# 1. 复制插件目录到 extensions
cp -r algo-memory ~/.openclaw/extensions/

# 2. 重启 OpenClaw（依赖会自动安装）
openclaw gateway restart
```

### 方式二：从 GitHub 安装

```bash
# 注意：URL 安装可能有 bug，建议使用手动安装
openclaw plugins install https://github.com/xcqblue/algo-memory
```

---

## ⚙️ 配置

### 零配置（默认）

插件会自动启用以下默认配置：

```json
{
  "autoCapture": true,
  "autoRecall": true,
  "maxResults": 5,
  "cleanupDays": 180,
  "recencyDecay": true,
  "smartDedup": true
}
```

### 可选配置

如果需要自定义配置，在 `openclaw.json` 中添加：

```json
{
  "plugins": {
    "entries": {
      "algo-memory": {
        "enabled": true,
        "autoCapture": true,
        "autoRecall": true,
        "maxResults": 5
      }
    }
  }
}
```

### LLM 配置（可选）

如需使用 LLM 功能（智能判断核心/关键词/去重）：

```json
{
  "plugins": {
    "entries": {
      "algo-memory": {
        "enabled": true,
        "llm": {
          "enabled": true,
          "provider": "minimax",
          "apiKey": "your-api-key",
          "model": "abab6.5s-chat"
        }
      }
    }
  }
}
```

#### 支持的 LLM

| 类型 | 提供商 | 模型 |
|------|--------|------|
| 🇨🇳 默认 | MiniMax | abab6.5s-chat |
| 🇨🇳 国内 | 阿里百炼 | qwen-plus, qwen-turbo |
| 🇨🇳 国内 | DeepSeek | deepseek-chat |
| 🇨🇳 国内 | Kimi | kimi-chat |
| 🇨🇳 国内 | 智谱 | glm-4-flash |
| 🌍 国外 | OpenAI | gpt-4o-mini |
| 🌍 本地 | Ollama | llama2, mistral |

---

## 📖 工具

| 工具名 | 说明 |
|--------|------|
| `algo_memory_list` | 列出所有记忆 |
| `algo_memory_search` | 搜索记忆 |
| `algo_memory_stats` | 查看记忆统计 |
| `algo_memory_get` | 获取单条记忆详情 |
| `algo_memory_delete` | 删除单条记忆 |
| `algo_memory_delete_bulk` | 批量删除记忆 |
| `algo_memory_clear` | 清空记忆 |
| `algo_memory_update` | 更新记忆内容 |
| `algo_memory_export` | 导出所有记忆 |
| `algo_memory_import` | 导入记忆 |
| `algo_memory_session` | 获取 Session 临时记忆 |

---

## ⚠️ 注意事项

### 1. 与 MemOS 冲突

algo-memory 和 memos-local/memos-cloud **不能同时启用**，因为它们都占用 `memory` slot。

**解决方案**：在 `openclaw.json` 中禁用 memos：

```json
{
  "plugins": {
    "slots": {
      "memory": "algo-memory"
    },
    "entries": {
      "memos-local-openclaw-plugin": {
        "enabled": false
      }
    }
  }
}
```

### 2. 安全警告

如果启用 LLM 功能，OpenClaw 可能会显示安全警告。这是因为 LLM 需要：
- 读取环境变量（获取 API Key）
- 发送网络请求（调用 LLM API）

这是**正常行为**，不是恶意代码。

---

## 🛠️ 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 开发模式
npm run dev
```

---

## 📄 许可证

MIT License
