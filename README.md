# algo-memory

> OpenClaw 记忆管理插件 — 纯算法召回，零 API 费用

**版本 2.4.0**

---

## 核心能力

| 能力 | 说明 |
|------|------|
| 🤖 **全自动存储** | 对话结束自动存储，无需手动 |
| 💰 **零成本** | 纯算法（Jaccard + BM25），LLM 可选 |
| 🔍 **精准召回** | FTS5 全文搜索 + 智能排序 |
| 📊 **智能分层** | peripheral → working → core，按频率自动晋升 |
| 🔄 **会话续接** | 解决"第二天忘记昨天聊什么" |

---

## 工具（16个）

| 工具 | 功能 |
|------|------|
| `algo_memory_list` | 列出记忆 |
| `algo_memory_search` | 搜索记忆 |
| `algo_memory_stats` | 统计数量 |
| `algo_memory_get` | 查看单条 |
| `algo_memory_update` | 更新内容 |
| `algo_memory_delete` | 删除单条 |
| `algo_memory_delete_bulk` | 批量删除 |
| `algo_memory_clear` | 清空（可选保留core） |
| `algo_memory_import` | 批量导入 |
| `algo_memory_export` | 导出JSON |
| `algo_memory_feedback` | 自然语言修正 |
| `algo_memory_metrics` | 运行指标 |

---

## 快速开始

```bash
# 1. 克隆
git clone https://github.com/xcqblue/algo-memory.git ~/.openclaw/extensions/algo-memory

# 2. 安装
cd ~/.openclaw/extensions/algo-memory && npm install && npm run build

# 3. 重启
openclaw gateway restart
```

---

## 工作流程

### 存储流程

```
用户消息 → 噪声过滤 → 查重 → 核心判断 → 压缩存储 → SQLite
```

### 召回流程

```
用户提问 → 意图判断 → 检索 → MMR去重 → 注入上下文
```

---

## 存储层级

| 层级 | 条件 | 权重 |
|------|------|------|
| core | 高频访问（≥10次）| ×1.5 |
| working | 普通对话 | ×1.0 |
| peripheral | 低频/超期 | ×0.5（自动清理）|

---

## 会话续接

解决"晚上聊完，第二天早上忘了"的问题：

```
昨天18:00-24:00 → Session A 对话
    ↓ → 保存会话快照
今天07:00 继续
    ↓ → 检测到会话切换
    ↓ → 自动注入上会话摘要
    ↓ → AI 知道昨晚聊了什么 ✅
```

---

## 配置示例

```json
{
  "enabled": true,
  "coreKeywords": ["记住", "重要", "别忘"],
  "tier": {
    "enabled": true,
    "coreThreshold": 10
  },
  "sessionContinuity": {
    "enabled": true,
    "maxInjectTokens": 800
  }
}
```

详细配置见 [CONFIG.md](CONFIG.md)

---

## 更新日志

| 版本 | 内容 |
|------|------|
| 2.4.0 | 会话续接（解决上下文丢失问题） |
| 2.3.0 | 语言感知召回、MMR优化、LLM默认关闭 |
| 2.2.0 | 统一检索引擎、BM25F权重 |
