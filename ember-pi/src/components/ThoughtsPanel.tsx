import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';

export function ThoughtsPanel() {
  const { thoughtLines, clearThoughts, agentStatus } = useAppStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [thoughtLines]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1e1e1e] flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[#6b6b6b] uppercase tracking-widest">Agent Reasoning</span>
          {agentStatus === 'running' && (
            <span className="flex gap-1 items-center">
              {[0, 100, 200].map((d) => (
                <span
                  key={d}
                  className="w-1 h-1 rounded-full bg-[#8a6fff] animate-pulse"
                  style={{ animationDelay: `${d}ms` }}
                />
              ))}
            </span>
          )}
        </div>
        <button
          onClick={clearThoughts}
          className="text-[11px] text-[#3a3a3a] hover:text-[#6b6b6b] transition-colors"
        >
          clear
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {thoughtLines.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-1">
              <p className="text-[#2a2a2a] text-sm italic">No reasoning trace yet.</p>
              <p className="text-[10px] text-[#1e1e1e]">
                Thoughts appear when the agent prefixes output with [THOUGHT]
              </p>
            </div>
          </div>
        )}
        {thoughtLines.map((line, i) => (
          <div
            key={line.id}
            className="border-l-2 border-[#2a1e4a] pl-3 py-1"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[9px] text-[#4a3a6a] uppercase tracking-widest font-mono">
                thought {i + 1}
              </span>
              <span className="text-[9px] text-[#2a2a2a]">
                {new Date(line.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
            <p className="text-[#8a6fff] text-sm italic leading-relaxed">
              {line.content}
            </p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
