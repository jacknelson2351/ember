import { useCallback, useEffect, useRef, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useAppStore, useEphemeralStore } from '../stores/appStore';
import { writeFileBytes } from '../services/files';
import { EmberBuddy } from './EmberBuddy';
import {
  startPiSession,
  stopPiSession,
  sendPrompt,
  onPiEvent,
  onPiEnded,
  onPiStderr,
  type PiEvent,
} from '../services/pi';
import type { ToolCall } from '../types';

const QUICK_PROMPTS = [
  'List the files in /workspace.',
  'What tools are available in this environment?',
  'Run a quick system info check.',
];

export function ChatPanel() {
  const {
    messages,
    inputValue,
    setInputValue,
    addMessage,
    updateLastMessage,
    clearMessages,
    agentStatus,
    setAgentStatus,
    modelConfig,
    systemPrompt,
    memoryMode,
    notes,
    containerStatus,
    containerName,
    addSessionEvent,
    runtimeHealth,
  } = useAppStore();

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionActiveRef = useRef(false);

  // ── Voice to text ────────────────────────────────────────────────────────
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceInterim, setVoiceInterim] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  // Keep a ref to inputValue so the onresult closure always sees the latest value
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  const startVoice = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    r.onresult = (e: any) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t;
        else interim += t;
      }
      if (final) {
        const prev = inputValueRef.current;
        setInputValue(prev + (prev ? ' ' : '') + final.trim());
      }
      setVoiceInterim(interim);
    };

    r.onerror = () => { setVoiceActive(false); setVoiceInterim(''); };
    r.onend = () => { setVoiceActive(false); setVoiceInterim(''); };

    recognitionRef.current = r;
    r.start();
    setVoiceActive(true);
  }, [setInputValue]);

  const stopVoice = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setVoiceActive(false);
    setVoiceInterim('');
  }, []);

  const toggleVoice = useCallback(() => {
    voiceActive ? stopVoice() : startVoice();
  }, [voiceActive, startVoice, stopVoice]);
  // Tracks an in-progress pi_start so send() can await it instead of racing
  const sessionStartPromise = useRef<Promise<void> | null>(null);
  const [piStatus, setPiStatus] = useState<'starting' | 'ready' | 'error' | 'offline'>('offline');
  const [stderrLines, setStderrLines] = useState<string[]>([]);
  // Happy flash — true for ~1.8s when agent finishes a turn
  const [happyFlash, setHappyFlash] = useState(false);

  // ── File attachments ─────────────────────────────────────────────────────────
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([]);
  const attachInputRef = useRef<HTMLInputElement>(null);

  // ── Stable refs for startSession deps — prevents identity change from re-firing effects ──
  const containerNameRef = useRef(containerName);
  containerNameRef.current = containerName;
  const modelConfigRef = useRef(modelConfig);
  modelConfigRef.current = modelConfig;
  const containerStatusRef = useRef(containerStatus);
  containerStatusRef.current = containerStatus;

  /** Build effective system prompt — base + memory-injected notes */
  const buildSystemPrompt = useCallback((): string => {
    if (memoryMode === 'off') return systemPrompt;
    const pinned = notes.filter((n) => n.pinned);
    const selected = memoryMode === 'full' ? notes : pinned;
    if (selected.length === 0) return systemPrompt;
    const block = selected.map((n) => `- ${n.content}`).join('\n');
    const label = memoryMode === 'full' ? 'MEMORY NOTES' : 'PINNED NOTES';
    return `${systemPrompt}\n\n--- [${label}] ---\n${block}\n--- [END] ---`;
  }, [memoryMode, notes, systemPrompt]);

  // Must be declared after buildSystemPrompt
  const buildSystemPromptRef = useRef(buildSystemPrompt);
  buildSystemPromptRef.current = buildSystemPrompt;

  // Accumulation state for the in-progress agent message
  const accText = useRef('');
  const accThought = useRef('');
  const accTools = useRef<ToolCall[]>([]);
  const activeToolId = useRef<string | null>(null); // tool being streamed
  const execOutputs = useRef<Record<string, string>>({}); // toolcallId → output

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'l') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Pi session lifecycle ────────────────────────────────────────────────────

  // startSession reads volatile deps via refs so it stays stable across renders.
  // This prevents the container-status effect from re-firing when modelConfig/systemPrompt change.
  const startSession = useCallback(async () => {
    if (sessionActiveRef.current) return;
    if (containerStatusRef.current !== 'running') return;
    sessionActiveRef.current = true;
    setPiStatus('starting');
    setStderrLines([]);
    const promise = startPiSession(containerNameRef.current, modelConfigRef.current, buildSystemPromptRef.current())
      .then(() => {
        setPiStatus('ready');
      })
      .catch((e: unknown) => {
        sessionActiveRef.current = false;
        setPiStatus('error');
        const msg = e instanceof Error ? e.message : String(e);
        addMessage({
          id: crypto.randomUUID(),
          role: 'agent',
          content: `⚠ Ember failed to start: ${msg}\n\nMake sure the Docker image has been rebuilt with the agent installed (Settings → Runtime → Rebuild Image).`,
          timestamp: Date.now(),
        });
      })
      .finally(() => {
        sessionStartPromise.current = null;
      });
    sessionStartPromise.current = promise;
    await promise;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addMessage]); // stable — volatile deps read via refs above

  // Start pi when Docker container comes online
  // NOTE: Do NOT reset sessionActiveRef here — startSession guards itself.
  // Resetting before calling would allow double-starts (e.g. effect re-runs).
  useEffect(() => {
    if (containerStatus === 'running') {
      startSession();
    } else {
      // Container stopped — allow a fresh start when it comes back
      sessionActiveRef.current = false;
      setPiStatus('offline');
    }
  }, [containerStatus, startSession]);

  // Restart pi when model config VALUES change (not just reference — rehydration
  // creates new objects with the same values and must not trigger a restart).
  const prevModelConfigRef = useRef(modelConfig);
  useEffect(() => {
    const prev = prevModelConfigRef.current;
    prevModelConfigRef.current = modelConfig;
    const changed =
      prev.provider !== modelConfig.provider ||
      prev.endpoint !== modelConfig.endpoint ||
      prev.model !== modelConfig.model ||
      prev.apiKey !== modelConfig.apiKey;
    if (!changed) return;
    if (containerStatusRef.current === 'running' && sessionActiveRef.current) {
      sessionActiveRef.current = false;
      stopPiSession().finally(() => startSession());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelConfig]);

  // Tear down on unmount
  useEffect(() => {
    return () => {
      if (sessionActiveRef.current) {
        stopPiSession().catch(() => {});
        sessionActiveRef.current = false;
      }
      recognitionRef.current?.stop();
    };
  }, []);

  // ── Pi event handling ───────────────────────────────────────────────────────

  useEffect(() => {
    const resetAccum = () => {
      accText.current = '';
      accThought.current = '';
      accTools.current = [];
      activeToolId.current = null;
      execOutputs.current = {};
    };

    const unlistenEvent = onPiEvent((ev: PiEvent) => {
      switch (ev.type) {
        case 'agent_start': {
          resetAccum();
          // Guard: skip if there's already a streaming agent bubble (duplicate pi process)
          const currentMsgs = useEphemeralStore.getState().messages;
          const lastMsg = currentMsgs[currentMsgs.length - 1];
          if (lastMsg?.role === 'agent' && lastMsg.streaming) break;
          addMessage({
            id: crypto.randomUUID(),
            role: 'agent',
            content: '',
            timestamp: Date.now(),
            streaming: true,
            toolCalls: [],
          });
          setAgentStatus('running');
          break;
        }

        case 'message_update': {
          const d = ev.assistantMessageEvent;
          if (!d) break;

          if (d.type === 'text_delta' && d.delta) {
            accText.current += d.delta;
            updateLastMessage({
              content: accText.current,
              streaming: true,
              toolCalls: [...accTools.current],
            });
          } else if (d.type === 'thinking_delta' && d.delta) {
            accThought.current += d.delta;
            updateLastMessage({
              content: `[THOUGHT]${accThought.current}\n\n${accText.current}`,
              streaming: true,
              toolCalls: [...accTools.current],
            });
          } else if (d.type === 'toolcall_end' && d.toolCall) {
            // Full tool call info available at toolcall_end
            const tc: ToolCall = {
              id: d.toolCall.id,
              name: d.toolCall.name,
              args: d.toolCall.arguments ?? {},
              running: true,
            };
            accTools.current = [...accTools.current, tc];
            activeToolId.current = d.toolCall.id;
            updateLastMessage({ toolCalls: [...accTools.current] });
          } else if (d.type === 'done') {
            // Turn complete — finalize
            const finalContent = accThought.current
              ? `[THOUGHT]${accThought.current}\n\n${accText.current}`
              : accText.current;
            updateLastMessage({
              content: finalContent,
              streaming: false,
              toolCalls: [...accTools.current],
            });
            addSessionEvent({
              id: crypto.randomUUID(),
              type: 'agent',
              content: accText.current,
              timestamp: Date.now(),
            });
            setAgentStatus('idle');
            setPiStatus('ready');
          }
          break;
        }

        case 'tool_execution_start': {
          // Pi confirmed the tool is executing — update or create the tool call entry
          const id = ev.toolCallId ?? activeToolId.current ?? '';
          const existing = accTools.current.find((tc) => tc.id === id);
          if (existing) {
            accTools.current = accTools.current.map((tc) =>
              tc.id === id
                ? { ...tc, name: ev.toolName ?? tc.name, args: ev.args ?? tc.args, running: true }
                : tc,
            );
          } else {
            // Tool call wasn't created during message streaming — create it now
            accTools.current = [
              ...accTools.current,
              { id, name: ev.toolName ?? '…', args: ev.args ?? {}, running: true },
            ];
          }
          execOutputs.current[id] = '';
          updateLastMessage({ toolCalls: [...accTools.current] });
          break;
        }

        case 'tool_execution_update': {
          const id = ev.toolCallId ?? '';
          if (id) {
            const chunk = typeof ev.partialResult === 'string'
              ? ev.partialResult
              : JSON.stringify(ev.partialResult ?? '');
            execOutputs.current[id] = (execOutputs.current[id] ?? '') + chunk;
            accTools.current = accTools.current.map((tc) =>
              tc.id === id ? { ...tc, result: execOutputs.current[id] } : tc,
            );
            updateLastMessage({ toolCalls: [...accTools.current] });
          }
          break;
        }

        case 'tool_execution_end': {
          const id = ev.toolCallId ?? '';
          const finalResult = typeof ev.result === 'string'
            ? ev.result
            : JSON.stringify(ev.result ?? '');
          accTools.current = accTools.current.map((tc) =>
            tc.id === id
              ? {
                  ...tc,
                  result: finalResult || execOutputs.current[id] || '',
                  error: ev.isError === true,
                  running: false,
                }
              : tc,
          );
          updateLastMessage({ toolCalls: [...accTools.current] });
          break;
        }

        case 'agent_end': {
          // Ensure streaming is cleared and status is idle even if 'done' was missed
          updateLastMessage({ streaming: false });
          setAgentStatus('idle');
          setPiStatus('ready');
          // Happy flash for 1.8s if the agent actually produced content
          const lastMsg = useEphemeralStore.getState().messages.slice(-1)[0];
          if (lastMsg?.role === 'agent' && lastMsg.content.trim()) {
            setHappyFlash(true);
            setTimeout(() => setHappyFlash(false), 1800);
          }
          break;
        }

        default:
          break;
      }
    });

    const unlistenEnded = onPiEnded(() => {
      sessionActiveRef.current = false;
      setAgentStatus('idle');
      setPiStatus('offline');
    });

    const unlistenStderr = onPiStderr((line: string) => {
      setStderrLines((prev) => [...prev.slice(-49), line]); // keep last 50 lines
    });

    return () => {
      unlistenEvent.then((fn) => fn());
      unlistenEnded.then((fn) => fn());
      unlistenStderr.then((fn) => fn());
    };
  }, [addMessage, addSessionEvent, setAgentStatus, setPiStatus, updateLastMessage]);

  // ── Send ───────────────────────────────────────────────────────────────────

  const handleAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    useEphemeralStore.getState().setSuppressBlurCollapse(false);
    for (const file of files) {
      const destPath = `/workspace/${file.name}`;
      try {
        await writeFileBytes(destPath, file);
        setAttachments((prev) => [...prev, { name: file.name, path: destPath }]);
      } catch (err) {
        console.error('Attachment upload failed:', err);
      }
    }
    e.target.value = '';
  };

  const send = useCallback(async () => {
    const text = inputValue.trim();
    if ((!text && attachments.length === 0) || agentStatus === 'running') return;

    // If pi is still starting, wait for it
    if (sessionStartPromise.current) {
      await sessionStartPromise.current;
    }
    if (!sessionActiveRef.current) {
      // Attempt to (re)start pi first
      await startSession();
      if (sessionStartPromise.current) await sessionStartPromise.current;
    }

    const currentAttachments = [...attachments];
    const attachmentNote = currentAttachments.length > 0
      ? `Files uploaded to /workspace: ${currentAttachments.map((a) => a.name).join(', ')}\n\n`
      : '';
    const promptText = attachmentNote + text;

    addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
    });
    addSessionEvent({
      id: crypto.randomUUID(),
      type: 'user',
      content: promptText,
      timestamp: Date.now(),
    });
    setInputValue('');
    setAttachments([]);

    try {
      await sendPrompt(promptText);
    } catch (e) {
      addMessage({
        id: crypto.randomUUID(),
        role: 'agent',
        content: `Error sending to Ember: ${e instanceof Error ? e.message : String(e)}`,
        timestamp: Date.now(),
      });
      setAgentStatus('idle');
    }
  }, [addMessage, addSessionEvent, agentStatus, attachments, inputValue, setAgentStatus, setInputValue, startSession]);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const canSend = (Boolean(inputValue.trim()) || attachments.length > 0) && agentStatus !== 'running';
  const isRunning = agentStatus === 'running';
  const sharedPath = runtimeHealth?.sharedPath ?? '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Status bar */}
      <div className="flex items-center gap-2 border-b border-white/6 px-4 py-2">
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${
          piStatus === 'ready' ? 'bg-emerald-400' :
          piStatus === 'starting' ? 'bg-amber-400 animate-pulse' :
          piStatus === 'error' ? 'bg-red-400' : 'bg-slate-600'
        }`} />
        <span className="text-[11px] text-slate-500 min-w-0 flex-1 truncate">
          {modelConfig.provider}/{modelConfig.model || '—'}
        </span>
        {(piStatus === 'offline' || piStatus === 'error') && containerStatus === 'running' && (
          <button
            onClick={() => { sessionActiveRef.current = false; startSession(); }}
            className="text-[11px] text-slate-600 hover:text-slate-300 transition"
          >
            reconnect
          </button>
        )}
        {messages.length > 0 && (
          <button onClick={clearMessages} className="text-[11px] text-slate-600 hover:text-slate-400 transition">
            clear
          </button>
        )}
      </div>

      {/* Stderr — collapsed by default, shown only when there's output */}
      {stderrLines.length > 0 && (
        <details className="border-b border-white/6">
          <summary className="cursor-pointer px-4 py-1.5 text-[10px] text-amber-600/80 hover:text-amber-400 transition select-none">
            ⚠ stderr ({stderrLines.length} lines)
          </summary>
          <div className="max-h-24 overflow-y-auto px-4 pb-2 scrollbar-thin">
            {stderrLines.map((line, i) => (
              <p key={i} className="font-mono text-[10px] leading-[1.6] text-amber-500/60">{line}</p>
            ))}
          </div>
        </details>
      )}

      {/* Messages */}
      <div className="min-h-0 flex-1 overflow-y-auto py-4 scrollbar-thin">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center px-5 pt-6 pb-2 gap-4">
            {/* Ember buddy — thinking if agent is running, idle otherwise */}
            <EmberBuddy
              mode={
                happyFlash            ? 'happy'    :
                piStatus === 'error'  ? 'error'    :
                piStatus === 'starting' ? 'thinking' :
                agentStatus === 'running' ? 'thinking' :
                'idle'
              }
              pixelScale={4}
            />
            {containerStatus !== 'running' ? (
              <p className="text-[11px] text-amber-500/70 text-center">
                Docker offline — start the runtime in Settings.
              </p>
            ) : (
              <p className="text-[12px] text-slate-500 text-center leading-relaxed">
                {piStatus === 'starting' ? 'Starting up…' : 'Ask me anything.'}
              </p>
            )}
            <div className="w-full space-y-1">
              {QUICK_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => setInputValue(p)}
                  className="w-full text-left px-3 py-2 rounded-lg text-[12px] text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-5 px-5">
            {messages.map((message) => {
              const { thought, response } = parseContent(message.content);
              const isUser = message.role === 'user';
              return (
                <div key={message.id} className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                  {/* Avatar */}
                  {isUser ? (
                    <div className="mt-0.5 shrink-0">
                      <CoalfireAvatar />
                    </div>
                  ) : (
                    <div className="shrink-0" style={{ marginTop: -2 }}>
                      <EmberBuddy
                        mode={
                          message.streaming && !message.content.trim() ? 'thinking'  :
                          message.streaming                             ? 'streaming' :
                          message.toolCalls?.some(tc => tc.running)    ? 'excited'   :
                          message.toolCalls?.some(tc => tc.error)      ? 'error'     :
                          'idle'
                        }
                        pixelScale={2}
                      />
                    </div>
                  )}

                  <div className={`min-w-0 max-w-[88%] space-y-1.5 ${isUser ? 'items-end flex flex-col' : ''}`}>
                    {/* Tool calls — shown above the text */}
                    {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
                      <div className="w-full space-y-1">
                        {message.toolCalls.map((tc) => (
                          <ToolCallBlock key={tc.id} call={tc} sharedPath={sharedPath} />
                        ))}
                      </div>
                    )}

                    {/* Reasoning */}
                    {thought && (
                      <ReasoningBlock thought={thought} streaming={Boolean(message.streaming && !response)} />
                    )}

                    {/* Message text */}
                    {(response || (!thought && message.content) || message.streaming) && (
                      <div className={
                        isUser
                          ? 'rounded-2xl rounded-tr-sm bg-[rgba(255,109,43,0.12)] px-3.5 py-2 text-white/90'
                          : 'text-slate-200'
                      }>
                        {isUser ? (
                          <span className="whitespace-pre-wrap break-words text-[13px] leading-[1.65]">
                            {message.content}
                          </span>
                        ) : (
                          <MessageContent
                            text={response || (!thought ? message.content : '')}
                            streaming={message.streaming}
                          />
                        )}
                      </div>
                    )}

                    {/* Attachment chips on user messages */}
                    {isUser && message.attachments && message.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1 justify-end">
                        {message.attachments.map((a) => (
                          <span
                            key={a.path}
                            className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-0.5 text-[11px] text-slate-400"
                          >
                            <svg width="9" height="10" viewBox="0 0 9 10" fill="none" className="shrink-0">
                              <path d="M1.5 1h4l2.5 2.5V9H1.5V1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                            </svg>
                            {a.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-white/6 px-4 py-3">
        {/* Interim voice preview */}
        {voiceInterim && (
          <p className="mb-1.5 px-1 text-[12px] italic text-slate-500">{voiceInterim}…</p>
        )}

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span
                key={a.path}
                className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] pl-2.5 pr-1.5 py-0.5 text-[11px] text-slate-300"
              >
                <svg width="9" height="10" viewBox="0 0 9 10" fill="none" className="shrink-0 text-slate-500">
                  <path d="M1.5 1h4l2.5 2.5V9H1.5V1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                </svg>
                {a.name}
                <button
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
                  className="ml-0.5 text-slate-600 hover:text-slate-300 transition leading-none"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className={`flex items-end gap-1.5 rounded-2xl border px-3 py-2.5 transition ${
          voiceActive ? 'border-red-500/30 bg-red-500/[0.03]' :
          isRunning ? 'border-white/6 opacity-60' : 'border-white/10 focus-within:border-white/16'
        }`}>
          {/* Hidden file input for attachments */}
          <input
            ref={attachInputRef}
            type="file"
            multiple
            onChange={handleAttach}
            style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
          />

          {/* Mic button */}
          <button
            onClick={toggleVoice}
            disabled={isRunning}
            title={voiceActive ? 'Stop recording' : 'Voice input'}
            className={`mb-0.5 shrink-0 rounded-full p-1.5 transition disabled:opacity-20 ${
              voiceActive
                ? 'text-red-400 animate-pulse'
                : 'text-slate-600 hover:text-slate-300'
            }`}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <rect x="4.5" y="1" width="5" height="7.5" rx="2.5" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M2 6.5a5 5 0 0010 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <line x1="7" y1="11.5" x2="7" y2="13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>

          {/* Paperclip / attach button */}
          <button
            onClick={() => {
              useEphemeralStore.getState().setSuppressBlurCollapse(true);
              attachInputRef.current?.click();
            }}
            disabled={isRunning}
            title="Attach file"
            className="mb-0.5 shrink-0 rounded-full p-1.5 text-slate-600 transition disabled:opacity-20 hover:text-slate-300"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M12 6.5L6.5 12a3.5 3.5 0 01-5-5l5.5-5.5a2 2 0 012.8 2.8L4 10a.5.5 0 01-.7-.7L9 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={voiceActive ? 'Listening…' : isRunning ? 'Working…' : 'Ask Ember…'}
            disabled={isRunning}
            rows={1}
            className="min-h-[22px] max-h-32 flex-1 resize-none bg-transparent text-[13px] leading-[1.65] text-white outline-none placeholder:text-slate-500 disabled:cursor-not-allowed"
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = 'auto';
              t.style.height = `${Math.min(t.scrollHeight, 128)}px`;
            }}
          />
          <button
            onClick={send}
            disabled={!canSend}
            className="mb-0.5 shrink-0 rounded-full p-1.5 transition disabled:opacity-20 enabled:hover:bg-white/8 enabled:text-[rgba(255,109,43,0.9)]"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function parseContent(content: string): { thought: string | null; response: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('[THOUGHT]')) return { thought: null, response: content };
  const body = trimmed.slice(9);
  const end = /\n{2,}|\[(?:RESPONSE|FINAL)\]\s*/.exec(body);
  if (end) return { thought: body.slice(0, end.index).trim(), response: body.slice(end.index + end[0].length).trim() };
  return { thought: body.trim(), response: '' };
}

/** Tools that write files — show a file card with reveal button. */
const FILE_WRITE_TOOLS = new Set(['write', 'write_file', 'edit', 'create_file']);

/** Map Docker /workspace path to host shared path for revealItemInDir. */
function resolveHostPath(dockerPath: string, sharedPath: string): string | null {
  if (!sharedPath) return null;
  const p = String(dockerPath ?? '');
  if (p.startsWith('/workspace/')) return `${sharedPath}/${p.slice(11)}`;
  if (p.startsWith('/workspace')) return sharedPath;
  return null;
}

function ToolCallBlock({ call, sharedPath }: { call: ToolCall; sharedPath: string }) {
  const [open, setOpen] = useState(false);

  const isFileWrite = FILE_WRITE_TOOLS.has(call.name);
  const isBash = call.name === 'bash';
  const filePath = isFileWrite
    ? String(call.args.path ?? call.args.file_path ?? '')
    : null;
  const hostPath = filePath ? resolveHostPath(filePath, sharedPath) : null;
  const fileName = filePath ? filePath.split('/').pop() : null;

  // ── File card (write/edit operations) ──────────────────────────────────────
  if (isFileWrite && fileName && !call.running && !call.error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5">
        <svg width="11" height="12" viewBox="0 0 11 12" fill="none" className="shrink-0 text-slate-500">
          <path d="M1.5 1h5l3 3v7h-8V1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
          <path d="M6.5 1v3h3" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
        </svg>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300" title={filePath ?? ''}>
          {fileName}
        </span>
        {filePath && filePath !== fileName && (
          <span className="font-mono text-[10px] text-slate-600 truncate max-w-[90px]" title={filePath}>
            {filePath.replace('/workspace/', '').replace(`/${fileName}`, '')}
          </span>
        )}
        {hostPath && (
          <button
            onClick={() => revealItemInDir(hostPath).catch(() => {})}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:text-slate-200 transition"
          >
            reveal ↗
          </button>
        )}
      </div>
    );
  }

  // ── Bash / generic tool block ───────────────────────────────────────────────
  const cmd = isBash ? String(call.args.command ?? call.args.cmd ?? '') : null;
  const preview = isBash
    ? (cmd ?? '').slice(0, 90)
    : filePath
    ? filePath
    : Object.entries(call.args)
        .filter(([k]) => k !== 'content')
        .map(([, v]) => String(v).slice(0, 40))
        .join(' ');

  const result = call.result ?? '';
  const lines = result.split('\n').filter(Boolean);

  return (
    <div className="rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-white/[0.03]"
      >
        {/* Icon */}
        {isBash ? (
          <span className="shrink-0 font-mono text-[10px] text-slate-600">$</span>
        ) : (
          <span className="shrink-0 text-[9px] text-slate-600">⚙</span>
        )}
        {/* Command/preview */}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400">
          {preview}
        </span>
        {/* Status */}
        {call.running && (
          <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
        )}
        {!call.running && call.error && (
          <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-red-400" />
        )}
        {!call.running && !call.error && result && (
          <span className="shrink-0 font-mono text-[9px] text-slate-600 group-hover:text-slate-400 transition">
            {lines.length} line{lines.length !== 1 ? 's' : ''}
          </span>
        )}
      </button>

      {/* Expanded output */}
      {open && (
        <div className="mx-2 mb-2 rounded-lg border border-white/[0.06] bg-black/20">
          {call.running && !result ? (
            <span className="block px-3 py-2 text-[11px] text-slate-600 animate-pulse">Running…</span>
          ) : (
            <pre
              className={`max-h-40 overflow-y-auto px-3 py-2.5 whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.65] scrollbar-thin ${
                call.error ? 'text-red-400/70' : 'text-slate-500'
              }`}
            >
              {result || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ReasoningBlock({ thought, streaming }: { thought: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-violet-500/15 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left bg-violet-500/[0.04] hover:bg-violet-500/[0.07] transition"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-violet-400 shrink-0" />
        <span className="flex-1 text-[10px] text-violet-400/80">
          {streaming ? 'thinking…' : 'thought'}
        </span>
        <span className="text-[9px] text-violet-600">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-violet-500/10">
          <p className="whitespace-pre-wrap break-words text-[11px] leading-[1.6] text-violet-300/60">
            {thought}{streaming && <span className="ml-1 inline-block h-[5px] w-[5px] rounded-full bg-violet-400/50 align-middle" style={{ animation: 'streamPulse 1s ease-in-out infinite' }} />}
          </p>
        </div>
      )}
    </div>
  );
}

/** Three-dot bounce shown when the agent bubble has no text yet. */
function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-[3px] py-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-[5px] w-[5px] rounded-full bg-slate-500"
          style={{
            animation: 'typingBounce 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.18}s`,
          }}
        />
      ))}
    </span>
  );
}

/** Soft pulsing dot shown at the tail of streaming text. */
function StreamingCursor() {
  return (
    <span
      className="ml-1 inline-block h-[7px] w-[7px] rounded-full bg-[rgba(255,109,43,0.5)] align-middle"
      style={{ animation: 'streamPulse 1s ease-in-out infinite' }}
    />
  );
}

// ── Message content renderer with copy-able code blocks ──────────────────────

interface Segment {
  type: 'text' | 'code';
  content: string;
  lang?: string;
}

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ type: 'text', content: text.slice(last, match.index) });
    }
    segments.push({ type: 'code', lang: match[1].trim() || 'text', content: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ type: 'text', content: text.slice(last) });
  }
  return segments.length ? segments : [{ type: 'text', content: text }];
}

function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(content.trimEnd()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-white/8 bg-black/30">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/6 px-3 py-1.5">
        <span className="font-mono text-[10px] text-slate-500">{lang}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-slate-500 transition hover:bg-white/8 hover:text-slate-200"
        >
          {copied ? (
            <>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1.5 5l2.5 2.5L8.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              copied
            </>
          ) : (
            <>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <rect x="3.5" y="3.5" width="5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.1"/>
                <path d="M3.5 6.5H2.5a1 1 0 01-1-1V2a1 1 0 011-1h4a1 1 0 011 1v1" stroke="currentColor" strokeWidth="1.1"/>
              </svg>
              copy
            </>
          )}
        </button>
      </div>
      {/* Code */}
      <pre className="overflow-x-auto px-3 py-2.5 scrollbar-thin">
        <code className="font-mono text-[11.5px] leading-[1.7] text-slate-200 whitespace-pre">
          {content.trimEnd()}
        </code>
      </pre>
    </div>
  );
}

function InlineCode({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(children).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title="Click to copy"
      className={`rounded px-1 py-0.5 font-mono text-[11.5px] transition ${
        copied ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/8 text-slate-200 hover:bg-white/12'
      }`}
    >
      {copied ? '✓' : children}
    </button>
  );
}

/** Render text with inline backtick code highlighted. */
function TextSegment({ content }: { content: string }) {
  const parts = content.split(/(`[^`\n]+`)/g);
  return (
    <span className="whitespace-pre-wrap break-words text-[13px] leading-[1.65]">
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return <InlineCode key={i}>{part.slice(1, -1)}</InlineCode>;
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

/** Coalfire double-hexagon mark used as the user message avatar. */
function CoalfireAvatar() {
  // Two nested flat-top hexagons. Outer = white border, inner = Coalfire orange.
  // viewBox 0 0 20 20, flat-top orientation (first vertex at 3 o'clock).
  const hex = (r: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (i * Math.PI) / 3;
      return `${(10 + r * Math.cos(a)).toFixed(2)},${(10 + r * Math.sin(a)).toFixed(2)}`;
    }).join(' ');

  return (
    <svg viewBox="0 0 20 20" width="20" height="20" style={{ display: 'block' }}>
      {/* Outer hex — subtle white ring */}
      <polygon points={hex(9.2)} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
      {/* Inner hex — Coalfire orange */}
      <polygon points={hex(6.2)} fill="#DC502A" opacity="0.9" />
    </svg>
  );
}

function MessageContent({ text, streaming }: { text: string; streaming?: boolean }) {
  // No text yet — show typing indicator instead of empty bubble + cursor
  if (streaming && !text.trim()) {
    return <TypingIndicator />;
  }

  const segments = parseSegments(text);
  return (
    <div>
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          <CodeBlock key={i} lang={seg.lang!} content={seg.content} />
        ) : (
          <TextSegment key={i} content={seg.content} />
        )
      )}
      {streaming && <StreamingCursor />}
    </div>
  );
}
