# Architecture

> How algo-memory works — design decisions, data flow, and key algorithms.

---

## System Overview

algo-memory is a **pull-based memory system** built on SQLite. It does not require an external embedding service — instead it uses FTS5 BM25 for retrieval and JavaScript-side scoring. LLM is optional and used only for keyword extraction and dedup. MCP is not used — tools are exposed via OpenClaw's native `registerTool()` API.

```
User Message
    │
    ▼
agent_end Hook
    │
    ▼
store(AgentId, messages[])
    │
    ├─ Phase 1 (sync): filter noise/duplicate/hash → candidates[]
    │
    ├─ Phase 2 (async): batch LLM — extractKeywords() × 1
    │                   deduplicateByLLM() × n (if enabled)
    │
    └─ Phase 3 (sync): scheduleBatchWrite() → MemoryBuffer
                                            │
                                            ▼ (500ms delay or messageCount threshold)
                                      flushMemoryBuffer()
                                            │
                                            ▼
                                     SQLite memories table
                                            │
                                            └─► FTS5 memories_fts (via triggers)
```

---

## Data Flow

### Capture Path（store）

1. `agent_end` fires with `event.messages[]`
2. Each user message is:
   - Cleaned: Feishu array format → plain text, metadata stripped
   - Noise filtered: greetings / emoji-only / short queries
   - Hash checked: `hashSet` in-memory deduplication
   - Batch Jaccard: checked against same-batch candidates
   - DB Jaccard: checked against last 5 DB memories
3. Phase 2: LLM keyword extraction (1 call for all batch) + optional LLM dedup
4. Tier computed: `importance × (1 + log10(access_count + 1))`
5. Queued to `MemoryBuffer` (500ms debounce)
6. On flush: batch INSERT to SQLite + FTS5 trigger auto-sync

### Retrieval Path（recall）

```
before_prompt_build fires
    │
    ▼
Extract last 3 user messages → query string
    │
    ▼
shouldRetrieve(query, config, sessionDedup)
    │  - forceKeywords check (BEFORE META_PATTERNS)
    │  - META_PATTERNS skip
    │  - Length gate (CJK ≥6, EN ≥15)
    │  - sessionDedup (similarity ≥0.75 in 30s → skip)
    ▼
FTS5 search (BM25)
    │
    ▼
scoreMemories() — tier weight × recency × reinforcement × lengthNorm
    │
    ▼
mmrDeduplicate() — λ×relevance - (1-λ)×diversity
    │
    ▼
hardMinScore filter (threshold 0.35)
    │
    ▼
cited_count += 1 (for returned items only)
    │
    ▼
prependSystemContext() — formatted memories injected into LLM context
```

---

## Memory Tier System

```
tier score = importance × (1 + log10(access_count + 1))

core:       access_count ≥ 10
            OR (score ≥ 0.7 AND age ≤ 60 days)

peripheral: score < 0.15
            OR (age > 60 days AND score < 0.7)

working:    everything in between
```

Core memories are never auto-deleted by cleanup. Peripheral memories are subject to Weibull decay and cleanup after `cleanupDays` of no access.

---

## Time Decay

### Weibull Decay（shape=1.5, scale=90 days）

```
decay(t) = exp(-(t / scale) ^ shape)

t=0 days   → decay = 1.000  (fresh, no decay)
t=30 days  → decay = 0.894  (minimal decay)
t=60 days  → decay = 0.710  (moderate decay)
t=90 days  → decay = 0.368  (significant decay)
t=180 days → decay = 0.018  (near zero)
```

shape > 1 means: **early protection** (new memories are safe) then **accelerated forgetting** over time.

### Reinforcement

When a memory is cited (appears in recall results):
- `cited_count += 1`
- `last_accessed = now`

Reinforcement factor: `1.0 + (access_count - 1) × 0.5`, capped at `3.0×`.

---

## OpenClaw Lifecycle Hooks

### Hook Event Flow

```
gateway_start
    │
    ▼
registerHook()
    │
    ├─ before_prompt_build ──► recall() ──► prependSystemContext()
    │
    ├─ agent_end ──► store() ──► scheduleBatchWrite()
    ├─ before_compaction ──► store(sessionFile) ──► promotePeripheral()
    │                       └─► reinforceOnCompaction()
    │
    ├─ after_compaction ──► (logged, reinforcement done in before_compaction)
    │
    ├─ after_tool_call ──► reinforceCitedMemories(algo_memory_search results)
    │
    ├─ llm_output ──► recordLlmUsage(token stats)
    │
    └─ gateway_stop ──► flushAll() ──► db.close()
```

> `session_start` / `session_end` 是 Planned 事件，当前 OpenClaw 版本不触发，实际由 `agent_end` 统一处理 capture + 会话快照。

### Context Priority

`api.prependSystemContext()` is used to inject memories. The `priority: 10` in `before_prompt_build` ensures algo-memory runs after other memory plugins but before the LLM call.

---

## Workspace Integration

algo-memory 写入 workspace 的文件：

| Path | Purpose | Format |
|------|---------|--------|
| `memory/algo-memory/YYYY-MM-DD.md` | Core memory sync | **已禁用（v2.6.0）** |

**为什么不直接写 workspace 文件？**
workspace plugin 使用 JSON 格式写入 `MEMORY.md`，algo-memory 直接写 Markdown 会导致格式冲突。v2.6.0 起 `syncCoreToWorkspace` 改为禁用状态，如需导出使用 `algo_memory_export` 工具。

## LLM Providers

Supported providers (set via `config.llm.provider`):

| Provider | Env Variable | Model |
|----------|-------------|-------|
| MiniMax | `MINIMAX_API_KEY` | `auto` |
| DeepSeek | `DEEPSEEK_API_KEY` | `auto` |
| Kimi | `KIMI_API_KEY` | `auto` |
| 阿里百炼 | `DASHSCOPE_API_KEY` | `auto` |
| OpenAI | `OPENAI_API_KEY` | `auto` |
| Anthropic | `ANTHROPIC_API_KEY` | `auto` |
| 智谱 GLM | `ZHIPU_API_KEY` | `auto` |
| Ollama | `OLLAMA_BASE_URL` | `auto` |
| SiliconFlow | `SILICONFLOW_API_KEY` | `auto` |

---

## Error Handling Strategy

| Scenario | Strategy |
|----------|---------|
| LLM API failure | Retry up to 3 times with exponential backoff |
| DB write failure | Log error, skip this item, continue |
| FTS unavailable | Fallback to `LIKE '%term%'` query |
| Invalid message format | Catch exception, skip this message |
| Buffer flush during DB close | `flushing` mutex prevents race |

---

## Performance Characteristics

| Operation | Complexity | Typical Latency |
|-----------|-----------|----------------|
| `store()` Phase 1 (sync filter) | O(n) | < 1ms |
| `extractKeywords()` LLM call | O(1) per batch | 500-2000ms |
| FTS5 search | O(log n) | 5-20ms |
| JS scoring (n results) | O(n) | < 1ms |
| MMR dedup | O(k²) where k = maxResults | < 1ms |
| Buffer flush (batch write) | O(b) where b = batch size | 10-50ms |

n = total memories in DB (typically < 10,000)
b = buffer size (typically 1-20)

---

## Key Design Decisions

1. **SQLite over LanceDB**: algo-memory is designed for environments without external services. SQLite is embedded, zero-config, and sufficient for text retrieval at this scale.

2. **FTS5 over vector search**: Vector search requires an embedding API. FTS5 BM25 provides comparable text retrieval without external dependencies.

3. **Tier system over pure recency**: Pure recency (e.g., VectorDB's default) cannot distinguish "my wife's birthday" (important, infrequent access) from "lunch plans" (ephemeral). The tier system handles this.

4. **Batch LLM over per-message LLM**: Reduces LLM API calls by 50-95% in burst scenarios. Keywords are shared across batch messages as an acceptable approximation.

5. **Fire-and-forget compaction hooks**: `before_compaction` and `after_compaction` hooks do not await LLM operations to avoid blocking OpenClaw's compaction pipeline.

6. **Workspace isolation**: algo-memory does not write to MEMORY.md directly to avoid corrupting the workspace plugin's JSON format.
