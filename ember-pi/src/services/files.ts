import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceFile } from '../types';

interface RawFileInfo {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  modified: number;
}

export async function listDir(path: string): Promise<WorkspaceFile[]> {
  try {
    const raw = await invoke<RawFileInfo[]>('list_dir', { path });
    return raw.map((f) => ({
      name: f.name,
      path: f.path,
      size: f.size,
      isDir: f.is_dir,
      modified: f.modified,
    }));
  } catch {
    return [];
  }
}

export async function readFile(path: string): Promise<string> {
  return await invoke<string>('read_file', { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  await invoke('write_file', { path, content });
}

export async function writeFileBytes(path: string, file: File): Promise<void> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<data>" — strip the prefix
      resolve(result.substring(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  await invoke('write_file_bytes', { path, dataBase64: base64 });
}

export async function deleteFile(path: string): Promise<void> {
  await invoke('delete_file', { path });
}
