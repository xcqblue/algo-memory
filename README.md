# algo-memory

> OpenClaw 记忆管理插件 — 纯算法召回，零 API 费用，零外部依赖

**版本 2.4.0** · [更新日志](#更新日志) · [配置参考](CONFIG.md)

---

## 核心能力

| | |
|---|---|
| 🤖 **全自动** | 对话结束自动存储，无需手动管理 |
| 💰 **零成本** | 纯算法（Jaccard + BM25 + MMR），LLM 完全可选 |
| 🔍 **精准召回** | FTS5 全文搜索 + BM25F 关键词权重 2× + 自适应查询扩展 |
| 📊 **智能分层** | peripheral → working → core，按访问频率自动晋升 |
| 🗑️ **安全清理** | peripheral 层超过 cleanupDays 天数后自动清理 |
| 🎯 **统一检索** | recall 和 search 共用同一检索引擎，评分一致 |

---

## 工具列表（16 个）

| 工具 | 说明 |
|---|---|
| `algo_memory_list` | 列出记忆，支持分页 |
| `algo_memory_search` | 全文搜索（FTS5 + LIKE 兜底），按综合相关性排序 |
| `algo_memory_stats` | 统计：total / core / working / peripheral |
| `algo_memory_get` | 查看单条记忆详情 |
| `algo_memory_update` | 更新记忆内容（保留访问历史） |
| `algo_memory_delete` | 删除记忆 |
| `algo_memory_delete_bulk` | 批量删除 |
| `algo_memory_clear` | 清空（keepCore=true 保留 core 层） |
| `algo_memory_import` | 批量导入（事务保护，ID 冲突自动替换） |
| `algo_memory_export` | 导出 JSON |
| `algo_memory_metrics` | 运行时指标（LLM 错误计数 / DB 错误计数） |
| `algo_memory_recall_stats` | 召回统计（DB 信息 / 缓存命中率 / LLM 错误数） |
| `algo_memory_recall_info` | 最近一次召回详情（命中数 / 耗时 / FTS 是否启用） |
| `algo_memory_recall_reset` | 清除会话去重状态 |
| `algo_memory_feedback` | 自然语言修正记忆（AI 生成修正建议） |
| `algo_memory_apply_feedback` | 应用确认后的修正结果 |

---

## 工作流程

### 存储

```
用户消息
    ↓
存储优先级打分（命中 coreKeywords 的词数越多优先级越高）
    ↓
噪声过滤 → 精确查重（SHA256 hash）→ 智能去重（Jaccard）
    ↓
核心判断 + 关键词提取
    ↓
SQLite + FTS5 索引
    ↓
补充存储（before_prompt_build 时自动补充漏存的消息，importance=0.4）
```

### 召回

```
用户提问
    ↓
Prompt Gating（过滤 emoji / 招呼 / 反问句 / 纯定义类查询）
    ↓
会话去重（30s 内相似查询不重复召回）
    ↓
统一检索引擎（FTS5 → 评分 → MMR → cited_count 更新 → 截断）
    ↓
Token 上限注入（自动适应上下文剩余量）
```

### 搜索

```
用户主动搜索
    ↓
统一检索引擎（FTS5 → 评分，不含 MMR）
    ↓
返回按综合相关性排序的结果
```

---

## 存储层级

```
core        ▸ 重要高频  权重 ×1.5
working    ▸ 普通对话  权重 ×1.0
peripheral ▸ 低频记忆  权重 ×0.5  ·  超期自动清理
general    ▸ 无层级标签
```

---

## 核心机制

**统一检索引擎** · recall 和 search 共用同一检索管道：FTS5 + BM25F 关键词权重 + 时间衰减 + 访问强化 + MMR（recall）或纯评分（search）

**MMR 多样性** · `λ×relevance − (1−λ)×diversity`，默认 λ=0.7，MMR 早停修正为基于最大剩余候选相关性

**时间衰减** · 半衰期 180 天，地板值 0.5，老记忆不会归零；Weibull 分布可选

**会话去重** · 30 秒内 Jaccard ≥ 0.6 的相同查询不重复召回

**语言感知** · `shouldRetrieve` 自动检测查询语言（中/英/日/韩等），使用对应语言的 forceKeywords 触发词表

**Query Expansion** · FTS5 空结果时自动去掉最短词再搜一次

**内容归一化** · 存储前自动去除 @mention / Markdown 噪音 / 连续空白

---

## 会话续接（Session Continuity）

> 解决"晚上对话后，第二天早上继续时上下文丢失"的问题

### 问题背景

OpenClaw 默认每天凌晨 4 点会重置会话（可配置），这意味着：
- 18:00-24:00 的对话，到第二天会变成一个新 session
- 早上继续聊天时，AI 不知道昨晚聊了什么

### 解决方案

algo-memory 会话续接功能会在每次对话结束时自动保存会话快照，当检测到会话切换时，自动注入上会话的上下文。

```
18:00-24:00  → Session A 对话
    ↓          → 每次 agent_end 保存会话快照
24:00 最后一条 → 保存快照 A
    ↓
04:00        → Session A 变成 stale
    ↓
07:00 发"继续"
              → 检测到会话切换
              → 注入快照 A 的上下文
              → AI 知道昨晚的对话内容 ✅
```

### 工作原理

| 钩子 | 时机 | 作用 |
|------|------|------|
| `agent_end` | 每次对话完成后 | 保存会话快照到数据库 |
| `before_agent_start` | 新对话开始前 | 检测会话切换，注入上会话上下文 |
| `session_end` / `session_start` | OpenClaw 内部钩子 | 辅助检测会话切换 |

### 持久化

- `lastSessionKey` 会持久化到数据库，防止 Gateway 重启后丢失
- 新 Session 启动时会从数据库恢复会话状态

### 配置选项

```json
{
  "sessionContinuity": {
    "enabled": true,
    "maxInjectTokens": 800,
    "maxMessagesForSummary": 30
  }
}
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 是否启用会话续接 |
| `maxInjectTokens` | `800` | 注入上下文的最大 token 数 |
| `maxMessagesForSummary` | `30` | 生成摘要时最多使用多少条消息 |

### 数据库表

| 表名 | 用途 |
|------|------|
| `session_snapshots` | 存储会话快照（摘要 + 上下文） |
| `session_metadata` | 存储会话状态（lastSessionKey 等） |

---

## 安装

```bash
git clone https://github.com/xcqblue/algo-memory.git \
  ~/.openclaw/extensions/algo-memory

cd ~/.openclaw/extensions/algo-memory
npm install
npm run build

openclaw gateway restart
```

详细安装步骤和配置说明见 [INSTALL.md](INSTALL.md)。

---

## 更新日志

| 版本 | 内容 |
|------|------|
| **2.4.0** | 会话续接功能：解决"晚上对话后第二天早上续不上"的问题，新增 session_snapshots / session_metadata 表，持久化 lastSessionKey 防止 Gateway 重启丢失 |
| **2.3.0** | v2.3.0 正式版：语言感知召回 / MMR早停修正 / cited_count扩大更新范围 / urgency字段移除 / 软删除简化 / MCP工具补全 / 批量更新SQL注入修复 / updateMemory完整判断链 / LLM默认关闭 / anthropic API修正 / 文档全面修正 |
| **2.2.5** | 统一检索引擎（retrieve.ts），recall/search 共用同一管道；recall 保留 agent 权重 1.5×；Bug 修复 |
| **2.2.4** | 存储优先级打分 / Query Expansion / 动态 Token 上限 / BM25F / 软删除 |
| **2.2.3** | 删除冗余机制（citedBoost/urgencyDecay/sessionMemory/lexicalOverlap）|
| 2.2.2 | MMR 真公式 + 会话去重 + CLI 工具 |
| 2.2.1 | sql.js → better-sqlite3 迁移 |
