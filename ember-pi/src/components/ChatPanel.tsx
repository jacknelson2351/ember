import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useAppStore, useEphemeralStore } from '../stores/appStore';
import { writeFileBytes, copyFile } from '../services/files';
import { getCurrentWebview } from '@tauri-apps/api/webview';
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
import type { ChatMessage, OutputLine, ToolCall } from '../types';
import { buildEffectivePrompt } from '../utils/buildPrompt';

const QUICK_PROMPTS = [
  'List the files in the current workspace.',
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
    skills,
    containerStatus,
    containerName,
    addSessionEvent,
    upsertThoughtLine,
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
    if (!SR) {
      setVoiceInterim('Voice input unavailable — check microphone permissions');
      setTimeout(() => setVoiceInterim(''), 3500);
      return;
    }

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
  const [stopRequested, setStopRequested] = useState(false);
  const restartAfterStopRef = useRef(false);

  // ── File attachments + drag-and-drop ─────────────────────────────────────────
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([]);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // ── Stable refs for startSession deps — prevents identity change from re-firing effects ──
  const containerNameRef = useRef(containerName);
  containerNameRef.current = containerName;
  const modelConfigRef = useRef(modelConfig);
  modelConfigRef.current = modelConfig;
  const containerStatusRef = useRef(containerStatus);
  containerStatusRef.current = containerStatus;

  /** Build effective system prompt — base + memory-injected notes + enabled skills */
  const buildSystemPrompt = useCallback((): string => {
    return buildEffectivePrompt({ systemPrompt, memoryMode, notes, skills });
  }, [memoryMode, notes, skills, systemPrompt]);

  // Must be declared after buildSystemPrompt
  const buildSystemPromptRef = useRef(buildSystemPrompt);
  buildSystemPromptRef.current = buildSystemPrompt;

  // Accumulation state for the in-progress agent message
  const accText = useRef('');
  const accThought = useRef('');
  const accTools = useRef<ToolCall[]>([]);
  const activeToolId = useRef<string | null>(null); // tool being streamed
  const execOutputs = useRef<Record<string, string>>({}); // toolcallId → output
  const activeThoughtId = useRef<string | null>(null);
  const activeThoughtTimestamp = useRef<number | null>(null);
  const thinkingActive = useRef(false);

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

  // ── Drag-and-drop files into chat ────────────────────────────────────────────
  useEffect(() => {
    const sharedPath = runtimeHealth?.sharedPath?.replace(/\/$/, '') ?? '';
    let unlisten: (() => void) | null = null;

    getCurrentWebview().onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (payload.type === 'enter') {
        setDragging(true);
      } else if (payload.type === 'leave') {
        setDragging(false);
      } else if (payload.type === 'drop') {
        setDragging(false);
        if (!sharedPath || payload.paths.length === 0) return;
        useEphemeralStore.getState().setSuppressBlurCollapse(false);
        for (const srcPath of payload.paths) {
          const fileName = srcPath.split('/').pop() ?? srcPath.split('\\').pop() ?? 'file';
          const destPath = `/workspace/${fileName}`;
          try {
            await copyFile(srcPath, `${sharedPath}/${fileName}`);
            setAttachments((prev) => [...prev, { name: fileName, path: destPath }]);
          } catch (err) {
            console.error('Drop upload failed:', err);
          }
        }
      }
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, [runtimeHealth?.sharedPath]);

  // ── Pi event handling ───────────────────────────────────────────────────────

  useEffect(() => {
    const resetAccum = () => {
      accText.current = '';
      accThought.current = '';
      accTools.current = [];
      activeToolId.current = null;
      activeThoughtId.current = null;
      activeThoughtTimestamp.current = null;
      execOutputs.current = {};
      thinkingActive.current = false;
    };

    const syncThoughtLine = (nextContent?: string | null) => {
      const content = (nextContent ?? accThought.current).trim();
      if (!content) return;

      const id = activeThoughtId.current ?? crypto.randomUUID();
      const timestamp = activeThoughtTimestamp.current ?? Date.now();
      activeThoughtId.current = id;
      activeThoughtTimestamp.current = timestamp;

      const line: OutputLine = {
        id,
        type: 'thought',
        content,
        timestamp,
      };
      upsertThoughtLine(line);
    };

    const buildAssistantMessageState = (streaming: boolean) => {
      const inline = parseContent(accText.current);
      const mergedThought = mergeThoughtContent(accThought.current, inline.thought);
      return {
        content: inline.hasThought ? inline.response : accText.current,
        thought: mergedThought ?? '',
        thoughtStreaming: streaming && (thinkingActive.current || inline.thoughtStreaming),
        streaming,
        toolCalls: [...accTools.current],
      };
    };

    let unlistenEventFn: (() => void) | undefined;
    let unlistenEndedFn: (() => void) | undefined;
    let unlistenStderrFn: (() => void) | undefined;
    let active = true;

    const unlistenEvent = onPiEvent((ev: PiEvent) => {
      switch (ev.type) {
        case 'agent_start': {
          resetAccum();
          setStopRequested(false);
          // Guard: skip if there's already a streaming agent bubble (duplicate pi process)
          const currentMsgs = useEphemeralStore.getState().messages;
          const lastMsg = currentMsgs[currentMsgs.length - 1];
          if (lastMsg?.role === 'agent' && lastMsg.streaming) break;
          addMessage({
            id: crypto.randomUUID(),
            role: 'agent',
            content: '',
            thought: '',
            thoughtStreaming: false,
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

          if (d.type === 'thinking_start') {
            thinkingActive.current = true;
            const nextMessage = buildAssistantMessageState(true);
            if (nextMessage.thought) syncThoughtLine(nextMessage.thought);
            updateLastMessage(nextMessage);
          } else if (d.type === 'text_delta' && d.delta) {
            accText.current += d.delta;
            const nextMessage = buildAssistantMessageState(true);
            if (nextMessage.thought) syncThoughtLine(nextMessage.thought);
            updateLastMessage(nextMessage);
          } else if (d.type === 'thinking_delta' && d.delta) {
            thinkingActive.current = true;
            accThought.current += d.delta;
            const nextMessage = buildAssistantMessageState(true);
            if (nextMessage.thought) syncThoughtLine(nextMessage.thought);
            updateLastMessage(nextMessage);
          } else if (d.type === 'thinking_end') {
            thinkingActive.current = false;
            const nextMessage = buildAssistantMessageState(true);
            if (nextMessage.thought) syncThoughtLine(nextMessage.thought);
            updateLastMessage(nextMessage);
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
            thinkingActive.current = false;
            const finalMessage = buildAssistantMessageState(false);
            if (finalMessage.thought) syncThoughtLine(finalMessage.thought);
            updateLastMessage(finalMessage);
            addSessionEvent({
              id: crypto.randomUUID(),
              type: 'agent',
              content: finalMessage.content,
              timestamp: Date.now(),
            });
            setStopRequested(false);
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
          updateLastMessage({ streaming: false, thoughtStreaming: false });
          setStopRequested(false);
          setAgentStatus('idle');
          setPiStatus('ready');
          // Happy flash for 1.8s if the agent actually produced content
          const lastMsg = useEphemeralStore.getState().messages.slice(-1)[0];
          if (lastMsg?.role === 'agent' && (lastMsg.content.trim() || lastMsg.thought?.trim())) {
            setHappyFlash(true);
            setTimeout(() => setHappyFlash(false), 1800);
          }
          break;
        }

        default:
          break;
      }
    });

    unlistenEvent.then((fn) => { if (!active) fn(); else unlistenEventFn = fn; });

    const unlistenEnded = onPiEnded(() => {
      sessionActiveRef.current = false;
      if (restartAfterStopRef.current && containerStatusRef.current === 'running') {
        restartAfterStopRef.current = false;
        setStopRequested(false);
        setAgentStatus('idle');
        startSession().catch(() => {});
        return;
      }
      setStopRequested(false);
      setAgentStatus('idle');
      setPiStatus('offline');
    });

    unlistenEnded.then((fn) => { if (!active) fn(); else unlistenEndedFn = fn; });

    const unlistenStderr = onPiStderr((line: string) => {
      setStderrLines((prev) => [...prev.slice(-49), line]); // keep last 50 lines
    });
    unlistenStderr.then((fn) => { if (!active) fn(); else unlistenStderrFn = fn; });

    return () => {
      active = false;
      unlistenEventFn?.();
      unlistenEndedFn?.();
      unlistenStderrFn?.();
    };
  }, [addMessage, addSessionEvent, setAgentStatus, setPiStatus, startSession, updateLastMessage, upsertThoughtLine]);

  // ── Send ───────────────────────────────────────────────────────────────────

  const handleAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    const sharedPath = runtimeHealth?.sharedPath?.replace(/\/$/, '') ?? '';
    if (!sharedPath) return;
    useEphemeralStore.getState().setSuppressBlurCollapse(false);
    for (const file of files) {
      const hostPath = `${sharedPath}/${file.name}`;
      const destPath = `/workspace/${file.name}`;
      try {
        await writeFileBytes(hostPath, file);
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
      ? `[The user just uploaded the following file(s) to /workspace: ${currentAttachments.map((a) => a.name).join(', ')}. Read their contents before responding — use relative paths (e.g. "${currentAttachments[0].name}").]\n\n`
      : '';
    const userText = text || (currentAttachments.length > 0 ? 'Please read and summarize the uploaded file(s).' : '');
    const promptText = attachmentNote + userText;

    addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
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

  const stopRun = useCallback(async () => {
    if (agentStatus !== 'running' || stopRequested) return;
    restartAfterStopRef.current = true;
    setStopRequested(true);
    updateLastMessage({ streaming: false, thoughtStreaming: false });
    try {
      await stopPiSession();
    } catch (e) {
      restartAfterStopRef.current = false;
      setStopRequested(false);
      setAgentStatus('error');
      setPiStatus('error');
      addMessage({
        id: crypto.randomUUID(),
        role: 'agent',
        content: `Error stopping Ember: ${e instanceof Error ? e.message : String(e)}`,
        timestamp: Date.now(),
      });
    }
  }, [addMessage, agentStatus, setAgentStatus, stopRequested, updateLastMessage]);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const canSend = (Boolean(inputValue.trim()) || attachments.length > 0) && agentStatus !== 'running';
  const canStop = agentStatus === 'running' && !stopRequested;
  const isRunning = agentStatus === 'running';
  const sharedPath = runtimeHealth?.sharedPath ?? '';

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Drop overlay */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-[inherit] border-2 border-dashed border-[#e85c2a]/50 bg-[rgba(232,92,42,0.06)]">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-[#e85c2a]/70">
            <path d="M12 2v13M7 8l5-6 5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <span className="text-[12px] text-[#e85c2a]/70">Drop to attach</span>
        </div>
      )}
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
        {isRunning && (
          <button
            onClick={stopRun}
            disabled={!canStop}
            className="text-[11px] text-red-300/80 hover:text-red-200 transition disabled:opacity-50"
          >
            {stopRequested ? 'stopping…' : 'stop'}
          </button>
        )}
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
              const { thought, response, hasThought, thoughtStreaming } = getMessageParts(message);
              const isUser = message.role === 'user';
              const isReasoningOnly =
                message.streaming && !response.trim() && (thoughtStreaming || hasThought || !message.content.trim());
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
                          isReasoningOnly ? 'thinking' :
                          message.streaming ? 'streaming' :
                          message.toolCalls?.some(tc => tc.running) ? 'excited' :
                          message.toolCalls?.some(tc => tc.error) ? 'error' :
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
                    {hasThought && (
                      <ReasoningBlock thought={thought ?? ''} streaming={thoughtStreaming} />
                    )}

                    {/* Message text */}
                    {(response || (!hasThought && message.content) || (message.streaming && !hasThought)) && (
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
                            text={response || (!hasThought ? message.content : '')}
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
            onClick={isRunning ? () => { stopRun(); } : send}
            disabled={isRunning ? !canStop : !canSend}
            title={isRunning ? (stopRequested ? 'Stopping…' : 'Stop current response') : 'Send'}
            className={`mb-0.5 shrink-0 rounded-full p-1.5 transition disabled:opacity-20 enabled:hover:bg-white/8 ${
              isRunning
                ? 'enabled:text-red-300'
                : 'enabled:text-[rgba(255,109,43,0.9)]'
            }`}
          >
            {isRunning ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="3.25" y="3.25" width="7.5" height="7.5" rx="1.3" fill="currentColor" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function getMessageParts(message: ChatMessage): {
  thought: string | null;
  response: string;
  hasThought: boolean;
  thoughtStreaming: boolean;
} {
  const inline = parseContent(message.content);
  if (message.role === 'agent' && (message.thought !== undefined || message.thoughtStreaming !== undefined)) {
    const thought = mergeThoughtContent(message.thought, inline.thought);
    return {
      thought,
      response: inline.hasThought ? inline.response : message.content,
      hasThought: Boolean(thought),
      thoughtStreaming: Boolean(message.thoughtStreaming || inline.thoughtStreaming),
    };
  }

  return {
    ...inline,
    thoughtStreaming: Boolean(message.streaming && inline.hasThought && (inline.thoughtStreaming || !inline.response.trim())),
  };
}

function mergeThoughtContent(...parts: Array<string | null | undefined>): string | null {
  const merged = parts
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
  return merged || null;
}

function parseContent(content: string): {
  thought: string | null;
  response: string;
  hasThought: boolean;
  thoughtStreaming: boolean;
} {
  const trimmed = content.trimStart();
  const thoughtPrefix = trimmed.match(/^\[THOUGHT\]:?\s*/i);
  if (thoughtPrefix) {
    const body = trimmed.slice(thoughtPrefix[0].length);
    const responseMarker = /\[(?:RESPONSE|FINAL)\]\s*/i.exec(body);
    if (responseMarker?.index !== undefined) {
      return {
        thought: body.slice(0, responseMarker.index).trim(),
        response: body.slice(responseMarker.index + responseMarker[0].length).trim(),
        hasThought: true,
        thoughtStreaming: false,
      };
    }
    const blankLineIndex = body.search(/\n{2,}/);
    if (blankLineIndex !== -1) {
      const separator = body.slice(blankLineIndex).match(/^\n{2,}/)?.[0] ?? '\n\n';
      return {
        thought: body.slice(0, blankLineIndex).trim(),
        response: body.slice(blankLineIndex + separator.length).trim(),
        hasThought: true,
        thoughtStreaming: false,
      };
    }
    return { thought: body.trim(), response: '', hasThought: true, thoughtStreaming: true };
  }

  const tagOpen = trimmed.match(/^<(think(?:ing)?|thought)>\s*/i);
  if (tagOpen) {
    const body = trimmed.slice(tagOpen[0].length);
    const closeMatch = body.match(new RegExp(`</${tagOpen[1]}>`, 'i'));
    if (closeMatch?.index !== undefined) {
      return {
        thought: body.slice(0, closeMatch.index).trim() || null,
        response: body.slice(closeMatch.index + closeMatch[0].length).trim(),
        hasThought: true,
        thoughtStreaming: false,
      };
    }
    return {
      thought: body.trim(),
      response: '',
      hasThought: true,
      thoughtStreaming: true,
    };
  }

  return { thought: null, response: content, hasThought: false, thoughtStreaming: false };
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

  if (isBash && cmd) {
    return (
      <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03]">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="rounded-md border border-white/8 bg-black/25 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-slate-400">
              bash
            </span>
            {call.running && (
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
            )}
            {!call.running && call.error && (
              <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                navigator.clipboard.writeText(cmd).catch(() => {});
              }}
              className="rounded px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:bg-white/8 hover:text-slate-200"
            >
              copy
            </button>
            {(result || call.running) && (
              <button
                onClick={() => setOpen((v) => !v)}
                className="rounded px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:bg-white/8 hover:text-slate-200"
              >
                {open ? 'hide output' : 'show output'}
              </button>
            )}
          </div>
        </div>

        <pre className="overflow-x-auto px-3 py-2.5 scrollbar-thin">
          <code className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.7] text-slate-200">
            {cmd}
          </code>
        </pre>

        {open && (
          <div className="border-t border-white/[0.06] bg-black/20">
            {call.running && !result ? (
              <span className="block px-3 py-2 text-[11px] text-slate-500 animate-pulse">Running…</span>
            ) : (
              <pre
                className={`max-h-40 overflow-y-auto px-3 py-2.5 whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.65] scrollbar-thin ${
                  call.error ? 'text-red-400/70' : 'text-slate-400'
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
  const [open, setOpen] = useState(true);
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

// ── Message content renderer with proper markdown ─────────────────────────────

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
  return (
    <code className="rounded-md border border-white/8 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11.5px] text-slate-100">
      {children}
    </code>
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

function flattenMarkdownText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenMarkdownText).join('');
  if (!node) return '';
  return '';
}

const markdownComponents: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ children, className }) => {
    const content = flattenMarkdownText(children).replace(/\n$/, '');
    const lang = /language-(\S+)/.exec(className ?? '')?.[1] ?? 'text';
    const isBlock = Boolean(className) || content.includes('\n');
    return isBlock ? <CodeBlock lang={lang} content={content} /> : <InlineCode>{content}</InlineCode>;
  },
  h1: ({ children }) => (
    <h1 className="mb-3 mt-1 text-[23px] font-semibold tracking-[-0.02em] text-white">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2.5 mt-5 border-b border-white/8 pb-1 text-[18px] font-semibold tracking-[-0.01em] text-white/95 first:mt-1">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-4 text-[15px] font-semibold uppercase tracking-[0.08em] text-slate-200/95">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-4 text-[13px] font-semibold text-slate-100">
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="mb-3 whitespace-pre-wrap break-words text-[13px] leading-[1.75] text-slate-200/95 last:mb-0">
      {children}
    </p>
  ),
  ul: ({ children }) => (
    <ul className="mb-3 list-disc space-y-1.5 pl-5 text-[13px] leading-[1.7] text-slate-200/95 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 list-decimal space-y-1.5 pl-5 text-[13px] leading-[1.7] text-slate-200/95 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 rounded-r-xl border-l-2 border-[rgba(255,109,43,0.45)] bg-[rgba(255,255,255,0.03)] px-4 py-2 text-slate-300/90 italic last:mb-0">
      {children}
    </blockquote>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-[rgba(255,109,43,0.95)] underline decoration-[rgba(255,109,43,0.45)] underline-offset-4 transition hover:text-[rgba(255,139,88,1)]"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-0 border-t border-white/8" />,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic text-slate-100/95">{children}</em>,
  table: ({ children }) => (
    <div className="mb-4 overflow-x-auto rounded-xl border border-white/8 bg-black/10 last:mb-0">
      <table className="min-w-full border-collapse text-left text-[12px] text-slate-200/95">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-white/[0.04]">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-white/8 px-3 py-2 font-semibold tracking-[0.04em] text-slate-100">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-t border-white/6 px-3 py-2 align-top text-slate-200/90">
      {children}
    </td>
  ),
};

function MessageContent({ text, streaming }: { text: string; streaming?: boolean }) {
  // No text yet — show typing indicator instead of empty bubble + cursor
  if (streaming && !text.trim()) {
    return <TypingIndicator />;
  }

  return (
    <div className="max-w-none text-slate-200">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
      {streaming && <StreamingCursor />}
    </div>
  );
}
