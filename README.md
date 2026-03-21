# algo-memory

> OpenClaw 记忆管理插件 — 纯算法召回，无需 LLM API

## 核心特点

| 特点 | 说明 |
|------|------|
| **零 API 费用** | 纯算法（Jaccard + BM25）完成召回，LLM 完全可选 |
| **自动存储** | 每次对话自动提取用户消息，无需手动管理 |
| **三层晋升** | peripheral → working → core，按访问频率自动升级/降级 |
| **全文搜索** | FTS5 全文索引，支持中文（无外部依赖） |
| **Token 节约** | 召回结果按 importance 优先级注入，强制上限 1500 tokens |

---

## 工作流程

```
用户消息 → 文本归一化 → 噪声过滤 → 精确查重 → 智能去重 → 核心判断 → 层级晋升 → 写入数据库
                                                              ↓
                                                    定时清理（自动）
```

```
用户提问 → 全文搜索（FTS5/LIKE）→ 时间衰减评分 → MMR去重 → Token上限注入 → 返回记忆
```

---

## 工具（13 个）

| 工具 | 说明 |
|------|------|
| `algo_memory_list` | 列出记忆（支持 limit + offset 分页） |
| `algo_memory_search` | 全文搜索（FTS5 优先，LIKE 兜底） |
| `algo_memory_stats` | 查看统计（total / core / working / peripheral） |
| `algo_memory_get` | 获取单条记忆详情 |
| `algo_memory_delete` | 删除单条记忆 |
| `algo_memory_delete_bulk` | 批量删除（原子事务） |
| `algo_memory_update` | 更新记忆内容（自动重新判断重要性） |
| `algo_memory_clear` | 清空记忆（可选保留 core 层） |
| `algo_memory_import` | 批量导入记忆（事务保护） |
| `algo_memory_export` | 导出为 JSON（默认最多 1000 条） |
| `algo_memory_session` | 获取当前 Session 临时记忆 |
| `algo_memory_session_add` | 写入 Session 临时记忆 |
| `algo_memory_metrics` | 查看运行时指标（LLM 错误次数、DB 错误次数） |

---

## 存储层级

```
core       — 重要、频繁访问的记忆（权重 ×1.5）
working    — 普通对话记忆（权重 ×1.0）
peripheral — 边缘记忆，可被自动清理（权重 ×0.5）
general    — 无层级标签的普通记忆
```

---

## 性能与安全

| 方面 | 措施 |
|------|------|
| 写入性能 | 500ms debounce 批量持久化，高频写入不卡 |
| 数据安全 | 每 30s 强制 flush，崩溃最多丢 30s 数据 |
| 并发安全 | PID 文件检测，防止插件重复加载 |
| SQL 安全 | 所有用户输入走参数化查询，无注入风险 |
| Session 隔离 | Agent 级别隔离，支持跨 Agent 可见配置 |

---

## 安装

详见 [INSTALL.md](INSTALL.md)，完整步骤：

```bash
git clone https://github.com/xcqblue/algo-memory.git ~/.openclaw/extensions/algo-memory
cd ~/.openclaw/extensions/algo-memory
npm install && npm run build
openclaw gateway restart
```

## 配置

详见 [CONFIG.md](CONFIG.md)。

## 架构设计

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 流程图

详见 [FLOW.md](FLOW.md)。

---

## 对比 memos-local

| 特性 | algo-memory | memos-local |
|------|-------------|-------------|
| LLM 依赖 | **可选**（纯算法优先） | 必须 |
| API 费用 | 零 | 有（按 token 计费） |
| 去重 | Jaccard + 可选 LLM | 仅 LLM |
| 全文搜索 | FTS5（本地索引） | 依赖 LLM embedding |
| Tier 晋升 | 自动三层晋升 | 无 |
| 存储 | SQLite（sql.js） | SQLite |
| Slot 冲突 | 有（与 memos-local 互斥） | 有（与 algo-memory 互斥） |

> **注意**：两个插件同名 slot (`slots = ["memory"]`），同时只可启用一个。

---

## 版本

当前版本：`2.2.3`（见 [VERSION.txt](VERSION.txt)）
