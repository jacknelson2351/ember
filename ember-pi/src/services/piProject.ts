import { deleteFile, writeFile } from './files';
import {
  buildPiAppendSystemPrompt,
  buildPiManagedSkills,
  type PiContextOptions,
} from '../utils/buildPrompt';

const APPEND_SYSTEM_RELATIVE_PATH = '.pi/APPEND_SYSTEM.md';
const MANAGED_SKILLS_ROOT = '.pi/skills/ember-managed';

export function getPiProjectPaths(sharedPath: string) {
  const root = sharedPath.replace(/\/$/, '');
  return {
    appendSystemPath: `${root}/${APPEND_SYSTEM_RELATIVE_PATH}`,
    managedSkillsRootPath: `${root}/${MANAGED_SKILLS_ROOT}`,
  };
}

export async function syncPiProjectContext(
  sharedPath: string,
  context: PiContextOptions,
): Promise<void> {
  const normalizedRoot = sharedPath.trim().replace(/\/$/, '');
  if (!normalizedRoot) return;

  const paths = getPiProjectPaths(normalizedRoot);
  await writeFile(paths.appendSystemPath, `${buildPiAppendSystemPrompt(context)}\n`);

  try {
    await deleteFile(paths.managedSkillsRootPath);
  } catch {
    // First sync is expected to miss.
  }

  const managedSkills = buildPiManagedSkills(context.skills, context.memoryMode);
  for (const skill of managedSkills) {
    await writeFile(
      `${paths.managedSkillsRootPath}/${skill.slug}/SKILL.md`,
      skill.content,
    );
  }
}
