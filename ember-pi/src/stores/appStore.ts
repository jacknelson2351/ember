import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Panel,
  ContainerStatus,
  AgentStatus,
  OutputLine,
  ChatMessage,
  Note,
  Skill,
  ModelConfig,
  AppearanceConfig,
  WorkspaceFile,
  SessionEvent,
  RuntimeHealth,
} from '../types';

// ── Persisted slice (survives reload) ───────────────────────────────────────

interface PersistedState {
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig) => void;

  notes: Note[];
  addNote: (note: Note) => void;
  togglePin: (id: string) => void;
  deleteNote: (id: string) => void;
  updateNote: (id: string, content: string) => void;

  memoryMode: 'off' | 'minimal' | 'session' | 'full';
  setMemoryMode: (mode: 'off' | 'minimal' | 'session' | 'full') => void;

  skills: Skill[];
  addSkill: (skill: Skill) => void;
  updateSkill: (id: string, patch: Partial<Skill>) => void;
  deleteSkill: (id: string) => void;
  toggleSkill: (id: string) => void;

  systemPrompt: string;
  setSystemPrompt: (p: string) => void;

  setupComplete: boolean;
  setSetupComplete: (ready: boolean) => void;

  containerName: string;
  setContainerName: (n: string) => void;

  workspacePath: string;
  setWorkspacePath: (p: string) => void;

  appearance: AppearanceConfig;
  setAppearance: (a: Partial<AppearanceConfig>) => void;
}

const usePersistedStore = create<PersistedState>()(
  persist(
    (set) => ({
      modelConfig: {
        provider: 'lmstudio',
        endpoint: 'http://localhost:1234/v1',
        model: 'local-model',
      },
      setModelConfig: (modelConfig) => set({ modelConfig }),

      notes: [],
      addNote: (note) => set((s) => ({ notes: [...s.notes, note] })),
      togglePin: (id) =>
        set((s) => ({
          notes: s.notes.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n)),
        })),
      deleteNote: (id) => set((s) => ({ notes: s.notes.filter((n) => n.id !== id) })),
      updateNote: (id, content) =>
        set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, content } : n)) })),

      memoryMode: 'minimal',
      setMemoryMode: (memoryMode) => set({ memoryMode }),

      skills: [
        {
          id: '1',
          name: 'recon',
          content: '# Recon Skill\n\nRun passive reconnaissance on a target.\n\n## Steps\n1. whois lookup\n2. dns enumeration\n3. port scan',
          enabled: true,
          createdAt: Date.now(),
        },
        {
          id: '2',
          name: 'report',
          content: '# Report Skill\n\nGenerate a findings report.\n\n## Template\n- Finding\n- Severity\n- Evidence\n- Recommendation',
          enabled: false,
          createdAt: Date.now(),
        },
      ],
      addSkill: (skill) => set((s) => ({ skills: [...s.skills, skill] })),
      updateSkill: (id, patch) =>
        set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, ...patch } : sk)) })),
      deleteSkill: (id) => set((s) => ({ skills: s.skills.filter((sk) => sk.id !== id) })),
      toggleSkill: (id) =>
        set((s) => ({
          skills: s.skills.map((sk) => (sk.id === id ? { ...sk, enabled: !sk.enabled } : sk)),
        })),

      systemPrompt:
        'You are a knowledgeable assistant with access to a Kali Linux environment and a shared /workspace folder. You can help with security tasks, coding, scripting, file analysis, system administration, and general technical questions. When you provide shell commands or code, always use fenced code blocks with the appropriate language tag (e.g. ```bash). Be concise and accurate.',
      setSystemPrompt: (systemPrompt) => set({ systemPrompt }),

      setupComplete: false,
      setSetupComplete: (setupComplete) => set({ setupComplete }),

      containerName: 'ember-pi-runtime',
      setContainerName: (containerName) => set({ containerName }),

      workspacePath: '/workspace',
      setWorkspacePath: (workspacePath) => set({ workspacePath }),

      appearance: {
        fontSize: 13,
        alwaysOnTop: false,
        monoFont: '"JetBrains Mono", "SF Mono", Monaco, monospace',
        launchExpanded: false,
        toolbarWidth: 780,
        panelHeight: 560,
      },
      setAppearance: (patch) =>
        set((s) => ({ appearance: { ...s.appearance, ...patch } })),
    }),
    { name: 'ember-pi-persist' }
  )
);

// ── Ephemeral slice (runtime only) ──────────────────────────────────────────

interface EphemeralState {
  activePanel: Panel;
  setActivePanel: (panel: Panel) => void;

  containerStatus: ContainerStatus;
  agentStatus: AgentStatus;
  setContainerStatus: (s: ContainerStatus) => void;
  setAgentStatus: (s: AgentStatus) => void;

  messages: ChatMessage[];
  addMessage: (msg: ChatMessage) => void;
  updateLastMessage: (patch: Partial<ChatMessage>) => void;
  clearMessages: () => void;

  terminalLines: OutputLine[];
  addTerminalLine: (line: OutputLine) => void;
  clearTerminal: () => void;

  thoughtLines: OutputLine[];
  addThoughtLine: (line: OutputLine) => void;
  clearThoughts: () => void;

  sessionLog: SessionEvent[];
  addSessionEvent: (e: SessionEvent) => void;
  clearSessionLog: () => void;

  workspaceFiles: WorkspaceFile[];
  setWorkspaceFiles: (files: WorkspaceFile[]) => void;

  selectedFile: WorkspaceFile | null;
  setSelectedFile: (f: WorkspaceFile | null) => void;

  fileContent: string | null;
  setFileContent: (c: string | null) => void;

  inputValue: string;
  setInputValue: (v: string) => void;

  containerLogs: string;
  appendContainerLogs: (chunk: string) => void;
  clearContainerLogs: () => void;

  runtimeHealth: RuntimeHealth | null;
  setRuntimeHealth: (health: RuntimeHealth | null) => void;

  /** Prevents blur-collapse while a native OS dialog (e.g. file picker) is open. */
  suppressBlurCollapse: boolean;
  setSuppressBlurCollapse: (val: boolean) => void;
}

export const useEphemeralStore = create<EphemeralState>((set) => ({
  activePanel: 'chat',
  setActivePanel: (panel) => set({ activePanel: panel }),

  containerStatus: 'stopped',
  agentStatus: 'idle',
  setContainerStatus: (containerStatus) => set({ containerStatus }),
  setAgentStatus: (agentStatus) => set({ agentStatus }),

  messages: [],
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  updateLastMessage: (patch) =>
    set((s) => {
      const msgs = [...s.messages];
      if (msgs.length === 0) return {};
      msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], ...patch };
      return { messages: msgs };
    }),
  clearMessages: () => set({ messages: [] }),

  terminalLines: [],
  addTerminalLine: (line) =>
    set((s) => ({ terminalLines: [...s.terminalLines.slice(-800), line] })),
  clearTerminal: () => set({ terminalLines: [] }),

  thoughtLines: [],
  addThoughtLine: (line) =>
    set((s) => ({ thoughtLines: [...s.thoughtLines.slice(-200), line] })),
  clearThoughts: () => set({ thoughtLines: [] }),

  sessionLog: [],
  addSessionEvent: (e) =>
    set((s) => ({ sessionLog: [...s.sessionLog.slice(-500), e] })),
  clearSessionLog: () => set({ sessionLog: [] }),

  workspaceFiles: [],
  setWorkspaceFiles: (workspaceFiles) => set({ workspaceFiles }),

  selectedFile: null,
  setSelectedFile: (selectedFile) => set({ selectedFile }),

  fileContent: null,
  setFileContent: (fileContent) => set({ fileContent }),

  inputValue: '',
  setInputValue: (inputValue) => set({ inputValue }),

  containerLogs: '',
  appendContainerLogs: (chunk) =>
    set((s) => ({
      containerLogs: (s.containerLogs + chunk).split('\n').slice(-300).join('\n'),
    })),
  clearContainerLogs: () => set({ containerLogs: '' }),

  runtimeHealth: null,
  setRuntimeHealth: (runtimeHealth) => set({ runtimeHealth }),

  suppressBlurCollapse: false,
  setSuppressBlurCollapse: (suppressBlurCollapse) => set({ suppressBlurCollapse }),
}));

// ── Unified hook (merges both slices) ───────────────────────────────────────

export function useAppStore() {
  const p = usePersistedStore();
  const e = useEphemeralStore();
  return { ...p, ...e };
}
