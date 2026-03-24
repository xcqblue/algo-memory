/**
 * algo-memory v2.3.0 - LLM Client
 */

import type { Config, LLMConfig } from '../types.js';
import { jaccardSimilarity, extractKeywords, isCoreKeyword, sleep, RETRY_MAX_ATTEMPTS, RETRY_DELAY_MS } from '../utils.js';

// ============= LLM Provider Configurations =============
const LLM_PROVIDERS = {
  // ===== 国内模型 =====

  // MiniMax (默认推荐)
  minimax: {
    baseURL: 'https://api.minimax.chat/v1',
    models: [
      'abab6.5s-chat',
      'abab6.5g-chat',
      'abab6.5s-chat-200k',
      'abab1.8s-chat',
      'abab1.8g-chat',
      'abab6s-chat',
      'abab5.5s-chat'
    ],
    defaultModel: 'abab6.5s-chat'
  },
  // 阿里云百炼
  bailian: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long', 'qwen2.5-72b-instruct'],
    defaultModel: 'qwen-plus'
  },
  // DeepSeek
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat'
  },
  // Kimi (月之暗面)
  kimi: {
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-chat', 'kimi-chat-latest'],
    defaultModel: 'moonshot-v1-8k'
  },
  // 智谱 AI
  zhipu: {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4', 'glm-4-flash', 'glm-4-plus', 'glm-3-turbo'],
    defaultModel: 'glm-4-flash'
  },
  // 腾讯混元
  hunyuan: {
    baseURL: 'https://hunyuan.tencent.com/proxy/v1',
    models: ['hunyuan-pro', 'hunyuan-standard'],
    defaultModel: 'hunyuan-standard'
  },
  // 百度文心
  wenxin: {
    baseURL: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-4.0-8k', 'ernie-3.5-8k', 'ernie-speed-8k'],
    defaultModel: 'ernie-3.5-8k'
  },
  // SiliconFlow (国内聚合)
  siliconflow: {
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2-7B-Instruct', 'THUDM/glm-4-9b-chat', 'deepseek-ai/DeepSeek-V2-Chat'],
    defaultModel: 'Qwen/Qwen2-7B-Instruct'
  },

  // ===== 国外模型 =====
  openai: {
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini'
  },
  anthropic: {
    baseURL: 'https://api.anthropic.com',
    models: ['claude-3-haiku-20240307'],
    defaultModel: 'claude-3-haiku-20240307'
  },
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    models: ['llama2', 'mistral'],
    defaultModel: 'llama2'
  }
};

// ============= Resolve LLM Config =============
export function resolveLLMConfig(config: LLMConfig): LLMConfig {
  if (!config.enabled) return config;

  if (config.provider === 'auto' || !config.provider) {
    return { ...config, provider: 'minimax', ...LLM_PROVIDERS.minimax };
  }

  const provider = config.provider.toLowerCase();
  // Provider name aliases
  const providerMap: Record<string, string> = {
    qwen: 'bailian',
    'dashscope': 'bailian',
    moonshot: 'kimi',
    silicon: 'siliconflow',
  };
  const mapped = providerMap[provider] || provider;
  const providerConfig = (LLM_PROVIDERS as Record<string, { baseURL?: string; defaultModel?: string }>)[mapped];

  if (!providerConfig) {
    return { ...config, provider: 'minimax', ...LLM_PROVIDERS.minimax };
  }

  return {
    ...config,
    baseURL: config.baseURL || providerConfig.baseURL || '',
    model: config.model || providerConfig.defaultModel || ''
  };
}

// ============= LLM Call With Retry =============
async function llmCallWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = RETRY_MAX_ATTEMPTS,
  delayMs: number = RETRY_DELAY_MS
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxRetries) await sleep(delayMs);
    }
  }
  throw lastError;
}

// ============= LLM Client =============
/** Build the correct endpoint URL for a given provider and baseURL */
export function llmEndpoint(baseURL: string, provider: string): string {
  if (provider === 'anthropic') {
    return `${baseURL.replace(/\/$/, '')}/messages`;
  }
  return `${baseURL.replace(/\/$/, '')}/chat/completions`;
}

/** Build headers for a given provider */
export function llmHeaders(apiKey: string, provider: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };
  if (provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
}

export class LLMClient {
  private config: Config;
  private log: any;
  // Metrics callbacks for error tracking
  public onCoreError?: () => void;
  public onExtractError?: () => void;
  public onDedupError?: () => void;

  constructor(config: Config, log: any) {
    this.config = config;
    this.log = log;
  }

  async isCoreMemory(content: string): Promise<{ isCore: boolean; confidence: number }> {
    const localResult = isCoreKeyword(content, this.config.coreKeywords);
    if (localResult) return { isCore: true, confidence: 1.0 };
    if (!this.config.llm.enabled || !this.config.llm.apiKey) return { isCore: false, confidence: 0.5 };

    try {
      const result = await llmCallWithRetry(async () => {
        const response = await fetch(llmEndpoint(this.config.llm.baseURL, this.config.llm.provider), {
          method: 'POST',
          headers: llmHeaders(this.config.llm.apiKey, this.config.llm.provider),
          body: JSON.stringify({
            model: this.config.llm.model,
            messages: [
              { role: 'system', content: '判断是否重要需要长期记住。回复JSON: {"isCore": true/false, "confidence": 0-1}' },
              { role: 'user', content }
            ],
            max_tokens: 100,
            temperature: 0.1
          })
        });
        if (!response.ok) {
          throw new Error(`LLM API 错误: ${response.status} ${response.statusText}`);
        }
        const jsonResponse = await response.json() as any;
        if (!jsonResponse?.choices?.[0]?.message?.content) {
          throw new Error('LLM 响应格式错误');
        }
        return JSON.parse(jsonResponse.choices[0].message.content);
      }, RETRY_MAX_ATTEMPTS, RETRY_DELAY_MS);
      return result;
    } catch (err) {
      this.log.error('[algo-memory] LLM isCoreMemory 失败:', err);
      this.onCoreError?.();
      return { isCore: false, confidence: 0.5 };
    }
  }

  async extractKeywordsFromLLM(content: string): Promise<string> {
    const local = extractKeywords(content);
    if (!this.config.llm.enabled || !this.config.llm.apiKey) return local;

    try {
      const result = await llmCallWithRetry(async () => {
        const response = await fetch(llmEndpoint(this.config.llm.baseURL, this.config.llm.provider), {
          method: 'POST',
          headers: llmHeaders(this.config.llm.apiKey, this.config.llm.provider),
          body: JSON.stringify({
            model: this.config.llm.model,
            messages: [
              { role: 'system', content: '提取关键词，最多10个。回复JSON: {"keywords": ["k1", "k2"]}' },
              { role: 'user', content }
            ],
            max_tokens: 200,
            temperature: 0.2
          })
        });
        if (!response.ok) {
          throw new Error(`LLM API 错误: ${response.status} ${response.statusText}`);
        }
        const jsonResponse = await response.json() as any;
        if (!jsonResponse?.choices?.[0]?.message?.content) {
          throw new Error('LLM 响应格式错误');
        }
        const parsed = JSON.parse(jsonResponse.choices[0].message.content);
        if (!parsed?.keywords) {
          throw new Error('LLM 响应缺少 keywords 字段');
        }
        return parsed.keywords.join(',');
      }, RETRY_MAX_ATTEMPTS, RETRY_DELAY_MS);
      return result;
    } catch (err) {
      this.log.error('[algo-memory] LLM extractKeywords 失败:', err);
      this.onExtractError?.();
      return local;
    }
  }

  async isDuplicateLLM(c1: string, c2: string): Promise<{ isDuplicate: boolean; similarity: number }> {
    const sim = jaccardSimilarity(c1, c2);
    if (sim >= 0.98 || sim < 0.5) return { isDuplicate: sim >= 0.98, similarity: sim };
    if (!this.config.llm.enabled || !this.config.llm.apiKey) return { isDuplicate: false, similarity: sim };

    try {
      const result = await llmCallWithRetry(async () => {
        const response = await fetch(llmEndpoint(this.config.llm.baseURL, this.config.llm.provider), {
          method: 'POST',
          headers: llmHeaders(this.config.llm.apiKey, this.config.llm.provider),
          body: JSON.stringify({
            model: this.config.llm.model,
            messages: [
              { role: 'system', content: '判断是否重复。回复JSON: {"isDuplicate": true/false, "similarity": 0-1}' },
              { role: 'user', content: `内容1: ${c1}\n内容2: ${c2}` }
            ],
            max_tokens: 100,
            temperature: 0.1
          })
        });
        if (!response.ok) {
          throw new Error(`LLM API 错误: ${response.status} ${response.statusText}`);
        }
        const jsonResponse = await response.json() as any;
        if (!jsonResponse?.choices?.[0]?.message?.content) {
          throw new Error('LLM 响应格式错误');
        }
        return JSON.parse(jsonResponse.choices[0].message.content);
      }, RETRY_MAX_ATTEMPTS, RETRY_DELAY_MS);
      return result;
    } catch (err) {
      this.log.error('[algo-memory] LLM isDuplicate 失败:', err);
      this.onDedupError?.();
      return { isDuplicate: sim >= this.config.dedupThreshold, similarity: sim };
    }
  }
}
