import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { execInContainer } from '../services/container';

const TYPE_COLOR: Record<string, string> = {
  thought:  'text-[#8a6fff]',
  tool:     'text-[#f5a623]',
  terminal: 'text-[#a8ff78]',
  response: 'text-[#e2e2e2]',
  error:    'text-[#e05252]',
};

export function TerminalPanel() {
  const {
    terminalLines,
    clearTerminal,
    containerStatus,
    containerName,
    addTerminalLine,
    addSessionEvent,
  } = useAppStore();

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [cmdInput, setCmdInput] = useState('');
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [terminalLines]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        clearTerminal();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [clearTerminal]);

  const runCommand = async () => {
    const cmd = cmdInput.trim();
    if (!cmd || running) return;

    const parts = cmd.split(/\s+/);
    const program = parts[0];
    const args = parts.slice(1);

    addTerminalLine({ id: crypto.randomUUID(), type: 'terminal', content: `$ ${cmd}`, timestamp: Date.now() });
    setHistory((h) => [cmd, ...h.slice(0, 49)]);
    setHistIdx(-1);
    setCmdInput('');
    setRunning(true);

    try {
      const result = await execInContainer(containerName, program, args);
      const output = result.stdout + result.stderr;
      for (const line of output.split('\n').filter(Boolean)) {
        addTerminalLine({
          id: crypto.randomUUID(),
          type: result.success ? 'terminal' : 'error',
          content: line,
          timestamp: Date.now(),
        });
      }
      if (!result.success && !output.trim()) {
        addTerminalLine({
          id: crypto.randomUUID(),
          type: 'error',
          content: `exit code: non-zero`,
          timestamp: Date.now(),
        });
      }
      addSessionEvent({ id: crypto.randomUUID(), type: 'tool', content: cmd, timestamp: Date.now() });
    } catch (e) {
      addTerminalLine({
        id: crypto.randomUUID(),
        type: 'error',
        content: containerStatus !== 'running'
          ? `Container is ${containerStatus}. Start it first.`
          : String(e),
        timestamp: Date.now(),
      });
    } finally {
      setRunning(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      runCommand();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(idx);
      setCmdInput(history[idx] ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = Math.max(histIdx - 1, -1);
      setHistIdx(idx);
      setCmdInput(idx === -1 ? '' : history[idx]);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1e1e1e] flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[#6b6b6b] uppercase tracking-widest">Terminal</span>
          <span className={`text-[10px] font-mono ${containerStatus === 'running' ? 'text-[#4caf78]' : 'text-[#6b6b6b]'}`}>
            {containerStatus === 'running' ? '● live' : `● ${containerStatus}`}
          </span>
        </div>
        <button
          onClick={clearTerminal}
          className="text-[11px] text-[#3a3a3a] hover:text-[#6b6b6b] transition-colors"
          title="Clear (⌃K)"
        >
          clear
        </button>
      </div>

      {/* Output */}
      <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-5">
        {terminalLines.length === 0 && (
          <p className="text-[#2a2a2a]">
            {containerStatus === 'running'
              ? '— container running, waiting for output —'
              : '— container offline — start it to see output —'}
          </p>
        )}
        {terminalLines.map((line) => (
          <div key={line.id} className="flex gap-2 min-w-0">
            <span className="text-[#2a2a2a] flex-shrink-0 select-none">
              {new Date(line.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
            <span className={`${TYPE_COLOR[line.type] ?? 'text-[#e2e2e2]'} break-all`}>
              {line.content}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Command input */}
      <div className="border-t border-[#1e1e1e] px-3 py-2 flex-shrink-0">
        <div className={`flex items-center gap-2 bg-[#0d0d0d] rounded border px-3 py-1.5 font-mono transition-colors ${
          containerStatus === 'running' ? 'border-[#1e1e1e] focus-within:border-[#2a2a2a]' : 'border-[#141414] opacity-50'
        }`}>
          <span className="text-[#4caf78] text-[12px] flex-shrink-0 select-none">
            {containerStatus === 'running' ? '$' : '○'}
          </span>
          <input
            ref={inputRef}
            value={cmdInput}
            onChange={(e) => setCmdInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={containerStatus !== 'running' || running}
            placeholder={
              containerStatus === 'running'
                ? 'command… (↑↓ for history)'
                : `container ${containerStatus}`
            }
            className="flex-1 bg-transparent text-[#a8ff78] placeholder-[#2a2a2a] text-[12px] outline-none"
          />
          {running && (
            <span className="text-[10px] text-[#f5a623] animate-pulse flex-shrink-0">running…</span>
          )}
        </div>
      </div>
    </div>
  );
}
