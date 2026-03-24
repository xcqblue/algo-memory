# 架构设计

> algo-memory 的工作原理 — 设计决策、数据流与核心算法。

---

## 系统概述

algo-memory 是一个基于 SQLite 的**拉取式记忆系统**。不依赖外部 embedding 服务，使用 FTS5 BM25 进行检索，JavaScript 端计算评分。LLM 是可选功能，仅用于关键词提取和去重。不使用 MCP，工具通过 OpenClaw 原生 `registerTool()` API 暴露。

```
用户消息
    │
    ▼
agent_end Hook
    │
    ▼
store(AgentId, messages[])
    │
    ├─ 阶段1（同步）：过滤噪声/重复/哈希 → 候选列表[]
    │
    ├─ 阶段2（异步）：批量 LLM — extractKeywords() × 1
    │                   deduplicateByLLM() × n（如已启用）
    │
    └─ 阶段3（同步）：scheduleBatchWrite() → MemoryBuffer
                                            │
                                            ▼（500ms 防抖 或 消息数阈值）
                                      flushMemoryBuffer()
                                            │
                                            ▼
                                     SQLite memories 表
                                            │
                                            └─► FTS5 memories_fts（通过触发器）
```

---

## 数据流

### 写入路径（store）

1. `agent_end` 触发，携带 `event.messages[]`
2. 每条用户消息经过：
   - 清洗：飞书数组格式 → 纯文本，去除元数据
   - 噪声过滤：问候语 / 纯 emoji / 短查询
   - 哈希去重：`hashSet` 内存去重
   - 批量 Jaccard：与同一批次候选对比
   - 数据库 Jaccard：与最近 5 条 DB 记忆对比
3. 阶段2：LLM 关键词提取（批次内 1 次调用）+ 可选 LLM 去重
4. 计算 tier：`importance × (1 + log10(access_count + 1))`
5. 进入 `MemoryBuffer`（500ms 防抖）
6. 触发 flush：批量 INSERT 到 SQLite + FTS5 触发器自动同步

### 检索路径（recall）

```
before_prompt_build 触发
    │
    ▼
提取最近 3 条用户消息 → query 字符串
    │
    ▼
shouldRetrieve(query, config, sessionDedup)
    │  - forceKeywords 检查（优先于 META_PATTERNS）
    │  - META_PATTERNS 跳过
    │  - 长度门槛（中文 ≥6，英文 ≥15）
    │  - sessionDedup（30秒内相似度 ≥0.75 → 跳过）
    ▼
FTS5 搜索（BM25）
    │
    ▼
scoreMemories() — tier权重 × weibullDecay × reinforcement × lengthNorm
    │
    ▼
mmrDeduplicate() — λ×相关性 - (1-λ)×多样性
    │
    ▼
hardMinScore 过滤（阈值 0.35）
    │
    ▼
cited_count += 1（仅对返回的记忆）
    │
    ▼
prependSystemContext() — 格式化记忆注入 LLM 上下文
```

---

## 记忆分层系统

```
tier score = importance × (1 + log10(access_count + 1))

core:       access_count ≥ 10
            或 (score ≥ 0.7 且 age ≤ 60 天)

peripheral: score < 0.15
            或 (age > 60 天 且 score < 0.7)

working:    其余情况
```

Core 记忆不会被 cleanup 自动删除。Peripheral 记忆受 Weibull 衰减影响，超过 `cleanupDays` 未被访问则清理。

---

## 时间衰减

### Weibull 衰减（shape=1.5, scale=90 天）

```
decay(t) = exp(-(t / scale) ^ shape)

t=0 天   → decay = 1.000  （新鲜，无衰减）
t=30 天  → decay = 0.894  （轻微衰减）
t=60 天  → decay = 0.710  （中等衰减）
t=90 天  → decay = 0.368  （显著衰减）
t=180 天 → decay = 0.018  （接近零）
```

shape > 1 意味着：**前期保护**（新记忆安全）→ 随后**加速遗忘**。

### Reinforcement 强化

记忆被召回（出现在 recall 结果中）时：
- `cited_count += 1`
- `last_accessed = now`

Compaction 也会强化：core 记忆将 access_count 提升到 10，其他提升到 5。

---

## OpenClaw 生命周期 Hook

### Hook 事件流

```
gateway_start
    ▼
registerHook()
    │
    ├─ before_prompt_build ──► recall() ──► prependSystemContext()
    │
    ├─ agent_end ──► store() ──► scheduleBatchWrite()
    │
    ├─ before_compaction ──► store(sessionFile) ──► promotePeripheral()
    │                       └─► reinforceOnCompaction()
    │
    ├─ after_compaction ──►（仅记录日志，强化在 before_compaction 完成）
    │
    ├─ after_tool_call ──► reinforceCitedMemories(algo_memory_search 结果)
    │
    └─ gateway_stop ──► flushAll() ──► db.close()
```

### 上下文优先级

`api.prependSystemContext()` 用于注入记忆。`before_prompt_build` 中的 `priority: 10` 确保 algo-memory 在其他 memory 插件之后、LLM 调用之前执行。

---

## LLM 模型支持

### 国内模型

| Provider | 别名 | 默认模型 | 推荐 |
|----------|------|---------|------|
| `minimax` | — | `abab6.5s-chat` | abab6.5s-chat（推荐）/ abab6.5g-chat |
| `deepseek` | — | `deepseek-chat` | deepseek-chat（V3）/ deepseek-reasoner（R1推理）|
| `kimi` | `moonshot` | `moonshot-v1-8k` | moonshot-v1-8k（性价比）/ moonshot-v1-128k（长上下文）|
| `zhipu` | — | `glm-4-flash` | glm-4-flash（免费）/ glm-4-plus（最强）|
| `qwen` | `dashscope`、`bailian` | `qwen-plus` | qwen-plus（推荐）/ qwen-max（最强）/ qwen2.5-72b-instruct |
| `hunyuan` | — | `hunyuan-standard` | hunyuan-pro（腾讯混元 Pro）|
| `wenxin` | — | `ernie-3.5-8k` | ernie-4.0-8k（百度文心）|
| `siliconflow` | `silicon` | `Qwen/Qwen2-7B-Instruct` | SiliconFlow 聚合 50+ 模型 |

### 国外模型

| Provider | 默认模型 | 推荐 |
|----------|---------|------|
| `openai` | `gpt-4o-mini` | gpt-4o-mini（快）/ gpt-4o（强）|
| `anthropic` | `claude-3-haiku-20240307` | claude-3-haiku（快）/ claude-3-5-sonnet（强）|
| `ollama` | `llama2` | 本地自定义模型 |

---

## 错误处理策略

| 场景 | 策略 |
|------|------|
| LLM API 失败 | 指数退避重试最多 3 次 |
| DB 写入失败 | 记录错误，跳过该项目，继续执行 |
| FTS 不可用 | 降级为 `LIKE '%term%'` 查询 |
| 消息格式无效 | 捕获异常，跳过该消息 |
| DB 关闭时 buffer 还在 flush | `flushing` 互斥锁防止竞争 |

---

## 性能特征

| 操作 | 复杂度 | 典型延迟 |
|------|--------|---------|
| `store()` 阶段1（同步过滤）| O(n) | < 1ms |
| `extractKeywords()` LLM 调用 | O(1) 每批次 | 500-2000ms |
| FTS5 搜索 | O(log n) | 5-20ms |
| JS 评分（n 个结果）| O(n) | < 1ms |
| MMR 去重 | O(k²)，k = maxResults | < 1ms |
| Buffer flush（批量写入）| O(b)，b = 批次大小 | 10-50ms |

n = DB 中总记忆数（通常 < 10,000）
b = buffer 大小（通常 1-20）

---

## 关键设计决策

1. **SQLite 而非 LanceDB**：algo-memory 设计为无需外部服务的环境。SQLite 内嵌、零配置，对这个规模完全够用。

2. **FTS5 而非向量搜索**：向量搜索需要 embedding API。FTS5 BM25 提供相当的文本检索能力，无需外部依赖。

3. **分层系统而非纯时效**：纯时效（如 VectorDB 默认方案）无法区分"我老婆生日"（重要但访问不频繁）和"午饭计划"（临时性的）。tier 分层系统解决了这个问题。

4. **批量 LLM 而非逐条 LLM**：在突发场景下将 LLM API 调用减少 50-95%。关键词在同一批次消息间共享，是可接受的近似方案。

5. **Fire-and-forget compaction hooks**：`before_compaction` 和 `after_compaction` hooks 不等待 LLM 操作，避免阻塞 OpenClaw 的 compaction 流程。

6. **Workspace 隔离**：algo-memory 不直接写入 `MEMORY.md`，避免破坏 workspace plugin 的 JSON 格式。
