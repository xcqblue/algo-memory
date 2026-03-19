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

### 3. 安装依赖

```bash
cd ~/.openclaw/extensions/algo-memory
npm install
```

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
[algo-memory] 数据库初始化: ~/.openclaw/workspace/algo-memory/memories.db
[algo-memory] FTS5 全文搜索已启用
[algo-memory] 插件注册完成, 工具数: 11, 自动启用: true
```

---

## 卸载

```bash
rm -rf ~/.openclaw/extensions/algo-memory
openclaw gateway restart
```

---

## 常见问题

### Q: npm install 报错？

```bash
# 确保安装了编译工具
sudo apt-get install build-essential
```

### Q: 如何查看数据库？

```bash
sqlite3 ~/.openclaw/workspace/algo-memory/memories.db
```
