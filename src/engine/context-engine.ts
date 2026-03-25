/**
 * algo-memory v2.7.5 - ContextEngine Implementation
 * Implements the OpenClaw ContextEngine interface by wrapping MemoryPlugin.
 *
 * Type imports are pulled from openclaw's plugin-sdk (available as peer dep)
 * and @mariozechner/pi-agent-core (peer dep). At runtime these are provided
 * by the OpenClaw host; at compile time we declare stub types so tsc succeeds.
 */

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
  childSessionKey: string;
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
  cleanup?(): void;
  close?(): void;
  config?: { maxInjectTokens?: number };
  version?: string;
}

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
      version: plugin && (plugin as any).version || '2.7.5',
      ownsCompaction: false,
    };
  }

  // No-op: plugin is already initialized via its own init() in register()
  async bootstrap(): Promise<BootstrapResult> {
    return { bootstrapped: false, reason: 'MemoryPlugin handles its own initialization' };
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

  // Trigger cleanup on maintain — rewrites nothing in the transcript
  async maintain(): Promise<ContextEngineMaintenanceResult> {
    this.plugin.cleanup?.();
    return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: 'noop - algo-memory uses hook-based storage' };
  }

  /**
   * Assemble model context: call plugin.recall() with the user prompt
   * and convert returned Memory[] to AgentMessage[] for injection.
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
        const lineTokens = Math.ceil((line.length * 0.4)); // rough token estimate
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
