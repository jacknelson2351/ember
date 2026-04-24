import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useShallow } from 'zustand/react/shallow';
import { useEphemeralStore, usePersistedStore } from '../stores/appStore';
import { startContainer, stopContainer, getContainerLogs } from '../services/container';
import { testConnection, discoverModels } from '../services/llm';
import { loadProviderApiKey, saveProviderApiKey } from '../services/secrets';
import type { ModelConfig } from '../types';

type Section = 'model' | 'runtime' | 'behavior' | 'session';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'model',   label: 'AI Model' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'session', label: 'Session' },
];

export function SettingsPanel() {
  const [section, setSection] = useState<Section>('model');

  return (
    <div className="flex h-full flex-col">
      {/* Section tabs */}
      <div className="flex shrink-0 gap-0.5 border-b border-white/8 px-3 pt-2">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`px-3 py-2 text-[11px] font-medium transition-colors ${
              section === s.id
                ? 'border-b-2 border-[var(--ember-orange)] text-white'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {section === 'model'   && <ModelSection />}
        {section === 'runtime' && <RuntimeSection />}
        {section === 'behavior' && <BehaviorSection />}
        {section === 'session'  && <SessionSection />}
      </div>
    </div>
  );
}

// ── AI Model ─────────────────────────────────────────────────────────────────

const PROVIDERS: { id: ModelConfig['provider']; label: string; endpoint: string; model: string; needsKey: boolean }[] = [
  { id: 'openai',    label: 'OpenAI / ChatGPT',   endpoint: 'https://api.openai.com/v1',    model: 'gpt-4o',             needsKey: true  },
  { id: 'anthropic', label: 'Anthropic / Claude',  endpoint: '',                             model: 'claude-opus-4-7',    needsKey: true  },
  { id: 'google',    label: 'Google / Gemini',     endpoint: '',                             model: 'gemini-2.5-flash',   needsKey: true  },
  { id: 'lmstudio',  label: 'LM Studio',           endpoint: 'http://localhost:1234/v1',    model: '',                   needsKey: false },
  { id: 'ollama',    label: 'Ollama',              endpoint: 'http://localhost:11434/v1',   model: '',                   needsKey: false },
  { id: 'custom',    label: 'Custom',              endpoint: '',                             model: '',                   needsKey: true  },
];

function ModelSection() {
  const { modelConfig, setModelConfig } = usePersistedStore(useShallow((state) => ({
    modelConfig: state.modelConfig,
    setModelConfig: state.setModelConfig,
  })));
  const [local, setLocal] = useState<ModelConfig>({ ...modelConfig });
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [foundModels, setFoundModels] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const currentProvider = PROVIDERS.find((p) => p.id === local.provider)!;

  useEffect(() => {
    setLocal({ ...modelConfig });
  }, [modelConfig]);

  const selectProvider = async (id: ModelConfig['provider']) => {
    const p = PROVIDERS.find((x) => x.id === id)!;
    const apiKey = p.needsKey ? await loadProviderApiKey(id) : '';
    setLocal((prev) => ({ ...prev, provider: id, endpoint: p.endpoint, model: p.model, apiKey: apiKey || undefined }));
    setTestResult(null);
    setFoundModels([]);
  };

  const save = async () => {
    try {
      const apiKey = currentProvider.needsKey ? local.apiKey?.trim() ?? '' : '';
      await saveProviderApiKey(local.provider, apiKey);
      setModelConfig({ ...local, apiKey: apiKey || undefined });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (error) {
      setTestResult({ ok: false, message: String(error) });
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const r = await testConnection(local);
    setTestResult(r);
    setTesting(false);
  };

  const discover = async () => {
    setDiscovering(true);
    const models = await discoverModels(local);
    setFoundModels(models);
    setDiscovering(false);
  };

  const showEndpoint = local.provider !== 'anthropic' && local.provider !== 'google';

  return (
    <div className="space-y-5 px-4 py-4">
      {/* Provider picker */}
      <div>
        <Label>Provider</Label>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => selectProvider(p.id)}
              className={`rounded-xl border px-3 py-2.5 text-left text-[12px] transition ${
                local.provider === p.id
                  ? 'border-[rgba(255,109,43,0.4)] bg-[rgba(255,109,43,0.1)] text-white'
                  : 'border-white/8 bg-white/[0.02] text-slate-400 hover:border-white/12 hover:text-slate-200'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Endpoint (not shown for hosted providers) */}
      {showEndpoint && (
        <div>
          <Label>Endpoint URL</Label>
          <Input
            value={local.endpoint}
            onChange={(v) => setLocal({ ...local, endpoint: v })}
            placeholder="http://localhost:1234/v1"
          />
        </div>
      )}

      {/* Model */}
      <div>
        <div className="flex items-center justify-between">
          <Label>Model</Label>
          <button
            onClick={discover}
            disabled={discovering}
            className="text-[10px] text-slate-500 transition hover:text-slate-300 disabled:opacity-40"
          >
            {discovering ? 'Fetching…' : 'Discover →'}
          </button>
        </div>
        <Input
          value={local.model}
          onChange={(v) => setLocal({ ...local, model: v })}
          placeholder={currentProvider.model || 'Discover Models or enter an exact model id'}
        />
        {local.provider === 'lmstudio' && (
          <p className="mt-2 text-[11px] leading-5 text-slate-500">
            In LM Studio, load a model and start the local server first. Then click `Discover`.
          </p>
        )}
        {foundModels.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {foundModels.map((m) => (
              <button
                key={m}
                onClick={() => setLocal({ ...local, model: m })}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
                  local.model === m
                    ? 'border-[rgba(255,109,43,0.4)] bg-[rgba(255,109,43,0.1)] text-orange-200'
                    : 'border-white/8 text-slate-500 hover:text-slate-200'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* API Key (shown when provider needs it) */}
      {currentProvider.needsKey && (
        <div>
          <Label>API Key</Label>
          <Input
            value={local.apiKey ?? ''}
            onChange={(v) => setLocal({ ...local, apiKey: v })}
            placeholder="sk-… / API key"
            type="password"
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Btn label={saved ? '✓ Saved' : 'Save'} onClick={save} />
        <Btn label={testing ? 'Testing…' : 'Test'} onClick={test} disabled={testing} muted />
      </div>

      {testResult && (
        <div className={`rounded-xl border px-3 py-2 text-[11px] font-mono ${
          testResult.ok
            ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-300'
            : 'border-red-500/20 bg-red-500/[0.06] text-red-300'
        }`}>
          {testResult.message}
        </div>
      )}
    </div>
  );
}

// ── Runtime ───────────────────────────────────────────────────────────────────

function RuntimeSection() {
  const { containerName } = usePersistedStore(useShallow((state) => ({
    containerName: state.containerName,
  })));
  const { containerStatus, setContainerStatus, setRuntimeHealth, addTerminalLine, runtimeHealth } = useEphemeralStore(
    useShallow((state) => ({
      containerStatus: state.containerStatus,
      setContainerStatus: state.setContainerStatus,
      setRuntimeHealth: state.setRuntimeHealth,
      addTerminalLine: state.addTerminalLine,
      runtimeHealth: state.runtimeHealth,
    })),
  );

  const [logs, setLogs] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const doStart = async () => {
    setErrorMsg(null);
    setContainerStatus('starting');
    try {
      const health = await startContainer(containerName);
      setRuntimeHealth(health);
      setContainerStatus(health.containerStatus);
    } catch (e) {
      const msg = String(e);
      setContainerStatus('error');
      setErrorMsg(msg);
      addTerminalLine({ id: crypto.randomUUID(), type: 'error', content: msg, timestamp: Date.now() });
    }
  };

  const doStop = async () => {
    setErrorMsg(null);
    setContainerStatus('stopping');
    try {
      await stopContainer(containerName);
      setContainerStatus('stopped');
    } catch (e) {
      const msg = String(e);
      setContainerStatus('error');
      setErrorMsg(msg);
      addTerminalLine({ id: crypto.randomUUID(), type: 'error', content: msg, timestamp: Date.now() });
    }
  };

  const viewLogs = async () => {
    const l = await getContainerLogs(containerName, 150);
    setLogs(l || '(no output)');
  };

  const statusColor: Record<string, string> = {
    running: 'text-emerald-400',
    stopped: 'text-slate-600',
    starting: 'text-amber-400',
    stopping: 'text-amber-400',
    error: 'text-red-400',
  };

  return (
    <div className="space-y-4 px-4 py-4">
      {/* Status row */}
      <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
        <span className={`text-xl leading-none ${statusColor[containerStatus] ?? 'text-slate-600'}`}>●</span>
        <div>
          <p className="text-[12px] capitalize text-slate-200">{containerStatus}</p>
          <p className="font-mono text-[10px] text-slate-600">{containerName}</p>
        </div>
      </div>

      {runtimeHealth && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <InfoChip label="Docker" value={runtimeHealth.dockerStatus} />
          <InfoChip label="Image" value={runtimeHealth.imageTag} mono />
          <InfoChip label="Workspace" value={runtimeHealth.sharedPath || '/workspace'} mono />
          <InfoChip label="Config" value={runtimeHealth.configPath || '—'} mono />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Btn label="Start" onClick={doStart} disabled={containerStatus === 'running' || containerStatus === 'starting'} />
        <Btn label="Stop" onClick={doStop} disabled={containerStatus === 'stopped' || containerStatus === 'stopping'} muted />
        <Btn label="View Logs" onClick={viewLogs} muted />
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2.5">
          <p className="mb-1 text-[10px] uppercase tracking-widest text-red-400">Error</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-red-300/80">{errorMsg}</pre>
        </div>
      )}

      {logs !== null && (
        <div>
          <div className="flex items-center justify-between pb-1">
            <span className="text-[10px] uppercase tracking-widest text-slate-600">Container output</span>
            <button onClick={() => setLogs(null)} className="text-[11px] text-slate-700 hover:text-slate-400">close</button>
          </div>
          <pre className="max-h-56 overflow-y-auto rounded-xl border border-white/8 bg-black/30 px-3 py-2.5 font-mono text-[11px] leading-[1.6] text-emerald-300 scrollbar-thin">
            {logs}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Behavior ─────────────────────────────────────────────────────────────────

function BehaviorSection() {
  const { appearance, setAppearance } = usePersistedStore(useShallow((state) => ({
    appearance: state.appearance,
    setAppearance: state.setAppearance,
  })));

  const toggleAlwaysOnTop = async () => {
    const next = !appearance.alwaysOnTop;
    setAppearance({ alwaysOnTop: next });
    try {
      await getCurrentWindow().setAlwaysOnTop(next);
    } catch {
      setAppearance({ alwaysOnTop: !next });
    }
  };

  return (
    <div className="space-y-5 px-4 py-4">
      <div className="space-y-2">
        <Label>Window</Label>
        <Toggle
          label="Always on top"
          description="Toolbar floats above other windows"
          active={appearance.alwaysOnTop}
          onToggle={toggleAlwaysOnTop}
        />
        <Toggle
          label="Launch expanded"
          description="Open with chat panel visible on start"
          active={appearance.launchExpanded}
          onToggle={() => setAppearance({ launchExpanded: !appearance.launchExpanded })}
        />
        <Toggle
          label="Collapse on click away"
          description="Panel closes when the window loses focus"
          active={appearance.collapseOnBlur}
          onToggle={() => setAppearance({ collapseOnBlur: !appearance.collapseOnBlur })}
        />
      </div>

      <div>
        <Label>Toolbar width — {appearance.toolbarWidth}px</Label>
        <input
          type="range" min={520} max={1100} step={20}
          value={appearance.toolbarWidth}
          onChange={(e) => setAppearance({ toolbarWidth: Number(e.target.value) })}
          className="mt-2 w-full accent-[var(--ember-orange)]"
        />
      </div>

      <div>
        <Label>Panel height — {appearance.panelHeight}px</Label>
        <input
          type="range" min={400} max={900} step={20}
          value={appearance.panelHeight}
          onChange={(e) => setAppearance({ panelHeight: Number(e.target.value) })}
          className="mt-2 w-full accent-[var(--ember-orange)]"
        />
      </div>
    </div>
  );
}

// ── Shared components ────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{children}</p>
  );
}

function Input({
  value, onChange, placeholder, type = 'text',
}: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="mt-1.5 w-full rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2 text-[12px] text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-white/15"
    />
  );
}

function Btn({
  label, onClick, muted, disabled,
}: { label: string; onClick?: () => void; muted?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-4 py-1.5 text-[11px] font-medium transition disabled:opacity-30 ${
        muted
          ? 'border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.07]'
          : 'bg-[var(--ember-orange)] text-white hover:bg-[var(--ember-orange-strong)]'
      }`}
    >
      {label}
    </button>
  );
}

function InfoChip({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
      <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className={`mt-0.5 truncate text-[11px] text-slate-300 ${mono ? 'font-mono' : ''}`} title={value}>{value}</p>
    </div>
  );
}

function Toggle({
  label, description, active, onToggle,
}: { label: string; description: string; active: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left transition ${
        active
          ? 'border-[rgba(255,109,43,0.3)] bg-[rgba(255,109,43,0.08)]'
          : 'border-white/8 bg-white/[0.02] hover:border-white/12'
      }`}
    >
      <div>
        <p className="text-[12px] text-slate-200">{label}</p>
        <p className="text-[10px] text-slate-600">{description}</p>
      </div>
      <div className={`h-4 w-7 rounded-full border transition-colors ${
        active ? 'border-[rgba(255,109,43,0.5)] bg-[rgba(255,109,43,0.3)]' : 'border-white/15 bg-white/[0.06]'
      }`}>
        <div className={`mt-px h-3 w-3 rounded-full transition-transform ${
          active ? 'translate-x-3 bg-[var(--ember-orange)]' : 'translate-x-0.5 bg-slate-500'
        }`} />
      </div>
    </button>
  );
}

// ── Session log ───────────────────────────────────────────────────────────────

function SessionSection() {
  const { sessionLog, clearSessionLog } = useEphemeralStore(useShallow((state) => ({
    sessionLog: state.sessionLog,
    clearSessionLog: state.clearSessionLog,
  })));

  const typeColor: Record<string, string> = {
    user:   'text-[#5f8fff]',
    agent:  'text-[#4caf78]',
    tool:   'text-[#f5a623]',
    system: 'text-slate-500',
  };

  return (
    <div className="flex flex-col h-full px-4 py-4 space-y-3">
      <div className="flex items-center justify-between">
        <Label>Session events</Label>
        <button
          onClick={clearSessionLog}
          className="text-[11px] text-slate-500 hover:text-red-400 transition-colors"
        >
          clear
        </button>
      </div>
      <p className="text-[10px] text-slate-500 -mt-1">
        Live transcript of this session — cleared on reload. {sessionLog.length} event{sessionLog.length !== 1 ? 's' : ''}.
      </p>
      <div className="flex-1 overflow-y-auto space-y-1">
        {sessionLog.length === 0 && (
          <p className="text-slate-400 text-[12px] pt-2">No events yet.</p>
        )}
        {sessionLog.slice().reverse().map((e) => (
          <div key={e.id} className="py-1.5 border-b border-white/6 last:border-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className={`text-[10px] font-mono uppercase ${typeColor[e.type] ?? 'text-slate-500'}`}>
                {e.type}
              </span>
              <span className="text-[10px] text-slate-500">
                {new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed line-clamp-2 break-words">
              {e.content}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
