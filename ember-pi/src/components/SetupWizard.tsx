import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { CoalfireBrand } from './CoalfireBrand';
import { discoverModels, testConnection } from '../services/llm';
import type { ModelConfig, RuntimeHealth } from '../types';

interface SetupWizardProps {
  runtimeHealth: RuntimeHealth | null;
  ensuringRuntime: boolean;
  onEnsureRuntime: () => Promise<void>;
  onRefreshRuntime: () => Promise<unknown>;
}

const PROVIDERS: {
  id: ModelConfig['provider'];
  label: string;
  eyebrow: string;
  description: string;
  endpoint: string;
  model: string;
  keyPlaceholder: string;
}[] = [
  {
    id: 'lmstudio',
    label: 'LM Studio',
    eyebrow: 'Local desktop',
    description: 'Best local-first path. Assumes a local OpenAI-compatible endpoint on port 1234.',
    endpoint: 'http://localhost:1234/v1',
    model: 'local-model',
    keyPlaceholder: 'Not required',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    eyebrow: 'Local runtime',
    description: 'Targets a local Ollama instance running with the OpenAI compatibility layer.',
    endpoint: 'http://localhost:11434/v1',
    model: 'llama3.2',
    keyPlaceholder: 'Not required',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    eyebrow: 'Hosted API',
    description: 'Use OpenAI directly with a saved API key.',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    eyebrow: 'Hosted API',
    description: 'Use Anthropic directly with its native API.',
    endpoint: 'https://api.anthropic.com',
    model: 'claude-opus-4-6',
    keyPlaceholder: 'sk-ant-...',
  },
  {
    id: 'custom',
    label: 'OpenAI-Compatible',
    eyebrow: 'Custom endpoint',
    description: 'Works with any OpenAI-compatible server, gateway, or proxy.',
    endpoint: '',
    model: '',
    keyPlaceholder: 'Optional',
  },
];

function readinessTone(runtimeHealth: RuntimeHealth | null) {
  if (!runtimeHealth) {
    return { label: 'Checking runtime', tone: 'border-white/10 bg-white/5 text-white/80' };
  }

  switch (runtimeHealth.dockerStatus) {
    case 'ready':
      if (runtimeHealth.containerStatus === 'running') {
        return { label: 'Runtime online', tone: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' };
      }
      return { label: 'Docker ready', tone: 'border-amber-400/30 bg-amber-400/10 text-amber-100' };
    case 'missing':
      return { label: 'Docker missing', tone: 'border-rose-500/30 bg-rose-500/10 text-rose-200' };
    case 'daemon_offline':
      return { label: 'Docker not running', tone: 'border-amber-400/30 bg-amber-400/10 text-amber-100' };
    default:
      return { label: 'Runtime unavailable', tone: 'border-white/10 bg-white/5 text-white/80' };
  }
}

export function SetupWizard({
  runtimeHealth,
  ensuringRuntime,
  onEnsureRuntime,
  onRefreshRuntime,
}: SetupWizardProps) {
  const { modelConfig, setModelConfig, setSetupComplete } = useAppStore();
  const [draft, setDraft] = useState<ModelConfig>(modelConfig);
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [connectionResult, setConnectionResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    setDraft(modelConfig);
  }, [modelConfig]);

  const tone = readinessTone(runtimeHealth);
  const runtimeReady =
    runtimeHealth?.dockerStatus === 'ready' && runtimeHealth.containerStatus === 'running';
  const canFinish = runtimeReady && connectionResult?.ok;

  const providerMeta = useMemo(
    () => PROVIDERS.find((provider) => provider.id === draft.provider) ?? PROVIDERS[0],
    [draft.provider]
  );

  const chooseProvider = (provider: (typeof PROVIDERS)[number]) => {
    setDiscoveredModels([]);
    setConnectionResult(null);
    setDraft((current) => ({
      ...current,
      provider: provider.id,
      endpoint: provider.id === 'anthropic' ? current.endpoint : provider.endpoint,
      model: provider.model,
      apiKey:
        provider.id === 'lmstudio' || provider.id === 'ollama'
          ? ''
          : current.apiKey ?? '',
    }));
  };

  const runConnectionTest = async () => {
    setTesting(true);
    setConnectionResult(null);
    const result = await testConnection(draft);
    setConnectionResult({ ok: result.ok, message: result.message });
    setTesting(false);
    if (result.ok) setModelConfig(draft);
  };

  const discoverAvailableModels = async () => {
    setDiscovering(true);
    const models = await discoverModels(draft);
    setDiscoveredModels(models);
    setDiscovering(false);
  };

  const finishSetup = () => {
    if (!canFinish) return;
    setModelConfig(draft);
    setSetupComplete(true);
  };

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-8">
      <div className="relative w-full max-w-5xl overflow-hidden rounded-[32px] border border-white/12 bg-[#07101d]/92 shadow-[0_50px_120px_rgba(0,0,0,0.58)] backdrop-blur-xl">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,109,43,0.2),transparent_38%),radial-gradient(circle_at_top_right,rgba(101,178,255,0.15),transparent_32%)]" />

        <div className="relative grid gap-8 p-8 lg:grid-cols-[1.1fr_1.3fr] lg:p-10">
          <div className="space-y-8">
            <div className="space-y-4">
              <CoalfireBrand />
              <div className={`inline-flex items-center rounded-full border px-3 py-1 text-[0.7rem] font-medium uppercase tracking-[0.24em] ${tone.tone}`}>
                {tone.label}
              </div>
              <div className="space-y-3">
                <h1 className="max-w-md text-4xl font-semibold leading-tight text-white">
                  Stand up the operator workspace once, then just point it at a model.
                </h1>
                <p className="max-w-xl text-sm leading-7 text-slate-300">
                  This setup flow makes Docker and model hookup the only moving pieces on a new machine.
                  LM Studio is treated as a first-class local option, not a fallback.
                </p>
              </div>
            </div>

            <div className="grid gap-3">
              <RuntimeChecklistItem
                step="1"
                title="Install Docker Desktop"
                description="Required for the isolated runtime used by terminal, files, and tooling."
                complete={runtimeHealth?.dockerStatus !== 'missing'}
              />
              <RuntimeChecklistItem
                step="2"
                title="Start Docker and prepare the runtime"
                description={runtimeHealth?.message || 'The app can build and create its runtime container automatically.'}
                complete={runtimeReady}
              />
              <RuntimeChecklistItem
                step="3"
                title="Validate your model connection"
                description="Pick a provider preset, verify connectivity, and the app will persist the config."
                complete={Boolean(connectionResult?.ok)}
              />
            </div>

            <div className="rounded-[24px] border border-white/10 bg-white/5 p-5">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={onEnsureRuntime}
                  disabled={ensuringRuntime || runtimeHealth?.dockerStatus === 'missing'}
                  className="rounded-full bg-[var(--ember-orange)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--ember-orange-strong)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {ensuringRuntime ? 'Preparing runtime…' : 'Build / Start Runtime'}
                </button>
                <button
                  onClick={onRefreshRuntime}
                  className="rounded-full border border-white/12 px-4 py-2 text-sm text-slate-200 transition hover:border-white/25 hover:bg-white/6"
                >
                  Refresh status
                </button>
              </div>
              {runtimeHealth && (
                <div className="mt-4 grid gap-3 text-sm text-slate-300 sm:grid-cols-3">
                  <PathInfo label="Workspace" value={runtimeHealth.sharedPath || 'Pending'} />
                  <PathInfo label="Config" value={runtimeHealth.configPath || 'Pending'} />
                  <PathInfo label="Memory" value={runtimeHealth.memoryPath || 'Pending'} />
                </div>
              )}
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-[28px] border border-white/12 bg-[#0b1628]/88 p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[0.7rem] uppercase tracking-[0.26em] text-slate-400">Provider Presets</p>
                  <h2 className="mt-2 text-xl font-semibold text-white">Pick the model path</h2>
                </div>
                <span className="rounded-full border border-[#ff6d2b33] bg-[#ff6d2b14] px-3 py-1 text-[0.7rem] font-medium uppercase tracking-[0.22em] text-[#ffd3b4]">
                  LM Studio ready
                </span>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {PROVIDERS.map((provider) => {
                  const active = draft.provider === provider.id;
                  return (
                    <button
                      key={provider.id}
                      onClick={() => chooseProvider(provider)}
                      className={`rounded-[22px] border p-4 text-left transition ${
                        active
                          ? 'border-[var(--ember-orange)] bg-[linear-gradient(180deg,rgba(255,109,43,0.2),rgba(255,109,43,0.07))] shadow-[0_12px_28px_rgba(255,109,43,0.14)]'
                          : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]'
                      }`}
                    >
                      <p className="text-[0.68rem] uppercase tracking-[0.24em] text-slate-400">{provider.eyebrow}</p>
                      <p className="mt-2 text-base font-medium text-white">{provider.label}</p>
                      <p className="mt-2 text-sm leading-6 text-slate-300">{provider.description}</p>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 grid gap-4">
                {draft.provider !== 'anthropic' && (
                  <FormField label="Endpoint URL">
                    <input
                      value={draft.endpoint}
                      onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                      placeholder={providerMeta.endpoint || 'http://localhost:1234/v1'}
                      className="wizard-input"
                    />
                  </FormField>
                )}

                <FormField label="Model name">
                  <input
                    value={draft.model}
                    onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                    placeholder={providerMeta.model || 'Enter a model id'}
                    className="wizard-input"
                  />
                </FormField>

                <FormField label="API key">
                  <input
                    type="password"
                    value={draft.apiKey ?? ''}
                    onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                    placeholder={providerMeta.keyPlaceholder}
                    className="wizard-input"
                  />
                </FormField>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  onClick={runConnectionTest}
                  disabled={testing}
                  className="rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {testing ? 'Testing…' : 'Test Connection'}
                </button>
                <button
                  onClick={discoverAvailableModels}
                  disabled={discovering}
                  className="rounded-full border border-white/12 px-4 py-2 text-sm text-slate-200 transition hover:border-white/25 hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {discovering ? 'Checking models…' : 'Discover Models'}
                </button>
                {connectionResult && (
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${
                    connectionResult.ok
                      ? 'bg-emerald-500/14 text-emerald-200'
                      : 'bg-rose-500/14 text-rose-200'
                  }`}>
                    {connectionResult.message}
                  </span>
                )}
              </div>

              {discoveredModels.length > 0 && (
                <div className="mt-5 flex flex-wrap gap-2">
                  {discoveredModels.map((model) => (
                    <button
                      key={model}
                      onClick={() => setDraft({ ...draft, model })}
                      className={`rounded-full border px-3 py-1.5 text-xs transition ${
                        draft.model === model
                          ? 'border-[var(--ember-orange)] bg-[var(--ember-orange-soft)] text-white'
                          : 'border-white/12 bg-white/[0.03] text-slate-200 hover:border-white/25'
                      }`}
                    >
                      {model}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-slate-400">Ready State</p>
                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    Finish setup once both the runtime and model connection validate successfully.
                  </p>
                </div>
                <button
                  onClick={finishSetup}
                  disabled={!canFinish}
                  className="rounded-full bg-[var(--ember-orange)] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-[var(--ember-orange-strong)] disabled:cursor-not-allowed disabled:opacity-35"
                >
                  Enter Coalfire Ember
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RuntimeChecklistItem({
  step,
  title,
  description,
  complete,
}: {
  step: string;
  title: string;
  description: string;
  complete: boolean;
}) {
  return (
    <div className="flex gap-4 rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-sm font-semibold ${
        complete ? 'bg-emerald-500/18 text-emerald-200' : 'bg-white/6 text-white/70'
      }`}>
        {complete ? '✓' : step}
      </div>
      <div>
        <p className="text-sm font-medium text-white">{title}</p>
        <p className="mt-1 text-sm leading-6 text-slate-300">{description}</p>
      </div>
    </div>
  );
}

function PathInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/10 px-3 py-3">
      <p className="text-[0.68rem] uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-2 break-all font-mono text-xs text-slate-200">{value}</p>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[0.72rem] font-medium uppercase tracking-[0.22em] text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}
