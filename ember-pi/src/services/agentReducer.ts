import type { ToolCall } from '../types';
import type { PiEvent } from './pi';

export interface TurnState {
  text: string;
  thought: string;
  tools: ToolCall[];
  execOutputs: Record<string, string>;
  activeToolId: string | null;
  thinkingActive: boolean;
  thoughtId: string;
  thoughtTimestamp: number;
}

export function initialTurnState(): TurnState {
  return {
    text: '',
    thought: '',
    tools: [],
    execOutputs: {},
    activeToolId: null,
    thinkingActive: false,
    thoughtId: crypto.randomUUID(),
    thoughtTimestamp: Date.now(),
  };
}

export function reduceTurnEvent(state: TurnState, ev: PiEvent): TurnState {
  switch (ev.type) {
    case 'message_update': {
      const d = ev.assistantMessageEvent;
      if (!d) return state;
      switch (d.type) {
        case 'thinking_start':
          return { ...state, thinkingActive: true };
        case 'thinking_delta':
          return { ...state, thought: state.thought + (d.delta ?? ''), thinkingActive: true };
        case 'thinking_end':
          return { ...state, thinkingActive: false };
        case 'text_delta':
          return { ...state, text: state.text + (d.delta ?? '') };
        case 'toolcall_end': {
          if (!d.toolCall) return state;
          const tc: ToolCall = {
            id: d.toolCall.id,
            name: d.toolCall.name,
            args: d.toolCall.arguments ?? {},
            running: true,
          };
          return { ...state, tools: [...state.tools, tc], activeToolId: d.toolCall.id };
        }
        default:
          return state;
      }
    }

    case 'tool_execution_start': {
      const id = ev.toolCallId ?? state.activeToolId ?? '';
      const exists = state.tools.some((tc) => tc.id === id);
      const tools = exists
        ? state.tools.map((tc) =>
            tc.id === id
              ? { ...tc, name: ev.toolName ?? tc.name, args: ev.args ?? tc.args, running: true }
              : tc,
          )
        : [...state.tools, { id, name: ev.toolName ?? '…', args: ev.args ?? {}, running: true }];
      return { ...state, tools, execOutputs: { ...state.execOutputs, [id]: '' } };
    }

    case 'tool_execution_update': {
      const id = ev.toolCallId ?? '';
      if (!id) return state;
      const chunk =
        typeof ev.partialResult === 'string'
          ? ev.partialResult
          : JSON.stringify(ev.partialResult ?? '');
      const output = (state.execOutputs[id] ?? '') + chunk;
      return {
        ...state,
        execOutputs: { ...state.execOutputs, [id]: output },
        tools: state.tools.map((tc) => (tc.id === id ? { ...tc, result: output } : tc)),
      };
    }

    case 'tool_execution_end': {
      const id = ev.toolCallId ?? '';
      const finalResult =
        typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '');
      return {
        ...state,
        tools: state.tools.map((tc) =>
          tc.id === id
            ? {
                ...tc,
                result: finalResult || state.execOutputs[id] || '',
                error: ev.isError === true,
                running: false,
              }
            : tc,
        ),
      };
    }

    default:
      return state;
  }
}
