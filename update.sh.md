# 更新脚本说明

## 使用方法

```bash
cd ~/.openclaw/extensions/algo-memory
./update.sh
```

## 功能特点

| 特点 | 说明 |
|------|------|
| **一键更新** | 只需运行 `./update.sh` |
| **自动备份** | 更新前自动备份旧版本 |
| **编译检查** | 编译失败自动回滚 |
| **增量更新** | 只拉取变更的文件 |

## 更新流程

```
1. 备份旧版本 (dist.bak)
2. 拉取最新代码 (git pull)
3. 编译新版本 (npm run build)
4. 检查编译结果
   ├── 成功 → 重启 OpenClaw
   └── 失败 → 自动回滚旧版本
5. 清理备份
```

## 常见问题

### Q: 更新失败怎么办？

脚本会自动回滚，无需手动操作。

### Q: 如何查看当前版本？

```bash
cd ~/.openclaw/extensions/algo-memory
git log --oneline -1
```

### Q: 如何回滚到旧版本？

```bash
cd ~/.openclaw/extensions/algo-memory
git checkout <版本号>
npm run build
openclaw gateway restart
```

### Q: 提示"已是最新版本"？

说明没有新版本更新，无需操作。

## 手动更新（备选）

如果脚本不可用，可以手动更新：

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
