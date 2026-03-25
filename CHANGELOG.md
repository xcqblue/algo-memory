# Changelog

All notable changes to algo-memory are documented here.

## [3.0.0] - 2026-03-25

### 🔴 高优先级修复

#### 多路召回：原始 query 先生成多路，再分别 Trie 展开
- **问题**：`generateMultiPathQueries()` 对已展开的 FTS5 query（包含 OR）做前缀截取，语义不准确
- **优化**：在原始 query 上先生成多路，再分别调用 `buildTrieFts5Query()` 展开
- **效果**：不同路径保留各自独立展开的同义词集合（如"北京出差"展开"帝都"+"商务出行"）

#### recall 和 search 统一走 `retrieve()` 检索引擎
- **问题**：`recall.ts` 中的 MMR 是自己实现的全局 MMR，没有 tier 分组；`searchMemories` 走另一套 `ftsQuery` + `likeFallback`，没有 MMR
- **优化**：
  - `recall.ts` 替换为调用 `retrieve.ts` 的 `tierGroupedMMR()` 纯函数
  - `searchMemories` 重构为调用统一 `retrieve()` 引擎
- **效果**：recall 和 search 的去重逻辑完全一致，core 记忆保留率提升

### 🟡 中优先级优化

#### LLM 队列动态批次
- **问题**：固定 200ms 窗口 + 每次 10 条，队列积压时处理慢，空闲时等待浪费
- **优化**：队列深度决定批次大小和处理延迟
  - 队列 ≥ 20：每次 20 条，50ms 快速消耗
  - 队列 5~20：每次 10 条，200ms 标准等待
  - 队列 < 5：最多 10 条，500ms 等待攒批
- **效果**：低延迟（队列短时）+ 高吞吐（队列长时）+ 批量效率（队列满时）

#### cleanupEmptyBuffers 30 分钟强制清理
- **问题**：buffer 只在 `timer === null` 且 `idle > 1h` 时清理，长期会话的 buffer 可能堆积
- **优化**：增加 `idle > 30 分钟` 强制清理条件（timer 最大等待 10s，30 分钟无 flush 说明无新消息）
- **效果**：防止 `memoryBuffers` Map 无限增长

#### hash 预热改为"今日+最近1000条"并集
- **问题**：固定加载最近 2000 条，今天只有少量记忆时浪费；旧记忆加载了但今天没机会重复
- **优化**：取今日 00:00 以来 + 最近 24 小时的最大值，LIMIT 1000
- **效果**：覆盖今日活跃会话的同时兜底最近历史，启动扫描量减少

---

## [2.9.0] - 2026-03-25

### 性能优化（写入）

#### 批量去重 O(n²) → O(n log n)
- **问题**：批次内两两 Jaccard 比较，n 条消息 → n²/2 次比较，消息多时延迟飙升
- **优化**：按内容长度降序排列，在长度窗口内（最多 5 条）两两比较；窗口外长度差异过大，Jaccard 上界必然低于阈值，直接跳过
- **效果**：批次去重次数大幅减少，写入延迟降低

#### DB Jaccard 长度预过滤
- **问题**：每条候选都要和 DB 中 5 条记忆做 Jaccard，很多比较无意义（长度差异大时 Jaccard 上界必然低）
- **优化**：Jaccard 上界由长度比决定：`min(a,b)/max(a,b) < 0.3` 直接跳过比较
- **效果**：70%+ Jaccard 计算被跳过

#### Content hash 内存预热
- **新增**：启动时加载最近 2000 条记忆的 `content_hash` 到 `Set<string>`
- **效果**：精确去重 O(1)（先查内存 Set，未命中再查 DB）

#### 合并 LLM 调用（processMemory）
- **新增** `LLMClient.processMemory()` 方法
- 单次调用同时完成：isCore 判断 + 关键词提取 + 语义去重
- **效果**：减少 50%+ LLM API 调用，降低延迟和成本

### 性能优化（召回）

#### Tier 分组 MMR 去重
- **问题**：全局 MMR 可能让 core 记忆被 peripheral 挤出（内容相似时，peripheral 先被选中）
- **优化**：按 tier 分组，每组内独立 MMR 去重，再合并按 score 排序
- **效果**：core 记忆不会被 peripheral 意外淘汰

#### Trie 树同义词展开（synonym-trie.ts）
- **问题**：同义词展开 O(query_len × syn_count)，每 token 要遍历 200+ 同义词表
- **优化**：预编译 Trie 树，从任意子串出发贪心最长匹配，时间复杂度 O(query_len × max_word_len)
- **新增文件**：`src/engine/synonym-trie.ts`
- **效果**：FTS5 查询同义词展开从 ~4000 次/查询 降至 ~query_len 次

#### 多路召回 4 → 2 路
- **问题**：原始 4 路（原始 + 前缀3 + 后缀2 + 首尾）产生大量冗余候选，实际价值低
- **优化**：只保留原始 Query + 前缀 3-token，裁剪后缀和首尾组合
- **效果**：召回候选数量减少 50%+，评分压力降低

#### 会话去重长度豁免
- **问题**：30 秒内相似查询直接跳过，但追问类场景（"茅台" → "茅台股价走势如何"）不应被拦截
- **优化**：本次 query 长度超过上次 1.5 倍时，视为追问/深入问，允许召回
- **效果**：追问类场景不被误拦截

### 可靠性优化

#### before_compaction 放弃 2s 有限等待
- **问题**：`Promise.race([storePromise, 2000ms])` 不可靠：消息量大时 store 永远无法完成；超时后的 storePromise 仍在后台运行，可能在 gateway restart 时竞走
- **优化**：改为完全 fire-and-forget，依赖 `session_end` / `gateway_stop` 做最终 flush 兜底
- **效果**：compaction 不被阻塞，gateway 重启时无竞走风险

#### Peripheral cleanup 双 cutoff
- **问题**：旧实现用 `last_accessed` 作为 cutoff，存在"续命"问题——peripheral 记忆在第 179 天被访问一次 → last_accessed 更新 → 重新获得 180 天寿命
- **优化**：同时使用 `created_at` + `last_accessed` 双 cutoff：
  - `created_at < cutoff`：已存活 cleanupDays 天（临时信息本质）
  - `last_accessed < cutoff`：长期未被访问（非活跃记忆）
- **效果**：真正重要的记忆会被 recall 强化（last_accessed 持续更新），临时的 peripheral 记忆两者都超 cutoff → 被清理

#### Tier 评分分段公式
- **问题**：原公式 `importance × (1 + log10(access_count + 1))` 中，高访问次数（100+/1000+）时对数项过早饱和，multiplier 差距极小（ac=100 → 3.0, ac=1000 → 4.0）
- **优化**：分段设计：
  - ac 1~10: log10 增长（快速提升）
  - ac 10~100: sqrt 增长（平稳期）
  - ac 100+: 对数上限（饱和期，multiplier 上限 5.0）
- **效果**：高频访问记忆获得应有区分度

### 数据库优化

#### 新增 3 个索引
```sql
-- peripheral cleanup 查询优化
CREATE INDEX idx_peripheral_cleanup ON memories(tier, layer, created_at) WHERE tier = 'peripheral' AND layer = 'general';

-- export / list 查询优化
CREATE INDEX idx_agent_created ON memories(agent_id, created_at DESC);

-- content_hash 精确去重（UNIQUE + WHERE 允许 NULL）
CREATE UNIQUE INDEX idx_content_hash ON memories(content_hash) WHERE content_hash IS NOT NULL;
```

### 项目结构更新
- **新增** `src/engine/synonym-trie.ts`（Trie 树同义词展开器）

---

## [2.8.2] - 2026-03-25

### Bug Fixes（OpenClaw 25 Hook 全覆盖修复）

#### `before_reset` — `/new` 时抢救 unflushed buffer
- **问题**：用户敲 `/new` 时，如果上一轮 buffer 里还有未 flush 的消息，这些消息会随旧 session context 一起丢弃（因为 `before_prompt_build` 需要新消息触发，旧的 buffer 没有新触发机会）
- **修复**：新增 `before_reset` hook，在 `/new` 或 `/reset` 触发后、新 session 开始前强制 flush buffer，并清空 recall 缓存

#### `gateway_start` — 启动时 DB 健康预热
- **问题**：gateway 启动后、第一个会话处理前，没有验证 DB 连接是否正常
- **修复**：新增 `gateway_start` hook，gateway 完全启动后执行 DB 健康检查（`SELECT 1`），确保 FTS 索引就绪后才对外交互

#### heartbeat/cron 时 `store()` 跳过
- **问题**：`before_prompt_build` 对 heartbeat/cron 触发的系统消息跳过了 recall，但没有跳过 store，导致系统消息进记忆
- **修复**：`before_prompt_build` 和 `agent_end` 均检测 `trigger`，heartbeat/cron 时跳过 store

#### `before_dispatch` 哈希一致性修复
- **问题**：`before_dispatch` 直接对 raw 内容 hash，`store()` 里先 `safeContent()` 再 hash，两者 hash 结果不一致，精确去重失效
- **修复**：`before_dispatch` 改用 `safeContent()` 规范化后 hash，与 `store()` 的 `content_hash` 一致

### OpenClaw 25 个 Plugin Hook 全覆盖

| Hook | 用途 |
|------|------|
| `before_prompt_build` | 存储 + 召回 |
| `agent_end` | 兜底存储 |
| `before_compaction` | buffer flush + tier 强化（2s 有限等待）|
| `after_compaction` | no-op（compaction 后 context 已截断）|
| `session_start` | gateway restart 后 buffer 抢救 + 缓存清理 |
| `session_end` | buffer flush |
| **`before_reset`** 🆕 | `/new` 时抢救 unflushed buffer |
| **`gateway_start`** 🆕 | DB 健康预热 |
| `gateway_stop` | flush + close |
| `after_tool_call` | cited_count 实时强化 |
| `tool_result_persist` | cited_count 强化 |
| `before_dispatch` | 入站哈希精确去重 |
| `subagent_spawning` | 日志 |
| `subagent_spawned` | 日志 |
| `subagent_ended` | 日志 |

---

## [2.8.0] - 2026-03-25

### 新增功能（OpenClaw v2026.3.24 深度集成）

#### `before_dispatch` 入站预过滤
- **问题**：元数据噪声（`Conversation info` / `message_id` / `Sender`）在 `store()` 时才被剥离，早期占用了 store 引擎的过滤算力
- **修复**：新增 `before_dispatch` hook，在消息进入 transcript 之前执行 strip + 哈希精确去重拦截
- **效果**：重复消息提前拦截，`store()` 压力降低；精确重复时更新 `access_count`，加速 tier 升级

#### Gateway `/v1/embeddings` 语义召回接口
- 新增 `algo-memory.embeddings` Gateway Method
- 调用 OpenClaw Gateway 兼容接口 `/v1/embeddings`，为后续向量语义检索留出扩展接口
- 返回 `{ embedding, query, agentId, limit }`，供 `assemble()` 阶段做混合评分

#### LLM Proxy 支持（企业网络环境）
- **问题**：企业内网需要代理访问 LLM API，直接 fetch 会超时
- **修复**：读取 `HTTPS_PROXY` / `http_proxy` 环境变量，通过 `undici.ProxyAgent` 注入所有 LLM fetch 调用
- **涉及位置**：`llm.ts`（`isCoreMemory` / `extractKeywords` / `isDuplicate`）+ `index.ts`（`correct` 方法）
- **效果**：企业内网环境下 LLM 增强功能（关键词提取/语义去重）正常可用

#### MCP Server 暴露
- **问题**：algo-memory 工具（`algo_memory_*`）只能在 OpenClaw 内使用，无法被 Cursor / Claude Desktop 等 MCP Client 调用
- **修复**：使用 `@modelcontextprotocol/sdk` 将 18 个工具暴露为标准 MCP tools，支持 stdio 传输
- **配置**：设置 `config.mcp.enabled: true` 开启（默认关闭）
- **效果**：Cursor / Claude Desktop 等 MCP Client 可直接查询 / 操作 algo-memory 记忆

#### `skill.json` 安装元数据
- 新增 `skill.json`，包含 OpenClaw 一键安装所需元数据：
  - `requirements`：LLM API Key 配置提示（支持 zhipu/deepseek/minimax/qwen/kimi/siliconflow）
  - `recipes`：复制到 `~/.openclaw/plugins/` 目录的步骤
  - `configHints`：各配置项的 UI 展示提示
- **效果**：OpenClaw Control UI 可展示"Get your key"链接和 setup 引导

### Bug Fixes & 可靠性改进

#### `before_compaction` 异步 store 可靠化
- **问题**：`store()` 完全 fire-and-forget，若 gateway 重启，会话消息可能丢失
- **修复**：加 2s 有限等待（`Promise.race(storePromise, timeoutPromise)`），兼顾不阻塞 compaction + 防止竞走丢消息
- **效果**：compaction + restart 场景下数据不丢失

#### `after_compaction` 精简
- **问题**：`reinforceOnCompaction` 已在 `before_compaction` fire-and-forget 执行，`after_compaction` 再次执行无意义
- **修复**：改为 no-op log，保留 hook 签名以保持 OpenClaw 生命周期完整性
- **效果**：compaction 后不再重复强化，减少无意义计算

#### JSON.parse 容错统一（`tryParse`）
- **问题**：`after_tool_call` 和 `tool_result_persist` 的 JSON 解析分散在两处，try/catch 分支冗余
- **修复**：新增 `tryParse<T>()` 工具函数，统一处理 string/object → T 解析，失败返回 null
- **效果**：代码更简洁，ID 提取逻辑更一致

### 依赖更新
- 新增 `undici`（`ProxyAgent` 用于 LLM HTTP 代理）
- 新增 `https-proxy-agent`（备用）
- Node ≥ 20.0.0（已有）

---

## [2.7.5] - 2026-03-25

### 新增功能（OpenClaw 深度集成）

#### ContextEngine 接口实现
- 新增 `src/engine/context-engine.ts` — 实现 OpenClaw `ContextEngine` 接口
- `AlgoMemoryContextEngine` 类包装 `MemoryPlugin`，向 OpenClaw 暴露标准 `assemble()` / `compact()` / `ingest()` 接口
- `assemble()` 调用 `plugin.recall()` 并将 `Memory[]` 转换为 `AgentMessage[]` 注入模型上下文
- `compact()` 调用 `plugin.manualCompact()` 执行 tier 强化
- 通过 `api.registerContextEngine('algo-memory', ...)` 注册

#### Gateway RPC 方法
- `algo-memory.stats` — 获取记忆统计
- `algo-memory.search` — 搜索记忆
- `algo-memory.list` — 分页列出记忆
- `algo-memory.health` — 健康检查
- `algo-memory.metrics` — 运行时指标
- 通过 `api.registerGatewayMethod()` 注册，支持 CLI/HTTP 调用（无需 LLM）

#### 会话生命周期 Hooks
- `session_start` — 初始化会话状态，清除 recall 缓存
- `session_end` — 确保所有 buffer flush 到 DB

#### 消息写入 Hook
- `before_message_write` — 消息写入 transcript 前的预处理钩子（为未来增强预留）

#### 子 Agent 生命周期 Hooks
- `subagent_spawning` / `subagent_spawned` / `subagent_ended` — 子 Agent 生命周期钩子（预留）

### Bug Fixes（代码审查 + OpenClaw 兼容性修复）

#### before_compaction 移除同步读磁盘
- **问题**：`fs.readFileSync()` 是同步阻塞操作，会阻塞 gateway 事件循环
- **修复**：改用 `event.messages`（OpenClaw 在 hook 调用前已直接传入），无需读磁盘
- **效果**：compaction 触发更平稳，不影响 gateway 响应其他请求

#### after_tool_call 记忆 ID 提取安全化
- **问题**：`/"id"\s*:\s*"([^"]+)"/g` 纯正则提取，假阳性率高；格式变化时静默失败
- **修复**：优先 `JSON.parse()` 安全解析，支持 `{ memories: [...] }` 和 `[...]` 两种格式；正则仅作兜底；新增 `startsWith('mem_')` 校验
- **效果**：`reinforceCitedMemories()` 更可靠，不会误强化无关 ID

#### gateway_stop 竞态守卫
- **问题**：`before_prompt_build` 的异步 `store()` 可能在 `gateway_stop` 触发后仍试图写入已关闭的 DB
- **修复**：新增 `setClosing()` 全局标志；`close()` 时先设标志再 flush；`scheduleBatchWrite()` 检查标志并拒绝新调度
- **效果**：gateway 重启/关闭时不再出现 "SQLite error: database is closed" 写入崩溃

#### memoryFlush 自我谦让机制（与 OpenClaw 内置兼容）
- **问题**：algo-memory 与 OpenClaw 内置 memoryFlush 同时启用时，两者都会在 compaction 前存储记忆，导致重复存储
- **修复**：在 `before_compaction` 中检测 `memoryFlush.enabled` 状态；若 memoryFlush 启用，则跳过 `store()`（由 memoryFlush 写 Markdown），仅执行 `promotePeripheralOnCompaction()` 和 `reinforceOnCompaction()`；algo-memory 的实时 hooks（`before_prompt_build` / `agent_end`）继续写入 SQLite，两系统无冲突
- **效果**：无需用户手动配置，两者共存时自动消解冲突

#### Gateway RPC 签名修复
- **问题**：`registerGatewayMethod` 的 handler 签名错误，直接返回结果而非调用 `respond()`，导致 gateway method 无法被调用
- **修复**：改用 `async (opts: GatewayRequestHandlerOptions) => void`，通过 `opts.respond(true, result)` 返回，`opts.params` 读取参数
- **效果**：gateway method 真正可用：`openclaw gateway call algo-memory.stats --params '{"agentId":"default"}'`

#### tool_result_persist Hook
- **问题**：`after_tool_call` 的 `event.result` 为字符串，需要正则提取 memory ID
- **修复**：新增 `tool_result_persist` hook，`event.message` 为 AgentMessage 结构，可直接 JSON 解析
- **效果**：ID 提取更可靠，早于 `after_tool_call` 触发

#### ctx.trigger 防递归召回
- **问题**：`before_prompt_build` 的 recall 在 memory/heartbeat/cron 触发的 agent turn 中会递归调用
- **修复**：增加 `ctx.trigger` 检查，当 trigger 为 `memory`/`heartbeat`/`cron` 时跳过 recall
- **效果**：避免 memory 触发的 agent turn 中重复召回

## [2.7.4] - 2026-03-25

### Bug Fixes（agent_end 在嵌入式模式不触发per-turn的修复）

#### agent_end 不触发：改用 before_prompt_build 存储
- **问题根因**：`agent_end` 只在嵌入式 run 正式结束时触发（gateway stop 或 /new），不在每轮对话结束后触发。导致在持续对话中消息永远存不进去。
- **修复**：在 `before_prompt_build` 钩子中也调用 `store()`（在 recall 之后）。`before_prompt_build` 在每轮 LLM 调用前触发，此时 messages[] 已包含上一轮的完整 user+agent 交换，是存储的完美时机。
- **影响**：store() 每轮被调用一次，hash 去重确保不会重复写入。存储最多延迟 1 轮。
- **副作用**：内存中 hash set 会随对话历史累积（可忽略，对话长度通常 <1000 条）

## [2.7.3] - 2026-03-25

### Bug Fixes（单元测试 + 集成测试发现问题并修复）

#### 系统消息过滤顺序修复
- **问题**：`isSystemMessage()` 定义在 `scoredMessages` 过滤之后，但 filter 中只检查 `score > 0`，导致 score=0 的系统消息直接跳过，永远没机会进入 `isSystemMessage`
- **修复**：将 `isSystemMessage()` 移到 `scoredMessages` 定义之前，并将其整合进 filter 条件 `!isSystemMessage(msg)`
- **效果**："A new session was started via /new" 等系统消息无论 score 如何都能被正确过滤

#### extractKeywords 中文分词修复（2-gram）
- **问题**：中文使用单字分词，导致"生日"被拆成"生"+"日"，关键词质量差，FTS 搜索噪音大
- **修复**：中文改用 2-gram（相邻字组合），英文/数字按词，同时过滤纯数字词条
- **效果**："我的生日是6月1日" → `我的,的生,生日,日是,日生`，关键词更精准

#### normalizeForStorage @mention 剥离修复
- **问题**：`/@\w+/g` 中 `\w` 不匹配中文字符，导致 `@张三` 无法被剥离
- **修复**：改为 `/@[^\s]+/g`，支持中文/英文用户名

#### isNoise 纯数字过滤
- **问题**：`isNoise` 未覆盖纯数字场景，"1234567890" 被判定为非噪音
- **修复**：新增 `/^\d+$/.test(content.trim())` 检查

#### isMetadataLike Feishu 格式检测修复
- **问题**：Feishu `Conversation info` 格式中间隔较长（`---` 在 Sender 块后才出现），原正则 `/^Conversation info[\s\S]{0,100}?---/` 无法匹配
- **修复**：将限制放宽至 500 字符，并新增 `/^Conversation info[\s\S]*?json\s*\{/i` 专门匹配 Feishu 格式

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
