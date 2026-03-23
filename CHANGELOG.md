# 更新日志

所有重要改动按版本分组。

---

## v2.4.0

### 🆕 新功能
- **会话续接**：解决"第二天忘记昨天聊什么"的问题
  - `session_end` 钩子保存会话快照
  - `session_start` 钩子检测会话切换
  - 自动注入上会话摘要到上下文

### ⚡ 性能优化
- **批量写入**：500ms 缓冲批量写入，减少 DB IO
- **记忆压缩**：长内容自动压缩（最大 200 字符）
- **LLM 队列单例**：避免重复 LLM 调用
- **动态批量调整**：基于消息频率动态调整

### 🛡️ 稳定性
- **缓存 LRU 策略**：访问时更新访问时间
- **错误边界**：LLM 调用添加超时和重试机制
- **分层历史记录**：追踪记忆晋升/降级历史

### 📚 文档优化
- 精简 README.md（-95%）
- 完善 INSTALL.md（添加更新说明）
- 添加一键更新脚本 update.sh

---

## v2.3.0

### 新功能
- **语言感知召回**：`shouldRetrieve` 自动检测查询语言，使用对应语言的 forceKeywords 触发词表（中/英/日/韩/西/法/德）
- **Memory Feedback**：新增 `feedback` / `apply_feedback` 两个工具，支持自然语言修正记忆
- **MCP 协议暴露**：新增 MCP stdio server，16 个工具全部通过 MCP 协议暴露给外部 AI 调用

### 核心改进
- **cited_count 更新范围扩大**：召回时对所有 MMR 候选项更新（不仅仅是截断后的结果），被 MMR 过滤但仍相关的项同样计入
- **updateMemory 完整判断链**：更新记忆时走完整的 importance 判断（keyword → LLM 可选），不再写死 0.5/1.0
- **MMR 早停修正**：追踪剩余候选中最高 relevance，而非依赖刚选中项，避免低相关性项误触发早停
- **anthropic API 修正**：正确使用 `/v1/messages` 端点和 `anthropic-version` 请求头
- **硬删除简化**：移除软删除机制（`deleted_at` 列 + 2 个 FTS 触发器），简化 schema

### Bug 修复
- **SQL 注入**：store.ts tier 批量更新改为完全参数化
- **importMemories ID 冲突**：`INSERT` 改为 `INSERT OR REPLACE`，ID 冲突时替换而非静默丢数据
- **CLI stats SQL 引号**：`"core"` 改为 `'core'`（双引号在 SQLite 中表示列名）
- **safeContent 冗余编码**：移除无意义的 `<>` → `&lt;&gt;` HTML 编码
- **normalizeText**：移除所有 `@mention`（而非仅第一个）
- **MCP 工具列表**：补全 `delete_bulk` 和 `clear`（之前列表缺失但 switch 有处理）

### 配置变更
- **默认开关调整**：默认开启（除 `llm` 和 `mcp`）；之前所有评分增强均默认关闭
- **LLM 默认关闭**：`llm.enabled` 默认为 `false`，避免无 API Key 时认证超时导致响应慢
- **urgency 字段移除**：schema 清理，`urgency` 列和 migration 代码移除

---

## v2.2.5
- 统一检索引擎（retrieve.ts），recall 和 search 共用同一检索管道
- recall 保留 agent 权重 1.5×（tier.core）
- 修复 recall 不传递 agent 权重的问题

## v2.2.4
- 存储优先级打分机制
- Query Expansion（FTS5 空结果时自动去掉最短词）
- 动态 Token 上限
- BM25F 关键词权重 2×
- 软删除机制引入

## v2.2.3
- 删除冗余机制：citedBoost / urgencyDecay / sessionMemory / lexicalOverlap

## v2.2.2
- MMR 公式修正
- 会话去重机制
- CLI 工具

## v2.2.1
- sql.js → better-sqlite3 迁移
