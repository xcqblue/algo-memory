# algo-memory

> OpenClaw 记忆管理插件 — 纯算法召回，LLM 完全可选，零外部依赖

---

## 核心特点

| 特点 | 说明 |
|------|------|
| **零 API 费用** | 纯算法（Jaccard + BM25 + MMR）完成召回，LLM 完全可选 |
| **零外部依赖** | SQLite（better-sqlite3）+ FTS5，无向量库、无 Embedding 服务 |
| **自动存储** | 每次对话自动提取用户消息，无需手动管理 |
| **三层晋升** | peripheral → working → core，按访问频率自动升级/降级 |
| **全文搜索** | FTS5 全文索引，支持中文（无外部依赖） |
| **Token 节约** | 召回结果按 importance 优先级注入，强制上限 1500 tokens |
| **会话去重** | 短时间相似查询不重复召回，减少无效 API 调用 |

---

## 工作流程

### 存储流程

```
用户消息 → 文本归一化 → 噪声过滤 → 内容归一化 → 精确查重 → 同类 Capping
  → 智能去重（Jaccard / LLM）→ 核心判断 → 层级晋升 → 写入 SQLite → FTS5 索引
```

### 召回流程

```
用户提问 → Prompt Gating（精细过滤）→ 会话去重（Jaccard 窗口）→ FTS5/LIKE 检索
  → 时间衰减评分（地板 0.5）→ 访问强化 → 引用强化（cited_count）→ 长度归一化
  → MMR 多样性去重 → 词重叠抑制 → 硬阈值过滤 → Token 上限注入 → cited_count 自增
```

---

## 16 个工具

| 工具 | 说明 |
|------|------|
| `algo_memory_list` | 列出记忆（支持 limit + offset 分页） |
| `algo_memory_search` | 全文搜索（FTS5 优先，LIKE 兜底） |
| `algo_memory_stats` | 查看统计（total / core / working / peripheral） |
| `algo_memory_get` | 获取单条记忆详情 |
| `algo_memory_delete` | 删除单条记忆 |
| `algo_memory_delete_bulk` | 批量删除（原子事务） |
| `algo_memory_update` | 更新记忆内容（自动重新判断重要性，更新 content_hash） |
| `algo_memory_clear` | 清空记忆（可选保留 core 层） |
| `algo_memory_import` | 批量导入记忆（事务保护，自动补齐 cited_count / urgency） |
| `algo_memory_export` | 导出为 JSON（默认最多 1000 条） |
| `algo_memory_session` | 获取当前 Session 临时记忆 |
| `algo_memory_session_add` | 写入 Session 临时记忆 |
| `algo_memory_metrics` | 查看运行时指标（LLM 错误次数、DB 错误次数） |
| `algo_memory_recall_stats` | 召回统计（含 MMR / 会话去重状态 / DB 信息） |
| `algo_memory_recall_info` | 查看最近一次召回的查询和时间 |
| `algo_memory_recall_reset` | 清除会话去重状态，允许相同查询再次召回 |

---

## 存储层级

```
core       — 重要、频繁访问的记忆（权重 ×1.5）
working    — 普通对话记忆（权重 ×1.0）
peripheral — 边缘记忆，可被自动清理（权重 ×0.5）
general    — 无层级标签的普通记忆
```

---

## 核心机制详解

### MMR 多样性去重
真正的 MMR 公式：`λ × relevance − (1−λ) × diversity`
- `λ=0.7`（默认值）：70% 权重看相关性，30% 权重保多样性
- 预计算词集合 + 早停优化，性能优秀
- MMR 之后还有 Lexical Overlap Suppression 做二次重叠降权

### 会话去重（Session Dedup）
- 30 秒内 Jaccard 相似度 ≥ 0.6 的查询不重复召回
- 结果**不缓存**，确保每次判断都是实时的
- 可通过 `algo_memory_recall_reset` 手动清除状态

### 时间衰减
- 默认半衰期 180 天：`0.5 + 0.5 × 0.5^(daysOld/180)`
- 地板值 0.5，老记忆不会衰减到接近零
- 可选 Weibull 衰减（形状参数 1.5，尺度 90 天）

### 引用强化（Cited Boost）
- 每次召回命中时自动 `cited_count++`
- 得分公式：`score × (1 + 0.05 × cited_count)`
- 被多次引用的记忆排名更高

### 紧急度衰减（Urgency Decay）
- 新记忆 urgency=1.0，按半衰期（默认 168 小时 = 7 天）快速衰减
- `urgencyDecay score = urgency × 2^(−hoursOld / halfLifeHours)`
- 适用于"热点信息快速淡化"场景

### 内容归一化
存储前自动处理：去除 `@mentions`、压缩连续空白、去除 Markdown 标记（保留文字内容）

### Prompt Gating
精细过滤以下 query，不触发召回：
- 纯 emoji 消息
- 招呼语（hi / hello / 你好）
- 反问句（do you remember / 你还记得吗）
- 短定义查询（what is X，≤15 字符）

---

## 性能与安全

| 方面 | 措施 |
|------|------|
| 持久化 | better-sqlite3 同步写入磁盘，无需手动 flush |
| 并发安全 | PID 文件检测，防止插件重复加载 |
| SQL 安全 | 所有用户输入走参数化查询，无注入风险 |
| Session 隔离 | Agent 级别隔离，支持跨 Agent 可见配置 |
| 向后兼容 | 新增字段通过 ALTER TABLE 自动迁移，不破坏已有数据 |

---

## 安装

```bash
git clone https://github.com/xcqblue/algo-memory.git ~/.openclaw/extensions/algo-memory
cd ~/.openclaw/extensions/algo-memory
npm install && npm run build
openclaw gateway restart
```

## 配置

详见 [CONFIG.md](CONFIG.md)。

## 架构设计

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 流程图

详见 [FLOW.md](FLOW.md)。

---

## 对比

| 特性 | algo-memory | memos-local | memory-lancedb-pro |
|------|-------------|-------------|---------------------|
| LLM 依赖 | **可选** | 必须 | 可选（Embedding 必须） |
| API 费用 | 零 | 有 | 有（Embedding API） |
| 向量搜索 | ❌ | ❌ | ✅ |
| 去重 | Jaccard + 可选 LLM | 仅 LLM | BM25 + Reranker |
| 全文搜索 | FTS5（本地） | 依赖 LLM | LanceDB FTS + BM25 |
| Tier 晋升 | ✅ 三层自动 | ❌ | ❌ |
| MMR 多样性 | ✅ | ❌ | ✅ |
| 会话去重 | ✅ | ❌ | ❌ |
| 引用强化 | ✅ | ❌ | ❌ |
| 存储 | SQLite（better-sqlite3） | SQLite | LanceDB |
| 外部依赖 | 零 | 无 | LanceDB + Embedding |

> **注意**：algo-memory 和 memos-local 同名 slot（`slots = ["memory"]`），同时只可启用一个。

---

## 版本

当前版本：`2.2.3`（见 [VERSION.txt](VERSION.txt)）

**更新日志（2.2.x）**：
- 2.2.3 — 修复 urgencyDecay 列无效 / 会话去重缓存绕过 / updateMemory content_hash / importMemories cited_count 错位
- 2.2.2 — MMR 真公式 + 会话去重 + 3 个 CLI 工具
- 2.2.1 — sql.js → better-sqlite3 迁移
- 2.2.0 — 全新架构，支持 FTS5 / Tier / LLM 可选
