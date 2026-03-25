# Changelog

All notable changes to algo-memory are documented here.

## [2.7.2] - 2026-03-25

### Bug Fixes（消息保底机制 + 元数据剥离修复 + 系统消息过滤 + Tier损坏防御）

#### messagePriority 保底机制
- **问题**：`messagePriority(score > 0)` 是硬关卡，没有命中 `coreKeywords` 的消息在到达 `isNoise` 之前就被过滤掉，导致"查一下内存情况"这类普通消息无法存入
- **修复**：增加保底逻辑——无核心关键词但内容有实质意义（`meaningfulLen >= 10`，中文字符×1 + 英文×0.4）的消息，给 score = 1 进入 isNoise 二次判断
- **效果**：普通用户对话现在可以被记录，只被 isNoise 过滤

#### 元数据剥离重写（stripInboundMetadata）
- **问题**：原正则 `/^Conversation info[\s\S]*?---\s*/` 要求 `---` 必须紧跟 Conversation info 块，但实际 Feishu 消息格式为 `Conversation info...}` + `[message_id:...]` + `Sender...---`，正则无法匹配，导致元数据残留存储
- **修复**：拆分为三个独立 pattern 分别处理：
  - `META_PREFIX_PATTERN`：匹配 `Conversation info` 行或跨行 JSON 块
  - `META_MSGID_PATTERN`：匹配 `[message_id: xxx]` 行
  - `META_SENDER_PATTERN`：匹配 `Sender...---` 多行块
- **效果**：飞书消息的元数据包裹层完全剥离，只存用户实际内容

#### 系统消息过滤（isSystemMessage）
- **问题**：Session Startup 序列、"A new session was started via /new or /reset" 等系统消息被存入记忆库
- **修复**：新增 `isSystemMessage()` 函数，基于 `msg.source === 'system'` 和内容 pattern 双重判断，在 store 主循环中拦截
- **效果**：系统消息不再污染记忆库

#### Tier 列损坏防御
- **问题**：tier promotion 的 CASE WHEN 参数顺序错误（`[...idParams, ...tierParams, ...whereParams]` 应该是 `[...idParams, ...tierParams, ...whereParams]` 但 SQLite CASE WHEN WHEN id = ? THEN ? 只需要 2 个参数/次，结果把 memory ID 当作 tier 值写入），导致 tier 列被污染成 memory ID，且 tier_history 中的 old_tier 也是错误的 memory ID
- **修复**：tier promotion 循环前增加 `VALID_TIERS` 白名单校验，不合法的 tier 值（既不是 core/working/peripheral）自动修复为 'working' 并记录警告日志
- **效果**：已有损坏数据被自动修复，新增写入不会再损坏

## [2.7.1] - 2026-03-25

### Bug Fixes（Hook API 修复 + 元数据过滤 + 压缩策略优化）

#### before_prompt_build 钩子 API 修复
- `api.prependSystemContext(...)` 方法调用改为 `return { prependSystemContext: ... }`
- OpenClaw `before_prompt_build` 钩子正确契约是通过 `return` 传递 `PluginHookBeforePromptBuildResult`，而非调用实例方法
- 修复后钩子错误（`TypeError: api.prependSystemContext is not a function`）不再出现，召回记忆正常注入上下文

#### 噪音过滤器扩展（skipPatterns）
- `noiseFilter` 新增 `skipPatterns` 字段：支持正则表达式数组，符合任一 pattern 的内容在 importance 评分前直接跳过
- 默认 patterns 覆盖 OpenClaw 飞书等平台的元数据包裹层：
  - `^Conversation info` — 飞书消息前缀元数据块
  - `^```json` / `^```json{` — JSON 代码块包裹
  - `^{.*"message_id"` — 包含 message_id 的 JSON 对象
  - `^{.*"sender_id"` — 包含 sender_id 的 JSON 对象
- 新增 `skipSystemSource` 字段（预留来源标签过滤能力）

#### 元数据包裹层过滤（来源标签过滤）
- 新增 `isMetadataLike()` 函数，检测内容是否像系统元数据包裹层
- store() 循环中，在精确去重之前加入 `isMetadataLike()` 兜底过滤
- **效果**：飞书消息的 `Conversation info` 元数据包裹层被直接跳过，不再污染记忆库

#### 语义去重增强（元数据结构感知）
- smart dedup 中加入元数据感知逻辑：
  - 双方都是元数据类内容：阈值降至原值的 **50%**（更激进地去重）
  - 一方是元数据类内容：阈值降至原值的 **75%**
- **效果**：避免结构相似的元数据碎片被误认为"不同内容"重复存入

#### 压缩策略优化
- `compression` 新增 `minLengthForCompression` 字段（默认 300 字符）：
  - 内容长度 ≤300 字符：跳过压缩，直接存储原文
  - 避免短内容被过度截断
- `compression` 新增 `skipMetadataCompression: true`：
  - 元数据类内容：直接存储原文，不执行压缩逻辑
- **效果**：短内容（≤300字符）保持完整，元数据内容不浪费压缩 CPU

### 配置变更

**noiseFilter 新增字段（向后兼容，未设置时使用默认值）：**
```json
{
  "skipPatterns": [
    "^Conversation info",
    "^```json",
    "^```json\\{",
    "^{.*\"message_id\"",
    "^{.*\"sender_id\""
  ],
  "skipSystemSource": true
}
```

**compression 新增字段：**
```json
{
  "minLengthForCompression": 300,
  "skipMetadataCompression": true
}
```

## [2.7.0] - 2026-03-24

### Features（FTS5 同义词扩展 + 多路召回）

#### FTS5 同义词扩展检索（离线，零依赖）
- **脚本感知分词**：Latin 与 CJK（中文）分段处理，解决中英混合文本整词无法切分问题
  - `"iPhone屏幕碎了"` → `["iPhone", "屏幕", "碎", "坏", "苹果手机", "苹果", "手机", "裂", "爆", "故障"]`
- **SYNONYMS 双向子串提取**：Query 中的任意子串命中同义词表 key 或 value 时，自动提取并展开为 OR 查询
  - `"Mac系统崩了"` → `"Mac" OR "苹果电脑" OR "Apple" OR "崩" OR "死机" OR "蓝屏" OR "黑屏" OR "崩溃"`
- **同义词表覆盖范围（200+ 条）**：
  - 生活：老婆↔媳妇↔妻子 / 记住↔记得 / 讨厌↔不喜欢↔抵触↔不想
  - 设备：iPhone↔苹果手机↔手机 / Mac↔苹果电脑↔Apple / 坏↔碎↔裂↔爆 / 崩↔死机↔蓝屏↔黑屏
  - 地点/时间：上海↔魔都 / 北京↔帝都 / 明天↔次日 / 午饭↔午餐
  - **金融（新增 90+ 条）**：买↔建仓↔开仓 / 卖↔清仓↔平仓↔止损↔割肉 / 加仓↔增持 / 美联储↔FOMC / 加息↔提息 / 降准↔MLF / CPI↔通胀 / 茅台↔600519 / 腾讯↔00700 / 苹果↔AAPL
  - 宏观：GDP↔增速 / 汇率↔外汇 / 房价↔楼市

#### 多路召回（Multi-Path Recall）
- 单次 Query 生成 4 条检索路径，合并去重后统一 MMR
- 路径1：原始 Query（优先）
- 路径2：前缀 3-token
- 路径3：后缀 2-token
- 路径4：首尾 token 组合
- **冲突处理**：MMR 改为在多路合并后统一做一次，cited_count 更新去重后只更新一次

#### BM25+ 评分增强
- 在 SQLite BM25 基础上加 δ=1.0 偏移，避免短文本评分过低

### Bug Fixes

- 修复 `simpleChineseTokenize` 中文字符无法切分的根本性缺陷（重写为脚本感知切分 + SYNONYMS 子串提取）
- 修复 SYNONYMS 表 duplicate key `'生日'` 重复定义（TS error TS1117）
- 修复 CPI/cpi 大小写不敏感的同义词展开

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
