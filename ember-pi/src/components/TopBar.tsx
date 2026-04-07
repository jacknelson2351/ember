import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { useAppStore } from '../stores/appStore';
import type { Panel, ContainerStatus, AgentStatus } from '../types';
import { startContainer, stopContainer } from '../services/container';

const EXPANDED_H = 680;
const COLLAPSED_H = 44;

export async function expandWindow() {
  const win = getCurrentWindow();
  const w = (await win.outerSize()).width / (await win.scaleFactor());
  await win.setSize(new LogicalSize(w, EXPANDED_H));
}

export async function collapseWindow() {
  const win = getCurrentWindow();
  const w = (await win.outerSize()).width / (await win.scaleFactor());
  await win.setSize(new LogicalSize(w, COLLAPSED_H));
}

export async function hideWindow() {
  await getCurrentWindow().hide();
}

// ── Icons ────────────────────────────────────────────────────────────────────

function ChatIcon()     { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v7a1 1 0 01-1 1H9l-3 2v-2H3a1 1 0 01-1-1V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>; }
function TerminalIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3.5h12M2 3.5v9h12v-9M6 8l-2 1.5 2 1.5M9 11h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ThoughtsIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3"/><circle cx="5.5" cy="12.5" r="1" stroke="currentColor" strokeWidth="1.2"/><circle cx="3.5" cy="14" r="0.75" stroke="currentColor" strokeWidth="1"/></svg>; }
function FilesIcon()    { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3.5a1 1 0 01.75-.75H4.5l1 1H13a1 1 0 011 1v5.5a1 1 0 01-1 1H3a1 1 0 01-1-1V3.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>; }
function MemoryIcon()   { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="5" rx="5" ry="2.2" stroke="currentColor" strokeWidth="1.3"/><path d="M3 5v3c0 1.2 2.24 2.2 5 2.2S13 9.2 13 8V5" stroke="currentColor" strokeWidth="1.3"/><path d="M3 8v3c0 1.2 2.24 2.2 5 2.2S13 12.2 13 11V8" stroke="currentColor" strokeWidth="1.3"/></svg>; }
function SettingsIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3"/><path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M3.4 12.6l.7-.7M11.9 4.1l.7-.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>; }
function ChevronDownIcon() { return <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ChevronUpIcon()   { return <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 6.5l3-3 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>; }

const NAV_ITEMS: { id: Panel; icon: React.ReactNode; title: string }[] = [
  { id: 'chat',     icon: <ChatIcon />,     title: 'Chat ⌃1' },
  { id: 'terminal', icon: <TerminalIcon />, title: 'Terminal ⌃2' },
  { id: 'thoughts', icon: <ThoughtsIcon />, title: 'Thoughts ⌃3' },
  { id: 'files',    icon: <FilesIcon />,    title: 'Files ⌃4' },
  { id: 'memory',   icon: <MemoryIcon />,   title: 'Memory ⌃5' },
  { id: 'settings', icon: <SettingsIcon />, title: 'Settings ⌃6' },
];

// ── Status dot ────────────────────────────────────────────────────────────────

function statusDotColor(s: ContainerStatus | AgentStatus | string) {
  switch (s) {
    case 'running': case 'idle': return 'bg-[#4caf78]';
    case 'starting': case 'stopping': return 'bg-[#f5a623] animate-pulse';
    case 'error': return 'bg-[#e05252]';
    default: return 'bg-[#2a2a2a]';
  }
}

// ── TopBar ────────────────────────────────────────────────────────────────────

interface TopBarProps {
  expanded: boolean;
  onToggle: () => void;
}

export function TopBar({ expanded, onToggle }: TopBarProps) {
  const {
    activePanel,
    setActivePanel,
    containerStatus,
    agentStatus,
    modelConfig,
    containerName,
    setContainerStatus,
  } = useAppStore();

  const selectPanel = (id: Panel) => {
    setActivePanel(id);
    if (!expanded) onToggle();
  };

  const toggleContainer = async () => {
    if (containerStatus === 'running') {
      setContainerStatus('stopping');
      try { await stopContainer(containerName); setContainerStatus('stopped'); }
      catch { setContainerStatus('error'); }
    } else if (containerStatus === 'stopped' || containerStatus === 'error') {
      setContainerStatus('starting');
      try { await startContainer(containerName); setContainerStatus('running'); }
      catch { setContainerStatus('error'); }
    }
  };

  return (
    <div
      data-tauri-drag-region
      className="flex items-center h-11 px-2.5 gap-1.5 border-b border-[#181818] bg-[#080808] flex-shrink-0 select-none"
    >
      {/* Brand */}
      <div data-tauri-drag-region className="flex items-center gap-1.5 pr-1.5 flex-shrink-0">
        <span className="w-[18px] h-[18px] rounded-[4px] bg-[#e85c2a] flex items-center justify-center text-[9px] font-black text-white tracking-tighter">
          E
        </span>
        <span className="text-[10px] text-[#2a2a2a] font-semibold tracking-widest uppercase hidden sm:block">
          Ember
        </span>
      </div>

      <Divider />

      {/* Nav icons */}
      <div className="flex items-center gap-0.5">
        {NAV_ITEMS.map((item) => {
          const active = activePanel === item.id && expanded;
          return (
            <button
              key={item.id}
              onClick={() => selectPanel(item.id)}
              title={item.title}
              className={`
                w-7 h-7 rounded flex items-center justify-center transition-colors
                ${active
                  ? 'bg-[#1a1a1a] text-[#e2e2e2]'
                  : 'text-[#3a3a3a] hover:text-[#888] hover:bg-[#111]'}
              `}
            >
              {item.icon}
              {active && (
                <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-0.5 rounded bg-[#e85c2a]" />
              )}
            </button>
          );
        })}
      </div>

      {/* Spacer — drag region */}
      <div data-tauri-drag-region className="flex-1 h-full" />

      {/* Status dots */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <StatusDot
          color={statusDotColor(containerStatus)}
          title={`Container: ${containerStatus}`}
          onClick={toggleContainer}
        />
        <StatusDot
          color={statusDotColor(agentStatus)}
          title={`Agent: ${agentStatus}`}
        />
        <StatusDot
          color="bg-[#5f8fff]"
          title={`Model: ${modelConfig.model}`}
          onClick={() => selectPanel('settings')}
        />
      </div>

      <Divider />

      {/* Collapse / expand */}
      <button
        onClick={onToggle}
        title={expanded ? 'Collapse' : 'Expand'}
        className="w-6 h-6 rounded flex items-center justify-center text-[#2a2a2a] hover:text-[#888] hover:bg-[#111] transition-colors"
      >
        {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
      </button>

      {/* Hide */}
      <button
        onClick={hideWindow}
        title="Hide (click tray icon to reopen)"
        className="w-6 h-6 rounded flex items-center justify-center text-[#2a2a2a] hover:text-[#888] hover:bg-[#111] transition-colors text-[13px] leading-none"
      >
        ×
      </button>
    </div>
  );
}

function Divider() {
  return <div className="w-px h-4 bg-[#1a1a1a] flex-shrink-0" />;
}

function StatusDot({
  color,
  title,
  onClick,
}: {
  color: string;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="relative group w-4 h-4 flex items-center justify-center"
    >
      <span className={`block w-[6px] h-[6px] rounded-full ${color}`} />
    </button>
  );
}
