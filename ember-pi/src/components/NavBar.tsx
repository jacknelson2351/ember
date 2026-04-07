import { useAppStore } from '../stores/appStore';
import type { Panel } from '../types';

interface NavItem {
  id: Panel;
  label: string;
  title: string;
  shortcut: string;
  icon: React.ReactNode;
}

function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v7a1 1 0 01-1 1H9l-3 2v-2H3a1 1 0 01-1-1V3z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/>
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 3.5h12M2 3.5v9h12v-9M6 8l-2 1.5 2 1.5M9 11h2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ThoughtsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.25"/>
      <circle cx="5.5" cy="12.5" r="1" stroke="currentColor" strokeWidth="1.25"/>
      <circle cx="3.5" cy="14" r="0.75" stroke="currentColor" strokeWidth="1"/>
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 3.5a1 1 0 011-1h3.5l1.5 1.5H13a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1v-7.5z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/>
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <ellipse cx="8" cy="5" rx="5" ry="2.5" stroke="currentColor" strokeWidth="1.25"/>
      <path d="M3 5v3c0 1.38 2.24 2.5 5 2.5S13 9.38 13 8V5" stroke="currentColor" strokeWidth="1.25"/>
      <path d="M3 8v3c0 1.38 2.24 2.5 5 2.5S13 12.38 13 11V8" stroke="currentColor" strokeWidth="1.25"/>
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.25"/>
      <path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M3.4 12.6l.7-.7M11.9 4.1l.7-.7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { id: 'chat',     label: 'CH', title: 'Chat (⌃1)',     shortcut: '⌃1', icon: <ChatIcon /> },
  { id: 'terminal', label: 'TM', title: 'Terminal (⌃2)', shortcut: '⌃2', icon: <TerminalIcon /> },
  { id: 'thoughts', label: 'TH', title: 'Thoughts (⌃3)', shortcut: '⌃3', icon: <ThoughtsIcon /> },
  { id: 'files',    label: 'FL', title: 'Files (⌃4)',    shortcut: '⌃4', icon: <FilesIcon /> },
  { id: 'memory',   label: 'ME', title: 'Memory (⌃5)',   shortcut: '⌃5', icon: <MemoryIcon /> },
  { id: 'settings', label: 'ST', title: 'Settings (⌃6)', shortcut: '⌃6', icon: <SettingsIcon /> },
];

export function NavBar() {
  const { activePanel, setActivePanel } = useAppStore();

  return (
    <nav className="flex flex-col items-center gap-1 py-2 flex-1">
      {NAV_ITEMS.map((item) => {
        const active = activePanel === item.id;
        return (
          <button
            key={item.id}
            onClick={() => setActivePanel(item.id)}
            title={item.title}
            className={`
              relative w-9 h-9 rounded-md flex items-center justify-center
              transition-colors duration-100 group
              ${active
                ? 'bg-[#1e1e1e] text-[#e85c2a]'
                : 'text-[#4a4a4a] hover:text-[#a0a0a0] hover:bg-[#141414]'}
            `}
          >
            {active && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-r bg-[#e85c2a]" />
            )}
            {item.icon}

            {/* Tooltip */}
            <span className="
              pointer-events-none absolute left-full ml-2 px-2 py-1 rounded
              bg-[#1e1e1e] border border-[#2a2a2a] text-[#c0c0c0] text-[11px]
              whitespace-nowrap opacity-0 group-hover:opacity-100
              transition-opacity duration-100 z-50
            ">
              {item.title.split(' (')[0]}
              <span className="ml-1.5 text-[#4a4a4a] font-mono">{item.shortcut}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
