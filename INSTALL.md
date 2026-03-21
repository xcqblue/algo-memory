# 📖 安装指南

## 环境要求

| 项目 | 最低 | 推荐 |
|------|------|------|
| Node.js | >= 20.0.0 | >= 24.0.0 |
| 内存 | 256MB | 512MB+ |
| 磁盘 | 50MB | 100MB+ |

---

## 安装步骤

### 1. 安装系统依赖

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y build-essential libsqlite3-dev python3

# CentOS/RHEL
sudo yum install -y gcc-c++ make python3 sqlite-devel

# macOS
xcode-select --install
```

### 2. 克隆插件

```bash
mkdir -p ~/.openclaw/extensions
git clone https://github.com/xcqblue/algo-memory.git ~/.openclaw/extensions/algo-memory
```

### 3. 安装依赖并构建

```bash
cd ~/.openclaw/extensions/algo-memory
npm install
npm run build
```

> ⚠️ 必须执行 `npm run build`，插件是 TypeScript 源码，不构建无法运行。

### 4. 重启 OpenClaw

```bash
openclaw gateway restart
```

---

## 验证安装

```bash
# 查看日志
openclaw logs | grep algo-memory
```

预期输出：
```
[algo-memory] 数据库初始化: ~/.openclaw/state/algo-memory/memories.db
[algo-memory] 每轮最多写入: 10 条
[algo-memory] 插件已就绪, 工具数: 13, 自动捕获: true, 自动召回: true
```

如果看到以下警告，说明 FTS5 不可用（不影响基本功能，搜索会降级为 LIKE）：
```
[algo-memory] FTS5 不可用，使用 LIKE 备用
```

---

## 运行测试

```bash
npm test
```

当前共 **41 个单元测试**，涵盖所有纯算法函数（Jaccard / Weibull 衰减 / 关键词提取 / 噪声过滤 / 层级晋升 / Token 估算等）。

---

## 卸载

```bash
rm -rf ~/.openclaw/extensions/algo-memory
rm -rf ~/.openclaw/state/algo-memory
openclaw gateway restart
```

---

## 常见问题

### Q: npm install 报错？

```bash
# 确保安装了编译工具
sudo apt-get install build-essential
```

### Q: npm run build 报错？

确保 Node.js 版本 >= 20.0.0：
```bash
node --version
```

### Q: 如何查看数据库？

```bash
sqlite3 ~/.openclaw/state/algo-memory/memories.db
```

### Q: 插件启动后 FTS5 警告？

正常。sql.js 在某些环境不支持 FTS5，插件会自动降级为 LIKE 搜索，记忆功能不受影响。

### Q: 如何确认插件已正常加载？

```bash
openclaw logs | grep "algo-memory"
```
确认日志中出现 `工具数: 13` 和 `插件已就绪`。
