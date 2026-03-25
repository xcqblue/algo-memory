# 架构设计

algo-memory v3.0.0 的工作原理 — 设计决策、数据流与核心算法。

完整配置参考 → [CONFIG.md](CONFIG.md)

---

## 系统概述

algo-memory 是一个基于 SQLite 的**拉取式记忆系统**。不依赖外部 embedding 服务，使用 FTS5 BM25 进行检索，JavaScript 端计算评分。LLM 是可选功能，仅用于关键词提取和去重。工具通过 OpenClaw 原生 `registerTool()` API 暴露。

```
用户消息 → agent_end Hook → store()
                                │
                          MemoryBuffer（500ms 防抖 或 消息数阈值）
                                │
                          flush() → SQLite memories 表
                                         │
                              FTS5 触发器自动同步 → memories_fts
```

---

## 数据流

### 写入路径（store）

1. `agent_end` 触发，携带 `event.messages[]`
2. 每条用户消息经过：
   - 清洗：飞书数组格式 → 纯文本，去除元数据（`extractMessageText()` 剥离 `Conversation info` / `[message_id]` / `Sender` 三层元数据包裹，**仅执行一次**，O1 优化）
   - **messagePriority 评分**：命中 `coreKeywords` 得正分；无命中但内容有实质意义（≥10 权重字符）也给 1 分保底，确保非"记住xxx"类消息也能进入下一关
   - 系统消息过滤：`isSystemMessage()` 拦截 Session Startup、系统指令等来源
   - 噪声过滤：问候语 / 纯 emoji / 短查询
   - 哈希去重：`hashSet` 内存去重（O(1) 精确去重）
   - 批量 Jaccard：与同一批次候选对比（O(n log n)，O2 优化：仅一次规范化）
   - 数据库 Jaccard：与最近 5 条 DB 记忆对比（长度预过滤 + 元数据感知阈值）
3. LLM 关键词提取（批次内 1 次调用）+ 可选 LLM 去重
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
    │
    ▼
┌─ 多路召回（Multi-Path）— 2 条路径并行检索（v3.0.0 优化）─┐
│  路径1：原始 Query                                               │
│  路径2：前缀 3-token                                            │
│  每个路径分别 Trie 展开 → 不同路径保留各自展开的同义词集合      │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
FTS5 搜索（BM25 + Trie 同义词扩展）
    │
    ▼
多路结果合并（id 去重，保留首次出现）
    │
    ▼
Tier 分组 MMR 去重（v2.9.0 — core/working/peripheral 组内独立去重，v3.0.0 recall/search 统一）
    │
    ▼
scoreMemories() — tier权重 × weibullDecay × reinforcement × lengthNorm
    │
    ▼
hardMinScore 过滤（阈值 0.35）
    │
    ▼
cited_count += 1（去重后只更新一次）
    │
    ▼
prependSystemContext() — 格式化记忆注入 LLM 上下文
```

---

## FTS5 同义词扩展

algo-memory 在 Query 时使用 **Trie 树预编译展开**（v2.9.0），时间复杂度 O(query_len) 替代原来的 O(query_len × syn_count)。

### Trie 树同义词展开（v2.9.0 优化）

**脚本感知切分** + **贪心最长匹配**：
- 输入经过脚本感知切分（Latin vs CJK 分开处理）
- CJK 段在 Trie 树中查找所有命中词
- 贪心最长匹配：每个位置找最长匹配词，然后跳到该词末尾继续
- 每个命中词返回其标准词 + 所有同义词

```
输入："Mac系统崩了"
  段1: "Mac" (latin) → 直接保留
  段2: "系统崩了" (cjk)
    在 Trie 中贪心匹配：
    "系统崩了" → "崩" 命中 → 标准词="崩"，同义词=[死机,蓝屏,黑屏,宕机,崩溃]
    "系统" 未直接命中
    跳过已匹配位置，继续

  → tokens: ["Mac", "苹果电脑", "Apple", "崩", "死机", "蓝屏", "黑屏", "宕机", "崩溃", "系统"]

最后构建 FTS5 OR 查询：
  "Mac" OR "苹果电脑" OR "Apple" OR "崩" OR "死机" OR "蓝屏" OR "黑屏" OR "宕机" OR "崩溃" OR "系统"
```

### 多路召回 Trie 展开（v3.0.0 优化）

```
原始 query: "北京出差"
  路径1: "北京出差"     → Trie 展开 → "北京" OR "帝都" OR ... OR "出差" OR "商务出行" OR ...
  路径2: "北京"         → Trie 展开 → "北京" OR "帝都" OR ...

每个路径分别展开，保留各自独立的同义词集合。
```

**脚本感知切分**：Latin 与 CJK（中文）分段处理，解决"iPhone屏幕碎了"这类中英混合文本无法切分的核心问题。

```
输入："iPhone屏幕碎了"
  段1: "iPhone" (latin)
  段2: "屏幕碎了" (cjk)
    ↓
  "屏幕碎了" 在 SYNONYMS 中查找子串命中
    → "屏幕"（手机/显示相关）→ 提取
    → "碎"（损坏相关）→ 提取
    → "坏"（同义词反向查找）→ 提取
    → "iPhone"（英文直接保留）
```

### SYNONYMS 同义词表

**双向子串提取**：Query 中任意子串命中 SYNONYMS 表的 key 或 value 时，均被提取并展开为 OR 查询。

```
Query: "Mac系统崩了"
  tokens: [Mac, 系统, 崩]
    ↓
  Mac → 苹果电脑, Apple
  崩 → 死机, 蓝屏, 黑屏, 宕机, 崩溃
    ↓
扩展: "Mac" OR "苹果电脑" OR "Apple" OR
      "崩" OR "死机" OR "蓝屏" OR "黑屏" OR "宕机" OR "崩溃"
    ↓
  ✓ "苹果电脑蓝屏了" — 命中"苹果电脑" + "蓝屏"
  ✓ "Mac死机了" — 命中"Mac" + "死机"
```

### SYNONYMS 覆盖范围

| 分类 | 示例 |
|------|------|
| 人物关系 | 老婆↔媳妇↔妻子 / 老公↔丈夫 / 孩子↔儿子↔女儿 |
| 地点/出差 | 北京↔帝都 / 出差↔商务出行 / 明天↔次日 |
| 设备/故障 | iPhone↔苹果手机 / 坏↔碎↔裂↔故障 / 崩↔死机↔蓝屏↔黑屏 |
| 情感态度 | 讨厌↔不喜欢↔厌恶↔抵触 / 喜欢↔爱↔偏爱 |
| 金融/股票 | 买↔建仓↔开仓 / 卖↔清仓↔平仓↔止损↔割肉 / 加仓↔增持 |
| 宏观政策 | 美联储↔FOMC / 加息↔提息 / 降准↔MLF / CPI↔通胀 / GDP↔增速 |
| 品牌/公司 | 茅台↔600519 / 腾讯↔00700 / 苹果↔AAPL / 宁德↔300750 |
| 时间/餐饮 | 今天↔本日 / 午饭↔午餐↔中饭 / 辣↔川菜↔火锅 |

**总计：200+ 同义词条**，覆盖生活、数码、金融、宏观经济等场景。

---

## 记忆分层系统

```
tier_score = importance × multiplier(access_count)

multiplier 分段（v2.9.0 优化）：
  ac 1~10:    1 + log10(ac + 1)           （快速提升，log10 增长）
  ac 10~100:  1 + log10(11) + 0.3×(√ac - √10)  （平稳期，sqrt 增长，避免对数饱和）
  ac 100+:    min(5.0, 对数上限饱和)       （防马太效应）

示例：ac=1→1.30, ac=10→2.04, ac=50→2.6, ac=100→3.04, ac=1000→4.04

core:       access_count ≥ 10
            或 (tier_score ≥ 0.7 且 age ≤ 60 天)

peripheral: tier_score < 0.15
            或 (age > 60 天 且 tier_score < 0.7)

working:    其余情况
```

Core 记忆不会被 cleanup 自动删除。Peripheral 记忆受 **双 cutoff** 清理（同时满足 `created_at` + `last_accessed` 均超期才删除），避免"续命"问题。

### Weibull 衰减

shape > 1 意味着：**前期保护**（新记忆安全）→ 随后**加速遗忘**。

```
decay(t) = exp(-(t / scale) ^ shape)

t=0 天   → 1.000  （新鲜，无衰减）
t=30 天  → 0.894  （轻微衰减）
t=60 天  → 0.710  （中等衰减）
t=90 天  → 0.368  （显著衰减）
t=180 天 → 0.018  （接近零）
```

### Reinforcement 强化

记忆被召回时：`cited_count += 1`，`last_accessed = now`。Compaction 也会强化 core 到 access_count=10，其他到 access_count=5。

---

## OpenClaw 生命周期 Hook

v2.8.2 已接入 **15 个 OpenClaw Plugin Hook**，覆盖完整存储/召回/生命周期管理：

```
gateway_start ──► DB 健康检查（SELECT 1），确保 FTS 索引就绪
    ▼
registerHook()
    │
    ├─ registerContextEngine ──► AlgoMemoryContextEngine 实例
    │                              │
    │                              ├─ assemble() ──► recall() → AgentMessage[]
    │                              ├─ compact() ──► manualCompact() → tier 强化
    │                              └─ ingest() ──► store()
    │
    ├─ registerGatewayMethod ──► stats / search / list / health / metrics / embeddings
    │
    ├─ before_dispatch ──► 入站哈希精确去重（safeContent 后 hash，与 store 一致）
    │
    ├─ before_prompt_build ──► recall() ──► return { prependSystemContext }
    │                          store() ──► scheduleBatchWrite()（实时存储）
    │                          ⚠ trigger===heartbeat/cron 时跳过 store（系统消息不进记忆）
    │
    ├─ agent_end ──► store() ──► scheduleBatchWrite()（heartbeat/cron 时跳过）
    │
    ├─ after_tool_call ──► reinforceCitedMemories()（tryParse 安全解析）
    ├─ tool_result_persist ──► reinforceCitedMemories()（AgentMessage 结构解析，优先 JSON）
    │
    ├─ before_compaction ──►
    │   ├── memoryFlush 启用？→ 跳过 store()（避免重复存储）
    │   ├── memoryFlush 未启用？→ store(event.messages)（fire-and-forget，依赖 session_end 兜底）
    │   ├── promotePeripheralOnCompaction()
    │   └── reinforceOnCompaction()
    │
    ├─ after_compaction ──► no-op（compaction 后 context 已截断，无需重复强化）
    │
    ├─ session_start ──► gateway restart 时抢救 buffer + clearRecallCache()
    ├─ session_end ──► flushAllBuffers()（记录 reason）
    ├─ before_reset ──► 抢救 unflushed buffer，防止 /new 时消息丢失
    ├─ subagent_spawning ──► 日志
    ├─ subagent_spawned ──► 日志
    ├─ subagent_ended ──► 日志
    │
    └─ gateway_stop ──► setClosing() → flushAll() → db.close()
```

`before_prompt_build` 使用 `priority: 10`，确保在 LLM 调用之前、其他 memory 插件之后执行。

---

## LLM 模型支持

algo-memory 的 LLM **不是必选功能**。如需关键词提取或去重，配置环境变量后指定 provider：

```bash
export MINIMAX_API_KEY="your-key"
export DEEPSEEK_API_KEY="your-key"
export ZHIPU_API_KEY="your-key"   # 推荐，免费额度高
```

```json
{
  "plugins": {
    "algo-memory": {
      "llm": {
        "provider": "zhipu",
        "model": "glm-4-flash"
      }
    }
  }
}
```

> **v3.0.0 LLM 队列动态批次**：队列深度决定批次大小（10~20）和处理延迟（50~500ms），低延迟（队列短时）+ 高吞吐（队列长时）+ 批量效率（队列满时）。
> **v2.9.0 合并 LLM 调用**：`processMemory()` 单次调用同时完成 isCore 判断 + 关键词提取 + 去重，减少 50%+ API 调用。

| Provider | 别名 | 默认模型 | 推荐 |
|----------|------|---------|------|
| `minimax` | — | `abab6.5s-chat` | abab6.5s-chat |
| `deepseek` | — | `deepseek-chat` | deepseek-chat（V3）/ deepseek-reasoner（R1）|
| `kimi` | `moonshot` | `moonshot-v1-8k` | moonshot-v1-8k（性价比）/ moonshot-v1-128k |
| `zhipu` | — | `glm-4-flash` | glm-4-flash（免费）/ glm-4-plus |
| `qwen` | `dashscope`、`bailian` | `qwen-plus` | qwen-plus / qwen-max / qwen2.5-72b-instruct |
| `hunyuan` | — | `hunyuan-standard` | hunyuan-pro |
| `wenxin` | — | `ernie-3.5-8k` | ernie-4.0-8k |
| `siliconflow` | `silicon` | `Qwen/Qwen2-7B-Instruct` | SiliconFlow 聚合 50+ 模型 |
| `openai` | — | `gpt-4o-mini` | gpt-4o-mini（快）/ gpt-4o（强）|
| `anthropic` | — | `claude-3-haiku-20240307` | claude-3-haiku（快）/ claude-3-5-sonnet（强）|
| `ollama` | — | `llama2` | 本地自定义模型 |

> 完整模型列表（含 MiniMax/智谱/阿里/腾讯/百度等）见 [CONFIG.md](CONFIG.md)。

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
| `extractKeywords()` LLM 调用（动态批次，v3.0.0）| O(1) 每批次 | 队列≥20→50ms；5~20→200ms；<5→最多500ms |
| FTS5 搜索 | O(log n) | 5-20ms |
| JS 评分（n 个结果）| O(n) | < 1ms |
| Tier 分组 MMR 去重 | O(k²)，k = maxResults per group | < 1ms |
| Buffer flush（批量写入）| O(b)，b = 批次大小 | 10-50ms |

n = DB 中总记忆数（通常 < 10,000），b = buffer 大小（通常 1-20）

> v3.0.0 LLM 队列动态批次：队列深度决定批次大小（10~20）和处理延迟（50~500ms），低延迟（队列短时）+ 高吞吐（队列长时）。

---

## 关键设计决策

1. **SQLite 而非 LanceDB**：algo-memory 设计为无需外部服务的环境。SQLite 内嵌、零配置，对这个规模完全够用。

2. **FTS5 而非向量搜索**：向量搜索需要 embedding API。FTS5 BM25 提供相当的文本检索能力，无需外部依赖。

3. **分层系统而非纯时效**：纯时效（如 VectorDB 默认方案）无法区分"我老婆生日"（重要但访问不频繁）和"午饭计划"（临时性的）。tier 分层系统解决了这个问题。

4. **批量 LLM 而非逐条 LLM**：在突发场景下将 LLM API 调用减少 50-95%。关键词在同一批次消息间共享，是可接受的近似方案。

5. **Fire-and-forget compaction hooks**：`before_compaction` 和 `after_compaction` hooks 不等待 LLM 操作，避免阻塞 OpenClaw 的 compaction 流程。

6. **Workspace 隔离**：algo-memory 不直接写入 `MEMORY.md`，避免破坏 workspace plugin 的 JSON 格式。
