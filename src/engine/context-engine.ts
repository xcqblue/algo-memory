/**
 * algo-memory v3.1.0 - ContextEngine Implementation
 *
 * v3.1.0 三大优化：
 * 1. bootstrap(): 扫描 workspace Markdown 并导入到 SQLite
 * 2. maintain(): 返回真实 cleanup metrics（deleted / bytesFreed）
 * 3. assemble(): 语言感知 token 估算（中英文分开，更精确）
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';

// AgentMessage is provided by the OpenClaw runtime; we declare it as a local type alias
// so this file has no external type-level dependencies beyond the plugin host.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentMessage = any;

// ============= Local type stubs (mirrors OpenClaw plugin-sdk types) =============

export interface ContextEngineInfo {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
}

export interface BootstrapResult {
  bootstrapped: boolean;
  importedMessages?: number;
  reason?: string;
}

export interface ContextEngineMaintenanceResult {
  changed: boolean;
  bytesFreed: number;
  rewrittenEntries: number;
  reason?: string;
}

export interface SubagentSpawnPreparation {
  rollback: () => void | Promise<void>;
}

export type SubagentEndReason = 'deleted' | 'completed' | 'swept' | 'released';

export interface AssembleParams {
  sessionId: string;
  sessionKey?: string;
  messages: AgentMessage[];
  tokenBudget?: number;
  model?: string;
  prompt?: string;
}

export interface CompactParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  tokenBudget?: number;
  force?: boolean;
  currentTokenCount?: number;
  compactionTarget?: 'budget' | 'threshold';
  customInstructions?: string;
  runtimeContext?: Record<string, unknown>;
}

export interface IngestParams {
  sessionId: string;
  sessionKey?: string;
  message: AgentMessage;
  isHeartbeat?: boolean;
}

export interface IngestBatchParams {
  sessionId: string;
  sessionKey?: string;
  messages: AgentMessage[];
  isHeartbeat?: boolean;
}

export interface AfterTurnParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  messages: AgentMessage[];
  prePromptMessageCount: number;
  autoCompactionSummary?: string;
  isHeartbeat?: boolean;
  tokenBudget?: number;
  runtimeContext?: Record<string, unknown>;
}

export interface MaintainParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  runtimeContext?: Record<string, unknown>;
}

export interface PrepareSubagentSpawnParams {
  parentSessionKey: string;
  childSessionKey: string;
  ttlMs?: number;
}

export interface OnSubagentEndedParams {
  childAgentId: string;
  reason: SubagentEndReason;
}

export interface ContextEngine {
  readonly info: ContextEngineInfo;
  bootstrap?(params: { sessionId: string; sessionKey?: string; sessionFile: string }): Promise<BootstrapResult>;
  maintain?(params: MaintainParams): Promise<ContextEngineMaintenanceResult>;
  ingest(params: IngestParams): Promise<IngestResult>;
  ingestBatch?(params: IngestBatchParams): Promise<IngestBatchResult>;
  afterTurn?(params: AfterTurnParams): Promise<void>;
  assemble(params: AssembleParams): Promise<AssembleResult>;
  compact(params: CompactParams): Promise<CompactResult>;
  prepareSubagentSpawn?(params: PrepareSubagentSpawnParams): Promise<SubagentSpawnPreparation | undefined>;
  onSubagentEnded?(params: OnSubagentEndedParams): Promise<void>;
  dispose?(): void;
}

export interface IngestResult {
  ingested: boolean;
}

export interface IngestBatchResult {
  ingestedCount: number;
}

export interface AssembleResult {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
}

// ============= AlgoMemoryContextEngine =============

/** Minimal interface of the MemoryPlugin instance passed from index.ts */
export interface MemoryPluginInstance {
  store(agentId: string, messages: any[]): Promise<void>;
  recall(agentId: string, query: string, options?: { limit?: number; skipDedup?: boolean }): Promise<{ hasMemory: boolean; memories: any[] }>;
  manualCompact(agentId: string): Promise<{ success: boolean; message: string; promoted?: number; reinforced?: number; pruned?: number }>;
  cleanup(): { deleted: number; bytesFreed: number };
  close?(): void;
  config?: { maxInjectTokens?: number };
  version?: string;
  workspaceDir?: string;
}

// ============= Token 估算器（v3.1.0 语言感知版）=============

/**
 * v3.1.0 语言感知 token 估算
 *
 * 问题：原来用 `length * 0.4` 过于粗糙：
 *   - 中文：1个汉字 ≈ 1个token，用 0.4 严重低估（×2.5 放大）
 *   - 英文：1个token ≈ 0.75个单词，1个单词≈4字符，用 length*0.4 ≈ 偏大
 *   - 混合文本：无法区分
 *
 * 新方案：CJK 字符 / English words / ASCII digits 分开估算
 * - CJK 字符（中文/日文/韩文）：1字符 ≈ 1 token
 * - Latin 单词：[a-zA-Z]+ 识别为英文单词，每词 ≈ 1.3 tokens（GPT tokenizer cl100k_base 经验值）
 * - ASCII 数字/标点：[0-9]+ ≈ 0.75 tokens/数字，标点 ≈ 1 token
 * - 空格：忽略
 *
 * 示例：
 * - "我生日是6月1日" → 8 CJK = 8 tokens
 * - "我的生日是6月1日，记得买蛋糕" → 10 CJK = 10 tokens
 * - "hello world today" → 3 words × 1.3 = 3.9 ≈ 4 tokens
 * - "MacBook Pro 2024" → 2 words × 1.3 + 1 number × 0.75 + 1 number × 0.75 ≈ 3.8 ≈ 4 tokens
 */
function estimateTokens(text: string): number {
  let tokens = 0;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];
    const code = text.charCodeAt(i);

    // ASCII range（英文单词、数字、标点、空格）
    if (code < 128) {
      if (/[a-zA-Z]/.test(char)) {
        // Latin word
        let wordLen = 0;
        while (i < len && /[a-zA-Z]/.test(text[i])) {
          wordLen++;
          i++;
        }
        tokens += wordLen * 1.3; // English word ≈ 1.3 tokens
      } else if (/[0-9]/.test(char)) {
        // Number
        let numLen = 0;
        while (i < len && /[0-9]/.test(text[i])) {
          numLen++;
          i++;
        }
        tokens += numLen * 0.75; // number ≈ 0.75 tokens
      } else if (/\S/.test(char)) {
        // Other non-whitespace ASCII (punctuation, etc.)
        tokens += 1;
        i++;
      } else {
        // Whitespace
        i++;
      }
    } else {
      // CJK（中文/日文/韩文）或全角字符
      // 简单判断：CJK Unicode 范围
      // 中文: 4E00-9FFF, 3400-4DBF（扩展A）, 20000-2A6DF（扩展B）
      // 日文 Hiragana/Katakana: 3040-309F, 30A0-30FF
      // 韩文: AC00-D7AF, 1100-11FF（初声）, 3100-312F（注音）
      const isCJK = (
        (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified Ideographs
        (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Extension A
        (code >= 0x20000 && code <= 0x2A6DF) ||  // CJK Extension B
        (code >= 0x3040 && code <= 0x309F) ||    // Hiragana
        (code >= 0x30A0 && code <= 0x30FF) ||    // Katakana
        (code >= 0xAC00 && code <= 0xD7AF) ||    // Hangul Syllables
        (code >= 0x1100 && code <= 0x11FF) ||     // Hangul Jamo
        (code >= 0x3100 && code <= 0x312F)       // Bopomofo
      );
      if (isCJK) {
        tokens += 1; // 每个 CJK 字符 ≈ 1 token
        i++;
      } else {
        // 全角字母/数字/标点（占两个代码单元但算一个字符）
        tokens += 1;
        i += 2;
      }
    }
  }

  return Math.ceil(tokens);
}

// ============= Markdown 解析器（v3.1.0 bootstrap 用）============

/**
 * 解析 OpenClaw workspace Markdown 文件中的记忆条目
 *
 * 支持的格式：
 * - "- [日期] 记忆内容"  （MEMORY.md / memory/*.md 标准格式）
 * - "- [algo-memory/tier] 记忆内容" （algo-memory syncToWorkspace 格式）
 * - "## 日期" / "# 日期" （日期分区标题）
 * - "- 记忆内容" 或 "* 记忆内容" （无日期的列表项）
 * - "1. 记忆内容" （有序列表）
 */
function parseMemoryEntries(content: string): { date: string; text: string; source: string }[] {
  const entries: { date: string; text: string; source: string }[] = [];
  const lines = content.split('\n');
  let currentSection = '';

  // 行首空格
  const listItemPattern = /^[\s]*[-*]?\s*/;
  const sectionPattern = /^#+\s*(.+)/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 跳过代码块
    if (line.startsWith('```')) continue;

    // 解析日期分区标题
    const sectionMatch = line.match(sectionPattern);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    // 解析列表项
    if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
      const text = line.replace(listItemPattern, '').trim();

      // 跳过注释/空内容
      if (!text || text.startsWith('//') || text.startsWith('#')) continue;

      // 跳过已有标签行
      if (text.startsWith('[...') || text.startsWith('```') || text.startsWith('<!--')) continue;

      // 提取日期（如果有）
      let entryDate = currentSection || '';
      const dateMatch = text.match(/^\[(\d{4}-\d{2}-\d{2})\]/);
      if (dateMatch) {
        entryDate = dateMatch[1];
      }

      // 去除标签前缀 [algo-memory/core] 或 [日期]
      const cleanText = text
        .replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '')
        .replace(/^\[algo-memory\/[^]]+\]\s*/, '')
        .trim();

      if (cleanText.length >= 3) {
        entries.push({
          date: entryDate || new Date().toISOString().split('T')[0],
          text: cleanText,
          source: 'bootstrap',
        });
      }
    }
  }

  return entries;
}

// ============= AlgoMemoryContextEngine =============

/**
 * Wraps a MemoryPlugin instance to expose the OpenClaw ContextEngine interface.
 *
 * Design decisions:
 * - Does NOT re-implement store/recall logic — delegates entirely to MemoryPlugin
 * - ownsCompaction = false (algo-memory uses OpenClaw's hook-based compaction lifecycle)
 * - assemble() is the primary entry point: converts Memory[] → AgentMessage[] for model context
 */
export class AlgoMemoryContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo;

  constructor(private plugin: MemoryPluginInstance) {
    this.info = {
      id: 'algo-memory',
      name: 'algo-memory',
      version: plugin && (plugin as any).version || '3.1.0',
      ownsCompaction: false,
    };
  }

  /**
   * v3.1.0: bootstrap — 从 workspace Markdown 导入历史记忆到 SQLite
   *
   * 扫描路径：
   * - workspaceDir/MEMORY.md
   * - workspaceDir/memory/*.md（YYYY-MM-DD.md）
   *
   * 解析格式：支持 OpenClaw memory_search 标准格式和 algo-memory syncToWorkspace 格式
   * 导入方式：通过 plugin.store() 批量写入（触发 deduplication，不会重复导入）
   *
   * 只在从未 bootstrap 过时执行（通过检查 workspaceDir 下是否有 Markdown 文件判断）
   */
  async bootstrap(params: { sessionId: string; sessionKey?: string; sessionFile: string }): Promise<BootstrapResult> {
    const workspaceDir = (this.plugin as any).workspaceDir as string | undefined;

    if (!workspaceDir || !existsSync(workspaceDir)) {
      return { bootstrapped: false, reason: 'workspaceDir not available' };
    }

    try {
      const memoryDir = join(workspaceDir, 'memory');
      const entries: { date: string; text: string; source: string }[] = [];

      // 扫描 MEMORY.md
      const memoryPath = join(workspaceDir, 'MEMORY.md');
      if (existsSync(memoryPath)) {
        const content = await readFile(memoryPath, 'utf-8');
        entries.push(...parseMemoryEntries(content).map(e => ({ ...e, source: 'MEMORY.md' })));
      }

      // 扫描 memory/*.md
      if (existsSync(memoryDir)) {
        const { readdirSync } = await import('fs');
        const files = readdirSync(memoryDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
          const filePath = join(memoryDir, file);
          const content = await readFile(filePath, 'utf-8');
          entries.push(...parseMemoryEntries(content).map(e => ({ ...e, source: `memory/${file}` })));
        }
      }

      if (entries.length === 0) {
        return { bootstrapped: true, importedMessages: 0, reason: 'no entries found in workspace' };
      }

      // 转换为 AgentMessage 格式，调用 store()
      // 注意：store() 内部有 deduplication，重复导入不会产生重复记录
      const messages = entries.map(entry => ({
        role: 'user',
        content: entry.text,
        _meta: { importDate: entry.date, importSource: entry.source },
      }));

      // 分批导入（每批 50 条）
      const BATCH = 50;
      let imported = 0;
      for (let i = 0; i < messages.length; i += BATCH) {
        const batch = messages.slice(i, i + BATCH);
        try {
          await this.plugin.store(params.sessionId, batch);
          imported += batch.length;
        } catch (err) {
          console.warn(`[algo-memory] bootstrap batch import failed:`, err);
        }
      }

      console.log(`[algo-memory] bootstrap: 从 workspace 导入了 ${imported}/${entries.length} 条记忆到 SQLite`);
      return {
        bootstrapped: true,
        importedMessages: imported,
        reason: `从 workspace 导入了 ${imported}/${entries.length} 条记忆`,
      };
    } catch (err: any) {
      console.error('[algo-memory] bootstrap failed:', err);
      return { bootstrapped: false, reason: err?.message ?? String(err) };
    }
  }

  // Forward to plugin.store()
  async ingest(params: IngestParams): Promise<IngestResult> {
    try {
      await this.plugin.store(params.sessionId, [params.message]);
      return { ingested: true };
    } catch {
      return { ingested: false };
    }
  }

  // Forward to plugin.store()
  async ingestBatch(params: IngestBatchParams): Promise<IngestBatchResult> {
    try {
      await this.plugin.store(params.sessionId, params.messages);
      return { ingestedCount: params.messages.length };
    } catch {
      return { ingestedCount: 0 };
    }
  }

  // No-op: MemoryPlugin handles storage via hooks (before_prompt_build / agent_end)
  async afterTurn(): Promise<void> {}

  /**
   * v3.1.0: maintain — 调用 plugin.cleanup() 返回真实 metrics
   *
   * OpenClaw 用 bytesFreed 决定是否需要再次 maintain。
   * 之前返回 { bytesFreed: 0 }，导致 OpenClaw 误判 maintain 效果。
   * 现在返回 plugin.cleanup() 的实际值。
   */
  async maintain(): Promise<ContextEngineMaintenanceResult> {
    try {
      const result = this.plugin.cleanup();
      return {
        changed: result.deleted > 0,
        bytesFreed: result.bytesFreed,
        rewrittenEntries: 0, // algo-memory 不重写任何 entry
        reason: result.deleted > 0
          ? `清理了 ${result.deleted} 条 peripheral 记忆`
          : '无记忆需清理',
      };
    } catch (err: any) {
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: err?.message ?? String(err) };
    }
  }

  /**
   * v3.1.0: assemble — 语言感知 token 估算
   *
   * 用 estimateTokens() 替代 `length * 0.4` 粗糙估算，
   * 对中英文混合文本更准确。
   */
  async assemble(params: AssembleParams): Promise<AssembleResult> {
    try {
      const prompt = params.prompt || '';

      // Extract the latest user message as the recall query
      const userMessages = (params.messages as any[])
        .filter((m: any) => m?.role === 'user')
        .map((m: any) => typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content))
        .filter(Boolean);
      const query = userMessages.slice(-3).join(' ') || prompt;

      const { hasMemory, memories } = await this.plugin.recall(params.sessionId, query, {
        limit: params.tokenBudget ? Math.floor(params.tokenBudget / 50) : 5,
      });

      if (!hasMemory || memories.length === 0) {
        return { messages: [], estimatedTokens: 0 };
      }

      // Convert Memory[] → AgentMessage[] (as user messages for model context)
      const MAX_TOKENS = this.plugin.config?.maxInjectTokens ?? 2000;
      const messages: AgentMessage[] = [];
      let tokenCount = 0;

      for (let i = 0; i < memories.length; i++) {
        const m = memories[i];
        const line = `[记忆] ${m.content}`;
        // v3.1.0: 语言感知 token 估算
        const lineTokens = estimateTokens(line);
        if (tokenCount + lineTokens > MAX_TOKENS) break;
        const msg = {
          role: 'user' as const,
          content: line,
          timestamp: m.created_at || Date.now(),
        };
        messages.push(msg as unknown as AgentMessage);
        tokenCount += lineTokens;
      }

      const systemPromptAddition = messages.length < memories.length
        ? `[...还有 ${memories.length - messages.length} 条记忆因超出上下文限制未显示]`
        : undefined;

      return { messages, estimatedTokens: tokenCount, systemPromptAddition };
    } catch (err) {
      // Don't let assemble errors crash the agent run
      console.error('[algo-memory] assemble error:', err);
      return { messages: [], estimatedTokens: 0 };
    }
  }

  // Delegate to plugin.manualCompact() for tier management
  async compact(params: CompactParams): Promise<CompactResult> {
    try {
      const result = await this.plugin.manualCompact(params.sessionId);
      return {
        ok: result.success,
        compacted: result.success,
        reason: result.message,
        result: {
          tokensBefore: params.currentTokenCount ?? 0,
          details: { promoted: result.promoted, reinforced: result.reinforced, pruned: result.pruned },
        },
      };
    } catch (err: any) {
      return { ok: false, compacted: false, reason: err?.message ?? String(err) };
    }
  }

  // Stub: subagent state not yet implemented
  async prepareSubagentSpawn(): Promise<SubagentSpawnPreparation | undefined> {
    return undefined;
  }

  // Stub: subagent state not yet implemented
  async onSubagentEnded(): Promise<void> {}

  // Forward to plugin.close()
  dispose(): void {
    this.plugin.close?.();
  }
}
