import { useState } from 'react';
import { useAppStore } from '../stores/appStore';

type SubTab = 'notes' | 'session';

export function MemoryPanel() {
  const [subTab, setSubTab] = useState<SubTab>('notes');

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-[#1e1e1e] flex items-center justify-between flex-shrink-0">
        <span className="text-[11px] text-[#6b6b6b] uppercase tracking-widest">Memory</span>
        <MemoryModeSelector />
      </div>

      {/* Sub-tabs */}
      <div className="flex border-b border-[#1e1e1e] px-2 flex-shrink-0">
        {(['notes', 'session'] as SubTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setSubTab(t)}
            className={`px-3 py-2 text-[11px] font-medium capitalize transition-colors ${
              subTab === t
                ? 'text-[#e2e2e2] border-b-2 border-[#e85c2a]'
                : 'text-[#6b6b6b] hover:text-[#a0a0a0]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {subTab === 'notes'   && <NotesView />}
      {subTab === 'session' && <SessionView />}
    </div>
  );
}

function MemoryModeSelector() {
  const { memoryMode, setMemoryMode } = useAppStore();
  return (
    <select
      value={memoryMode}
      onChange={(e) => setMemoryMode(e.target.value as typeof memoryMode)}
      className="bg-[#141414] border border-[#1e1e1e] text-[#a0a0a0] text-[11px] rounded px-1.5 py-0.5 outline-none"
    >
      <option value="off">off</option>
      <option value="minimal">minimal</option>
      <option value="session">session</option>
      <option value="full">full</option>
    </select>
  );
}

// ── Notes view ───────────────────────────────────────────────────────────────

function NotesView() {
  const { notes, addNote, togglePin, deleteNote, updateNote } = useAppStore();
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    addNote({ id: crypto.randomUUID(), content: text, createdAt: Date.now(), pinned: false });
    setDraft('');
  };

  const startEdit = (id: string, content: string) => {
    setEditingId(id);
    setEditText(content);
  };

  const saveEdit = () => {
    if (editingId) updateNote(editingId, editText);
    setEditingId(null);
  };

  const pinned = notes.filter((n) => n.pinned);
  const unpinned = notes.filter((n) => !n.pinned);

  return (
    <>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {pinned.length > 0 && (
          <section>
            <p className="text-[10px] text-[#e85c2a] uppercase tracking-widest mb-1.5 px-1">Pinned</p>
            <NoteList
              notes={pinned}
              editingId={editingId}
              editText={editText}
              onEditTextChange={setEditText}
              onTogglePin={togglePin}
              onDelete={deleteNote}
              onStartEdit={startEdit}
              onSaveEdit={saveEdit}
            />
          </section>
        )}

        <section>
          {pinned.length > 0 && unpinned.length > 0 && (
            <p className="text-[10px] text-[#6b6b6b] uppercase tracking-widest mb-1.5 px-1">Notes</p>
          )}
          {notes.length === 0 && (
            <p className="text-[#2a2a2a] text-sm px-1">No notes yet. Add one below.</p>
          )}
          <NoteList
            notes={unpinned}
            editingId={editingId}
            editText={editText}
            onEditTextChange={setEditText}
            onTogglePin={togglePin}
            onDelete={deleteNote}
            onStartEdit={startEdit}
            onSaveEdit={saveEdit}
          />
        </section>
      </div>

      {/* Add note input */}
      <div className="border-t border-[#1e1e1e] px-3 py-2 flex-shrink-0">
        <div className="flex gap-2 bg-[#141414] rounded-lg border border-[#1e1e1e] px-3 py-2 focus-within:border-[#2a2a2a]">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Add note… (Enter to save)"
            className="flex-1 bg-transparent text-[#e2e2e2] placeholder-[#3a3a3a] text-sm outline-none"
          />
          <button
            onClick={submit}
            disabled={!draft.trim()}
            className="text-[11px] text-[#e85c2a] hover:text-[#d44f20] disabled:text-[#3a3a3a] transition-colors"
          >
            add
          </button>
        </div>
      </div>
    </>
  );
}

interface NoteListProps {
  notes: { id: string; content: string; pinned: boolean; createdAt: number }[];
  editingId: string | null;
  editText: string;
  onEditTextChange: (v: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  onStartEdit: (id: string, content: string) => void;
  onSaveEdit: () => void;
}

function NoteList({
  notes,
  editingId,
  editText,
  onEditTextChange,
  onTogglePin,
  onDelete,
  onStartEdit,
  onSaveEdit,
}: NoteListProps) {
  return (
    <div className="space-y-0.5">
      {notes.map((note) => (
        <div
          key={note.id}
          className="flex items-start gap-2 px-2 py-2 rounded hover:bg-[#0f0f0f] group"
        >
          {/* Pin button */}
          <button
            onClick={() => onTogglePin(note.id)}
            title={note.pinned ? 'Unpin' : 'Pin'}
            className={`flex-shrink-0 mt-0.5 w-3 h-3 rounded-full border transition-colors ${
              note.pinned
                ? 'bg-[#e85c2a] border-[#e85c2a]'
                : 'bg-transparent border-[#3a3a3a] opacity-0 group-hover:opacity-100'
            }`}
          />

          {/* Content */}
          {editingId === note.id ? (
            <input
              autoFocus
              value={editText}
              onChange={(e) => onEditTextChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSaveEdit();
                if (e.key === 'Escape') onSaveEdit();
              }}
              onBlur={onSaveEdit}
              className="flex-1 bg-transparent border-b border-[#e85c2a] text-[#e2e2e2] text-[12px] outline-none pb-0.5"
            />
          ) : (
            <span
              className="flex-1 text-[#c0c0c0] text-[12px] leading-relaxed break-words cursor-text"
              onDoubleClick={() => onStartEdit(note.id, note.content)}
              title="Double-click to edit"
            >
              {note.content}
            </span>
          )}

          {/* Actions */}
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 flex-shrink-0">
            <button
              onClick={() => onStartEdit(note.id, note.content)}
              className="text-[10px] text-[#4a4a4a] hover:text-[#5f8fff] transition-colors"
            >
              edit
            </button>
            <button
              onClick={() => onDelete(note.id)}
              className="text-[13px] text-[#4a4a4a] hover:text-[#e05252] transition-colors"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Session log view ─────────────────────────────────────────────────────────

function SessionView() {
  const { sessionLog, clearSessionLog } = useAppStore();

  const typeColor: Record<string, string> = {
    user:   'text-[#5f8fff]',
    agent:  'text-[#4caf78]',
    tool:   'text-[#f5a623]',
    system: 'text-[#6b6b6b]',
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1e1e1e] flex-shrink-0">
        <span className="text-[11px] text-[#6b6b6b]">
          {sessionLog.length} event{sessionLog.length !== 1 ? 's' : ''} this session
        </span>
        <button
          onClick={clearSessionLog}
          className="text-[11px] text-[#3a3a3a] hover:text-[#e05252] transition-colors"
        >
          clear
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {sessionLog.length === 0 && (
          <p className="text-[#2a2a2a] text-sm pt-2">No session events yet.</p>
        )}
        {sessionLog.slice().reverse().map((e) => (
          <div key={e.id} className="py-1.5 border-b border-[#0f0f0f] last:border-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className={`text-[10px] font-mono uppercase ${typeColor[e.type] ?? 'text-[#6b6b6b]'}`}>
                {e.type}
              </span>
              <span className="text-[10px] text-[#2a2a2a]">
                {new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
            <p className="text-[11px] text-[#6b6b6b] leading-relaxed line-clamp-2 break-words">
              {e.content}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
