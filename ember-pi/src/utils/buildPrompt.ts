import type { Note, Skill } from '../types';

export function buildEffectivePrompt(opts: {
  systemPrompt: string;
  memoryMode: 'off' | 'minimal' | 'session' | 'full';
  notes: Note[];
  skills: Skill[];
}): string {
  const { systemPrompt, memoryMode, notes, skills } = opts;

  if (memoryMode === 'off') return systemPrompt;

  const selectedNotes = memoryMode === 'full' ? notes : notes.filter((n) => n.pinned);
  const enabledSkills = skills.filter((sk) => sk.enabled);

  let result = systemPrompt;

  if (selectedNotes.length > 0) {
    const block = selectedNotes.map((n) => `- ${n.content}`).join('\n');
    result += `\n\n--- [NOTES] ---\n${block}\n--- [END] ---`;
  }

  if (enabledSkills.length > 0) {
    const skillBlock = enabledSkills
      .map((sk) => `## Skill: ${sk.name}\n${sk.content}`)
      .join('\n\n');
    result += `\n\n--- [SKILLS] ---\n${skillBlock}\n--- [END] ---`;
  }

  return result;
}
