export type Panel = 'chat' | 'files' | 'memory' | 'settings';

export type ContainerStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'error';
export type AgentStatus = 'idle' | 'running' | 'error';
export type DockerStatus = 'checking' | 'ready' | 'missing' | 'daemon_offline' | 'error';

export type OutputType = 'thought' | 'tool' | 'terminal' | 'response' | 'error';

export interface OutputLine {
  id: string;
  type: OutputType;
  content: string;
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  error?: boolean;
  running?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  thought?: string;
  thoughtStreaming?: boolean;
  timestamp: number;
  streaming?: boolean;
  toolCalls?: ToolCall[];
  attachments?: { name: string; path: string }[];
}

export interface Note {
  id: string;
  content: string;
  createdAt: number;
  pinned: boolean;
}

export interface Skill {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  createdAt: number;
}

export interface ModelConfig {
  provider: 'lmstudio' | 'openai' | 'anthropic' | 'google' | 'ollama' | 'custom';
  endpoint: string;
  apiKey?: string;
  model: string;
}

export interface RuntimeHealth {
  dockerStatus: DockerStatus;
  containerStatus: ContainerStatus;
  containerExists: boolean;
  imageExists: boolean;
  imageTag: string;
  containerName: string;
  sharedPath: string;
  configPath: string;
  memoryPath: string;
  message: string;
}

export interface AppearanceConfig {
  fontSize: number;
  alwaysOnTop: boolean;
  monoFont: string;
  launchExpanded: boolean;
  collapseOnBlur: boolean;
  toolbarWidth: number;
  panelHeight: number;
}

export interface WorkspaceFile {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  modified: number;
}

export interface SessionEvent {
  id: string;
  type: 'user' | 'agent' | 'system' | 'tool';
  content: string;
  timestamp: number;
}
