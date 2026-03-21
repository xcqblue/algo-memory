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

> ⚠️ 必须执行 `npm run build`，插件是 TypeScript 源码，不构建无法运行。

### 3. 重启 OpenClaw

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

### Q: 两个 memory 插件同时安装会怎样？

algo-memory 和 memos-local 使用相同的 slot（`memory`），同时只可启用一个，否则后加载的会覆盖先加载的。
