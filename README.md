# algo-memory

基于 SQLite 的结构化长期记忆插件 for OpenClaw — 三层分级、FTS5 全文检索、LLaM 辅助捕获、完整 OpenClaw 生命周期接入。

**版本：** v2.7.1 | **OpenClaw:** v2026.3.23+ | **Node:** ≥20

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
| **core** | 高 importance × log(access_count)，被频繁召回的重要记忆 |
| **working** | 中等重要度，日常信息 |
| **peripheral** | 低重要度，随时间自然衰减（Weibull, shape=1.5, scale=90天）|

### 全文检索（FTS5）
- SQLite FTS5 虚拟表，无需外部 embedding API，离线/隐私友好
- **同义词扩展**（离线，零依赖）— 覆盖生活（老婆↔媳妇）、设备（iPhone↔苹果手机）、金融（止损↔割肉）、宏观（CPI↔通胀）等 200+ 条目
- **多路召回**（Multi-Path）— 原始 Query + 前缀3-token + 后缀2-token + 首尾组合，并行检索后合并去重
- **BM25+ 排序** + **MMR 多样化检索**（λ=0.7）

### LLM 增强（可选）
- 自动提取关键词 / LLM 辅助去重 / 语义压缩
- **纯算法模式零成本运行**，LLM 非必选

### OpenClaw 生命周期 Hook

| Hook | 时机 | 行为 |
|------|------|------|
| `agent_end` | 每次对话结束 | capture 用户消息，写入 buffer |
| `before_prompt_build` | LLM 调用前 | 检索相关记忆，注入上下文；实时存储上一轮消息 |
| `before_compaction` | compaction 开始前 | 若 memoryFlush 未启用则 store；tier 强化/清理 |
| `after_compaction` | compaction 结束后 | 仅记录日志（强化已在 before_compaction 完成）|
| `after_tool_call` | 工具执行后 | 实时强化 `algo_memory_search` 召回的记忆 |
| `gateway_stop` | Gateway 关闭 | flush 所有 buffer，关闭 DB（带竞态守卫）|

---

## 工具（18 个）

通过 `registerTool()` 自动暴露，无需额外 MCP 配置。

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
| `cleanupDays` | `180` | peripheral 记忆超过此天数未访问则清理 |
| `language` | `"auto"` | 语言：`auto` / `zh` / `en` |

### 三层分级

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `coreKeywords` | `["记住", "重要", ...]` | 命中直接标记为 core |
| `tier.coreThreshold` | `10` | access_count ≥ 此值直接升为 core |
| `tier.peripheralThreshold` | `0.15` | 复合评分低于此值为 peripheral |

> 评分公式：`tier_score = importance × (1 + log10(access_count + 1))`

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
│   │   ├── retrieve.ts       # 检索引擎（FTS5/评分/MMR/多路召回）
│   │   ├── recall.ts         # 召回决策（shouldRetrieve/sessionDedup）
│   │   └── llm.ts            # LLM 客户端（多provider/重试/缓存）
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
| OpenClaw | v2026.3.23+ |
| Node | ≥ 20.0.0 |
| SQLite | FTS5 支持（Node ≥ 20 内置）|

**License:** MIT
