import type { Note, Skill } from '../types';

type MemoryMode = 'off' | 'minimal' | 'session' | 'full';

export interface PiContextOptions {
  systemPrompt: string;
  memoryMode: MemoryMode;
  notes: Note[];
  skills: Skill[];
}

export interface PiManagedSkill {
  slug: string;
  displayName: string;
  description: string;
  content: string;
}

const FALLBACK_QUICK_PROMPTS = [
  'Inspect the current workspace and summarize what is here.',
  'What Pi-native skills are available for this workspace right now?',
  'Check the environment and tell me the best next step.',
];

export function buildPiAppendSystemPrompt(opts: PiContextOptions): string {
  const sections: string[] = [];
  const basePrompt = opts.systemPrompt.trim();
  const selectedNotes = selectNotes(opts.memoryMode, opts.notes);

  if (basePrompt) {
    sections.push(basePrompt);
  }

  if (selectedNotes.length > 0) {
    sections.push(
      [
        '# Project Notes',
        'These notes are managed by Ember and synced into the project Pi context.',
        ...selectedNotes.map((note) => `- ${note.content.trim()}`),
      ].join('\n'),
    );
  }

  return sections.join('\n\n').trim();
}

export function buildPiManagedSkills(skills: Skill[], memoryMode: MemoryMode): PiManagedSkill[] {
  if (memoryMode === 'off') return [];

  return skills
    .filter((skill) => skill.enabled)
    .map((skill) => {
      const slug = slugifySkillName(skill.name);
      const description = inferSkillDescription(skill);
      const body = normalizeSkillBody(skill, description);
      return {
        slug,
        displayName: skill.name,
        description,
        content: [
          '---',
          `name: ${slug}`,
          `description: ${yamlQuote(description)}`,
          '---',
          '',
          body,
          '',
        ].join('\n'),
      };
    });
}

export function buildQuickPrompts(opts: PiContextOptions): string[] {
  const managedSkills = buildPiManagedSkills(opts.skills, opts.memoryMode);
  const notes = selectNotes(opts.memoryMode, opts.notes);
  const prompts: string[] = managedSkills
    .slice(0, 3)
    .map((skill) => truncate(`Use ${skill.displayName}: ${uncapitalize(trimPeriod(skill.description))}.`, 96));

  if (notes.length > 0) {
    prompts.push('Review the active project notes before starting.');
  }

  prompts.push('Inspect the workspace and decide which available Pi skill fits best.');

  return dedupe([...prompts, ...FALLBACK_QUICK_PROMPTS]).slice(0, 3);
}

export function buildEffectivePrompt(opts: PiContextOptions): string {
  const appendSystem = buildPiAppendSystemPrompt(opts);
  const managedSkills = buildPiManagedSkills(opts.skills, opts.memoryMode);
  const parts = [appendSystem];

  if (managedSkills.length > 0) {
    parts.push(
      [
        '--- [PI SKILLS] ---',
        ...managedSkills.map((skill) => `- ${skill.displayName}: ${skill.description}`),
        '--- [END] ---',
      ].join('\n'),
    );
  }

  return parts.filter(Boolean).join('\n\n');
}

function selectNotes(memoryMode: MemoryMode, notes: Note[]): Note[] {
  if (memoryMode === 'off') return [];
  return memoryMode === 'full' ? notes : notes.filter((note) => note.pinned);
}

function slugifySkillName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'skill';
}

function inferSkillDescription(skill: Skill): string {
  const explicit = skill.description?.trim();
  if (explicit) return explicit;

  const frontmatterDescription = extractFrontmatterField(skill.content, 'description');
  if (frontmatterDescription) return frontmatterDescription;

  const firstMeaningfulLine = extractMeaningfulLine(stripFrontmatter(skill.content));
  if (firstMeaningfulLine) return trimPeriod(firstMeaningfulLine);

  return `Use when a task matches ${skill.name}`;
}

function normalizeSkillBody(skill: Skill, description: string): string {
  const body = stripFrontmatter(skill.content).trim();
  if (!body) {
    return `# ${skill.name}\n\n${trimPeriod(description)}.`;
  }
  if (body.startsWith('#')) return body;
  return `# ${skill.name}\n\n${body}`;
}

function stripFrontmatter(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) return trimmed;
  return trimmed.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

function extractFrontmatterField(content: string, field: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return '';
  const fieldMatch = match[1].match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return fieldMatch?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
}

function extractMeaningfulLine(content: string): string {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (/^[-*]\s*$/.test(line)) continue;
    return line.replace(/^[-*]\s+/, '');
  }
  return '';
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function trimPeriod(value: string): string {
  return value.trim().replace(/[.]+$/, '');
}

function uncapitalize(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
