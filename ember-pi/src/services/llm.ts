import { invoke } from '@tauri-apps/api/core';
import type { ModelConfig } from '../types';

function isOpenAICompatibleProvider(provider: ModelConfig['provider']): boolean {
  return provider !== 'anthropic' && provider !== 'google';
}

function isLocalProvider(provider: ModelConfig['provider']): boolean {
  return provider === 'lmstudio' || provider === 'ollama' || provider === 'custom';
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/$/, '');
}

function localProviderUnavailableMessage(config: ModelConfig, error: unknown): string {
  if (config.provider === 'lmstudio') {
    return `LM Studio is not reachable at ${config.endpoint}. Load a model in LM Studio, start the local server, and confirm Ember can reach port 1234.`;
  }
  if (config.provider === 'ollama') {
    return `Ollama is not reachable at ${config.endpoint}. Make sure Ollama is running and the OpenAI-compatible endpoint is available.`;
  }
  return String(error);
}

export async function testConnection(
  config: ModelConfig,
): Promise<{ ok: boolean; latency: number; message: string }> {
  const start = Date.now();

  try {
    if (isOpenAICompatibleProvider(config.provider) && !config.endpoint.trim()) {
      return { ok: false, latency: Date.now() - start, message: 'Endpoint URL is required.' };
    }

    if (config.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': config.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      });
      const latency = Date.now() - start;
      return res.ok
        ? { ok: true, latency, message: `Anthropic connected (${latency}ms)` }
        : { ok: false, latency, message: `HTTP ${res.status}` };
    }

    if (config.provider === 'google') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${config.apiKey ?? ''}`,
      );
      const latency = Date.now() - start;
      return res.ok
        ? { ok: true, latency, message: `Google AI connected (${latency}ms)` }
        : { ok: false, latency, message: `HTTP ${res.status}` };
    }

    const endpoint = normalizeEndpoint(config.endpoint);
    const status = await invoke<number>('test_endpoint', {
      url: `${endpoint}/models`,
      apiKey: config.apiKey || null,
    });
    const latency = Date.now() - start;
    if (status >= 200 && status < 300) {
      const providerName = config.provider === 'lmstudio' ? 'LM Studio' : config.provider;
      return { ok: true, latency, message: `${providerName} connected (${latency}ms)` };
    }
    return { ok: false, latency, message: `HTTP ${status}` };
  } catch (error) {
    return {
      ok: false,
      latency: Date.now() - start,
      message: isLocalProvider(config.provider) ? localProviderUnavailableMessage(config, error) : String(error),
    };
  }
}

export async function discoverModels(config: ModelConfig): Promise<string[]> {
  try {
    if (config.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': config.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json.data)
        ? json.data.map((entry: { id?: string }) => entry.id).filter(Boolean)
        : [];
    }

    if (config.provider === 'google') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${config.apiKey ?? ''}`,
      );
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json.models)
        ? json.models.map((entry: { name?: string }) => entry.name?.replace('models/', '') ?? '').filter(Boolean)
        : [];
    }

    const endpoint = normalizeEndpoint(config.endpoint);
    if (!endpoint) return [];

    const body = await invoke<string>('fetch_json', {
      url: `${endpoint}/models`,
      apiKey: config.apiKey || null,
    });
    const json = JSON.parse(body);
    return Array.isArray(json.data)
      ? json.data.map((entry: { id?: string }) => entry.id).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}
