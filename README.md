# algo-memory

基于 SQLite 的结构化长期记忆插件 for OpenClaw — 三层分级、FTS5 全文检索、LLaM 辅助捕获、完整 OpenClaw 生命周期接入。

**版本：** v3.3.0 | **OpenClaw:** v2026.3.24+ | **Node:** ≥20

---

## 快速开始

```bash
git clone https://github.com/xcqblue/algo-memory.git ~/.openclaw/extensions/algo-memory
cd ~/.openclaw/extensions/algo-memory && npm install && npm run build
openclaw plugins enable algo-memory
openclaw gateway restart
```

完整安装与配置 → [INSTALL.md](INSTALL.md)
完整配置参考 → [CONFIG.md](CONFIG.md)
系统架构设计 → [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 核心特性

### 记忆分层（三级自动管理）
| 层级 | 说明 |
|------|------|
| **core** | 高 importance × 分段乘数，被频繁召回的重要记忆 |
| **working** | 中等重要度，日常信息 |
| **peripheral** | 低重要度，同时满足 `created_at` + `last_accessed` 双 cutoff 时清理（避免"续命"问题）|

> **v2.9.0 分段评分公式**：原 `importance × (1 + log10(access_count + 1))` 在高访问次数时过早饱和。新公式分段设计：1~10 次用 log10，10~100 次用 sqrt，100+ 次用对数上限，避免马太效应。

### 全文检索（FTS5）
- SQLite FTS5 虚拟表，无需外部 embedding API，离线/隐私友好
- **Trie 树同义词扩展**（v2.9.0 优化）— 预编译 Trie 树，O(query_len) 展开，替代 O(query_len × syn_count) 全表遍历
- **多路召回缩减为 2 路**（v2.9.0 优化）— 原始 Query + 前缀 3-token，减少冗余候选
- **Tier 分组 MMR**（v2.9.0 优化）— 每 tier 组内独立去重，core 记忆不会被 peripheral 意外挤出
- **会话去重长度豁免**（v2.9.0 优化）— 追问类查询（长度 > 上次 1.5x）不被误拦截
- **BM25+ 排序** + **MMR 多样化检索**（λ=0.7）

### LLM 增强（可选）
- 自动提取关键词 / LLM 辅助去重 / 语义压缩
- **合并 LLM 调用**（v2.9.0 新增）— 单次 `processMemory()` 完成 isCore + 关键词 + 去重，减少 50%+ API 调用
- **动态批次处理**（v3.0.0 优化）— 队列深度决定批次大小（10~20）和延迟（50~500ms），低延迟+高吞吐
- **纯算法模式零成本运行**，LLM 非必选

### OpenClaw 生命周期 Hook + ContextEngine

algo-memory 已接入 **15 个 OpenClaw Plugin Hook**，覆盖完整的存储/召回/生命周期管理。

| Hook | 时机 | 行为 |
|------|------|------|
| `before_dispatch` | 入站消息投递前 | 快速哈希精确去重拦截，更新 access_count |
| `before_prompt_build` | LLM 调用前 | 存储上一轮消息；**v3.1.0 retrieval-only 模式下禁用（由 ContextEngine assemble() 接管）** |
| `agent_end` | 每次对话结束 | 兜底存储（heartbeat/cron 时跳过，**retrieval-only 模式下跳过**）|
| `after_tool_call` | 工具执行后 | 实时强化 `algo_memory_search` 召回的记忆 cited_count |
| `tool_result_persist` | 工具结果写入 transcript 前 | 提取 memory ID，实时强化 cited_count |
| `before_compaction` | compaction 开始前 | standalone 模式：跳过 store（session_end 已 flush）；retrieval-only 模式：跳过（由 memoryFlush 负责）；两者均执行 tier 强化/清理（O5 优化）|
| `after_compaction` | compaction 结束后 | no-op |
| `session_start` | 会话开始 | gateway restart 后抢救 unflushed buffer；清除 recall 缓存 |
| `session_end` | 会话结束 | 确保所有 buffer flush 到 DB（含 workspace sync） |
| `before_reset` | `/new` 或 `/reset` 前 | 抢救 unflushed buffer（O7 优化：不再清 recall 缓存，session_start 会独立清） |
| `gateway_start` | Gateway 启动完成后 | DB 健康检查，确保 FTS 索引就绪；content_hash 预热到内存 |
| `gateway_stop` | Gateway 关闭 | flush 所有 buffer，关闭 DB（带竞态守卫）|
| `subagent_spawning` | 子 Agent 启动前 | 日志记录 |
| `subagent_spawned` | 子 Agent 已启动 | 日志记录 |
| `subagent_ended` | 子 Agent 结束 | 日志记录 |

**ContextEngine 接口**：`registerContextEngine('algo-memory', ...)` — 实现 `assemble()` / `compact()` / `ingest()` 方法，深度接入 OpenClaw 上下文管理生命周期。

> **v3.1.0 OpenClaw 兼容性**：当 OpenClaw built-in memory 启用时（memoryFlush / memory-lancedb / memory-core），algo-memory 会自动切换到 `retrieval-only` 模式，关闭 hooks 存储（避免与 memoryFlush 重复），通过 ContextEngine assemble() 提供 FTS5 检索增强。详见 [CONFIG.md](CONFIG.md) 的 `openClawMemoryMode` 配置。

### v3.3.0 新特性

**🛡️ 系统消息过滤增强**
- 新增 20+ 种 OpenClaw 内部上下文过滤规则
- 过滤 `[Subagent Context]`、`[Inter-session message]`、`OpenClaw runtime context` 等
- 防止运行时元数据被误记为用户记忆

**📅 核心记忆长期保护（coreCleanupDays）**
- 核心记忆专属保留天数（默认 365 天）
- 超过期限未访问的 core 记忆会被降级为 peripheral
- 保护重要记忆不会被意外清理

**⚡ 动态捕获（adaptiveCapture）**
- 密集对话时自动提高每轮最大捕获数（最高 10 条）
- 普通对话维持较低的 `capturePerTurn` 限制
- 避免密集对话时重要记忆被截断

---

## 工具（18 个）

通过 `registerTool()` 自动暴露，无需额外 MCP 配置。

### Gateway RPC（通过 `registerGatewayMethod` 注册，支持 CLI/HTTP 调用，无需 LLM）

签名：`async (opts: GatewayRequestHandlerOptions) => void`
调用方式：`opts.respond(true, result)` 返回结果，`opts.respond(false, undefined, error)` 返回错误

| 方法 | 说明 |
|------|------|
| `algo-memory.stats` | 获取记忆统计 |
| `algo-memory.search` | 搜索记忆 |
| `algo-memory.list` | 分页列出记忆 |
| `algo-memory.health` | 健康检查 |
| `algo-memory.metrics` | 运行时指标 |

```bash
# CLI 调用示例
openclaw gateway call algo-memory.stats --params '{"agentId":"default"}'
openclaw gateway call algo-memory.search --params '{"query":"腾讯持仓"}'
```

### 核心
| 工具 | 说明 |
|------|------|
| `algo_memory_search` | FTS5 搜索，支持评分 + MMR |
| `algo_memory_list` | 列出记忆，支持分页 |
| `algo_memory_stats` | 数量 / tier 分布 / DB 大小 |
| `algo_memory_get` | 单条记忆详情 |

### 管理
| 工具 | 说明 |
|------|------|
| `algo_memory_update` | 更新记忆内容 |
| `algo_memory_delete` | 删除单条记忆 |
| `algo_memory_delete_bulk` | 批量删除 |
| `algo_memory_clear` | 清空所有记忆 |
| `algo_memory_import` | 从 JSON 批量导入 |
| `algo_memory_export` | 导出为 JSON |

### 高级
| 工具 | 说明 |
|------|------|
| `algo_memory_metrics` | 运行时指标（LLM 调用、缓存命中率）|
| `algo_memory_diagnostics` | DB 状态 / MMR 配置 / 最后召回详情 |
| `algo_memory_recall_reset` | 清除会话去重状态 |
| `algo_memory_correct` | 修正记忆（直接更新 or AI 辅助定位）|
| `algo_memory_fts_rebuild` | 重建 FTS5 索引 |
| `algo_memory_compact` | 手动触发 compaction 强化 |
| `algo_memory_health` | 完整健康检查 |
| `algo_memory_sync` | 导出 core 记忆 |

---

## 配置

> 完整配置参考 → [CONFIG.md](CONFIG.md)

### 基础

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `autoCapture` | `true` | agent_end 时自动捕获消息 |
| `autoRecall` | `true` | before_prompt_build 时自动召回 |
| `maxResults` | `5` | 最多召回记忆条数 |
| `capturePerTurn` | `3` | 每轮对话最多存储条数 |
| `cleanupDays` | `180` | peripheral 记忆同时满足 `created_at` + `last_accessed` 双 cutoff 时清理（v2.9.0 防"续命"优化） |
| `language` | `"auto"` | 语言：`auto` / `zh` / `en` |

### 三层分级

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `coreKeywords` | `["记住", "重要", ...]` | 命中直接标记为 core |
| `tier.coreThreshold` | `10` | access_count ≥ 此值直接升为 core |
| `tier.peripheralThreshold` | `0.15` | 复合评分低于此值为 peripheral |

> 评分公式（v2.9.0 分段优化版）：`tier_score = importance × multiplier`
> - access_count 1~10: `1 + log10(access_count + 1)`（快速提升）
> - access_count 10~100: `sqrt` 增长（平稳期，避免对数饱和）
> - access_count 100+: 对数上限饱和（防止马太效应）

### 检索

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `mmr.enabled` | `true` | 启用 MMR 多样化检索 |
| `mmr.lambda` | `0.7` | 相关性/多样性平衡（1=全相关，0=全多样）|
| `smartDedup` | `true` | 开启 Jaccard 智能去重 |
| `noiseFilter.enabled` | `true` | 过滤噪声（问候语、命令、元数据包裹层等）|

### LLM（可选，默认关闭）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `llm.enabled` | `false` | 是否启用 LLM |
| `llm.provider` | `"auto"` | 提供商（`minimax` / `deepseek` / `kimi` / `zhipu` / `qwen` 等）|
| `llm.model` | `""` | 模型名称（留空使用默认值）|

---

## 数据结构

### memories 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | 唯一 ID |
| `agent_id` | TEXT | Agent 标识 |
| `scope` | TEXT | 作用域（默认 `agent`）|
| `content` | TEXT | 记忆内容 |
| `tier` | TEXT | `core` / `working` / `peripheral` |
| `importance` | REAL | 重要性评分（0-1）|
| `access_count` | INTEGER | 被召回次数 |
| `cited_count` | INTEGER | 被引用次数 |
| `created_at` | INTEGER | 创建时间戳 |
| `last_accessed` | INTEGER | 最后访问时间戳 |
| `content_hash` | TEXT | 内容哈希（去重用）|

### FTS5 虚拟表

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content, keywords);
-- INSERT/UPDATE/DELETE 触发器自动同步
```

---

## 与 OpenClaw 内置 memoryFlush 的关系

algo-memory **不依赖** OpenClaw 内置 `memoryFlush`，可独立工作。

**冲突处理（自我谦让）：** 若同时启用 algo-memory 的 `autoCapture` 和 OpenClaw 的 `memoryFlush`，algo-memory 在 `before_compaction` 时会**跳过 store()**（由 memoryFlush 写 Markdown），而依赖 `before_prompt_build` / `agent_end` 的实时 hooks 继续写 SQLite。两系统共存时无重复存储。

**建议：** 如只用 algo-memory，在 `openclaw.json` 中设置：
```json
"agents": { "defaults": { "compaction": { "memoryFlush": { "enabled": false } } } }
```

**algo-memory 独有价值：**
- 无需 embedding API，离线/隐私友好
- importance × cited_count × tier 三层分级
- Weibull 时间衰减 + reinforcement 强化机制
- 纯算法模式零 LLM 成本
- 结构化 SQLite（FTS5 关键词搜索）vs Markdown 向量语义搜索

---

## 项目结构

```
algo-memory/
├── src/
│   ├── index.ts              # MemoryPlugin 主类 + 工具注册 + Hook 绑定
│   ├── types.ts              # TypeScript 类型定义 + 配置默认值
│   ├── utils.ts              # 工具函数（Weibull/Jaccard/MMR/噪声过滤）
│   ├── engine/
│   │   ├── store.ts         # 写入引擎（Buffer/LLM队列/批处理）
│   │   ├── retrieve.ts       # 检索引擎（FTS5/评分/MMR/多路召回/TierGroupedMMR）
│   │   ├── recall.ts         # 召回决策（shouldRetrieve/sessionDedup）
│   │   ├── llm.ts            # LLM 客户端（多provider/重试/缓存/processMemory）
│   │   ├── synonym-trie.ts   # Trie 树同义词展开器（v2.9.0 新增）
│   │   └── context-engine.ts # OpenClaw ContextEngine 接口实现
│   ├── db/
│   │   ├── schema.ts         # SQLite 建表 + FTS5 + 触发器
│   │   └── queries.ts        # queryAll/queryOne/run 封装
│   └── __tests__/            # Vitest 测试文件（~2844 行）
├── dist/                     # TypeScript 编译输出
├── config.default.json       # 默认配置（复制到 openclaw.json 使用）
├── CONFIG.md                 # 完整配置参考 + tier 公式 + JSON 示例
├── INSTALL.md               # 安装指南 + FAQ + 更新/卸载
├── ARCHITECTURE.md           # 系统架构设计 + 数据流 + 核心算法
├── CHANGELOG.md             # 版本变更历史
├── update.sh                 # 一键更新脚本
├── openclaw.plugin.json      # OpenClaw 插件配置（configSchema + uiHints）
└── vitest.config.ts          # Vitest 测试配置
```

---

## 兼容性

| 版本 | 最低要求 |
|------|----------|
| OpenClaw | v2026.3.24+ |
| Node | ≥ 20.0.0 |
| SQLite | FTS5 支持（Node ≥ 20 内置）|

**License:** MIT
