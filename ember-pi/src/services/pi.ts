/**
 * Pi coding agent RPC service
 * https://pi.dev  |  https://github.com/badlogic/pi-mono
 *
 * Pi runs inside the Docker container as:
 *   pi --mode rpc [--provider <name>] [--model <name>] [--append-system-prompt <text>]
 *
 * Communication is JSONL over stdin/stdout.
 * Commands → stdin, events ← stdout (as Tauri "pi:event" broadcasts).
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ModelConfig } from '../types';

// ── Pi RPC event shapes ──────────────────────────────────────────────────────

/** The `assistantMessageEvent` field inside a `message_update` event. */
export interface AssistantMessageEvent {
  type:
    | 'start'
    | 'text_start' | 'text_delta' | 'text_end'
    | 'thinking_start' | 'thinking_delta' | 'thinking_end'
    | 'toolcall_start' | 'toolcall_delta' | 'toolcall_end'
    | 'done' | 'error';
  /** Present on text_delta and thinking_delta — the incremental content. */
  delta?: string;
  /** Present on toolcall_end. */
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  error?: string;
}

export interface PiEvent {
  type: string;
  /** message_update payload */
  assistantMessageEvent?: AssistantMessageEvent;
  /** tool_execution_* — field names use camelCase as emitted by pi */
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  error?: string;
}

// ── Provider mapping ─────────────────────────────────────────────────────────

/** Env var name for the API key of each cloud provider. */
function apiKeyEnvVar(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'ANTHROPIC_API_KEY';
    case 'openai':    return 'OPENAI_API_KEY';
    case 'google':    return 'GEMINI_API_KEY';
    default:          return '';
  }
}

/** Providers that pi supports natively with a simple --provider flag. */
const NATIVE_PROVIDERS = new Set(['anthropic', 'openai', 'google']);

function fallbackLocalApiKey(provider: ModelConfig['provider']): string {
  switch (provider) {
    case 'lmstudio':
      return 'lm-studio';
    case 'ollama':
      return 'ollama';
    default:
      return 'local-provider';
  }
}

/**
 * For local / custom providers, replace `localhost` or `127.0.0.1` with
 * `host.docker.internal` so pi (running inside Docker) can reach the host.
 */
function dockerifyEndpoint(url: string): string {
  return url
    .replace(/\blocalhost\b/g, 'host.docker.internal')
    .replace(/127\.0\.0\.1/g, 'host.docker.internal');
}

/**
 * Build the ~/.pi/agent/models.json content for a local/custom provider.
 * Pi uses this to resolve --provider <id> --model <modelId>.
 */
function buildModelsJson(config: ModelConfig): string {
  const providerId = config.provider; // e.g. "lmstudio", "ollama", "custom"
  const baseUrl = dockerifyEndpoint(config.endpoint.trim());
  const modelId = config.model.trim();

  const providerConfig = {
    baseUrl,
    api: 'openai-completions',
    apiKey: config.apiKey?.trim() || fallbackLocalApiKey(providerId),
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    models: [
      {
        id: modelId,
      },
    ],
  };

  return JSON.stringify({ providers: { [providerId]: providerConfig } }, null, 2);
}

// ── Session management ───────────────────────────────────────────────────────

/**
 * Start a pi RPC session inside the container.
 * Handles both cloud providers (anthropic/openai/google) and local ones
 * (lmstudio/ollama/custom) by writing a pi models.json config first.
 */
export async function startPiSession(
  containerName: string,
  config: ModelConfig,
  systemPrompt?: string,
): Promise<void> {
  const modelId = config.model.trim();
  if (!modelId) {
    throw new Error('Select a model first. In LM Studio, load a model and click Discover Models.');
  }

  const envVars: [string, string][] = [];
  const extraArgs: string[] = [];

  if (NATIVE_PROVIDERS.has(config.provider)) {
    // Cloud provider — pass API key + --provider + --model flags
    const envKey = apiKeyEnvVar(config.provider);
    if (config.apiKey && envKey) {
      envVars.push([envKey, config.apiKey]);
    }
    extraArgs.push('--provider', config.provider);
    if (modelId) {
      extraArgs.push('--model', modelId);
    }
  } else {
    const endpoint = config.endpoint.trim();
    if (!endpoint) {
      throw new Error('Endpoint URL is required for local and custom providers.');
    }

    // Local / custom provider — write models.json into the container first
    const modelsJson = buildModelsJson(config);
    await invoke('container_write_file', {
      containerName,
      path: '/root/.pi/agent/models.json',
      content: modelsJson,
    });
    extraArgs.push('--provider', config.provider);
    if (modelId) {
      extraArgs.push('--model', modelId);
    }
  }

  // Append the user's custom system prompt (pi adds this after its built-in prompt)
  if (systemPrompt?.trim()) {
    extraArgs.push('--append-system-prompt', systemPrompt.trim());
  }

  await invoke('pi_start', { containerName, envVars, extraArgs });
}

export async function stopPiSession(): Promise<void> {
  await invoke('pi_stop');
}

// ── Send a prompt ─────────────────────────────────────────────────────────────

export async function sendPrompt(text: string): Promise<void> {
  const cmd = JSON.stringify({ type: 'prompt', message: text });
  await invoke('pi_send', { line: cmd });
}

// ── Event listeners ───────────────────────────────────────────────────────────

export function onPiEvent(handler: (event: PiEvent) => void): Promise<UnlistenFn> {
  return listen<string>('pi:event', (ev) => {
    try {
      handler(JSON.parse(ev.payload) as PiEvent);
    } catch {
      // not valid JSON — ignore
    }
  });
}

export function onPiEnded(handler: () => void): Promise<UnlistenFn> {
  return listen('pi:ended', () => handler());
}

export function onPiStderr(handler: (line: string) => void): Promise<UnlistenFn> {
  return listen<string>('pi:stderr', (ev) => handler(ev.payload));
}
