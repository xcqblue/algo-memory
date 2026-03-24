# Changelog

All notable changes to algo-memory are documented here.

## [2.7.0] - 2026-03-24

### 新功能

- **向量搜索接口**（可选，默认关闭）：支持 openai / minimaxi / bge / ollama / siliconflow，存储在 `memory_embeddings` 表，FTS5+向量混合融合评分（`ftsWeight` 配置权重）

### Breaking Changes（Session 续接功能移除，请检查旧配置）

- 移除 `sessionContinuity` 配置项及所有相关代码
- 移除 `sessionSummary` 配置项及所有相关代码
- 移除 `session_snapshots` 数据库表（init 时不再创建）
- 移除 `session_metadata` 数据库表
- 移除 `snapshotRetentionDays` 配置项
- 移除 `before_prompt_build` 中的会话续接注入逻辑
- 移除 `generateSessionSummary()`、`extractContextSnapshot()`、`saveSessionSnapshot()`、`getLastSessionSnapshot()`、`detectSessionChangeAndGetSnapshot()`、`buildSessionContinuityContext()`、`writeSessionSummary()`、`restoreLastSessionKey()` 方法
- 移除 `lastSessionKey` Map 状态管理

### Refactor

- `agent_end` hook 简化为仅处理消息 capture，不再调用 session snapshot
- 清理 `index.ts` 约 280 行 session 相关代码
- 文档全面更新（README/CONFIG/ARCHITECTURE/INSTALL）

## [2.6.0] - 2026-03-24

### Breaking Changes（配置字段删减，请检查旧配置）

- 移除 `adaptiveRetrieval.topicDrift` 配置项（topicDrift 预加载功能已删除）
- 移除 `tier.pending.maxPendingDays`、`tier.pending.recallUpgrade`
- 移除 `tier.decay` 相关配置（`coreStaleDays`、`decayPerStep`、`demoteThreshold`）
- 移除 `compression.semanticEnhance` 配置项

### Bug Fixes

- **MCP Server 冲突**：移除独立的 MCP stdio server 实现，OpenClaw 本身已是 MCP Host，插件工具通过 `registerTool()` 自动暴露，无需重复实现
- **Workspace 文件冲突**：`syncCoreToWorkspace()` 改为禁用状态，log 警告引导用户使用 `algo_memory_export` 导出，避免与 workspace plugin 的 JSON 格式冲突
- **代码臃肿清理**：删除 topicDrift 预加载逻辑（~50行）、MCP server（~110行）、semanticEnhance 死代码，净减少 243 行

### Refactor

- `before_prompt_build` 钩子逻辑简化：移除 topicDrift 预加载逻辑，恢复为只做 recall 一件事
- `compressContent()` 删除未启用的 semanticEnhance 分支

## [2.5.0] - 2026-03-24

### Features

- **9 个 OpenClaw Hook 完整接入**
  - `agent_end` — capture 用户消息
  - `before_prompt_build` — recall 相关记忆
  - `before_compaction` — 从 session transcript 预捕获记忆，触发强化
  - `after_compaction` — 强化 core importance，清理低价值 peripheral
  - `session_start` — 检测会话切换，注入上会话摘要
  - `session_end` — 写会话摘要（per-agent per-day 文件）
  - `after_tool_call` — 实时强化 `algo_memory_search` 召回的记忆
  - `llm_output` — 记录 LLM token 使用统计
  - `gateway_stop` — 干净关闭，flush buffer

- **模型列表动态化**
  - 模型名直接透传给 API，内置 modelMap 只做日志展示用
  - 新增 `llm.customModelNames` 配置项：用户可自行添加新模型，无需修改插件代码
  - 解决模型频繁更新导致插件代码不断维护的问题
  - 示例：`{ "glm-4.7-flash": "智谱免费模型", "my-model": "私有模型" }`
  - `before_compaction`: `promotePeripheralOnCompaction()` — 将频繁访问的 peripheral 升级
  - `after_compaction`: `reinforceOnCompaction()` — 强化 core importance，清理低价值 peripheral

- **Workspace 集成**
  - `syncCoreToWorkspace()`: core 层记忆自动同步到 `memory/algo-memory/YYYY-MM-DD.md`
  - 不再写入 `MEMORY.md`（避免破坏 workspace 插件的 JSON 格式）

- **MCP 工具新增**
  - `algo_memory_health` — 完整健康检查（DB/FTS/buffer/LLM stats/配置/问题清单）
  - `algo_memory_compact` — 手动触发 compaction 强化

### Performance

- **store() 批处理优化**
  - 重构为 3 阶段：`同步过滤 → 批量 LLM → 同步入 buffer`
  - `extractKeywords`: 从 O(n) 次 LLM 降为 O(1)（所有消息合并一次调用）
  - **batch 内 Jaccard 去重**：同批次消息互相检查，避免连续重复存入 DB
  - 结果：10 条消息的 store 调用从 ~20 次 LLM 降至 ~1-3 次

### Bug Fixes

- **Critical**
  - `updateMemory`: `WHERE agent_id=?` 的参数漏传（只有 `[memoryId]`），任何用户可修改任何记忆
  - `updateMemory`: `metadata` 对象未 `JSON.stringify`，SQLite 存成 `"[object Object]"`
  - `before_prompt_build`: sessionDedup 配置传了 `config.adaptiveRetrieval`（不存在），**session 去重功能从未生效**（v2.5.0 修复后首次生效）
  - `snapshotRetentionDays`: 在 `cleanup()` 里使用但未加入 Config 接口，无法配置（v2.5.0 修复）
  - `getMemory`: 引用未定义的 `MEMORY_COLUMNS` 常量，运行时崩溃
  - `snapshotRetentionDays`: 在 `cleanup()` 里使用但未加入 Config 接口，无法配置

- **P1-P5 原始 Bug**
  - `queryAll` 用 `row[i]` 访问 better-sqlite3 对象（应使用 `row[col]`）
  - Feishu 元数据 `Conversation info (untrusted metadata)` 污染存储
  - `sessionSummary` 对 Feishu 数组格式消息处理失败
  - `forceKeywords` 被 `META_PATTERNS` 优先拦截
  - FTS5 触发器使用 `rowid` 而非稳定 `id`，VACUUM 后索引飘移

- **Error 序列化**
  - 所有 hook catch 块：`JSON.stringify(err)` → `err?.message ?? err, err?.stack`
  - 修复后日志可正常显示错误详情

### OpenClaw 集成

- 所有 hook 接收 `(event, ctx)` 两参数，`ctx.agentId` 是正确来源
- Hook 名称修正：`session:compact:before/after` → `before_compaction/after_compaction`
- `session_end` 使用 `event.sessionKey` 作为 `writeSessionSummary` 的 agentId
- `close()`: flush 和 db.close 各自独立 try/catch，flush 失败不阻塞关闭

### Configuration

- `sessionDedup.similarityThreshold`: 0.6 → **0.75**
- `mmr.lambda`: 0.85 → **0.7**（与 OpenClaw 默认值对齐）
- 新增 `metricsEnabled: true` — 控制 llm_output token 统计
- 新增 `snapshotRetentionDays: 30` — session_snapshots 保留天数

### Dependencies

- `openclaw.plugin.json`: `engines.openclaw: "^2026.3.23"`（最低要求）
- `installDependencies: false`（不自动 npm install，避免 Node 版本问题）

---

## [2.4.0] - 2026-03-23（原始版本）

- 初始 release
- SQLite FTS5 全文检索
- 三层分级（core/working/peripheral）
- MMR 多样化检索
- Weibull 时间衰减
- MiniMax / DeepSeek / Kimi / 阿里百炼 LLM 支持
- 会话续接（session_snapshots 表）
- 14 个 MCP 工具
