import { invoke } from '@tauri-apps/api/core';
import type { ModelConfig } from '../types';

export async function loadProviderApiKey(provider: ModelConfig['provider']): Promise<string> {
  return (await invoke<string | null>('get_provider_api_key', { provider })) ?? '';
}

export async function saveProviderApiKey(
  provider: ModelConfig['provider'],
  apiKey: string,
): Promise<void> {
  await invoke('set_provider_api_key', { provider, apiKey });
}
