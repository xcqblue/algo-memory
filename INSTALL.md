# 安装指南

## 环境要求

- **Node.js** >= 20.0.0
- **SQLite3**（大多数系统已预装）

---

## 快速开始（3 步）

```bash
# 1. 克隆并安装
git clone https://github.com/xcqblue/algo-memory.git ~/.openclaw/extensions/algo-memory
cd ~/.openclaw/extensions/algo-memory && npm install && npm run build

# 2. 启用插件（algo-memory 与内置 memory-core 共用同一插槽）
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

algo-memory 与内置 memory-core 共用同一插槽，需要切换：

```bash
openclaw plugins enable algo-memory
```

### 4. 配置（如需自定义）

复制 `config.default.json` 中的内容，添加到 `~/.openclaw/openclaw.json` 的 `plugins.entries.algo-memory.config` 下。

示例：

```json
{
  "plugins": {
    "algo-memory": {
      "autoCapture": true,
      "autoRecall": true,
      "maxResults": 5,
      "coreKeywords": ["记住", "重要", "别忘"]
    }
  }
}
```

完整配置项 → [CONFIG.md](CONFIG.md)

### 5. 重启

```bash
openclaw gateway restart
```

---

## 验证安装

```bash
openclaw logs | grep algo-memory
```

**预期输出：**

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

## 更新插件

### 一键更新（推荐）

```bash
cd ~/.openclaw/extensions/algo-memory
./update.sh
```

脚本自动完成：备份 → git pull → 编译 → 重启 OpenClaw。编译失败时自动回滚到旧版本。

### 手动更新

```bash
cd ~/.openclaw/extensions/algo-memory

# 备份
cp -r dist dist.bak

# 更新
git pull

# 编译
npm run build

# 重启
openclaw gateway restart
```

---

## 常见问题

### npm run build 报错

确保 Node.js >= 20.0.0：

```bash
node --version
```

### FTS5 警告

正常。某些环境不支持 FTS5，会自动降级为 `LIKE` 查询，不影响功能。

### 如何查看数据库

```bash
sqlite3 ~/.openclaw/state/algo-memory/memories.db

sqlite> .tables
sqlite> SELECT id, tier, substr(content, 1, 50) FROM memories LIMIT 5;
```

### 启动报错 `service.start is not a function`

确保执行了 `npm run build`。

### 两个 memory 插件冲突

algo-memory 与内置 memory-core 共用同一插槽，不可同时启用：

```bash
openclaw plugins enable algo-memory   # 切换到 algo-memory
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
