## v2.8.0 (2026-03-25)

### 🆕 新增功能

#### `before_dispatch` 入站预过滤
在消息进入 transcript 之前提前执行 stripInboundMetadata + 哈希精确去重拦截，减少 store 引擎压力，精确重复消息的 access_count 实时更新。

#### Gateway `/v1/embeddings` 语义召回接口
新增 `algo-memory.embeddings` Gateway Method，调用 OpenClaw Gateway 兼容端点 `/v1/embeddings`，为后续向量语义检索（FTS5 并行候选路径）留出扩展接口。

#### LLM Proxy 支持（企业网络环境）
读取 `HTTPS_PROXY` / `http_proxy` 环境变量，通过 `undici.ProxyAgent` 注入所有 LLM fetch 调用（`isCoreMemory` / `extractKeywords` / `isDuplicate` / `correct`），企业内网环境下 LLM 增强功能正常可用。

#### MCP Server 暴露
使用 `@modelcontextprotocol/sdk` 将 18 个工具暴露为标准 MCP tools，支持 stdio 传输。配置 `config.mcp.enabled: true` 开启，Cursor / Claude Desktop 等 MCP Client 可直接查询 / 操作 algo-memory 记忆。

#### `skill.json` 安装元数据
新增 `skill.json`，包含 OpenClaw 一键安装所需元数据：requirements（LLM API Key 配置提示）、recipes（复制到插件目录步骤）、configHints（UI 展示提示）。Control UI 可展示"Get your key"链接和 setup 引导。

---

### 🐛 Bug Fixes & 可靠性改进

| 修复项 | 说明 |
|--------|------|
| `before_compaction` 可靠化 | 加 2s 有限等待（`Promise.race`），防止 gateway restart 导致异步 store 竞走丢消息 |
| `after_compaction` 精简 | 改为 no-op log，compaction 后 context 已截断无需重复强化 |
| JSON.parse 容错统一 | 新增 `tryParse<T>()` 工具函数，`after_tool_call` 和 `tool_result_persist` 共用 |

---

### 📦 依赖更新
- 新增 `undici`（`ProxyAgent` 用于 LLM HTTP 代理）
- 新增 `https-proxy-agent`（备用）

### 🧹 其他
- 所有 7 个文件改动，+770 / -91 行

---

**Upgrade path：** `cd ~/.openclaw/plugins/algo-memory && git pull && npm run build`

**Full Changelog：** [CHANGELOG.md](https://github.com/xcqblue/algo-memory/blob/main/CHANGELOG.md)
