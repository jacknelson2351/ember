import { useEffect, useState, type ReactNode } from 'react';
import { usePersistedStore } from '../stores/appStore';
import { useShallow } from 'zustand/react/shallow';
import { buildPiAppendSystemPrompt, buildPiManagedSkills } from '../utils/buildPrompt';

type SkillDraft = {
  name: string;
  description: string;
  content: string;
};

const EMPTY_SKILL_DRAFT: SkillDraft = {
  name: '',
  description: '',
  content: '',
};

export function MemoryPanel() {
  const { memoryMode, setMemoryMode } = usePersistedStore(useShallow((state) => ({
    memoryMode: state.memoryMode,
    setMemoryMode: state.setMemoryMode,
  })));
  const extrasEnabled = memoryMode !== 'off';

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[#1e1e1e] px-4 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-[11px] uppercase tracking-widest text-[#6b6b6b]">Instructions</span>
            <p className="mt-1 text-[11px] leading-5 text-[#3f3f3f]">
              Base instructions always apply. Notes and skills are optional project context synced for Pi.
            </p>
          </div>
          <button
            onClick={() => setMemoryMode(extrasEnabled ? 'off' : 'minimal')}
            className={`shrink-0 rounded-full border px-3 py-1 text-[11px] transition ${
              extrasEnabled
                ? 'border-[rgba(232,92,42,0.4)] bg-[rgba(232,92,42,0.1)] text-[#e85c2a]'
                : 'border-white/10 bg-white/[0.02] text-[#4a4a4a] hover:text-[#6b6b6b]'
            }`}
            title={
              extrasEnabled
                ? 'Project notes and skills are enabled'
                : 'Project notes and skills are disabled'
            }
          >
            {extrasEnabled ? 'Notes & Skills On' : 'Notes & Skills Off'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <BaseInstructionsSection />
        <div className={`space-y-0 border-b border-[#1a1a1a] transition-opacity ${extrasEnabled ? '' : 'pointer-events-none opacity-45'}`}>
          <NotesSection disabled={!extrasEnabled} />
          <SkillsSection disabled={!extrasEnabled} />
        </div>
      </div>

      <GeneratedFilesDrawer />
    </div>
  );
}

function BaseInstructionsSection() {
  const { systemPrompt, setSystemPrompt } = usePersistedStore(useShallow((state) => ({
    systemPrompt: state.systemPrompt,
    setSystemPrompt: state.setSystemPrompt,
  })));
  const [open, setOpen] = useState(true);
  const [local, setLocal] = useState(systemPrompt);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLocal(systemPrompt);
  }, [systemPrompt]);

  const save = () => {
    setSystemPrompt(local);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const isDirty = local !== systemPrompt;

  return (
    <section className="border-b border-[#1a1a1a]">
      <SectionHeader
        title="Base Instructions"
        meta={systemPrompt.trim() ? `${systemPrompt.length}ch` : 'always on'}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      />

      {open && (
        <div className="space-y-2 px-3 pb-3">
          <p className="px-0.5 text-[11px] leading-5 text-[#4a4a4a]">
            Synced into Pi as `/workspace/.pi/APPEND_SYSTEM.md`. Use this for stable behavior and tone.
          </p>
          <textarea
            value={local}
            onChange={(event) => setLocal(event.target.value)}
            rows={8}
            className="w-full resize-none rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-slate-200 outline-none transition focus:border-white/15"
            spellCheck={false}
            placeholder="Set the base instructions Ember should always follow…"
          />
          {isDirty && (
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setLocal(systemPrompt)}
                className="text-[10px] text-[#4a4a4a] transition-colors hover:text-[#6b6b6b]"
              >
                revert
              </button>
              <button
                onClick={save}
                className="text-[10px] text-[#e85c2a] transition-colors hover:text-[#d44f20]"
              >
                {saved ? 'saved' : 'save'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function NotesSection({ disabled }: { disabled: boolean }) {
  const { notes, addNote, togglePin, deleteNote, updateNote } = usePersistedStore(useShallow((state) => ({
    notes: state.notes,
    addNote: state.addNote,
    togglePin: state.togglePin,
    deleteNote: state.deleteNote,
    updateNote: state.updateNote,
  })));
  const [open, setOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [draft, setDraft] = useState('');

  const included = notes.filter((note) => note.pinned);
  const excluded = notes.filter((note) => !note.pinned);

  const startEdit = (id: string, content: string) => {
    setEditingId(id);
    setEditText(content);
  };

  const saveEdit = () => {
    if (editingId) updateNote(editingId, editText);
    setEditingId(null);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    addNote({
      id: crypto.randomUUID(),
      content: text,
      createdAt: Date.now(),
      pinned: true,
    });
    setDraft('');
  };

  return (
    <section className="border-b border-[#1a1a1a]">
      <SectionHeader
        title="Notes"
        meta={`${included.length}/${notes.length} included`}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      />

      {open && (
        <div className="space-y-3 px-3 pb-3">
          <p className="px-0.5 text-[11px] leading-5 text-[#4a4a4a]">
            Short project reminders. Included notes are appended under Project Notes in Pi.
          </p>

          {included.length > 0 ? (
            <div>
              <p className="mb-1.5 px-1 text-[10px] uppercase tracking-widest text-[#e85c2a]">Included</p>
              <NoteCards
                notes={included}
                editingId={editingId}
                editText={editText}
                onEditTextChange={setEditText}
                onTogglePin={togglePin}
                onDelete={deleteNote}
                onStartEdit={startEdit}
                onSaveEdit={saveEdit}
              />
            </div>
          ) : (
            <p className="px-1 text-[12px] text-[#4a4a4a]">
              No notes are included yet.
            </p>
          )}

          {excluded.length > 0 && (
            <div>
              <p className="mb-1.5 px-1 text-[10px] uppercase tracking-widest text-[#5a5a5a]">Not Included</p>
              <NoteCards
                notes={excluded}
                editingId={editingId}
                editText={editText}
                onEditTextChange={setEditText}
                onTogglePin={togglePin}
                onDelete={deleteNote}
                onStartEdit={startEdit}
                onSaveEdit={saveEdit}
              />
            </div>
          )}

          <div className="rounded-lg border border-[#1e1e1e] bg-[#141414] px-3 py-2 focus-within:border-[#2a2a2a]">
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit();
                }}
                disabled={disabled}
                placeholder={disabled ? 'Turn notes and skills back on to add a note' : 'Add note to project context…'}
                className="flex-1 bg-transparent text-sm text-[#e2e2e2] outline-none placeholder:text-[#3a3a3a] disabled:cursor-not-allowed"
              />
              <button
                onClick={submit}
                disabled={disabled || !draft.trim()}
                className="text-[11px] text-[#e85c2a] transition-colors hover:text-[#d44f20] disabled:text-[#3a3a3a]"
              >
                add
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

interface NoteCardsProps {
  notes: { id: string; content: string; pinned: boolean; createdAt: number }[];
  editingId: string | null;
  editText: string;
  onEditTextChange: (value: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  onStartEdit: (id: string, content: string) => void;
  onSaveEdit: () => void;
}

function NoteCards({
  notes,
  editingId,
  editText,
  onEditTextChange,
  onTogglePin,
  onDelete,
  onStartEdit,
  onSaveEdit,
}: NoteCardsProps) {
  return (
    <div className="space-y-1">
      {notes.map((note) => (
        <div
          key={note.id}
          className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[#0f0f0f]"
        >
          <button
            onClick={() => onTogglePin(note.id)}
            title={note.pinned ? 'Exclude this note from Pi sync' : 'Include this note in Pi sync'}
            className={`flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider transition-colors ${
              note.pinned
                ? 'border-[rgba(232,92,42,0.4)] bg-[rgba(232,92,42,0.12)] text-[#e85c2a]'
                : 'border-white/8 bg-white/[0.02] text-[#5a5a5a] hover:border-white/15 hover:text-[#6b6b6b]'
            }`}
          >
            <span className={`h-1 w-1 rounded-full ${note.pinned ? 'bg-[#e85c2a]' : 'bg-[#3a3a3a]'}`} />
            {note.pinned ? 'included' : 'excluded'}
          </button>

          <div className="min-w-0 flex-1">
            {editingId === note.id ? (
              <input
                autoFocus
                value={editText}
                onChange={(event) => onEditTextChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === 'Escape') onSaveEdit();
                }}
                onBlur={onSaveEdit}
                className="w-full border-b border-[#e85c2a] bg-transparent pb-0.5 text-[12px] text-[#e2e2e2] outline-none"
              />
            ) : (
              <button
                onDoubleClick={() => onStartEdit(note.id, note.content)}
                className={`block w-full cursor-text text-left text-[12px] leading-relaxed ${
                  note.pinned ? 'text-[#c0c0c0]' : 'text-[#5a5a5a]'
                }`}
                title="Double-click to edit"
              >
                {note.content}
              </button>
            )}
          </div>

          <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={() => onStartEdit(note.id, note.content)}
              className="text-[10px] text-[#4a4a4a] transition-colors hover:text-[#5f8fff]"
            >
              edit
            </button>
            <button
              onClick={() => onDelete(note.id)}
              className="text-[13px] leading-none text-[#4a4a4a] transition-colors hover:text-[#e05252]"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SkillsSection({ disabled }: { disabled: boolean }) {
  const { skills, addSkill, updateSkill, deleteSkill, toggleSkill } = usePersistedStore(useShallow((state) => ({
    skills: state.skills,
    addSkill: state.addSkill,
    updateSkill: state.updateSkill,
    deleteSkill: state.deleteSkill,
    toggleSkill: state.toggleSkill,
  })));
  const [open, setOpen] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, SkillDraft>>({});
  const [newSkill, setNewSkill] = useState<SkillDraft>(EMPTY_SKILL_DRAFT);

  const enabledCount = skills.filter((skill) => skill.enabled).length;

  const startEditing = (skillId: string, skill: { name: string; description?: string; content: string }) => {
    setExpandedId((current) => (current === skillId ? null : skillId));
    setDrafts((current) => ({
      ...current,
      [skillId]: {
        name: skill.name,
        description: skill.description ?? '',
        content: skill.content,
      },
    }));
  };

  const saveSkill = (skillId: string) => {
    const draft = drafts[skillId];
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) return;
    updateSkill(skillId, {
      name,
      description: draft.description.trim() || undefined,
      content: normalizeSkillBody(name, draft.content),
    });
  };

  const createSkill = () => {
    const name = newSkill.name.trim();
    if (!name || disabled) return;
    addSkill({
      id: crypto.randomUUID(),
      name,
      description: newSkill.description.trim() || undefined,
      content: normalizeSkillBody(name, newSkill.content),
      enabled: true,
      createdAt: Date.now(),
    });
    setCreating(false);
    setNewSkill(EMPTY_SKILL_DRAFT);
  };

  return (
    <section className="border-b border-[#1a1a1a]">
      <SectionHeader
        title="Skills"
        meta={`${enabledCount}/${skills.length} enabled`}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        action={(
          <button
            onClick={(event) => {
              event.stopPropagation();
              if (disabled) return;
              setCreating((value) => !value);
              setExpandedId(null);
            }}
            disabled={disabled}
            className="rounded-full border border-white/10 px-2.5 py-0.5 text-[10px] text-[#6b6b6b] transition-colors hover:border-white/15 hover:text-slate-200 disabled:cursor-not-allowed disabled:text-[#3a3a3a]"
          >
            {creating ? 'cancel' : 'new skill'}
          </button>
        )}
      />

      {open && (
        <div className="space-y-3 px-3 pb-3">
          <p className="px-0.5 text-[11px] leading-5 text-[#4a4a4a]">
            Reusable workflows synced into `/workspace/.pi/skills/ember-managed/`. Enabled skills are available to Pi.
          </p>

          {creating && (
            <SkillEditor
              title="New Skill"
              draft={newSkill}
              onChange={setNewSkill}
              onCancel={() => {
                setCreating(false);
                setNewSkill(EMPTY_SKILL_DRAFT);
              }}
              onSave={createSkill}
              saveLabel="create skill"
            />
          )}

          {skills.length === 0 ? (
            <p className="px-1 text-[12px] text-[#4a4a4a]">
              No skills yet. Create one to sync a reusable Pi workflow into the workspace.
            </p>
          ) : (
            <div className="space-y-2">
              {skills.map((skill) => {
                const draft = drafts[skill.id] ?? {
                  name: skill.name,
                  description: skill.description ?? '',
                  content: skill.content,
                };
                const expanded = expandedId === skill.id;
                const summary = (skill.description ?? firstMeaningfulLine(skill.content) ?? 'No description').trim();
                const dirty =
                  draft.name !== skill.name ||
                  draft.description !== (skill.description ?? '') ||
                  draft.content !== skill.content;

                return (
                  <div
                    key={skill.id}
                    className={`rounded-xl border transition-colors ${
                      skill.enabled
                        ? 'border-[rgba(232,92,42,0.2)] bg-[rgba(232,92,42,0.04)]'
                        : 'border-white/6 bg-white/[0.01]'
                    }`}
                  >
                    <div className="flex items-start gap-2 px-3 py-2.5">
                      <button
                        onClick={() => toggleSkill(skill.id)}
                        disabled={disabled}
                        className={`mt-0.5 flex h-4 w-7 shrink-0 rounded-full border transition-colors ${
                          skill.enabled
                            ? 'border-[rgba(232,92,42,0.5)] bg-[rgba(232,92,42,0.3)]'
                            : 'border-white/15 bg-white/[0.06]'
                        }`}
                        title={skill.enabled ? 'Disable this skill for Pi' : 'Enable this skill for Pi'}
                      >
                        <div className={`mt-px h-3 w-3 rounded-full transition-transform ${
                          skill.enabled ? 'translate-x-3 bg-[#e85c2a]' : 'translate-x-0.5 bg-slate-500'
                        }`} />
                      </button>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-[12px] ${skill.enabled ? 'text-[#e2e2e2]' : 'text-[#7a7a7a]'}`}>
                            {skill.name}
                          </span>
                          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${
                            skill.enabled
                              ? 'bg-[rgba(232,92,42,0.12)] text-[#e85c2a]'
                              : 'bg-white/[0.04] text-[#4a4a4a]'
                          }`}>
                            {skill.enabled ? 'enabled' : 'disabled'}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] leading-5 text-[#5a5a5a]">
                          {summary}
                        </p>
                      </div>

                      <div className="flex shrink-0 gap-2">
                        <button
                          onClick={() => startEditing(skill.id, skill)}
                          className="text-[10px] text-[#4a4a4a] transition-colors hover:text-[#6b6b6b]"
                        >
                          {expanded ? 'close' : 'edit'}
                        </button>
                        <button
                          onClick={() => deleteSkill(skill.id)}
                          className="text-[10px] text-[#4a4a4a] transition-colors hover:text-[#e05252]"
                        >
                          delete
                        </button>
                      </div>
                    </div>

                    {expanded && (
                      <div className="border-t border-white/6 px-3 pb-3 pt-3">
                        <SkillEditor
                          title="Edit Skill"
                          draft={draft}
                          onChange={(nextDraft) => {
                            setDrafts((current) => ({ ...current, [skill.id]: nextDraft }));
                          }}
                          onCancel={() => {
                            setExpandedId(null);
                            setDrafts((current) => ({
                              ...current,
                              [skill.id]: {
                                name: skill.name,
                                description: skill.description ?? '',
                                content: skill.content,
                              },
                            }));
                          }}
                          onSave={() => saveSkill(skill.id)}
                          saveLabel={dirty ? 'save changes' : 'saved'}
                          saveDisabled={!dirty}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface SkillEditorProps {
  title: string;
  draft: SkillDraft;
  onChange: (draft: SkillDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  saveLabel: string;
  saveDisabled?: boolean;
}

function SkillEditor({
  title,
  draft,
  onChange,
  onCancel,
  onSave,
  saveLabel,
  saveDisabled = false,
}: SkillEditorProps) {
  return (
    <div className="space-y-2 rounded-xl border border-white/8 bg-black/20 px-3 py-3">
      <p className="text-[10px] uppercase tracking-widest text-[#4a4a4a]">{title}</p>
      <input
        value={draft.name}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
        placeholder="Skill name"
        className="w-full rounded-lg border border-white/8 bg-white/[0.03] px-2.5 py-2 text-[12px] text-slate-200 outline-none transition focus:border-white/15"
      />
      <input
        value={draft.description}
        onChange={(event) => onChange({ ...draft, description: event.target.value })}
        placeholder="Short description"
        className="w-full rounded-lg border border-white/8 bg-white/[0.03] px-2.5 py-2 text-[12px] text-slate-200 outline-none transition focus:border-white/15"
      />
      <textarea
        value={draft.content}
        onChange={(event) => onChange({ ...draft, content: event.target.value })}
        rows={10}
        placeholder={defaultSkillTemplate(draft.name)}
        className="w-full resize-none rounded-lg border border-white/8 bg-black/30 px-2.5 py-2 font-mono text-[11px] text-[#c0c0c0] outline-none transition focus:border-white/15"
      />
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="text-[10px] text-[#4a4a4a] transition-colors hover:text-[#6b6b6b]"
        >
          cancel
        </button>
        <button
          onClick={onSave}
          disabled={saveDisabled || !draft.name.trim()}
          className="text-[10px] text-[#e85c2a] transition-colors hover:text-[#d44f20] disabled:text-[#3a3a3a]"
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

function GeneratedFilesDrawer() {
  const { systemPrompt, memoryMode, notes, skills } = usePersistedStore(useShallow((state) => ({
    systemPrompt: state.systemPrompt,
    memoryMode: state.memoryMode,
    notes: state.notes,
    skills: state.skills,
  })));
  const [open, setOpen] = useState(false);

  const appendSystem = buildPiAppendSystemPrompt({ systemPrompt, memoryMode, notes, skills });
  const managedSkills = buildPiManagedSkills(skills, memoryMode);

  return (
    <div className="shrink-0 border-t border-[#1a1a1a]">
      <SectionHeader
        title="Generated Pi Files"
        meta={`${managedSkills.length} skills`}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      />

      {open && (
        <div className="space-y-2 px-3 pb-3">
          <p className="px-0.5 text-[11px] leading-5 text-[#4a4a4a]">
            Advanced preview only. Ember writes these files for Pi automatically.
          </p>

          <div className="rounded-xl border border-white/8 bg-black/30 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-widest text-[#4a4a4a]">
              /workspace/.pi/APPEND_SYSTEM.md
            </p>
            <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-[#4caf78]/70">
              {appendSystem || '# No appended system context'}
            </pre>
          </div>

          <div className="rounded-xl border border-white/8 bg-black/30 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-widest text-[#4a4a4a]">
              /workspace/.pi/skills/ember-managed/
            </p>
            {managedSkills.length > 0 ? (
              <div className="mt-2 space-y-1">
                {managedSkills.map((skill) => (
                  <div key={skill.slug} className="font-mono text-[10px] leading-relaxed text-slate-400">
                    <span className="text-[#e85c2a]/80">{skill.slug}</span>
                    <span className="text-[#3a3a3a]"> — </span>
                    <span>{skill.description}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-[#3a3a3a]">
                No managed Pi skill files will be generated right now.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface SectionHeaderProps {
  title: string;
  meta?: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
}

function SectionHeader({ title, meta, open, onToggle, action }: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5">
      <button
        onClick={onToggle}
        className="group flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className={`text-[10px] text-[#4a4a4a] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="flex-1 text-[10px] uppercase tracking-widest text-[#4a4a4a] transition-colors group-hover:text-[#6b6b6b]">
          {title}
        </span>
      </button>
      {action}
      {meta && <span className="text-[10px] font-mono text-[#2a2a2a]">{meta}</span>}
    </div>
  );
}

function normalizeSkillBody(name: string, content: string): string {
  const trimmed = content.trim();
  if (trimmed) return trimmed;
  return defaultSkillTemplate(name);
}

function defaultSkillTemplate(name: string): string {
  const title = name.trim() || 'New Skill';
  return `# ${title}

When to use
- Describe when Pi should reach for this skill.

Steps
1. First action
2. Second action
3. Output or handoff
`;
}

function firstMeaningfulLine(content: string): string {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    return line.replace(/^[-*]\s+/, '');
  }
  return '';
}
