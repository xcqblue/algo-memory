#!/bin/bash
# algo-memory 一键更新脚本
# 用法: ./update.sh

set -e

echo "=========================================="
echo "  algo-memory 一键更新"
echo "=========================================="

PLUGIN_DIR="$HOME/.openclaw/extensions/algo-memory"

# 检查目录是否存在
if [ ! -d "$PLUGIN_DIR" ]; then
    echo "❌ 插件目录不存在: $PLUGIN_DIR"
    echo "请先安装插件: https://github.com/xcqblue/algo-memory"
    exit 1
fi

cd "$PLUGIN_DIR"

# 1. 备份旧版本
echo ""
echo "📦 [1/4] 备份旧版本..."
if [ -d "dist" ]; then
    rm -rf dist.bak 2>/dev/null || true
    cp -r dist dist.bak
    echo "   备份完成 (dist.bak)"
else
    echo "   无旧版本可备份"
fi

# 2. 拉取最新代码
echo ""
echo "📥 [2/4] 拉取最新代码..."
git fetch origin
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "   ✅ 已是最新版本，无需更新"
    exit 0
fi

echo "   发现新版本: $REMOTE"
git pull origin main
echo "   拉取完成"

# 3. 编译
echo ""
echo "🔨 [3/4] 编译中..."
npm run build

# 检查编译结果
if [ ! -f "dist/index.js" ]; then
    echo "   ❌ 编译失败，恢复旧版本..."
    rm -rf dist
    mv dist.bak dist
    echo "   已恢复，请检查错误"
    exit 1
fi
echo "   编译成功 ✅"

# 4. 重启
echo ""
echo "🔄 [4/4] 重启 OpenClaw..."
openclaw gateway restart
echo "   重启命令已执行 ✅"

# 清理备份
rm -rf dist.bak

echo ""
echo "=========================================="
echo "  ✅ 更新完成！"
echo "=========================================="
echo ""
echo "查看日志: openclaw logs | grep algo-memory"
echo "运行测试: npm test"
