# 安装指南

## 环境要求

- Node.js >= 20.0.0
- SQLite3（大多数系统已预装）

---

## 快速开始（3分钟）

```bash
# 1. 克隆并安装
git clone https://github.com/xcqblue/algo-memory.git ~/.openclaw/extensions/algo-memory
cd ~/.openclaw/extensions/algo-memory && npm install && npm run build

# 2. 启用插件（切换内存插槽）
openclaw plugins enable algo-memory

# 3. 重启
openclaw gateway restart
```

---

## 完整安装

### 1. 克隆插件

```bash
mkdir -p ~/.openclaw/extensions
git clone https://github.com/xcqblue/algo-memory.git ~/.openclaw/extensions/algo-memory
```

### 2. 安装依赖

```bash
cd ~/.openclaw/extensions/algo-memory
npm install
npm run build
```

> ⚠️ **必须执行 `npm run build`**，否则启动会报错。

### 3. 启用插件

algo-memory 和内置 memory-core 共用同一插槽，需要切换：

```bash
openclaw plugins enable algo-memory
```

> ⚠️ **每次 OpenClaw 重启后都需要执行此命令**

### 4. 配置（如需自定义）

编辑 `~/.openclaw/openclaw.json`，在 `plugins.entries.algo-memory.config` 中添加配置：

```json
{
  "enabled": true,
  "autoCapture": true,
  "autoRecall": true,
  "maxResults": 5,
  "coreKeywords": ["记住", "重要", "别忘"]
}
```

完整配置项见 [CONFIG.md](CONFIG.md)

### 5. 重启

```bash
openclaw gateway restart
```

---

## 验证安装

```bash
openclaw logs | grep algo-memory
```

预期输出：
```
[algo-memory] 数据库初始化: ~/.openclaw/state/algo-memory/memories.db
[algo-memory] 每轮最多写入: 3 条
```

---

## 运行测试

```bash
npm test
```

---

## 常见问题

### Q: npm run build 报错？

确保 Node.js >= 20.0.0：
```bash
node --version
```

### Q: FTS5 警告？

正常。某些环境不支持 FTS5，会自动降级为 LIKE 搜索，不影响功能。

### Q: 如何查看数据库？

```bash
sqlite3 ~/.openclaw/state/algo-memory/memories.db
sqlite> .tables
sqlite> SELECT id, tier, substr(content, 1, 50) FROM memories LIMIT 5;
```

### Q: 启动报错 `service.start is not a function`？

确保执行了 `npm run build`。

### Q: 两个 memory 插件冲突？

algo-memory 和内置 memory-core 共用同一插槽，同时只可启用一个：

```bash
openclaw plugins enable algo-memory  # 切换到 algo-memory
openclaw plugins disable memory-core  # 可选：禁用内置
```

---

## 卸载

```bash
# 1. 禁用插件
openclaw plugins disable algo-memory

# 2. 删除文件
rm -rf ~/.openclaw/extensions/algo-memory
rm -rf ~/.openclaw/state/algo-memory

# 3. 重启
openclaw gateway restart
```
