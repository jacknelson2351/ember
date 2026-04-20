import { useState, useEffect } from 'react';
import { usePersistedStore } from '../stores/appStore';
import { useShallow } from 'zustand/react/shallow';
import { buildEffectivePrompt } from '../utils/buildPrompt';

export function MemoryPanel() {
  const { memoryMode, setMemoryMode } = usePersistedStore(useShallow((state) => ({
    memoryMode: state.memoryMode,
    setMemoryMode: state.setMemoryMode,
  })));
  const injecting = memoryMode !== 'off';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-[#1e1e1e] flex items-center justify-between flex-shrink-0">
        <span className="text-[11px] text-[#6b6b6b] uppercase tracking-widest">Knowledge</span>
        <button
          onClick={() => setMemoryMode(injecting ? 'off' : 'minimal')}
          className={`flex items-center gap-2 rounded-full px-3 py-1 text-[11px] transition border ${
            injecting
              ? 'border-[rgba(232,92,42,0.4)] bg-[rgba(232,92,42,0.1)] text-[#e85c2a]'
              : 'border-white/10 bg-white/[0.02] text-[#4a4a4a] hover:text-[#6b6b6b]'
          }`}
          title={injecting ? 'Ember reads these notes — click to disable' : 'Memory is off — click to enable'}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${injecting ? 'bg-[#e85c2a]' : 'bg-[#3a3a3a]'}`} />
          {injecting ? 'Active' : 'Off'}
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <SystemPromptSection />
        <div className={`transition-opacity ${injecting ? '' : 'opacity-40 pointer-events-none'}`}>
          <KnowledgeSection />
          <SkillsSection />
        </div>
      </div>

      <ContextPreviewDrawer />
      <AddNoteInput />
    </div>
  );
}

// ── System prompt ─────────────────────────────────────────────────────────────

function SystemPromptSection() {
  const { systemPrompt, setSystemPrompt } = usePersistedStore(useShallow((state) => ({
    systemPrompt: state.systemPrompt,
    setSystemPrompt: state.setSystemPrompt,
  })));
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(systemPrompt);
  const [saved, setSaved] = useState(false);

  // Keep local in sync if store changes from outside
  useEffect(() => { setLocal(systemPrompt); }, [systemPrompt]);

  const save = () => {
    setSystemPrompt(local);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const isDirty = local !== systemPrompt;

  return (
    <div className="border-b border-[#1a1a1a]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-left group"
      >
        <span className={`text-[10px] text-[#4a4a4a] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="text-[10px] uppercase tracking-widest text-[#4a4a4a] group-hover:text-[#6b6b6b] transition-colors flex-1">
          System Prompt
        </span>
        {systemPrompt.trim() && (
          <span className="text-[9px] font-mono text-[#2a2a2a]">{systemPrompt.length}ch</span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          <p className="text-[10px] text-[#3a3a3a] px-0.5">
            Always prepended to Ember's context. Notes and skills are appended after.
          </p>
          <textarea
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            rows={6}
            className="w-full resize-none rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-slate-200 outline-none transition focus:border-white/15"
            spellCheck={false}
            placeholder="No system prompt set…"
          />
          {isDirty && (
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setLocal(systemPrompt)}
                className="text-[10px] text-[#4a4a4a] hover:text-[#6b6b6b] transition-colors"
              >
                revert
              </button>
              <button
                onClick={save}
                className="text-[10px] text-[#e85c2a] hover:text-[#d44f20] transition-colors"
              >
                {saved ? '✓ saved' : 'save'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Knowledge (notes) ─────────────────────────────────────────────────────────

function KnowledgeSection() {
  const { notes, togglePin, deleteNote, updateNote } = usePersistedStore(useShallow((state) => ({
    notes: state.notes,
    togglePin: state.togglePin,
    deleteNote: state.deleteNote,
    updateNote: state.updateNote,
  })));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const active = notes.filter((n) => n.pinned);
  const inactive = notes.filter((n) => !n.pinned);
  const [showInactive, setShowInactive] = useState(true);

  const startEdit = (id: string, content: string) => { setEditingId(id); setEditText(content); };
  const saveEdit = () => { if (editingId) updateNote(editingId, editText); setEditingId(null); };

  return (
    <div className="px-3 pt-3 pb-1">
      {notes.length === 0 && (
        <p className="text-[#2a2a2a] text-[12px] px-1 pb-2">
          No notes yet. Add one below — active notes are injected into Ember's context.
        </p>
      )}

      {active.length > 0 && (
        <section className="mb-2">
          <p className="text-[10px] text-[#e85c2a] uppercase tracking-widest mb-1.5 px-1">Active</p>
          <NoteCards
            notes={active}
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

      {inactive.length > 0 && (
        <section>
          <button
            onClick={() => setShowInactive((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] text-[#4a4a4a] uppercase tracking-widest mb-1.5 px-1 hover:text-[#6b6b6b] transition-colors"
          >
            <span className={`transition-transform ${showInactive ? 'rotate-90' : ''}`}>▶</span>
            Inactive ({inactive.length})
          </button>
          {showInactive && (
            <NoteCards
              notes={inactive}
              editingId={editingId}
              editText={editText}
              onEditTextChange={setEditText}
              onTogglePin={togglePin}
              onDelete={deleteNote}
              onStartEdit={startEdit}
              onSaveEdit={saveEdit}
            />
          )}
        </section>
      )}
    </div>
  );
}

interface NoteCardsProps {
  notes: { id: string; content: string; pinned: boolean; createdAt: number }[];
  editingId: string | null;
  editText: string;
  onEditTextChange: (v: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  onStartEdit: (id: string, content: string) => void;
  onSaveEdit: () => void;
}

function NoteCards({
  notes, editingId, editText, onEditTextChange,
  onTogglePin, onDelete, onStartEdit, onSaveEdit,
}: NoteCardsProps) {
  return (
    <div className="space-y-0.5">
      {notes.map((note) => (
        <div
          key={note.id}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg group hover:bg-[#0f0f0f] transition-colors"
        >
          {/* Active toggle pill */}
          <button
            onClick={() => onTogglePin(note.id)}
            title={note.pinned ? 'Click to deactivate' : 'Click to activate'}
            className={`flex-shrink-0 flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border transition-colors ${
              note.pinned
                ? 'border-[rgba(232,92,42,0.4)] bg-[rgba(232,92,42,0.12)] text-[#e85c2a]'
                : 'border-white/8 bg-white/[0.02] text-[#3a3a3a] hover:text-[#6b6b6b] hover:border-white/15'
            }`}
          >
            <span className={`w-1 h-1 rounded-full ${note.pinned ? 'bg-[#e85c2a]' : 'bg-[#3a3a3a]'}`} />
            {note.pinned ? 'on' : 'off'}
          </button>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {editingId === note.id ? (
              <input
                autoFocus
                value={editText}
                onChange={(e) => onEditTextChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') onSaveEdit(); }}
                onBlur={onSaveEdit}
                className="w-full bg-transparent border-b border-[#e85c2a] text-[#e2e2e2] text-[12px] outline-none pb-0.5"
              />
            ) : (
              <span
                className={`text-[12px] leading-relaxed break-words cursor-text block ${note.pinned ? 'text-[#c0c0c0]' : 'text-[#5a5a5a]'}`}
                onDoubleClick={() => onStartEdit(note.id, note.content)}
                title="Double-click to edit"
              >
                {note.content}
              </span>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
            <button
              onClick={() => onStartEdit(note.id, note.content)}
              className="text-[10px] text-[#4a4a4a] hover:text-[#5f8fff] transition-colors"
            >
              edit
            </button>
            <button
              onClick={() => onDelete(note.id)}
              className="text-[13px] text-[#4a4a4a] hover:text-[#e05252] transition-colors leading-none"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Skills ────────────────────────────────────────────────────────────────────

function SkillsSection() {
  const { skills, toggleSkill, updateSkill } = usePersistedStore(useShallow((state) => ({
    skills: state.skills,
    toggleSkill: state.toggleSkill,
    updateSkill: state.updateSkill,
  })));
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState<Record<string, string>>({});

  const enabledCount = skills.filter((sk) => sk.enabled).length;

  return (
    <div className="px-3 py-2 border-t border-[#1a1a1a] mt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left group"
      >
        <span className={`text-[10px] text-[#4a4a4a] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="text-[10px] uppercase tracking-widest text-[#4a4a4a] group-hover:text-[#6b6b6b] transition-colors">
          Skills
        </span>
        <span className={`text-[10px] font-mono ml-1 ${enabledCount > 0 ? 'text-[#e85c2a]/60' : 'text-[#2a2a2a]'}`}>
          {enabledCount}/{skills.length}
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-1.5">
          {skills.map((sk) => {
            const isExpanded = expandedId === sk.id;
            const draft = draftContent[sk.id] ?? sk.content;
            const isDirty = draft !== sk.content;

            return (
              <div
                key={sk.id}
                className={`rounded-xl border transition-colors ${
                  sk.enabled ? 'border-[rgba(232,92,42,0.2)] bg-[rgba(232,92,42,0.04)]' : 'border-white/6 bg-white/[0.01]'
                }`}
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  {/* Enable toggle pill */}
                  <button
                    onClick={() => toggleSkill(sk.id)}
                    className={`flex-shrink-0 h-4 w-7 rounded-full border transition-colors ${
                      sk.enabled ? 'border-[rgba(232,92,42,0.5)] bg-[rgba(232,92,42,0.3)]' : 'border-white/15 bg-white/[0.06]'
                    }`}
                  >
                    <div className={`mt-px h-3 w-3 rounded-full transition-transform ${
                      sk.enabled ? 'translate-x-3 bg-[#e85c2a]' : 'translate-x-0.5 bg-slate-500'
                    }`} />
                  </button>

                  <span className={`flex-1 text-[12px] ${sk.enabled ? 'text-[#e2e2e2]' : 'text-[#6b6b6b]'}`}>
                    {sk.name}
                  </span>

                  {!isExpanded && (
                    <span className="text-[10px] text-[#2a2a2a] truncate max-w-[90px]">
                      {sk.content.slice(0, 60).replace(/\n/g, ' ')}
                    </span>
                  )}

                  <button
                    onClick={() => {
                      setExpandedId(isExpanded ? null : sk.id);
                      if (!isExpanded) setDraftContent((d) => ({ ...d, [sk.id]: sk.content }));
                    }}
                    className="text-[10px] text-[#3a3a3a] hover:text-[#6b6b6b] transition-colors flex-shrink-0"
                    title={isExpanded ? 'Collapse' : 'Edit'}
                  >
                    {isExpanded ? '▲' : '▼'}
                  </button>
                </div>

                {isExpanded && (
                  <div className="px-3 pb-3 space-y-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraftContent((d) => ({ ...d, [sk.id]: e.target.value }))}
                      rows={8}
                      className="w-full bg-black/30 border border-white/8 rounded-lg px-2.5 py-2 text-[11px] font-mono text-[#c0c0c0] outline-none resize-none focus:border-white/15 transition"
                    />
                    {isDirty && (
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => setDraftContent((d) => ({ ...d, [sk.id]: sk.content }))}
                          className="text-[10px] text-[#4a4a4a] hover:text-[#6b6b6b] transition-colors"
                        >
                          revert
                        </button>
                        <button
                          onClick={() => {
                            updateSkill(sk.id, { content: draft });
                            setDraftContent((d) => { const n = { ...d }; delete n[sk.id]; return n; });
                          }}
                          className="text-[10px] text-[#e85c2a] hover:text-[#d44f20] transition-colors"
                        >
                          save
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Context preview ───────────────────────────────────────────────────────────

function ContextPreviewDrawer() {
  const { systemPrompt, memoryMode, notes, skills } = usePersistedStore(useShallow((state) => ({
    systemPrompt: state.systemPrompt,
    memoryMode: state.memoryMode,
    notes: state.notes,
    skills: state.skills,
  })));
  const [open, setOpen] = useState(false);

  const preview = buildEffectivePrompt({ systemPrompt, memoryMode, notes, skills });

  return (
    <div className="border-t border-[#1a1a1a] flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-4 py-2 text-left group"
      >
        <span className={`text-[10px] text-[#4a4a4a] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="text-[10px] uppercase tracking-widest text-[#4a4a4a] group-hover:text-[#6b6b6b] transition-colors flex-1">
          Ember sees this
        </span>
        <span className="text-[10px] font-mono text-[#2a2a2a]">{preview.length}ch</span>
      </button>

      {open && (
        <div className="px-3 pb-3">
          <pre className="font-mono text-[10px] text-[#4caf78]/70 bg-black/30 rounded-xl border border-white/8 px-3 py-2.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">
            {preview}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Add note input ────────────────────────────────────────────────────────────

function AddNoteInput() {
  const { addNote } = usePersistedStore(useShallow((state) => ({
    addNote: state.addNote,
  })));
  const [draft, setDraft] = useState('');

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    addNote({ id: crypto.randomUUID(), content: text, createdAt: Date.now(), pinned: true });
    setDraft('');
  };

  return (
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
  );
}
