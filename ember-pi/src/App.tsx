import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useShallow } from 'zustand/react/shallow';
import { useEphemeralStore, usePersistedStore } from './stores/appStore';
import { ChatPanel } from './components/ChatPanel';
import { FilesPanel } from './components/FilesPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { CoalfireBrand } from './components/CoalfireBrand';
import { getRuntimeHealth } from './services/container';
import { loadProviderApiKey } from './services/secrets';
import type { Panel } from './types';

const PILL_HEIGHT = 58;
const BOTTOM_MARGIN = 0;
const PANEL_GAP = 12;
const COLLAPSED_WINDOW_HEIGHT = PILL_HEIGHT;

const PANEL_KEYS: Record<string, Panel> = {
  '1': 'chat',
  '2': 'files',
  '3': 'memory',
  '4': 'settings',
};

const PANEL_ITEMS: { id: Panel; title: string; icon: React.ReactNode }[] = [
  { id: 'chat', title: 'Chat', icon: <ChatIcon /> },
  { id: 'files', title: 'Files', icon: <FilesIcon /> },
  { id: 'memory', title: 'Memory', icon: <MemoryIcon /> },
  { id: 'settings', title: 'Settings', icon: <SettingsIcon /> },
];

async function quitWindow() {
  try {
    await invoke('quit_app');
  } catch {
    await getCurrentWindow().close().catch(() => {});
  }
}

async function syncShellSize(width: number, height: number) {
  const win = getCurrentWindow();
  // Read current position before resizing — macOS anchors the bottom-left when
  // setSize is called without an explicit position, which moves the toolbar up.
  // Re-applying the position keeps the top-left fixed so the window grows down.
  const [pos, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
  const logicalX = pos.x / scale;
  const logicalY = pos.y / scale;
  await win.setSize(new LogicalSize(width, height));
  await win.setPosition(new LogicalPosition(logicalX, logicalY));
}

export default function App() {
  const { activePanel, setActivePanel, setContainerStatus, setRuntimeHealth } = useEphemeralStore(
    useShallow((state) => ({
      activePanel: state.activePanel,
      setActivePanel: state.setActivePanel,
      setContainerStatus: state.setContainerStatus,
      setRuntimeHealth: state.setRuntimeHealth,
    })),
  );

  const {
    containerName,
    appearance,
    modelProvider,
    setModelConfig,
  } = usePersistedStore(
    useShallow((state) => ({
      containerName: state.containerName,
      appearance: state.appearance,
      modelProvider: state.modelConfig.provider,
      setModelConfig: state.setModelConfig,
    })),
  );

  const [expanded, setExpanded] = useState(appearance.launchExpanded);
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSizeRef = useRef<{ width: number; height: number } | null>(null);
  const dragInProgressRef = useRef(false);

  const flushQueuedShellSize = useCallback(() => {
    if (dragInProgressRef.current || !pendingSizeRef.current) return;
    const { width, height } = pendingSizeRef.current;
    pendingSizeRef.current = null;
    syncShellSize(width, height).catch(() => {});
  }, []);

  const queueShellSize = useCallback((width: number, height: number) => {
    pendingSizeRef.current = { width, height };
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      flushQueuedShellSize();
    }, 120);
  }, [flushQueuedShellSize]);

  const runToolbarAction = useCallback((event: React.MouseEvent | React.KeyboardEvent, action: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  }, []);

  const startShellDrag = useCallback((event: React.MouseEvent | React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragInProgressRef.current = true;
    getCurrentWindow()
      .startDragging()
      .catch(() => {})
      .finally(() => {
        dragInProgressRef.current = false;
        flushQueuedShellSize();
      });
  }, [flushQueuedShellSize]);

  const poll = useCallback(async () => {
    const health = await getRuntimeHealth(containerName);
    setRuntimeHealth(health);
    setContainerStatus(health.containerStatus);
  }, [containerName, setContainerStatus, setRuntimeHealth]);

  const togglePanel = useCallback((panel: Panel) => {
    if (expanded && activePanel === panel) {
      setExpanded(false);
      return;
    }

    setActivePanel(panel);
    setExpanded(true);
  }, [activePanel, expanded, setActivePanel]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return;
      if (PANEL_KEYS[event.key]) {
        event.preventDefault();
        togglePanel(PANEL_KEYS[event.key]);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [togglePanel]);

  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${appearance.fontSize}px`);
    document.documentElement.style.setProperty('--app-mono-font', appearance.monoFont);
    document.documentElement.style.setProperty('--app-shell-font', '"Avenir Next", "Segoe UI", sans-serif');
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    const window = getCurrentWindow();
    window.setAlwaysOnTop(appearance.alwaysOnTop).catch(() => {});
    window.setBackgroundColor([0, 0, 0, 0]).catch(() => {});
    getCurrentWebview().setBackgroundColor([0, 0, 0, 0]).catch(() => {});
  }, [appearance.alwaysOnTop, appearance.fontSize, appearance.monoFont]);

  // Resize window when panel opens/closes or dimensions change.
  // Reads current position first so the window grows downward, not upward.
  useEffect(() => {
    const height = expanded
      ? PILL_HEIGHT + PANEL_GAP + appearance.panelHeight + BOTTOM_MARGIN
      : COLLAPSED_WINDOW_HEIGHT;

    queueShellSize(appearance.toolbarWidth, height);
  }, [appearance.panelHeight, appearance.toolbarWidth, expanded, queueShellSize]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      await poll();
      if (!cancelled) {
        pollTimerRef.current = setTimeout(run, 8000);
      }
    };

    run();

    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [poll]);

  useEffect(() => {
    let cancelled = false;

    loadProviderApiKey(modelProvider)
      .then((apiKey) => {
        if (cancelled) return;
        const current = usePersistedStore.getState().modelConfig;
        if (current.provider !== modelProvider) return;
        if ((current.apiKey ?? '') === apiKey) return;
        setModelConfig({ ...current, apiKey: apiKey || undefined });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [modelProvider, setModelConfig]);

  // Collapse panel when window loses focus — but not if a native dialog (e.g. file picker) is open.
  // When focus returns, always clear the suppress flag so it doesn't get stuck.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        const { suppressBlurCollapse } = useEphemeralStore.getState();
        if (!suppressBlurCollapse && appearanceRef.current.collapseOnBlur) {
          setExpanded(false);
        }
      } else {
        useEphemeralStore.getState().setSuppressBlurCollapse(false);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => () => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent">
      <div className="flex h-full flex-col items-center">
        <header
          className="flex h-[58px] w-full select-none items-center gap-3 rounded-full border border-white/12 bg-[#0f141e] px-4 shadow-[0_22px_60px_rgba(0,0,0,0.42)]"
        >
          <button
            type="button"
            onMouseDown={startShellDrag}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') startShellDrag(event);
            }}
            className="pill-button cursor-grab text-slate-300 active:cursor-grabbing"
            title="Drag toolbar"
          >
            <DragHandleIcon />
          </button>

          <button
            type="button"
            onClick={(event) => runToolbarAction(event, () => togglePanel('chat'))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                runToolbarAction(event, () => togglePanel('chat'));
              }
            }}
            className="flex min-w-0 shrink-0 items-center gap-3 rounded-full px-1.5 py-1 transition hover:bg-white/[0.04]"
            title="Open chat"
          >
            <CoalfireBrand compact />
          </button>

          <div className="min-h-full flex-1" />

          <nav className="flex shrink-0 items-center gap-1 rounded-full bg-white/[0.04] p-1">
            {PANEL_ITEMS.map((item) => (
              <ToolbarTab
                key={item.id}
                label={item.title}
                icon={item.icon}
                active={expanded && activePanel === item.id}
                onPress={(event) => runToolbarAction(event, () => togglePanel(item.id))}
              />
            ))}
          </nav>

          <div className="min-h-full flex-1" />

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={(event) => runToolbarAction(event, () => setExpanded((value) => !value))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  runToolbarAction(event, () => setExpanded((value) => !value));
                }
              }}
              className="pill-button text-slate-200"
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </button>
            <button
              type="button"
              onClick={(event) => runToolbarAction(event, quitWindow)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  runToolbarAction(event, quitWindow);
                }
              }}
              className="pill-button text-slate-200"
              title="Quit"
            >
              ×
            </button>
          </div>
        </header>

        {expanded && (
          <main className="mt-3 flex min-h-0 w-full flex-1 overflow-hidden rounded-[28px] border border-white/10 bg-[#0a0f19] shadow-[0_28px_80px_rgba(0,0,0,0.5)]">
            <div className="h-full min-h-0 w-full">
              {activePanel === 'chat' && <ChatPanel />}
              {activePanel === 'files' && <FilesPanel />}
              {activePanel === 'memory' && <MemoryPanel />}
              {activePanel === 'settings' && <SettingsPanel />}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}

function ToolbarTab({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onPress: (event: React.MouseEvent | React.KeyboardEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onPress(event);
      }}
      className={`flex h-9 items-center gap-2 rounded-full px-3 text-[12px] font-medium transition ${
        active
          ? 'bg-[rgba(255,109,43,0.18)] text-white'
          : 'text-slate-300 hover:bg-white/[0.08] hover:text-white'
      }`}
    >
      {icon}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

function DragHandleIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="3" cy="3" r="1" fill="currentColor" />
      <circle cx="9" cy="3" r="1" fill="currentColor" />
      <circle cx="3" cy="6" r="1" fill="currentColor" />
      <circle cx="9" cy="6" r="1" fill="currentColor" />
      <circle cx="3" cy="9" r="1" fill="currentColor" />
      <circle cx="9" cy="9" r="1" fill="currentColor" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v7a1 1 0 01-1 1H9l-3 2v-2H3a1 1 0 01-1-1V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 3.5a1 1 0 01.75-.75H4.5l1 1H13a1 1 0 011 1v5.5a1 1 0 01-1 1H3a1 1 0 01-1-1V3.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <ellipse cx="8" cy="5" rx="5" ry="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 5v3c0 1.2 2.24 2.2 5 2.2S13 9.2 13 8V5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 8v3c0 1.2 2.24 2.2 5 2.2S13 12.2 13 11V8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M6.5 1.5h3l.45 1.75c.4.14.77.33 1.12.57l1.68-.65 1.5 2.6-1.28 1.08c.05.3.08.6.08.92 0 .3-.03.6-.08.9l1.28 1.1-1.5 2.58-1.68-.65c-.35.24-.72.43-1.12.57L9.5 14h-3l-.45-1.73a4.9 4.9 0 01-1.12-.57l-1.68.65-1.5-2.58 1.28-1.1A4.8 4.8 0 012.95 8c0-.32.03-.62.08-.92L1.75 5.97l1.5-2.6 1.68.65c.35-.24.72-.43 1.12-.57L6.5 1.5z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 6.5l3-3 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
