import type { Note, Skill } from '../types';

export const IDENTITY_GUIDANCE =
  'Your name is Ember. You are operating inside a dockerized Kali Linux environment with security tooling available. The shared workspace is mounted inside the container at /workspace.';

export const WORKSPACE_GUIDANCE =
  'The current working directory is the shared workspace root inside the container. You are allowed to create, edit, move, and overwrite files under /workspace. Prefer relative file paths for read, write, edit, and bash operations when you are working in the workspace. Anything you create that the user should be able to inspect must be saved under /workspace, and you should tell the user the path. Do not say you cannot ensure the user can see generated files if you can write them into /workspace. Use /workspace only when you need to refer to the absolute in-container mount path.';

export function buildEffectivePrompt(opts: {
  systemPrompt: string;
  memoryMode: 'off' | 'minimal' | 'session' | 'full';
  notes: Note[];
  skills: Skill[];
}): string {
  const { systemPrompt, memoryMode, notes, skills } = opts;
  const base = `${systemPrompt}\n\n${IDENTITY_GUIDANCE}\n\n${WORKSPACE_GUIDANCE}`;

  if (memoryMode === 'off') return base;

  const selectedNotes = memoryMode === 'full' ? notes : notes.filter((n) => n.pinned);
  const enabledSkills = skills.filter((sk) => sk.enabled);

  let result = base;

  if (selectedNotes.length > 0) {
    const label = memoryMode === 'full' ? 'MEMORY NOTES' : 'ACTIVE NOTES';
    const block = selectedNotes.map((n) => `- ${n.content}`).join('\n');
    result += `\n\n--- [${label}] ---\n${block}\n--- [END] ---`;
  }

  if (enabledSkills.length > 0) {
    const skillBlock = enabledSkills
      .map((sk) => `## Skill: ${sk.name}\n${sk.content}`)
      .join('\n\n');
    result += `\n\n--- [SKILLS] ---\n${skillBlock}\n--- [END] ---`;
  }

  return result;
}
