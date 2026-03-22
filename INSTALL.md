# 安装指南

## 环境要求

- Node.js >= 20.0.0
- SQLite3（大多数系统已预装）

## 安装步骤

### 1. 克隆插件

```bash
mkdir -p ~/.openclaw/extensions
git clone https://github.com/xcqblue/algo-memory.git ~/.openclaw/extensions/algo-memory
```

### 2. 安装依赖并构建

```bash
cd ~/.openclaw/extensions/algo-memory
npm install
npm run build
```

> ⚠️ **必须执行 `npm run build`**：OpenClaw 加载插件时要求 `MemoryPlugin` 类包含 `id` 和 `start` 属性，未构建的源码缺少这些，直接启动会报错。

### 3. 配置插件

algo-memory 需要独占 `memory` slot（与内置 `memory-core` 冲突），需要显式加入 `plugins.allow`：

```bash
# 禁用内置 memory-core
openclaw plugins disable memory-core

# 将 memory slot 指向 algo-memory
openclaw config set "plugins.slots.memory" "algo-memory"
```

然后编辑 `~/.openclaw/openclaw.json`，在 `plugins` 部分添加 `allow` 列表：

```json
"plugins": {
  "allow": ["algo-memory", "feishu", "minimax-portal-auth"],
  "entries": {
    "algo-memory": {
      "enabled": true,
      "config": {
        // === 默认开启的功能（mcp 除外）===
        "autoCapture": true,
        "autoRecall": true,
        "recencyDecay": true,
        "smartDedup": true,
        "noiseFilter": { "enabled": true, "skipGreetings": true, "skipCommands": true },
        "adaptiveRetrieval": { "enabled": true, "sessionDedup": { "enabled": true } },
        "cited_count": true,  // 召回后自动更新引用计数（无配置项，始终生效）
        "supplementStore": true,  // 每次 prompt 构建时自动补充存储（无配置项，始终生效）
        "feedback": { "enabled": true },
        "weibullDecay": { "enabled": true },
        "reinforcement": { "enabled": true },
        "mmr": { "enabled": true },
        "lengthNorm": { "enabled": true },
        "hardMinScore": { "enabled": true },
        "tier": { "enabled": true },
        "sessionSummary": { "enabled": true },

        // === LLM 相关（默认关闭，无 API Key 时请保持关闭）===
        // ⚠️ 如需开启，请先配置 llm.apiKey。首次启动时若未配置，会输出警告。
        "useLlmForCore": false,
        "useLlmForExtract": false,
        "useLlmForDedup": false,

        // === 以下默认关闭 ===
        "mcp": { "enabled": false }
      }
    },
    "memory-core": {
      "enabled": false
    }
  }
}
```

### 4. 启用插件（关键步骤）

algo-memory 与内置 memory-core 共用同一内存插槽，必须显式切换：

```bash
openclaw plugins enable algo-memory
```

此命令会自动将 memory 插槽切换到 algo-memory，并禁用其他同类插件（memory-core、memory-lancedb）。

> ⚠️ **每次 OpenClaw 重启后都需要执行此命令**。目前 OpenClaw 尚未提供绕过独占插槽限制的机制，请留意后续版本更新。

### 5. 重启 OpenClaw

```bash
openclaw gateway restart
```

## 验证安装

```bash
openclaw logs | grep algo-memory
```

预期输出：
```
[algo-memory] 数据库初始化: ~/.openclaw/state/algo-memory/memories.db
[algo-memory] 每轮最多写入: 3 条
```

如果看到以下警告，说明 FTS5 不可用（搜索自动降级为 LIKE，不影响基本功能）：
```
[algo-memory] FTS5 不可用，搜索将降级为 LIKE
```

## 运行测试

```bash
npm test
```

当前共 **41 个单元测试**，覆盖所有纯算法函数。

## 配置

详见 [CONFIG.md](CONFIG.md)。

## 卸载

```bash
rm -rf ~/.openclaw/extensions/algo-memory
rm -rf ~/.openclaw/state/algo-memory
openclaw gateway restart
```

## 常见问题

### Q: npm run build 报错？

确保 Node.js >= 20.0.0：
```bash
node --version
```

### Q: FTS5 警告是什么意思？

正常。某些环境不支持 FTS5，插件会自动降级为 LIKE 搜索，记忆功能不受影响。

### Q: 如何查看数据库内容？

```bash
sqlite3 ~/.openclaw/state/algo-memory/memories.db
sqlite> .tables
memories  memories_fts
sqlite> SELECT id, tier, importance, substr(content, 1, 50) FROM memories LIMIT 5;
```

### Q: 如何确认插件已正常加载？

```bash
openclaw logs | grep "数据库初始化"
```
确认出现数据库路径和"每轮最多写入"日志。

### Q: 启动时报 `TypeError: Cannot read properties of undefined (reading 'trim')` 或 `service.start is not a function`？

确保执行了 `npm run build`。未构建时源码缺少 OpenClaw  registry 要求的 `id` 和 `start` 属性。

### Q: 两个 memory 插件同时安装会怎样？

algo-memory 和内置 `memory-core` 共用同一内存插槽（`memory`），同时只可启用一个。

**解决方法：** 执行 `openclaw plugins enable algo-memory` 即可自动完成切换（禁用 memory-core、将插槽指向 algo-memory）。每次重启 OpenClaw 后均需重新执行此命令。
