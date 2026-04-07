import { useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { startContainer, stopContainer } from '../services/container';
import type { ContainerStatus, AgentStatus } from '../types';

function statusColor(s: ContainerStatus | AgentStatus | string): string {
  switch (s) {
    case 'running':
    case 'idle':
      return 'bg-[#4caf78]';
    case 'starting':
    case 'stopping':
      return 'bg-[#f5a623] animate-pulse';
    case 'error':
      return 'bg-[#e05252]';
    default:
      return 'bg-[#3a3a3a]';
  }
}

export function StatusBar() {
  const {
    containerStatus,
    agentStatus,
    modelConfig,
    containerName,
    setContainerStatus,
    setActivePanel,
  } = useAppStore();

  const toggleContainer = useCallback(async () => {
    if (containerStatus === 'running') {
      setContainerStatus('stopping');
      try {
        await stopContainer(containerName);
        setContainerStatus('stopped');
      } catch {
        setContainerStatus('error');
      }
    } else if (containerStatus === 'stopped' || containerStatus === 'error') {
      setContainerStatus('starting');
      try {
        await startContainer(containerName);
        setContainerStatus('running');
      } catch {
        setContainerStatus('error');
      }
    }
  }, [containerStatus, containerName, setContainerStatus]);

  return (
    <div className="flex flex-col items-center gap-2 px-2 py-3 border-t border-[#1e1e1e]">
      {/* Container toggle button */}
      <button
        onClick={toggleContainer}
        disabled={containerStatus === 'starting' || containerStatus === 'stopping'}
        title={containerStatus === 'running' ? 'Stop container' : 'Start container'}
        className={`
          w-9 h-9 rounded-md flex items-center justify-center transition-colors
          disabled:opacity-30 disabled:cursor-not-allowed
          ${containerStatus === 'running'
            ? 'text-[#4caf78] hover:bg-[#0f1f15] hover:text-[#e05252]'
            : 'text-[#4a4a4a] hover:bg-[#141414] hover:text-[#4caf78]'}
        `}
      >
        {containerStatus === 'running' ? <StopIcon /> : <PlayIcon />}
      </button>

      {/* Status dots */}
      <div className="flex flex-col items-center gap-1.5">
        <Dot color={statusColor(containerStatus)} title={`Container: ${containerStatus}`} />
        <Dot color={statusColor(agentStatus)} title={`Agent: ${agentStatus}`} />
        <Dot
          color="bg-[#5f8fff]"
          title={`Model: ${modelConfig.model}`}
          onClick={() => setActivePanel('settings')}
        />
      </div>
    </div>
  );
}

function Dot({
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
      className="relative group focus:outline-none"
    >
      <span className={`block w-2 h-2 rounded-full ${color}`} />
      <span className="
        pointer-events-none absolute left-full ml-2 px-2 py-1 rounded
        bg-[#1e1e1e] border border-[#2a2a2a] text-[#c0c0c0] text-[11px]
        whitespace-nowrap opacity-0 group-hover:opacity-100
        transition-opacity duration-100 z-50
      ">
        {title}
      </span>
    </button>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <polygon points="3,2 12,7 3,12" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" />
    </svg>
  );
}
