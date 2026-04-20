import { invoke } from '@tauri-apps/api/core';
import type { RuntimeHealth } from '../types';

const FALLBACK_RUNTIME: RuntimeHealth = {
  dockerStatus: 'checking',
  containerStatus: 'stopped',
  containerExists: false,
  imageExists: false,
  imageTag: 'coalfire-ember-runtime:latest',
  containerName: 'ember-pi-runtime',
  sharedPath: '',
  configPath: '',
  memoryPath: '',
  message: 'Checking Docker runtime…',
};

export async function getRuntimeHealth(name: string): Promise<RuntimeHealth> {
  try {
    return await invoke<RuntimeHealth>('runtime_health', { containerName: name });
  } catch (error) {
    return {
      ...FALLBACK_RUNTIME,
      containerName: name,
      dockerStatus: 'error',
      message: String(error),
    };
  }
}

export async function ensureRuntime(name: string): Promise<RuntimeHealth> {
  return await invoke<RuntimeHealth>('ensure_runtime', { containerName: name });
}

export async function startContainer(name: string): Promise<RuntimeHealth> {
  return await invoke<RuntimeHealth>('container_start', { containerName: name });
}

export async function stopContainer(name: string): Promise<void> {
  await invoke('container_stop', { containerName: name });
}

export async function getContainerLogs(name: string, tail = 100): Promise<string> {
  try {
    return await invoke<string>('container_logs', { containerName: name, tail });
  } catch {
    return '';
  }
}
