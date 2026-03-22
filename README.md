# algo-memory

> OpenClaw 记忆管理插件 — 纯算法召回，零 API 费用，零外部依赖

**版本 2.3.0** · [更新日志](#更新日志) · [配置参考](CONFIG.md)

---

## 核心能力

| | |
|---|---|
| 🤖 **全自动** | 对话结束自动存储，无需手动管理 |
| 💰 **零成本** | 纯算法（Jaccard + BM25 + MMR），LLM 完全可选 |
| 🔍 **精准召回** | FTS5 全文搜索 + BM25F 关键词权重 2× + 自适应查询扩展 |
| 📊 **智能分层** | peripheral → working → core，按访问频率自动晋升 |
| 🔄 **安全删除** | 软删除 + 可恢复，误删无忧 |
| 🎯 **统一检索** | recall 和 search 共用同一检索引擎，评分一致 |

---

## 工具列表

| 工具 | 说明 |
|---|---|
| `algo_memory_list` | 列出记忆，支持分页 |
| `algo_memory_search` | 全文搜索（FTS5 + LIKE 兜底），按综合相关性排序 |
| `algo_memory_stats` | 统计：total / core / working / peripheral |
| `algo_memory_get` | 查看单条记忆详情 |
| `algo_memory_update` | 更新记忆内容 |
| `algo_memory_delete` | 删除（软删除，可恢复） |
| `algo_memory_delete_bulk` | 批量删除 |
| `algo_memory_clear` | 清空（可选保留 core） |
| `algo_memory_import` | 批量导入（事务保护） |
| `algo_memory_export` | 导出 JSON（上限 5 万条） |
| `algo_memory_metrics` | 运行时指标 |
| `algo_memory_recall_stats` | 召回统计（MMR / 会话去重 / DB 信息） |
| `algo_memory_recall_info` | 最近一次召回记录 |
| `algo_memory_recall_reset` | 清除会话去重状态 |
| `algo_memory_feedback` | 自然语言修正记忆（AI 生成修正建议） |
| `algo_memory_apply_feedback` | 应用确认后的记忆修正 |

---

## 工作流程

### 存储

```
用户消息
    ↓
存储优先级打分（命中 coreKeywords 的词数越多优先级越高）
    ↓
噪声过滤 → 精确查重 → 智能去重（Jaccard）
    ↓
核心判断 + 关键词提取
    ↓
SQLite + FTS5 索引
    ↓
补充存储（before_prompt_build 时自动补充漏存的消息）
```

### 召回

```
用户提问
    ↓
Prompt Gating（过滤 emoji / 招呼 / 反问句）
    ↓
会话去重（30s 内相似查询不重复召回）
    ↓
统一检索引擎（FTS5 → 评分 → MMR → 截断）
    ↓
cited_count 更新（被召回的记忆引用次数 +1）
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
peripheral ▸ 低频记忆  权重 ×0.5  ·  自动清理
general    ▸ 无层级标签
```

---

## 核心机制

**统一检索引擎** · recall 和 search 共用同一检索管道：FTS5 + BM25F 关键词权重 + 时间衰减 + 访问强化 + MMR（recall）或纯评分（search）

**MMR 多样性** · `λ×relevance − (1−λ)×diversity`，默认 λ=0.7

**时间衰减** · 半衰期 180 天，地板值 0.5，老记忆不会归零

**会话去重** · 30 秒内 Jaccard ≥ 0.6 的相同查询不重复召回

**Query Expansion** · FTS5 空结果时自动去掉最短词再搜一次

**内容归一化** · 存储前自动去除 @mention / Markdown 噪音 / 连续空白

---

## 安装

```bash
git clone https://github.com/xcqblue/algo-memory.git \
  ~/.openclaw/extensions/algo-memory

cd ~/.openclaw/extensions/algo-memory
npm install

openclaw gateway restart
```

验证：

```bash
openclaw logs | grep algo-memory
# → [algo-memory] 数据库初始化: ~/.openclaw/state/algo-memory/memories.db
```

详细配置说明见 [CONFIG.md](CONFIG.md)。

---

## 更新日志

| 版本 | 内容 |
|------|------|
| **2.3.0** | Memory Feedback 自然语言修正 + MCP 工具暴露 + cited_count 召回计数 + 补充存储修复冷启动死锁 + 全面默认开启（除 MCP） |
| **2.2.5** | 统一检索引擎（retrieve.ts），recall/search 共用同一管道；recall 保留 agent 权重 1.5×；Bug 修复 |
| **2.2.4** | 存储优先级打分 / Query Expansion / 动态 Token 上限 / BM25F / 软删除 |
| **2.2.3** | 删除冗余机制（citedBoost/urgencyDecay/sessionMemory/lexicalOverlap）|
| 2.2.2 | MMR 真公式 + 会话去重 + CLI 工具 |
| 2.2.1 | sql.js → better-sqlite3 迁移 |
