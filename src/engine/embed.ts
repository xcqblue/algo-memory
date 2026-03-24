/**
 * algo-memory v2.7.0 - 向量搜索客户端
 * 支持多种 embedding provider：openai / minimaxi / bge / ollama / siliconflow
 */

import type { VectorSearchConfig } from '../types.js';
import { sleep } from '../utils.js';

export interface EmbedResult {
  embedding: number[];
  dimensions: number;
  provider: string;
  model: string;
}

const EMBED_PROVIDERS = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
    dimensions: 1536,
    model: 'text-embedding-3-small',
    path: '/embeddings',
  },
  minimaxi: {
    baseURL: 'https://api.minimax.chat/v1',
    dimensions: 1024,
    model: 'embo-01-large',
    path: '/embeddings',
  },
  bge: {
    baseURL: 'http://localhost:8080',
    dimensions: 1024,
    model: 'bge-m3',
    path: '/embeddings',
  },
  ollama: {
    baseURL: 'http://localhost:11434',
    dimensions: 768,
    model: 'nomic-embed-text',
    path: '/api/embeddings',
  },
  siliconflow: {
    baseURL: 'https://api.siliconflow.cn/v1',
    dimensions: 1024,
    model: 'BAAI/bge-m3',
    path: '/embeddings',
  },
} as const;

type EmbedProvider = keyof typeof EMBED_PROVIDERS;

function getProviderConfig(provider: EmbedProvider, config: VectorSearchConfig) {
  const base = EMBED_PROVIDERS[provider];
  return {
    baseURL: config.baseURL || base.baseURL,
    model: config.model || base.model,
    dimensions: config.dimensions || base.dimensions,
    path: base.path,
  };
}

async function embedOpenAI(text: string, config: VectorSearchConfig): Promise<EmbedResult> {
  const { baseURL, model, dimensions, path } = getProviderConfig('openai', config);
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
  const response = await fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as any;
  const embedding: number[] = data.data?.[0]?.embedding || [];
  return { embedding, dimensions: embedding.length || dimensions, provider: 'openai', model };
}

async function embedMiniMax(text: string, config: VectorSearchConfig): Promise<EmbedResult> {
  const { baseURL, model, dimensions, path } = getProviderConfig('minimaxi', config);
  const apiKey = config.apiKey || process.env.MINIMAX_API_KEY || '';
  const response = await fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model }),
  });
  if (!response.ok) {
    throw new Error(`MiniMax embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as any;
  const embedding: number[] = data.data?.[0]?.embedding || [];
  return { embedding, dimensions: embedding.length || dimensions, provider: 'minimaxi', model };
}

async function embedOllama(text: string, config: VectorSearchConfig): Promise<EmbedResult> {
  const { baseURL, model, dimensions } = getProviderConfig('ollama', config);
  const response = await fetch(`${baseURL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: text, model }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as any;
  const embedding: number[] = data.embedding || [];
  return { embedding, dimensions: embedding.length || dimensions, provider: 'ollama', model };
}

async function embedSiliconFlow(text: string, config: VectorSearchConfig): Promise<EmbedResult> {
  const { baseURL, model, dimensions, path } = getProviderConfig('siliconflow', config);
  const apiKey = config.apiKey || process.env.SILICONFLOW_API_KEY || '';
  const response = await fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model }),
  });
  if (!response.ok) {
    throw new Error(`SiliconFlow embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as any;
  const embedding: number[] = data.data?.[0]?.embedding || [];
  return { embedding, dimensions: embedding.length || dimensions, provider: 'siliconflow', model };
}

/**
 * 获取文本的向量表示
 * @param text 要向量化的文本
 * @param config 向量搜索配置
 * @returns 向量结果
 */
export async function embedText(text: string, config: VectorSearchConfig): Promise<EmbedResult> {
  if (!config.enabled) {
    throw new Error('Vector search is not enabled');
  }

  const provider = (config.provider || 'minimaxi') as EmbedProvider;

  // 根据 provider 选择调用方式
  switch (provider) {
    case 'openai':
      return embedOpenAI(text, config);
    case 'minimaxi':
      return embedMiniMax(text, config);
    case 'ollama':
      return embedOllama(text, config);
    case 'siliconflow':
      return embedSiliconFlow(text, config);
    default:
      // bge 使用 ollama 兼容方式
      return embedOllama(text, { ...config, provider: 'ollama' });
  }
}

