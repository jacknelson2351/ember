import type { ChatMessage, ModelConfig, OutputLine } from '../types';

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

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS_COMMON = [
  {
    name: 'bash',
    description:
      'Execute a shell command inside the Kali Linux Docker container. Use this to run security tools, inspect files, perform network operations, and any other system tasks. The shared workspace is mounted at /workspace inside the container.',
    parameters: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute (e.g. "ls /workspace", "cat /workspace/targets.txt", "nmap -sV 10.0.0.1")',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a text file from the shared workspace using its host path. Use a path returned by list_files, not the container path /workspace/...',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute host-side path to the file (e.g. from list_files)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write a text file to the shared workspace using a host-side path. Use a directory returned by list_files, not the container path /workspace/...',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute host-side path to write (for example, a path built from a directory returned by list_files)' },
        content: { type: 'string', description: 'Text content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in the shared workspace directory.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Host-side directory path inside the shared workspace (default: workspace root)' },
      },
      required: [],
    },
  },
];

const ANTHROPIC_TOOLS = TOOLS_COMMON.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
}));

const OPENAI_TOOLS = TOOLS_COMMON.map((t) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

const GOOGLE_TOOLS = [
  {
    functionDeclarations: TOOLS_COMMON.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  },
];

// ── Types ────────────────────────────────────────────────────────────────────

type StreamChunk = { delta: string; done: boolean };

export type AgentChunk =
  | { type: 'text'; delta: string; done: boolean }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_done'; id: string; result: string; error: boolean };

export type ExecuteToolFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ output: string; error: boolean }>;

interface ToolCallResult {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ── Anthropic agentic loop ───────────────────────────────────────────────────

async function completeAnthropic(
  config: ModelConfig,
  messages: { role: string; content: unknown }[],
  systemPrompt: string,
): Promise<{ text: string; toolCalls: ToolCallResult[]; stopReason: string }> {
  const body = {
    model: config.model || 'claude-opus-4-6',
    max_tokens: 8096,
    system: systemPrompt,
    messages,
    tools: ANTHROPIC_TOOLS,
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': config.apiKey ?? '',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const json = await res.json();
  const stopReason: string = json.stop_reason ?? 'end_turn';
  let text = '';
  const toolCalls: ToolCallResult[] = [];

  for (const block of json.content ?? []) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
    }
  }

  return { text, toolCalls, stopReason };
}

async function* runAnthropicAgent(
  config: ModelConfig,
  messages: ChatMessage[],
  systemPrompt: string,
  executeToolFn: ExecuteToolFn,
): AsyncGenerator<AgentChunk> {
  type AMsg = { role: string; content: unknown };
  const history: AMsg[] = messages.map((m) => ({
    role: m.role === 'agent' ? 'assistant' : 'user',
    content: m.content,
  }));

  for (let i = 0; i < 12; i++) {
    const { text, toolCalls, stopReason } = await completeAnthropic(config, history, systemPrompt);

    if (text) yield { type: 'text', delta: text, done: false };

    if (stopReason === 'tool_use' && toolCalls.length > 0) {
      const assistantContent: unknown[] = [];
      if (text) assistantContent.push({ type: 'text', text });
      for (const tc of toolCalls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      history.push({ role: 'assistant', content: assistantContent });

      const toolResults: unknown[] = [];
      for (const tc of toolCalls) {
        yield { type: 'tool_start', id: tc.id, name: tc.name, args: tc.args };
        const { output, error } = await executeToolFn(tc.name, tc.args);
        yield { type: 'tool_done', id: tc.id, result: output, error };
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: output });
      }
      history.push({ role: 'user', content: toolResults });
    } else {
      yield { type: 'text', delta: '', done: true };
      return;
    }
  }

  yield { type: 'text', delta: '\n(Reached max tool iterations.)', done: false };
  yield { type: 'text', delta: '', done: true };
}

// ── OpenAI-compat agentic loop ───────────────────────────────────────────────

type OAIMsg = {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
};

async function completeOpenAI(
  config: ModelConfig,
  messages: OAIMsg[],
  systemPrompt: string,
): Promise<{ text: string; toolCalls: ToolCallResult[]; finishReason: string }> {
  const endpoint = config.endpoint.replace(/\/$/, '');
  const url = `${endpoint}/chat/completions`;
  const body = {
    model: config.model,
    tools: OPENAI_TOOLS,
    tool_choice: 'auto',
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const json = await res.json();
  const choice = json.choices?.[0];
  const msg = choice?.message ?? {};
  const text: string = msg.content ?? '';
  const finishReason: string = choice?.finish_reason ?? 'stop';
  const toolCalls: ToolCallResult[] = [];

  for (const tc of msg.tool_calls ?? []) {
    try {
      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments),
      });
    } catch { /* skip */ }
  }

  return { text, toolCalls, finishReason };
}

async function* runOpenAIAgent(
  config: ModelConfig,
  messages: ChatMessage[],
  systemPrompt: string,
  executeToolFn: ExecuteToolFn,
): AsyncGenerator<AgentChunk> {
  const history: OAIMsg[] = messages.map((m) => ({
    role: m.role === 'agent' ? 'assistant' : 'user',
    content: m.content,
  }));

  for (let i = 0; i < 12; i++) {
    const { text, toolCalls, finishReason } = await completeOpenAI(config, history, systemPrompt);

    if (text) yield { type: 'text', delta: text, done: false };

    if (finishReason === 'tool_calls' && toolCalls.length > 0) {
      history.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      for (const tc of toolCalls) {
        yield { type: 'tool_start', id: tc.id, name: tc.name, args: tc.args };
        const { output, error } = await executeToolFn(tc.name, tc.args);
        yield { type: 'tool_done', id: tc.id, result: output, error };
        history.push({ role: 'tool', tool_call_id: tc.id, content: output });
      }
    } else {
      yield { type: 'text', delta: '', done: true };
      return;
    }
  }

  yield { type: 'text', delta: '\n(Reached max tool iterations.)', done: false };
  yield { type: 'text', delta: '', done: true };
}

// ── Google agentic loop ──────────────────────────────────────────────────────

async function completeGoogle(
  config: ModelConfig,
  contents: unknown[],
  systemPrompt: string,
): Promise<{ text: string; toolCalls: ToolCallResult[] }> {
  const model = config.model || 'gemini-2.0-flash';
  const apiKey = config.apiKey ?? '';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body: Record<string, unknown> = {
    contents,
    tools: GOOGLE_TOOLS,
    generationConfig: { maxOutputTokens: 8096 },
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const json = await res.json();
  const parts: unknown[] = json.candidates?.[0]?.content?.parts ?? [];
  let text = '';
  const toolCalls: ToolCallResult[] = [];

  for (const part of parts as Record<string, unknown>[]) {
    if (typeof part.text === 'string') text += part.text;
    if (part.functionCall) {
      const fc = part.functionCall as Record<string, unknown>;
      toolCalls.push({
        id: crypto.randomUUID(),
        name: fc.name as string,
        args: (fc.args as Record<string, unknown>) ?? {},
      });
    }
  }

  return { text, toolCalls };
}

async function* runGoogleAgent(
  config: ModelConfig,
  messages: ChatMessage[],
  systemPrompt: string,
  executeToolFn: ExecuteToolFn,
): AsyncGenerator<AgentChunk> {
  const contents: unknown[] = messages.map((m) => ({
    role: m.role === 'agent' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  for (let i = 0; i < 12; i++) {
    const { text, toolCalls } = await completeGoogle(config, contents, systemPrompt);

    if (text) yield { type: 'text', delta: text, done: false };

    if (toolCalls.length > 0) {
      const modelParts: unknown[] = [];
      if (text) modelParts.push({ text });
      for (const tc of toolCalls) {
        modelParts.push({ functionCall: { name: tc.name, args: tc.args } });
      }
      contents.push({ role: 'model', parts: modelParts });

      const resultParts: unknown[] = [];
      for (const tc of toolCalls) {
        yield { type: 'tool_start', id: tc.id, name: tc.name, args: tc.args };
        const { output, error } = await executeToolFn(tc.name, tc.args);
        yield { type: 'tool_done', id: tc.id, result: output, error };
        resultParts.push({
          functionResponse: { name: tc.name, response: { output, error } },
        });
      }
      contents.push({ role: 'user', parts: resultParts });
    } else {
      yield { type: 'text', delta: '', done: true };
      return;
    }
  }

  yield { type: 'text', delta: '\n(Reached max tool iterations.)', done: false };
  yield { type: 'text', delta: '', done: true };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function* runAgent(
  config: ModelConfig,
  messages: ChatMessage[],
  systemPrompt: string,
  executeToolFn: ExecuteToolFn,
): AsyncGenerator<AgentChunk> {
  if (config.provider === 'anthropic') {
    yield* runAnthropicAgent(config, messages, systemPrompt, executeToolFn);
  } else if (config.provider === 'google') {
    yield* runGoogleAgent(config, messages, systemPrompt, executeToolFn);
  } else {
    yield* runOpenAIAgent(config, messages, systemPrompt, executeToolFn);
  }
}

// Legacy streaming (no tools) — kept for providers that don't support function calling
export async function* streamChat(
  config: ModelConfig,
  messages: ChatMessage[],
  systemPrompt: string,
): AsyncGenerator<StreamChunk> {
  const history = messages.map((m) => ({
    role: m.role === 'agent' ? 'assistant' : 'user',
    content: m.content,
  }));

  if (config.provider === 'anthropic') {
    yield* streamAnthropic(config, history, systemPrompt);
  } else if (config.provider === 'google') {
    yield* streamGoogle(config, history, systemPrompt);
  } else {
    yield* streamOpenAICompat(config, history, systemPrompt);
  }
}

async function* streamOpenAICompat(
  config: ModelConfig,
  messages: { role: string; content: string }[],
  systemPrompt: string,
): AsyncGenerator<StreamChunk> {
  const endpoint = config.endpoint.replace(/\/$/, '');
  const url = `${endpoint}/chat/completions`;

  const body = {
    model: config.model,
    stream: true,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') { yield { delta: '', done: true }; return; }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content ?? '';
        if (delta) yield { delta, done: false };
      } catch { /* skip */ }
    }
  }
  yield { delta: '', done: true };
}

async function* streamAnthropic(
  config: ModelConfig,
  messages: { role: string; content: string }[],
  systemPrompt: string,
): AsyncGenerator<StreamChunk> {
  const body = {
    model: config.model || 'claude-opus-4-6',
    max_tokens: 8096,
    stream: true,
    system: systemPrompt,
    messages,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': config.apiKey ?? '',
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      try {
        const json = JSON.parse(data);
        if (json.type === 'content_block_delta') {
          const delta = json.delta?.text ?? '';
          if (delta) yield { delta, done: false };
        } else if (json.type === 'message_stop') {
          yield { delta: '', done: true }; return;
        }
      } catch { /* skip */ }
    }
  }
  yield { delta: '', done: true };
}

async function* streamGoogle(
  config: ModelConfig,
  messages: { role: string; content: string }[],
  systemPrompt: string,
): AsyncGenerator<StreamChunk> {
  const model = config.model || 'gemini-2.0-flash';
  const apiKey = config.apiKey ?? '';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: 8096 },
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        if (delta) yield { delta, done: false };
      } catch { /* skip */ }
    }
  }
  yield { delta: '', done: true };
}

// Classify a raw output line
export function classifyLine(raw: string): OutputLine {
  let type: OutputLine['type'] = 'terminal';
  let content = raw;

  if (raw.startsWith('[THOUGHT]')) { type = 'thought'; content = raw.slice(9).trim(); }
  else if (raw.startsWith('[TOOL]')) { type = 'tool'; content = raw.slice(6).trim(); }
  else if (raw.startsWith('[CMD]') || raw.startsWith('$')) { type = 'terminal'; content = raw; }
  else if (raw.startsWith('[FINAL]') || raw.startsWith('[RESPONSE]')) {
    type = 'response'; content = raw.replace(/^\[(FINAL|RESPONSE)\]\s*/, '');
  } else if (raw.startsWith('[ERROR]')) { type = 'error'; content = raw.slice(7).trim(); }

  return { id: crypto.randomUUID(), type, content, timestamp: Date.now() };
}

export async function testConnection(config: ModelConfig): Promise<{ ok: boolean; latency: number; message: string }> {
  const start = Date.now();
  try {
    if (isOpenAICompatibleProvider(config.provider) && !config.endpoint.trim()) {
      return { ok: false, latency: Date.now() - start, message: 'Endpoint URL is required.' };
    }

    if (isLocalProvider(config.provider) && !config.model.trim()) {
      return {
        ok: false,
        latency: Date.now() - start,
        message: 'Select a real model first. Use Discover Models after the local server is running.',
      };
    }

    if (config.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': config.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      });
      const latency = Date.now() - start;
      if (res.ok) return { ok: true, latency, message: `Connected (${latency}ms)` };
      return { ok: false, latency, message: `HTTP ${res.status}` };
    }

    if (config.provider === 'google') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${config.apiKey ?? ''}`,
      );
      const latency = Date.now() - start;
      if (res.ok) return { ok: true, latency, message: `Google AI connected (${latency}ms)` };
      return { ok: false, latency, message: `HTTP ${res.status}` };
    }

    const endpoint = normalizeEndpoint(config.endpoint);
    const res = await fetch(`${endpoint}/models`, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    });
    const latency = Date.now() - start;
    if (res.ok) {
      const providerName = config.provider === 'lmstudio' ? 'LM Studio' : config.provider;
      return { ok: true, latency, message: `${providerName} connected (${latency}ms)` };
    }
    return { ok: false, latency, message: `HTTP ${res.status}` };
  } catch (e) {
    return {
      ok: false,
      latency: Date.now() - start,
      message: isLocalProvider(config.provider) ? localProviderUnavailableMessage(config, e) : String(e),
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
        ? json.models.map((m: { name?: string }) => m.name?.replace('models/', '') ?? '').filter(Boolean)
        : [];
    }

    const endpoint = normalizeEndpoint(config.endpoint);
    if (!endpoint) return [];

    const res = await fetch(`${endpoint}/models`, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    });
    if (!res.ok) return [];

    const json = await res.json();
    return Array.isArray(json.data)
      ? json.data.map((entry: { id?: string }) => entry.id).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}
